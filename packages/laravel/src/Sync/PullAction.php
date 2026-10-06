<?php

declare(strict_types=1);

namespace Synloquent\Laravel\Sync;

use Synloquent\Laravel\Export\ExportRegistry;
use Synloquent\Laravel\Export\ManifestBuilder;
use Synloquent\Laravel\Protocol\CanonicalJson;
use Synloquent\Laravel\Protocol\ProtocolException;

final class PullAction
{
    public function __construct(private SyncDatabase $database, private WriteGateway $gateway, private ProjectionReader $reader, private CursorCodec $cursors, private ManifestBuilder $manifest, private RelationSetReader $relationSets, private ExportRegistry $registry, private MembershipIndex $memberships) {}

    /** @return array<array-key, mixed> */
    public function execute(?string $cursor, string $dataset, ActorContext $actor): array
    {
        $fingerprint = $this->manifest->build()['fingerprint'];
        $decoded = $cursor === null ? null : $this->cursors->decode($cursor, $actor, $dataset, $fingerprint);

        return $this->gateway->transaction($actor, function () use ($decoded, $dataset, $actor, $fingerprint): array {
            $connection = $this->database->connection();
            $stream = $connection->table('synloquent_streams')->where('stream', $actor->stream())->first();
            $sequence = (int) $stream->sequence;
            $oldScope = $decoded === null ? null : $this->memberships->scope($actor, $dataset, $fingerprint, $decoded['authorizationGeneration']);
            if ($decoded !== null) {
                if ($decoded['sequence'] < (int) $stream->retention_floor || $decoded['sequence'] > $sequence) {
                    throw new ProtocolException('cursor_expired', 'Cursor is outside the retained stream interval.', ['retentionFloor' => (string) $stream->retention_floor]);
                }
                if (! $connection->table('synloquent_subscriptions')->where('subscription', $this->checkpoint($actor, $dataset, $fingerprint, $decoded['authorizationGeneration'], $decoded['sequence']))->exists() || ! $this->memberships->ready($oldScope, $decoded['sequence'])) {
                    throw new ProtocolException('cursor_expired', 'Subscription membership checkpoint expired.');
                }
            }
            $selfContained = true;
            foreach ($this->registry->all() as $resource) {
                if (! $resource->selfContainedProjection()) {
                    $selfContained = false;
                    break;
                }
            }
            if ($decoded !== null && $selfContained && $decoded['authorizationGeneration'] === $actor->authorizationGeneration) {
                if ($decoded['sequence'] === $sequence) {
                    return $this->response([], [], $dataset, $actor, $fingerprint, $sequence);
                }
                $publications = $connection->table('synloquent_publications')->where('stream', $actor->stream())->where('sequence', '>', $decoded['sequence'])->where('sequence', '<=', $sequence)->orderBy('sequence');
                $sizes = (clone $publications)->limit(config('synloquent.max_delta_transactions', 1000) + 1)->get(['sequence', $connection->raw('octet_length(changes) as byte_size')]);
                if ($sizes->count() !== $sequence - $decoded['sequence'] && $sizes->count() <= config('synloquent.max_delta_transactions', 1000)) {
                    throw new ProtocolException('cursor_expired', 'Captured publication history is incomplete. Install a fresh snapshot.');
                }
                if ($sizes->count() > config('synloquent.max_delta_transactions', 1000) || $sizes->sum('byte_size') > config('synloquent.max_delta_bytes', 8388608)) {
                    throw new ProtocolException('cursor_expired', 'Captured interval exceeds incremental bounds. Install a fresh snapshot.');
                }
                $descriptors = [];
                $fallback = false;
                foreach ($publications->get(['changes']) as $publication) {
                    foreach (json_decode($publication->changes, true, flags: JSON_THROW_ON_ERROR) as $change) {
                        if (($change['kind'] ?? '') === 'authorization') {
                            $fallback = true;
                            break 2;
                        }
                        if (! in_array($change['kind'] ?? '', ['upsert', 'delete', 'relation'], true)) {
                            $fallback = true;
                            break 2;
                        }
                        if ($change['kind'] === 'delete' && ! ($change['dependenciesCaptured'] ?? false) && $this->hasDeletionDependencies($change['model'])) {
                            $fallback = true;
                            break 2;
                        }
                        $descriptors[$this->memberships->key($change)] = $change;
                    }
                }
                if (count($descriptors) > config('synloquent.max_delta_records', 1000)) {
                    throw new ProtocolException('cursor_expired', 'Captured identity set exceeds incremental bounds. Install a fresh snapshot.');
                }
                if (! $fallback) {
                    return $this->incremental(array_values($descriptors), $oldScope, $decoded['sequence'], $sequence, $dataset, $actor, $fingerprint);
                }
            }

            return $this->materialize($decoded, $oldScope, $sequence, $dataset, $actor, $fingerprint);
        });
    }

    /**
     * @param  list<array<array-key, mixed>>  $descriptors
     * @return array<array-key, mixed>
     */
    private function incremental(array $descriptors, string $scope, int $previousSequence, int $sequence, string $dataset, ActorContext $actor, string $fingerprint): array
    {
        $recordDescriptors = [];
        foreach ($descriptors as $descriptor) {
            $recordDescriptors[$descriptor['model'].':'.$descriptor['id']] = ['model' => $descriptor['model'], 'id' => $descriptor['id']];
        }
        $records = $this->reader->recordsFor(array_values($recordDescriptors), $actor);
        $sets = $this->relationSets->read($records, $actor, (int) config('synloquent.max_delta_records', 1000));
        $lookups = $descriptors;
        foreach ($recordDescriptors as $descriptor) {
            foreach ($this->manifest->build()['models'][$descriptor['model']]['relations'] as $relationName => $relation) {
                if (isset($relation['pivot'])) {
                    $lookups[] = [...$descriptor, 'relation' => $relationName];
                }
            }
        }
        foreach ($records as $record) {
            $lookups[] = $record;
        }
        foreach ($sets as $set) {
            $lookups[] = $set;
        }
        $previous = $this->memberships->lookup($lookups, $scope, $previousSequence);
        $current = [];
        $changes = [];
        foreach ($records as $record) {
            $key = $this->memberships->key($record);
            $member = ['model' => $record['model'], 'id' => $record['id'], 'hash' => CanonicalJson::hash($record)];
            $current[$key] = $member;
            if (($previous[$key]['hash'] ?? null) !== $member['hash']) {
                $changes[] = ['kind' => 'upsert', 'model' => $record['model'], 'id' => $record['id'], 'record' => $record];
            }
        }
        $changedSets = [];
        foreach ($sets as $set) {
            $key = $this->memberships->key($set);
            $member = ['model' => $set['model'], 'relation' => $set['relation'], 'id' => $set['parentId'], 'revision' => $set['revision'], 'hash' => CanonicalJson::hash($set)];
            $current[$key] = $member;
            if (($previous[$key]['hash'] ?? null) !== $member['hash']) {
                $changedSets[] = $set;
            }
        }
        $updates = $current;
        $removedRecords = [];
        foreach ($previous as $key => $member) {
            if (isset($current[$key])) {
                continue;
            }
            $updates[$key] = null;
            if (isset($member['relation'])) {
                $changedSets[] = ['model' => $member['model'], 'relation' => $member['relation'], 'parentId' => $member['id'], 'revision' => $member['revision'] ?? '0', 'completeness' => 'complete', 'targets' => []];
            } else {
                $removedRecords[] = $member;
            }
        }
        array_push($changes, ...$this->removals($removedRecords));
        $this->memberships->advance($updates, $scope, $sequence);
        $this->checkpointReady($actor, $dataset, $fingerprint, $sequence);

        return $this->response($changes, $changedSets, $dataset, $actor, $fingerprint, $sequence);
    }

    /**
     * @param  array<array-key, mixed>|null  $decoded
     * @return array<array-key, mixed>
     */
    private function materialize(?array $decoded, ?string $oldScope, int $sequence, string $dataset, ActorContext $actor, string $fingerprint): array
    {
        $maximum = (int) config('synloquent.max_pull_materialization_members', 5000);
        if ($decoded !== null && $this->memberships->exceeds($oldScope, $decoded['sequence'], $maximum)) {
            throw new ProtocolException('cursor_expired', 'Authorization or unknown dependencies require a fresh snapshot beyond the bounded fallback.');
        }
        $previous = $decoded === null ? [] : $this->memberships->all($oldScope, $decoded['sequence']);
        $records = $this->reader->records($actor, $dataset, $maximum);
        $sets = $this->relationSets->read($records, $actor, $maximum);
        if (count($records) + count($sets) > $maximum) {
            throw new ProtocolException('cursor_expired', 'Materialized pull exceeds the bounded fallback. Install a fresh snapshot.');
        }
        $membership = [];
        $changes = [];
        foreach ($records as $record) {
            $key = $this->memberships->key($record);
            $membership[$key] = ['model' => $record['model'], 'id' => $record['id'], 'hash' => CanonicalJson::hash($record)];
            if (($previous[$key]['hash'] ?? null) !== $membership[$key]['hash']) {
                $changes[] = ['kind' => 'upsert', 'model' => $record['model'], 'id' => $record['id'], 'record' => $record];
            }
        }
        $changedSets = [];
        foreach ($sets as $set) {
            $key = $this->memberships->key($set);
            $membership[$key] = ['model' => $set['model'], 'relation' => $set['relation'], 'id' => $set['parentId'], 'revision' => $set['revision'], 'hash' => CanonicalJson::hash($set)];
            if (($previous[$key]['hash'] ?? null) !== $membership[$key]['hash']) {
                $changedSets[] = $set;
            }
        }
        $removed = [];
        foreach (array_diff_key($previous, $membership) as $member) {
            if (! isset($member['relation'])) {
                $removed[] = $member;
            } else {
                $changedSets[] = ['model' => $member['model'], 'relation' => $member['relation'], 'parentId' => $member['id'], 'revision' => $member['revision'] ?? '0', 'completeness' => 'complete', 'targets' => []];
            }
        }
        array_push($changes, ...$this->removals($removed));
        $this->memberships->initialize($membership, $this->memberships->scope($actor, $dataset, $fingerprint), $actor->stream(), $sequence);
        $this->checkpointReady($actor, $dataset, $fingerprint, $sequence);

        return $this->response($changes, $changedSets, $dataset, $actor, $fingerprint, $sequence);
    }

    /**
     * @param  list<array<array-key, mixed>>  $members
     * @return list<array<array-key, mixed>>
     */
    private function removals(array $members): array
    {
        $groups = [];
        foreach ($members as $member) {
            $groups[$member['model']][] = $member['id'];
        }
        $changes = [];
        foreach ($groups as $name => $identities) {
            $model = new ($this->registry->get($name)->modelClass());
            $deletedAt = $this->manifest->build()['models'][$name]['softDeletes'] ?? null;
            $columns = [$model->getKeyName(), ...($deletedAt === null ? [] : [$deletedAt])];
            $present = $model->newQueryWithoutScopes()->whereKey($identities)->get($columns)->keyBy($model->getKeyName());
            foreach ($identities as $identity) {
                $remaining = $present->get($identity);
                $deleted = $remaining === null;
                $changes[] = ['kind' => $deleted ? 'delete' : 'remove', 'model' => $name, 'id' => $identity];
            }
        }

        return $changes;
    }

    private function hasDeletionDependencies(string $name): bool
    {
        foreach ($this->manifest->build()['models'] as $definition) {
            foreach ($definition['relations'] as $relation) {
                if (($relation['type'] === 'belongsTo' && $relation['model'] === $name && in_array($relation['onDelete'] ?? '', ['cascade', 'nullify'], true)) || (isset($relation['pivot']) && ($relation['model'] === $name || $definition['resource'] === $name))) {
                    return true;
                }
            }
        }

        return false;
    }

    /**
     * @param  list<array<array-key, mixed>>  $changes
     * @param  list<array<array-key, mixed>>  $sets
     * @return array<array-key, mixed>
     */
    private function response(array $changes, array $sets, string $dataset, ActorContext $actor, string $fingerprint, int $sequence): array
    {
        if (strlen(CanonicalJson::encode(['changes' => $changes, 'relationSets' => $sets])) > config('synloquent.max_pull_bytes', 8388608)) {
            throw new ProtocolException('cursor_expired', 'Pull interval exceeds response bounds. Install a fresh bounded snapshot.');
        }
        $next = $this->cursors->encode($actor, $dataset, $fingerprint, $sequence);

        return ['batches' => $changes === [] && $sets === [] ? [] : [['cursor' => $next, 'changes' => $changes, 'relationSets' => $sets]], 'cursor' => $next, 'highWater' => $next, 'scanComplete' => true, 'scope' => ['dataset' => $dataset, 'authorizationGeneration' => $actor->authorizationGeneration, 'projectionGeneration' => '1', 'schemaFingerprint' => $fingerprint, 'completeness' => 'complete']];
    }

    private function checkpointReady(ActorContext $actor, string $dataset, string $fingerprint, int $sequence): void
    {
        $this->database->connection()->table('synloquent_subscriptions')->insertOrIgnore(['subscription' => $this->checkpoint($actor, $dataset, $fingerprint, $actor->authorizationGeneration, $sequence), 'stream' => $actor->stream(), 'membership' => '[]', 'sequence' => $sequence, 'authorization_generation' => $actor->authorizationGeneration]);
    }

    private function checkpoint(ActorContext $actor, string $dataset, string $fingerprint, string $generation, int $sequence): string
    {
        return CanonicalJson::hash([$actor->partition(), $dataset, $fingerprint, $generation, $sequence]);
    }

    public function prune(ActorContext $actor, int $inclusiveFloor): void
    {
        $this->gateway->transaction($actor, function () use ($actor, $inclusiveFloor): void {
            $connection = $this->database->connection();
            $stream = $connection->table('synloquent_streams')->where('stream', $actor->stream())->first();
            if ($inclusiveFloor < (int) $stream->retention_floor || $inclusiveFloor > (int) $stream->sequence) {
                throw new ProtocolException('validation_failed', 'Invalid retention floor.');
            }
            if ($connection->table('synloquent_snapshot_grants')->where('stream', $actor->stream())->where('sequence', '<', $inclusiveFloor)->exists()) {
                throw new ProtocolException('conflict', 'Retained snapshots pin the publication tail.');
            }
            $connection->table('synloquent_publications')->where('stream', $actor->stream())->where('sequence', '<=', $inclusiveFloor)->delete();
            $connection->table('synloquent_subscriptions')->where('stream', $actor->stream())->where('sequence', '<', $inclusiveFloor)->delete();
            $this->memberships->prune($actor->stream(), $inclusiveFloor);
            $connection->table('synloquent_streams')->where('stream', $actor->stream())->update(['retention_floor' => $inclusiveFloor]);
        });
    }
}

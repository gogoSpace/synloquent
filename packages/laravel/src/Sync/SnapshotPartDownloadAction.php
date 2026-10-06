<?php

declare(strict_types=1);

namespace Synloquent\Laravel\Sync;

use Illuminate\Database\Eloquent\Relations\BelongsToMany;
use JsonException;
use stdClass;
use Synloquent\Laravel\Contracts\ResourceExport;
use Synloquent\Laravel\Export\ExportRegistry;
use Synloquent\Laravel\Protocol\CanonicalJson;
use Synloquent\Laravel\Protocol\ProtocolException;
use Synloquent\Laravel\Protocol\ProtocolValidator;

final class SnapshotPartDownloadAction
{
    private const BUNDLE_PARTS = 16;

    private const BUNDLE_BYTES = 1048576;

    private const INDEX_BYTES = 16384;

    public function __construct(private SnapshotPartStore $parts, private WriteGateway $gateway, private SnapshotDownloadAction $downloads, private ExportRegistry $registry, private ProtocolValidator $validator, private StageProfiler $profiler) {}

    public function execute(string $generation, string $hash, int $ordinal, string $continuation, ActorContext $actor): SnapshotPartDocument
    {
        return $this->read($generation, $hash, $ordinal, $continuation, $actor, false);
    }

    public function bundle(string $generation, string $hash, int $ordinal, string $continuation, ActorContext $actor): SnapshotPartDocument
    {
        return $this->read($generation, $hash, $ordinal, $continuation, $actor, true);
    }

    /** @return array<array-key, mixed> */
    public function confirm(string $generation, string $hash, string $confirmationToken, ActorContext $actor): array
    {
        $context = $this->parts->context($generation, $hash, $actor);
        $this->parts->verify($confirmationToken, 'snapshot-confirm', $context['grant']);
        $document = $this->downloads->stream($generation, $hash, $actor);
        if (! hash_equals($context['grant']->metadata_hash, CanonicalJson::hash($document->metadata))) {
            throw new ProtocolException('invalid_snapshot', 'Snapshot identity changed during confirmation.');
        }

        return [...$document->metadata, 'confirmed' => true];
    }

    private function read(string $generation, string $hash, int $ordinal, string $continuation, ActorContext $actor, bool $bundle): SnapshotPartDocument
    {
        return $this->gateway->transaction($actor, function () use ($generation, $hash, $ordinal, $continuation, $actor, $bundle): SnapshotPartDocument {
            $context = $this->parts->context($generation, $hash, $actor);
            $grant = $context['grant'];
            $token = $this->parts->verify($continuation, 'snapshot-part', $grant);
            if ($ordinal < 0 || $ordinal >= $context['descriptor']['partCount'] || ($token['ordinal'] ?? null) !== $ordinal) {
                throw new ProtocolException('forbidden_operation', 'Snapshot part continuation is out of order.', [], 403);
            }
            $bodies = [];
            $index = [];
            $bytes = 0;
            $nextOrdinal = $ordinal;
            while ($nextOrdinal < $context['descriptor']['partCount'] && count($bodies) < ($bundle ? self::BUNDLE_PARTS : 1)) {
                $part = $this->parts->part($grant->grant, $nextOrdinal);
                if ($nextOrdinal === $ordinal && (($token['hash'] ?? null) !== $part->hash || ($token['byteSize'] ?? null) !== (int) $part->byte_size)) {
                    throw new ProtocolException('invalid_snapshot', 'Snapshot part does not match its continuation.');
                }
                $identity = $this->parts->identity($part, $context['metadata'], $grant->metadata_hash);
                $candidateIndex = [...$index, $identity];
                $size = strlen($part->body) + (int) $bundle;
                if ($bundle && ($bytes + $size > self::BUNDLE_BYTES || strlen(CanonicalJson::encode($candidateIndex)) > self::INDEX_BYTES)) {
                    break;
                }
                $this->authorizePart($part, $context['descriptor'], $actor);
                $bodies[] = $part->body.($bundle ? "\n" : '');
                $index = $candidateIndex;
                $bytes += $size;
                $nextOrdinal++;
            }
            if ($bodies === []) {
                throw new ProtocolException('invalid_snapshot', 'Snapshot bundle cannot admit its first part.');
            }
            $next = $nextOrdinal < $context['descriptor']['partCount'] ? $this->parts->nextIdentity($grant->grant, $nextOrdinal, $context['metadata'], $grant->metadata_hash) : null;

            return new SnapshotPartDocument(implode('', $bodies), $next, $next === null ? $this->parts->confirmation($grant->grant, $grant->metadata_hash) : null, $bundle ? $index : []);
        });
    }

    /** @param array<array-key, mixed> $descriptor */
    private function authorizePart(stdClass $part, array $descriptor, ActorContext $actor): void
    {
        try {
            $body = json_decode($part->body, flags: JSON_THROW_ON_ERROR);
        } catch (JsonException) {
            throw new ProtocolException('invalid_snapshot', 'Snapshot part is not valid JSON.');
        }
        if (! $body instanceof stdClass || array_diff(array_keys(get_object_vars($body)), ['format', 'ordinal', 'section', 'firstIndex', 'rowCount', 'rows']) !== [] || ($body->format ?? null) !== SnapshotPartStore::FORMAT || ($body->ordinal ?? null) !== (int) $part->ordinal || ($body->section ?? null) !== $part->section || ($body->firstIndex ?? null) !== (int) $part->first_index || ($body->rowCount ?? null) !== (int) $part->row_count || ! is_array($body->rows ?? null) || count($body->rows) !== (int) $part->row_count || $body->rowCount < 1 || $body->rowCount > SnapshotPartStore::MAXIMUM_ROWS || ! in_array($body->section, ['records', 'relationSets'], true) || $body->firstIndex < 0 || $body->firstIndex + $body->rowCount > $descriptor[$body->section === 'records' ? 'recordCount' : 'relationSetCount']) {
            throw new ProtocolException('invalid_snapshot', 'Snapshot part index or shape is inconsistent.');
        }
        $opening = strpos($part->body, ',"rows":[');
        if ($opening === false) {
            throw new ProtocolException('invalid_snapshot', 'Snapshot part raw rows span is missing.');
        }
        $encodedRows = substr($part->body, $opening + strlen(',"rows":'), -1);
        $records = $this->profiler->measure('snapshotDownload.decodeAndValidation', fn () => $this->validator->validateCatalogChunk($body->section, $encodedRows, $body->firstIndex + $body->rowCount));
        if ($body->section === 'relationSets') {
            $this->authorizeRelationSets($records, $actor);

            return;
        }
        $started = hrtime(true);
        $groups = [];
        foreach ($records as $record) {
            $groups[$record->model][$record->id] = $record;
        }
        foreach ($groups as $name => $chunk) {
            $resource = $this->registry->get($name);
            if (! $resource->authorize('query', $actor)) {
                throw new ProtocolException('forbidden_operation', 'Snapshot resource access was revoked.', [], 403);
            }
            $query = ($resource->modelClass())::query();
            if (method_exists($query->getModel(), 'getDeletedAtColumn')) {
                $query->__call('withTrashed', []);
            }
            $resource->scope($query, $actor);
            $current = $query->whereKey(array_keys($chunk))->get()->keyBy($query->getModel()->getKeyName());
            if ($current->count() !== count($chunk)) {
                throw new ProtocolException('forbidden_operation', 'Historical snapshot membership access was revoked.', [], 403);
            }
            foreach ($chunk as $identity => $record) {
                $model = $current->get($identity);
                if ($model === null || array_diff(array_keys(get_object_vars($record->attributes)), array_keys($resource->project($model, $actor))) !== []) {
                    throw new ProtocolException('forbidden_operation', 'Historical snapshot field access was revoked.', [], 403);
                }
            }
        }
        $this->profiler->record('snapshotDownload.reauthorization', (hrtime(true) - $started) / 1e9, count($records));
    }

    /** @param list<stdClass> $sets */
    private function authorizeRelationSets(array $sets, ActorContext $actor): void
    {
        $started = hrtime(true);
        $owners = [];
        $targets = [];
        $relations = [];
        foreach ($sets as $set) {
            $resource = $this->registry->get($set->model);
            $owners[$set->model][$set->parentId] = true;
            $relation = $relations[$set->model][$set->relation] ?? null;
            if ($relation === null) {
                if (! in_array($set->relation, $resource->relations(), true)) {
                    throw new ProtocolException('forbidden_operation', 'Historical snapshot relation access was revoked.', [], 403);
                }
                $model = new ($resource->modelClass());
                $relation = $model->{$set->relation}();
                if (! $relation instanceof BelongsToMany) {
                    throw new ProtocolException('forbidden_operation', 'Historical snapshot relation access was revoked.', [], 403);
                }
                $relations[$set->model][$set->relation] = $relation;
            }
            $related = $this->registry->nameForClass($relation->getRelated()::class);
            $readable = [];
            foreach ($resource->pivotFields($set->relation) as $field => $definition) {
                if ($definition['readable']) {
                    $readable[] = $field;
                }
            }
            foreach ($set->targets as $target) {
                if (array_diff(array_keys(get_object_vars($target->attributes)), $readable) !== []) {
                    throw new ProtocolException('forbidden_operation', 'Historical snapshot pivot field access was revoked.', [], 403);
                }
                $targets[$related][$target->id] = true;
            }
        }
        foreach ($owners as $name => $identities) {
            $this->authorizeRelationIdentities($this->registry->get($name), array_keys($identities), $actor, true);
        }
        foreach ($targets as $name => $identities) {
            $this->authorizeRelationIdentities($this->registry->get($name), array_keys($identities), $actor, false);
        }
        $this->profiler->record('snapshotDownload.reauthorization', (hrtime(true) - $started) / 1e9, count($sets));
    }

    /** @param list<int|string> $identities */
    private function authorizeRelationIdentities(ResourceExport $resource, array $identities, ActorContext $actor, bool $includeTrashed): void
    {
        if (! $resource->authorize('query', $actor)) {
            throw new ProtocolException('forbidden_operation', 'Snapshot relation resource access was revoked.', [], 403);
        }
        foreach (array_chunk($identities, 1000) as $chunk) {
            $query = ($resource->modelClass())::query();
            if ($includeTrashed && method_exists($query->getModel(), 'getDeletedAtColumn')) {
                $query->__call('withTrashed', []);
            }
            $resource->scope($query, $actor);
            $current = $query->whereKey($chunk)->get();
            if ($current->count() !== count($chunk)) {
                throw new ProtocolException('forbidden_operation', 'Historical snapshot relation membership access was revoked.', [], 403);
            }
            foreach ($current as $model) {
                if (! array_key_exists($model->getKeyName(), $resource->project($model, $actor))) {
                    throw new ProtocolException('forbidden_operation', 'Historical snapshot relation identity field access was revoked.', [], 403);
                }
            }
        }
    }
}

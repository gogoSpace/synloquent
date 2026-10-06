<?php

declare(strict_types=1);

namespace Synloquent\Laravel\Sync;

use Synloquent\Laravel\Export\ManifestBuilder;
use Synloquent\Laravel\Protocol\CanonicalJson;
use Synloquent\Laravel\Protocol\CatalogEncoder;
use Synloquent\Laravel\Protocol\ProtocolException;
use Synloquent\Laravel\Protocol\ProtocolValidator;

final class SnapshotAction
{
    public function __construct(private SyncDatabase $database, private WriteGateway $gateway, private ProjectionReader $reader, private CursorCodec $cursors, private ManifestBuilder $manifest, private RelationSetReader $relationSets, private MembershipIndex $memberships, private StageProfiler $profiler, private ProtocolValidator $validator) {}

    /** @param (callable(array<array-key, mixed>, string, array<string, int>): void)|null $afterPersist */
    public function stream(string $dataset, ActorContext $actor, ?callable $afterPersist = null): SnapshotStreamDocument
    {
        $fingerprint = $this->manifest->build()['fingerprint'];

        return $this->gateway->transaction($actor, function () use ($dataset, $actor, $fingerprint, $afterPersist): SnapshotStreamDocument {
            $connection = $this->database->connection();
            $sequence = (int) $connection->table('synloquent_streams')->where('stream', $actor->stream())->value('sequence');
            $records = (function () use ($actor, $dataset): \Generator {
                foreach ($this->reader->chunks($actor, $dataset) as $chunk) {
                    foreach ($chunk as $record) {
                        yield $record;
                    }
                }
            })();
            $relations = (function () use ($actor, $dataset): \Generator {
                $targetCount = 0;
                foreach ($this->reader->identityChunks($actor, $dataset) as $chunk) {
                    $sets = $this->profiler->measure('snapshot.relationChunks', fn () => $this->relationSets->read($chunk, $actor, (int) config('synloquent.max_snapshot_rows', 200000) - $targetCount));
                    foreach ($sets as $set) {
                        $targetCount += count($set['targets']);
                        yield $set;
                    }
                }
            })();
            $catalog = new CatalogEncoder($records, $relations, $this->profiler, $this->validator);
            $this->profiler->measure('snapshot.membershipInitialization', fn () => $this->memberships->initializeStream($catalog->membership(), $this->memberships->scope($actor, $dataset, $fingerprint), $actor->stream(), $sequence));
            $metadata = $this->metadata($actor, $dataset, $fingerprint, $sequence, $catalog->hash(), $catalog->size());
            $this->validator->validate('snapshot', json_decode(CanonicalJson::encode([...$metadata, 'records' => [], 'relationSets' => []]), flags: JSON_THROW_ON_ERROR));
            $hasContent = $connection->table('synloquent_snapshots')->where('hash', $metadata['hash'])->exists();
            if ($hasContent) {
                $this->profiler->record('snapshot.contentCacheHit', 0.0, 1);
            }
            if ($afterPersist === null) {
                $this->persist($actor, $sequence, $metadata, $hasContent ? null : $catalog->bytes());
            } else {
                $bytes = $catalog->bytes();
                $this->persist($actor, $sequence, $metadata, $hasContent ? null : $bytes);
                $afterPersist($metadata, $bytes, $catalog->counts());
            }

            return new SnapshotStreamDocument($metadata, $catalog);
        });
    }

    /** @return array<array-key, mixed> */
    private function metadata(ActorContext $actor, string $dataset, string $fingerprint, int $sequence, string $hash, int $size): array
    {
        $cursor = $this->cursors->encode($actor, $dataset, $fingerprint, $sequence);
        $scope = ['dataset' => $dataset, 'authorizationGeneration' => $actor->authorizationGeneration, 'projectionGeneration' => '1', 'schemaFingerprint' => $fingerprint, 'completeness' => 'complete'];
        $generation = CanonicalJson::hash([(string) config('synloquent.dataset_generation', '1'), $actor->partition(), $dataset, $fingerprint, $cursor, $hash, $scope]);

        return ['schemaFingerprint' => $fingerprint, 'dataset' => $dataset, 'cursor' => $cursor, 'scope' => $scope, 'generation' => $generation, 'hash' => $hash, 'byteSize' => $size, 'downloadUrl' => '/'.trim(config('synloquent.route_prefix', 'synloquent/v1'), '/').'/snapshots/'.$generation.'/'.$hash];
    }

    /** @param array<array-key, mixed> $metadata */
    private function persist(ActorContext $actor, int $sequence, array $metadata, ?string $bytes): void
    {
        $connection = $this->database->connection();
        if ($bytes !== null) {
            $this->profiler->measure('snapshot.contentPersistence', fn () => $connection->table('synloquent_snapshots')->insertOrIgnore(['hash' => $metadata['hash'], 'stream' => $actor->stream(), 'sequence' => $sequence, 'document' => $bytes, 'byte_size' => strlen($bytes), 'created_at' => now()]));
        }
        $connection->table('synloquent_snapshot_grants')->insertOrIgnore(['grant' => CanonicalJson::hash([$actor->partition(), $metadata['generation'], $metadata['hash']]), 'partition' => $actor->partition(), 'generation' => $metadata['generation'], 'hash' => $metadata['hash'], 'stream' => $actor->stream(), 'sequence' => $sequence, 'authorization_generation' => $actor->authorizationGeneration, 'schema_fingerprint' => $metadata['schemaFingerprint'], 'metadata' => CanonicalJson::encode($metadata), 'metadata_hash' => CanonicalJson::hash($metadata), 'created_at' => now()]);
        $connection->table('synloquent_subscriptions')->insertOrIgnore(['subscription' => CanonicalJson::hash([$actor->partition(), $metadata['dataset'], $metadata['schemaFingerprint'], $actor->authorizationGeneration, $sequence]), 'stream' => $actor->stream(), 'membership' => '[]', 'sequence' => $sequence, 'authorization_generation' => $actor->authorizationGeneration]);
    }

    /** @return array<array-key, mixed> */
    public function execute(string $dataset, ActorContext $actor): array
    {
        return $this->build($dataset, $actor)->document;
    }

    public function build(string $dataset, ActorContext $actor): SnapshotDocument
    {
        $fingerprint = $this->manifest->build()['fingerprint'];

        return $this->gateway->transaction($actor, function () use ($dataset, $actor, $fingerprint): SnapshotDocument {
            $connection = $this->database->connection();
            $sequence = (int) $connection->table('synloquent_streams')->where('stream', $actor->stream())->value('sequence');
            $records = $this->profiler->measure('snapshot.projection', fn () => $this->reader->records($actor, $dataset));
            $relations = $this->profiler->measure('snapshot.relations', fn () => $this->relationSets->read($records, $actor));
            $document = ['schemaFingerprint' => $fingerprint, 'dataset' => $dataset, 'cursor' => $this->cursors->encode($actor, $dataset, $fingerprint, $sequence), 'records' => $records, 'relationSets' => $relations, 'scope' => ['dataset' => $dataset, 'authorizationGeneration' => $actor->authorizationGeneration, 'projectionGeneration' => '1', 'schemaFingerprint' => $fingerprint, 'completeness' => 'complete']];
            $catalog = new CatalogEncoder($records, $relations, $this->profiler);
            $this->profiler->measure('snapshot.membershipInitialization', fn () => $this->memberships->initializeStream($catalog->membership(), $this->memberships->scope($actor, $dataset, $fingerprint), $actor->stream(), $sequence));
            $bytes = $catalog->bytes();
            if (strlen($bytes) > config('synloquent.max_snapshot_bytes', 67108864)) {
                throw new ProtocolException('validation_failed', 'Snapshot byte limit exceeded.');
            }
            $hash = hash('sha256', $bytes);
            $document['generation'] = CanonicalJson::hash([(string) config('synloquent.dataset_generation', '1'), $actor->partition(), $dataset, $fingerprint, $document['cursor'], $hash, $document['scope']]);
            $document['hash'] = $hash;
            $document['byteSize'] = strlen($bytes);
            $document['downloadUrl'] = '/'.trim(config('synloquent.route_prefix', 'synloquent/v1'), '/').'/snapshots/'.$document['generation'].'/'.$hash;
            $this->profiler->measure('snapshot.contentPersistence', fn () => $connection->table('synloquent_snapshots')->insertOrIgnore(['hash' => $hash, 'stream' => $actor->stream(), 'sequence' => $sequence, 'document' => $bytes, 'byte_size' => strlen($bytes), 'created_at' => now()]));
            $metadata = $document;
            unset($metadata['records'], $metadata['relationSets']);
            $connection->table('synloquent_snapshot_grants')->insertOrIgnore(['grant' => CanonicalJson::hash([$actor->partition(), $document['generation'], $hash]), 'partition' => $actor->partition(), 'generation' => $document['generation'], 'hash' => $hash, 'stream' => $actor->stream(), 'sequence' => $sequence, 'authorization_generation' => $actor->authorizationGeneration, 'schema_fingerprint' => $fingerprint, 'metadata' => CanonicalJson::encode($metadata), 'metadata_hash' => CanonicalJson::hash($metadata), 'created_at' => now()]);
            $connection->table('synloquent_subscriptions')->insertOrIgnore(['subscription' => CanonicalJson::hash([$actor->partition(), $dataset, $fingerprint, $actor->authorizationGeneration, $sequence]), 'stream' => $actor->stream(), 'membership' => '[]', 'sequence' => $sequence, 'authorization_generation' => $actor->authorizationGeneration]);

            return new SnapshotDocument($document, $bytes);
        });
    }
}

<?php

declare(strict_types=1);

namespace Synloquent\Laravel\Sync;

use Synloquent\Laravel\Export\ExportRegistry;
use Synloquent\Laravel\Export\ManifestBuilder;
use Synloquent\Laravel\Protocol\CanonicalJson;
use Synloquent\Laravel\Protocol\CatalogReader;
use Synloquent\Laravel\Protocol\ProtocolException;
use Synloquent\Laravel\Protocol\ProtocolValidator;

final class SnapshotDownloadAction
{
    public function __construct(private SyncDatabase $database, private WriteGateway $gateway, private ExportRegistry $registry, private ManifestBuilder $manifest, private CatalogReader $catalogReader, private ProtocolValidator $validator, private StageProfiler $profiler) {}

    /** @return array<array-key, mixed> */
    public function execute(string $generation, string $hash, ActorContext $actor): array
    {
        $document = $this->stream($generation, $hash, $actor);

        return [...$document->metadata, ...json_decode($document->content, true, flags: JSON_THROW_ON_ERROR)];
    }

    public function stream(string $generation, string $hash, ActorContext $actor): SnapshotStreamDocument
    {
        return $this->gateway->transaction($actor, function () use ($generation, $hash, $actor): SnapshotStreamDocument {
            $connection = $this->database->connection();
            $grant = $connection->table('synloquent_snapshot_grants')->where(['partition' => $actor->partition(), 'generation' => $generation, 'hash' => $hash, 'authorization_generation' => $actor->authorizationGeneration, 'schema_fingerprint' => $this->manifest->build()['fingerprint']])->first();
            if ($grant === null) {
                throw new ProtocolException('forbidden_operation', 'Snapshot grant is not valid for this actor, device, epoch and schema.', [], 403);
            }
            $content = $connection->table('synloquent_snapshots')->where('hash', $hash)->first();
            if ($content === null || ! hash_equals($hash, hash('sha256', $content->document)) || strlen($content->document) !== (int) $content->byte_size || (int) $content->byte_size > config('synloquent.max_snapshot_bytes', 67108864)) {
                throw new ProtocolException('invalid_snapshot', 'Stored snapshot content is corrupt.');
            }
            if (! hash_equals($grant->metadata_hash, hash('sha256', $grant->metadata))) {
                throw new ProtocolException('invalid_snapshot', 'Stored snapshot metadata is corrupt.');
            }
            $metadata = json_decode($grant->metadata, true, flags: JSON_THROW_ON_ERROR);
            if (($metadata['hash'] ?? null) !== $hash || ($metadata['generation'] ?? null) !== $generation || ($metadata['byteSize'] ?? null) !== (int) $content->byte_size) {
                throw new ProtocolException('invalid_snapshot', 'Stored snapshot metadata does not identify its content.');
            }
            $this->validator->validate('snapshot', json_decode(CanonicalJson::encode([...$metadata, 'records' => [], 'relationSets' => []]), flags: JSON_THROW_ON_ERROR));
            $encoded = [];
            $section = 'records';
            $counts = ['records' => 0, 'relationSets' => 0];
            foreach ($this->catalogReader->rows($content->document) as $entry) {
                if ($entry['section'] !== $section) {
                    $this->validateChunk($section, $encoded, $counts[$section], $actor);
                    $encoded = [];
                    $section = $entry['section'];
                }
                $counts[$section]++;
                if ($counts['records'] > config('synloquent.max_snapshot_rows', 200000)) {
                    throw new ProtocolException('invalid_snapshot', 'Stored snapshot exceeds the configured row limit.');
                }
                $encoded[] = $entry['encoded'];
                if (count($encoded) === 1000) {
                    $this->validateChunk($section, $encoded, $counts[$section], $actor);
                    $encoded = [];
                }
            }
            $this->validateChunk($section, $encoded, $counts[$section], $actor);

            return new SnapshotStreamDocument($metadata, $content->document);
        });
    }

    /**
     * @param  list<string>  $encoded
     */
    private function validateChunk(string $section, array $encoded, int $count, ActorContext $actor): void
    {
        if ($encoded === []) {
            return;
        }
        $records = $this->profiler->measure('snapshotDownload.decodeAndValidation', fn () => $this->validator->validateCatalogChunk($section, '['.implode(',', $encoded).']', $count));
        if ($section !== 'records') {
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
}

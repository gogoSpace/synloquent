<?php

declare(strict_types=1);

namespace Synloquent\Laravel\Sync;

use JsonException;
use stdClass;
use Synloquent\Laravel\Export\ExportRegistry;
use Synloquent\Laravel\Export\ManifestBuilder;
use Synloquent\Laravel\Protocol\CanonicalJson;
use Synloquent\Laravel\Protocol\CatalogReader;
use Synloquent\Laravel\Protocol\ProtocolException;
use Synloquent\Laravel\Protocol\ProtocolValidator;

final class SnapshotPartStore
{
    public const FORMAT = 'canonical-parts-v1';

    public const MAXIMUM_PART_BYTES = 65536;

    public const MAXIMUM_ROWS = 256;

    private const ROW_BYTES = 61440;

    public function __construct(private SyncDatabase $database, private ExportRegistry $registry, private CatalogReader $catalogs, private ManifestBuilder $manifest, private ProtocolValidator $validator, private CursorCodec $cursors, private StageProfiler $profiler) {}

    public function eligible(): bool
    {
        if (config('synloquent.capture_contract') !== 'gateway') {
            return false;
        }
        foreach ($this->registry->all() as $resource) {
            if (! $resource->selfContainedProjection()) {
                return false;
            }
        }

        return true;
    }

    /**
     * @param  array<array-key, mixed>  $metadata
     * @param  array<string, int>  $counts
     * @return array<array-key, mixed>
     */
    public function prepare(array $metadata, string $content, array $counts, ActorContext $actor): array
    {
        $grant = CanonicalJson::hash([$actor->partition(), $metadata['generation'], $metadata['hash']]);
        $metadataHash = CanonicalJson::hash($metadata);
        $connection = $this->database->connection();
        $existing = $connection->table('synloquent_snapshot_transfers')->where('grant', $grant)->first();
        if ($existing !== null) {
            $storedDescriptor = $this->descriptor($existing, $metadataHash);
            if (! $this->eligible()) {
                return [...$storedDescriptor, 'status' => 'admission-required', 'reason' => 'unsupported-host-contract', 'partCount' => 0];
            }

            return $this->render($storedDescriptor, $grant, $metadataHash);
        }
        $base = [...$metadata, 'format' => self::FORMAT, 'status' => 'ready', 'partCount' => 0, 'recordCount' => $counts['records'], 'relationSetCount' => $counts['relationSets'], 'maximumPartBytes' => self::MAXIMUM_PART_BYTES, 'maximumRowBytes' => 0, 'partRowLimit' => self::MAXIMUM_ROWS];
        $connection->table('synloquent_snapshot_transfers')->insertOrIgnore(['grant' => $grant, 'metadata_hash' => $metadataHash, 'descriptor' => CanonicalJson::encode($base), 'descriptor_hash' => CanonicalJson::hash($base), 'created_at' => now()]);
        $eligible = $this->eligible();
        $oversized = false;
        $ordinal = 0;
        $section = 'records';
        $positions = ['records' => 0, 'relationSets' => 0];
        $firstIndex = 0;
        $rows = [];
        $rowBytes = 0;
        foreach ($this->catalogs->rows($content) as $entry) {
            $length = strlen($entry['encoded']);
            $base['maximumRowBytes'] = max($base['maximumRowBytes'], $length);
            if (! $eligible || $oversized || $length > self::ROW_BYTES) {
                $oversized = $oversized || $length > self::ROW_BYTES;
                $positions[$entry['section']]++;

                continue;
            }
            if ($entry['section'] !== $section || count($rows) === self::MAXIMUM_ROWS || $rowBytes + $length + (int) ($rows !== []) > self::ROW_BYTES) {
                $nextOrdinal = $this->persistPart($grant, $ordinal, $section, $firstIndex, $rows);
                if ($nextOrdinal === null) {
                    $oversized = true;
                    $positions[$entry['section']]++;

                    continue;
                }
                $ordinal = $nextOrdinal;
                $rows = [];
                $rowBytes = 0;
                $section = $entry['section'];
            }
            if ($rows === []) {
                $firstIndex = $positions[$section];
            }
            $rowBytes += $length + (int) ($rows !== []);
            $rows[] = $entry['encoded'];
            $positions[$section]++;
        }
        if ($eligible && ! $oversized) {
            $nextOrdinal = $this->persistPart($grant, $ordinal, $section, $firstIndex, $rows);
            $oversized = $nextOrdinal === null;
            $ordinal = $nextOrdinal ?? $ordinal;
        }
        if (! $eligible || $oversized) {
            $connection->table('synloquent_snapshot_parts')->where('grant', $grant)->delete();
            $base['status'] = 'admission-required';
            $base['reason'] = $eligible ? 'row-exceeds-part-budget' : 'unsupported-host-contract';
        } else {
            $base['partCount'] = $ordinal;
        }
        $encoded = CanonicalJson::encode($base);
        $connection->table('synloquent_snapshot_transfers')->where('grant', $grant)->update(['descriptor' => $encoded, 'descriptor_hash' => hash('sha256', $encoded)]);

        return $this->render($base, $grant, $metadataHash);
    }

    /** @param list<string> $rows */
    private function persistPart(string $grant, int $ordinal, string $section, int $firstIndex, array $rows): ?int
    {
        if ($rows === []) {
            return $ordinal;
        }
        $prefix = CanonicalJson::encode(['format' => self::FORMAT, 'ordinal' => $ordinal, 'section' => $section, 'firstIndex' => $firstIndex, 'rowCount' => count($rows)]);
        $body = substr($prefix, 0, -1).',"rows":['.implode(',', $rows).']}';
        if (strlen($body) > self::MAXIMUM_PART_BYTES) {
            return null;
        }
        $this->profiler->measure('snapshot.partPersistence', fn () => $this->database->connection()->table('synloquent_snapshot_parts')->insert(['grant' => $grant, 'ordinal' => $ordinal, 'section' => $section, 'first_index' => $firstIndex, 'row_count' => count($rows), 'hash' => hash('sha256', $body), 'byte_size' => strlen($body), 'body' => $body]));

        return $ordinal + 1;
    }

    /** @return array{grant: stdClass, metadata: array<array-key, mixed>, descriptor: array<array-key, mixed>} */
    public function context(string $generation, string $hash, ActorContext $actor): array
    {
        if (! $this->eligible()) {
            throw new ProtocolException('unsupported_query', 'Bounded snapshot transfer requires the declared capture and projection contract.', ['reason' => 'unsupported-host-contract']);
        }
        $connection = $this->database->connection();
        $fingerprint = $this->manifest->build()['fingerprint'];
        $grant = $connection->table('synloquent_snapshot_grants')->where(['partition' => $actor->partition(), 'generation' => $generation, 'hash' => $hash, 'authorization_generation' => $actor->authorizationGeneration, 'schema_fingerprint' => $fingerprint])->first();
        if ($grant === null) {
            throw new ProtocolException('forbidden_operation', 'Snapshot grant is not valid for this actor, device, epoch and schema.', [], 403);
        }
        $stored = $connection->table('synloquent_snapshots')->where('hash', $hash)->first(['hash', 'byte_size']);
        if ($stored === null || ! hash_equals($grant->metadata_hash, hash('sha256', $grant->metadata))) {
            throw new ProtocolException('invalid_snapshot', 'Stored snapshot metadata is corrupt.');
        }
        $metadata = $this->decode($grant->metadata);
        if (($metadata['hash'] ?? null) !== $hash || ($metadata['generation'] ?? null) !== $generation || ($metadata['byteSize'] ?? null) !== (int) $stored->byte_size || (int) $stored->byte_size > config('synloquent.max_snapshot_bytes', 67108864)) {
            throw new ProtocolException('invalid_snapshot', 'Stored snapshot metadata does not identify its content.');
        }
        $this->validator->validate('snapshot', json_decode(CanonicalJson::encode([...$metadata, 'records' => [], 'relationSets' => []]), flags: JSON_THROW_ON_ERROR));
        $cursor = $this->cursors->decode($metadata['cursor'], $actor, $metadata['dataset'], $fingerprint);
        if ($cursor['sequence'] !== (int) $grant->sequence || $cursor['authorizationGeneration'] !== $actor->authorizationGeneration || $metadata['scope']['authorizationGeneration'] !== $actor->authorizationGeneration || $metadata['scope']['schemaFingerprint'] !== $fingerprint) {
            throw new ProtocolException('invalid_snapshot', 'Stored snapshot cursor or scope is inconsistent.');
        }
        $transfer = $connection->table('synloquent_snapshot_transfers')->where('grant', $grant->grant)->first();
        if ($transfer === null) {
            throw new ProtocolException('invalid_snapshot', 'Snapshot has no prepared bounded transfer.');
        }
        $descriptor = $this->descriptor($transfer, $grant->metadata_hash);
        foreach ($metadata as $name => $value) {
            if (($descriptor[$name] ?? null) !== $value) {
                throw new ProtocolException('invalid_snapshot', 'Snapshot transfer does not identify its grant.');
            }
        }
        if ($descriptor['status'] !== 'ready') {
            throw new ProtocolException('unsupported_query', 'Snapshot requires explicit row admission.', ['reason' => $descriptor['reason']]);
        }

        return ['grant' => $grant, 'metadata' => $metadata, 'descriptor' => $descriptor];
    }

    public function part(string $grant, int $ordinal): stdClass
    {
        $part = $this->database->connection()->table('synloquent_snapshot_parts')->where(['grant' => $grant, 'ordinal' => $ordinal])->first();
        if ($part === null || strlen($part->body) !== (int) $part->byte_size || (int) $part->byte_size > self::MAXIMUM_PART_BYTES || ! hash_equals($part->hash, hash('sha256', $part->body))) {
            throw new ProtocolException('invalid_snapshot', 'Stored snapshot part is missing or corrupt.');
        }

        return $part;
    }

    /**
     * @param  array<array-key, mixed>  $metadata
     * @return array<array-key, mixed>
     */
    public function identity(stdClass $part, array $metadata, string $metadataHash): array
    {
        return ['ordinal' => (int) $part->ordinal, 'downloadUrl' => $metadata['downloadUrl'].'/parts/'.$part->ordinal, 'hash' => $part->hash, 'byteSize' => (int) $part->byte_size, 'continuation' => $this->sign(['version' => 1, 'purpose' => 'snapshot-part', 'grant' => $part->grant, 'metadataHash' => $metadataHash, 'ordinal' => (int) $part->ordinal, 'hash' => $part->hash, 'byteSize' => (int) $part->byte_size])];
    }

    /**
     * @param  array<array-key, mixed>  $metadata
     * @return array<array-key, mixed>
     */
    public function nextIdentity(string $grant, int $ordinal, array $metadata, string $metadataHash): array
    {
        $part = $this->database->connection()->table('synloquent_snapshot_parts')->where(['grant' => $grant, 'ordinal' => $ordinal])->first(['grant', 'ordinal', 'hash', 'byte_size']);
        if ($part === null) {
            throw new ProtocolException('invalid_snapshot', 'Snapshot part index is incomplete.');
        }

        return $this->identity($part, $metadata, $metadataHash);
    }

    public function confirmation(string $grant, string $metadataHash): string
    {
        return $this->sign(['version' => 1, 'purpose' => 'snapshot-confirm', 'grant' => $grant, 'metadataHash' => $metadataHash]);
    }

    /** @return array<array-key, mixed> */
    public function verify(string $token, string $purpose, stdClass $grant): array
    {
        if (strlen($token) > 2048) {
            throw new ProtocolException('forbidden_operation', 'Invalid snapshot continuation.', [], 403);
        }
        $parts = explode('.', $token);
        if (count($parts) !== 2 || ! hash_equals($this->base64(hash_hmac('sha256', 'synloquent.snapshot.parts.v1.'.$parts[0], $this->secret(), true)), $parts[1])) {
            throw new ProtocolException('forbidden_operation', 'Invalid snapshot continuation.', [], 403);
        }
        $decoded = base64_decode(strtr($parts[0], '-_', '+/'), true);
        $value = $decoded === false ? null : json_decode($decoded, true);
        if (! is_array($value) || ($value['version'] ?? null) !== 1 || ($value['purpose'] ?? null) !== $purpose || ($value['grant'] ?? null) !== $grant->grant || ($value['metadataHash'] ?? null) !== $grant->metadata_hash) {
            throw new ProtocolException('forbidden_operation', 'Snapshot continuation scope changed.', [], 403);
        }

        return $value;
    }

    /** @return array<array-key, mixed> */
    private function descriptor(stdClass $transfer, string $metadataHash): array
    {
        if ($transfer->metadata_hash !== $metadataHash || ! hash_equals($transfer->descriptor_hash, hash('sha256', $transfer->descriptor))) {
            throw new ProtocolException('invalid_snapshot', 'Stored snapshot transfer metadata is corrupt.');
        }
        $descriptor = $this->decode($transfer->descriptor);
        if (($descriptor['format'] ?? null) !== self::FORMAT || ! in_array($descriptor['status'] ?? null, ['ready', 'admission-required'], true) || ($descriptor['maximumPartBytes'] ?? null) !== self::MAXIMUM_PART_BYTES || ($descriptor['partRowLimit'] ?? null) !== self::MAXIMUM_ROWS) {
            throw new ProtocolException('invalid_snapshot', 'Snapshot transfer descriptor is invalid.');
        }
        foreach (['partCount', 'recordCount', 'relationSetCount', 'maximumRowBytes'] as $name) {
            if (! is_int($descriptor[$name] ?? null) || $descriptor[$name] < 0) {
                throw new ProtocolException('invalid_snapshot', 'Snapshot transfer count is invalid.');
            }
        }
        if ($descriptor['partCount'] > $descriptor['recordCount'] + $descriptor['relationSetCount'] || ($descriptor['status'] === 'admission-required' && ! in_array($descriptor['reason'] ?? null, ['unsupported-host-contract', 'row-exceeds-part-budget'], true))) {
            throw new ProtocolException('invalid_snapshot', 'Snapshot transfer completeness is invalid.');
        }

        return $descriptor;
    }

    /** @return array<array-key, mixed> */
    private function decode(string $content): array
    {
        try {
            $value = json_decode($content, true, flags: JSON_THROW_ON_ERROR);
        } catch (JsonException) {
            throw new ProtocolException('invalid_snapshot', 'Stored snapshot metadata is not valid JSON.');
        }
        if (! is_array($value)) {
            throw new ProtocolException('invalid_snapshot', 'Stored snapshot metadata is not an object.');
        }

        return $value;
    }

    /**
     * @param  array<array-key, mixed>  $base
     * @return array<array-key, mixed>
     */
    private function render(array $base, string $grant, string $metadataHash): array
    {
        if ($base['status'] !== 'ready') {
            return $base;
        }
        if ($base['partCount'] === 0) {
            return [...$base, 'confirmationToken' => $this->confirmation($grant, $metadataHash)];
        }

        return [...$base, 'firstPart' => $this->identity($this->part($grant, 0), $base, $metadataHash)];
    }

    /** @param array<array-key, mixed> $payload */
    private function sign(array $payload): string
    {
        $body = $this->base64(CanonicalJson::encode($payload));

        return $body.'.'.$this->base64(hash_hmac('sha256', 'synloquent.snapshot.parts.v1.'.$body, $this->secret(), true));
    }

    private function secret(): string
    {
        $secret = config('synloquent.cursor_secret');
        if (! is_string($secret) || strlen($secret) < 16) {
            throw new ProtocolException('schema_mismatch', 'Configure a stable cursor signing secret.');
        }

        return $secret;
    }

    private function base64(string $value): string
    {
        return rtrim(strtr(base64_encode($value), '+/', '-_'), '=');
    }
}

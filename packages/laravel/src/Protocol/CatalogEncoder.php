<?php

declare(strict_types=1);

namespace Synloquent\Laravel\Protocol;

use Generator;
use Synloquent\Laravel\Sync\StageProfiler;

final class CatalogEncoder
{
    /** @var resource */
    private $stream;

    private int $size = 0;

    private bool $complete = false;

    private mixed $digest;

    /** @var array<string, int> */
    private array $counts = ['records' => 0, 'relationSets' => 0];

    /**
     * @param  iterable<array<array-key, mixed>>  $records
     * @param  iterable<array<array-key, mixed>>  $relations
     */
    public function __construct(private iterable $records, private iterable $relations, private StageProfiler $profiler, private ?ProtocolValidator $validator = null)
    {
        $stream = fopen('php://temp/maxmemory:1048576', 'w+b');
        if ($stream === false) {
            throw new ProtocolException('invalid_snapshot', 'Cannot create bounded catalog buffer.');
        }
        $this->stream = $stream;
        $this->digest = hash_init('sha256');
    }

    /** @return Generator<int, array<array-key, mixed>, mixed, void> */
    public function membership(): Generator
    {
        $encodingSeconds = 0.0;
        $hashSeconds = 0.0;
        $this->write('{"records":[');
        foreach ([$this->records, $this->relations] as $section => $rows) {
            if ($section === 1) {
                $this->write('],"relationSets":[');
            }
            $position = 0;
            $validation = [];
            $sectionName = $section === 0 ? 'records' : 'relationSets';
            foreach ($rows as $row) {
                $started = hrtime(true);
                $encoded = CanonicalJson::encode($row);
                $this->write(($position === 0 ? '' : ',').$encoded);
                $encodingSeconds += (hrtime(true) - $started) / 1e9;
                $position++;
                $this->counts[$sectionName]++;
                if ($this->validator !== null) {
                    $validation[] = $encoded;
                    if (count($validation) === 1000) {
                        $this->profiler->measure('snapshot.schemaValidation', fn () => $this->validator->validateCatalogChunk($sectionName, '['.implode(',', $validation).']', $position));
                        $validation = [];
                    }
                }
                $started = hrtime(true);
                $hash = hash('sha256', $encoded);
                $hashSeconds += (hrtime(true) - $started) / 1e9;
                yield ['model' => $row['model'], 'id' => $row['id'] ?? $row['parentId'], ...($section === 1 ? ['relation' => $row['relation'], 'revision' => $row['revision']] : []), 'hash' => $hash];
            }
            if ($validation !== []) {
                $this->profiler->measure('snapshot.schemaValidation', fn () => $this->validator->validateCatalogChunk($sectionName, '['.implode(',', $validation).']', $position));
            }
        }
        $this->write(']}');
        $this->complete = true;
        $this->profiler->record('snapshot.catalogEncoding', $encodingSeconds, array_sum($this->counts));
        $this->profiler->record('snapshot.membershipHash', $hashSeconds, array_sum($this->counts));
    }

    public function size(): int
    {
        return $this->size;
    }

    public function hash(): string
    {
        if (! $this->complete) {
            throw new ProtocolException('invalid_snapshot', 'Catalog is incomplete.');
        }

        return hash_final(hash_copy($this->digest));
    }

    /** @return array<string, int> */
    public function counts(): array
    {
        return $this->counts;
    }

    public function send(bool $omitOpeningBrace = false): void
    {
        $this->copy(static function (string $chunk): void {
            echo $chunk;
        }, $omitOpeningBrace);
    }

    /** @param callable(string): void $consumer */
    public function copy(callable $consumer, bool $omitOpeningBrace = false): void
    {
        if (! $this->complete) {
            throw new ProtocolException('invalid_snapshot', 'Catalog is incomplete.');
        }
        rewind($this->stream);
        if ($omitOpeningBrace) {
            fseek($this->stream, 1);
        }
        while (! feof($this->stream)) {
            $chunk = fread($this->stream, 65536);
            if ($chunk === false) {
                throw new ProtocolException('invalid_snapshot', 'Catalog read failed.');
            }
            $consumer($chunk);
        }
    }

    public function bytes(): string
    {
        if (! $this->complete) {
            throw new ProtocolException('invalid_snapshot', 'Catalog membership was not completely consumed.');
        }

        return $this->profiler->measure('snapshot.catalogReadback', function (): string {
            rewind($this->stream);
            $bytes = stream_get_contents($this->stream);
            if ($bytes === false) {
                throw new ProtocolException('invalid_snapshot', 'Cannot read encoded catalog.');
            }

            return $bytes;
        });
    }

    private function write(string $bytes): void
    {
        $this->size += strlen($bytes);
        if ($this->size > config('synloquent.max_snapshot_bytes', 67108864)) {
            throw new ProtocolException('validation_failed', 'Snapshot byte limit exceeded.');
        }
        if (fwrite($this->stream, $bytes) !== strlen($bytes)) {
            throw new ProtocolException('invalid_snapshot', 'Catalog buffer write was incomplete.');
        }
        hash_update($this->digest, $bytes);
    }

    public function __destruct()
    {
        fclose($this->stream);
    }
}

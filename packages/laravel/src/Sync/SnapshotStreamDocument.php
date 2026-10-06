<?php

declare(strict_types=1);

namespace Synloquent\Laravel\Sync;

use Synloquent\Laravel\Protocol\CatalogEncoder;

final readonly class SnapshotStreamDocument
{
    /** @param array<array-key, mixed> $metadata */
    public function __construct(public array $metadata, public CatalogEncoder|string $content) {}

    public function sendCatalog(bool $omitOpeningBrace = false): void
    {
        $this->copy(static function (string $chunk): void {
            echo $chunk;
        }, $omitOpeningBrace);
    }

    /** @param callable(string): void $consumer */
    public function copy(callable $consumer, bool $omitOpeningBrace = false): void
    {
        if ($this->content instanceof CatalogEncoder) {
            $this->content->copy($consumer, $omitOpeningBrace);

            return;
        }
        for ($offset = $omitOpeningBrace ? 1 : 0, $length = strlen($this->content); $offset < $length; $offset += 65536) {
            $consumer(substr($this->content, $offset, 65536));
        }
    }
}

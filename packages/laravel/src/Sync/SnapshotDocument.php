<?php

declare(strict_types=1);

namespace Synloquent\Laravel\Sync;

final readonly class SnapshotDocument
{
    /** @param array<array-key, mixed> $document */
    public function __construct(public array $document, public string $content) {}
}

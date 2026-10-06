<?php

declare(strict_types=1);

namespace Synloquent\Laravel\Sync;

final readonly class SnapshotPartDocument
{
    /**
     * @param  array<array-key, mixed>|null  $nextPart
     * @param  list<array<array-key, mixed>>  $partIndex
     */
    public function __construct(public string $body, public ?array $nextPart, public ?string $confirmationToken, public array $partIndex = []) {}
}

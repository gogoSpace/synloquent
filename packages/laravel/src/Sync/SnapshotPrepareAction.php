<?php

declare(strict_types=1);

namespace Synloquent\Laravel\Sync;

final class SnapshotPrepareAction
{
    public function __construct(private SnapshotAction $snapshots, private SnapshotPartStore $parts) {}

    /** @return array<array-key, mixed> */
    public function execute(string $dataset, ActorContext $actor): array
    {
        $descriptor = [];
        $this->snapshots->stream($dataset, $actor, function (array $metadata, string $content, array $counts) use ($actor, &$descriptor): void {
            $descriptor = $this->parts->prepare($metadata, $content, $counts, $actor);
        });

        return $descriptor;
    }
}

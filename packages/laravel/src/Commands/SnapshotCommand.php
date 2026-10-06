<?php

declare(strict_types=1);

namespace Synloquent\Laravel\Commands;

use Illuminate\Console\Command;
use Illuminate\Http\Request;
use Synloquent\Laravel\Contracts\ActorResolver;
use Synloquent\Laravel\Protocol\CanonicalJson;
use Synloquent\Laravel\Sync\SnapshotAction;

final class SnapshotCommand extends Command
{
    protected $signature = 'synloquent:snapshot {--dataset=catalog} {--actor=} {--output=}';

    protected $description = 'Materialize an immutable authorized snapshot';

    public function handle(SnapshotAction $snapshots, ActorResolver $actors): int
    {
        $request = Request::create('/');
        $request->headers->set('X-Synloquent-Actor', (string) $this->option('actor'));
        $document = $snapshots->stream((string) $this->option('dataset'), $actors->resolve($request));
        $path = $this->option('output');
        $stream = fopen($path ?: 'php://stdout', 'wb');
        if ($stream === false) {
            throw new \RuntimeException('Cannot open snapshot output.');
        }
        $writer = static function (string $chunk) use ($stream): void {
            if (fwrite($stream, $chunk) !== strlen($chunk)) {
                throw new \RuntimeException('Snapshot output was incomplete.');
            }
        };
        try {
            $writer(substr(CanonicalJson::encode($document->metadata), 0, -1).',');
            $document->copy($writer, true);
        } finally {
            fclose($stream);
        }

        return self::SUCCESS;
    }
}

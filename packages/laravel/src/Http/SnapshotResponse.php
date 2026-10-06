<?php

declare(strict_types=1);

namespace Synloquent\Laravel\Http;

use Symfony\Component\HttpFoundation\StreamedResponse;
use Synloquent\Laravel\Protocol\CanonicalJson;
use Synloquent\Laravel\Sync\SnapshotStreamDocument;

final class SnapshotResponse
{
    /** @param array<array-key, mixed>|null $envelope */
    public function make(SnapshotStreamDocument $document, ?array $envelope = null): StreamedResponse
    {
        $metadata = substr(CanonicalJson::encode($document->metadata), 0, -1);
        $header = $envelope === null ? null : substr(CanonicalJson::encode($envelope), 0, -1).',"payload":';

        return response()->stream(static function () use ($document, $metadata, $header): void {
            if ($header !== null) {
                echo $header;
            }
            echo $metadata.',';
            $document->sendCatalog(true);
            if ($header !== null) {
                echo '}';
            }
        }, 200, ['Content-Type' => 'application/json', 'Cache-Control' => 'private, no-store']);
    }
}

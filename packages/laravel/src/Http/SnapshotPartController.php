<?php

declare(strict_types=1);

namespace Synloquent\Laravel\Http;

use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Synloquent\Laravel\Contracts\ActorResolver;
use Synloquent\Laravel\Protocol\CanonicalJson;
use Synloquent\Laravel\Protocol\ProtocolException;
use Synloquent\Laravel\Sync\SnapshotPartDocument;
use Synloquent\Laravel\Sync\SnapshotPartDownloadAction;

final class SnapshotPartController
{
    public function __construct(private ActorResolver $actors, private SnapshotPartDownloadAction $parts) {}

    public function part(Request $request, string $generation, string $hash, string $ordinal): Response|JsonResponse
    {
        return $this->read($request, $generation, $hash, $ordinal, false);
    }

    public function bundle(Request $request, string $generation, string $hash, string $ordinal): Response|JsonResponse
    {
        return $this->read($request, $generation, $hash, $ordinal, true);
    }

    public function confirm(Request $request, string $generation, string $hash): JsonResponse
    {
        try {
            $token = $request->input('confirmationToken');
            if (! is_string($token) || strlen($token) > 2048 || array_keys($request->all()) !== ['confirmationToken']) {
                throw new ProtocolException('validation_failed', 'Confirmation requires one bounded token.');
            }

            return response()->json($this->parts->confirm($generation, $hash, $token, $this->actors->resolve($request)), 200, ['Cache-Control' => 'private, no-store']);
        } catch (ProtocolException $exception) {
            return response()->json(['error' => $exception->payload()], $exception->status);
        }
    }

    private function read(Request $request, string $generation, string $hash, string $ordinal, bool $bundle): Response|JsonResponse
    {
        try {
            $token = $request->header('X-Synloquent-Continuation');
            if (! ctype_digit($ordinal) || strlen($ordinal) > 6 || ! is_string($token) || strlen($token) > 2048) {
                throw new ProtocolException('validation_failed', 'Snapshot part requires a bounded ordinal and continuation.');
            }
            $actor = $this->actors->resolve($request);
            $document = $bundle ? $this->parts->bundle($generation, $hash, (int) $ordinal, $token, $actor) : $this->parts->execute($generation, $hash, (int) $ordinal, $token, $actor);

            return response($document->body, 200, $this->headers($document, $bundle));
        } catch (ProtocolException $exception) {
            return response()->json(['error' => $exception->payload()], $exception->status);
        }
    }

    /** @return array<string, string> */
    private function headers(SnapshotPartDocument $document, bool $bundle): array
    {
        $headers = ['Content-Type' => $bundle ? 'application/x-ndjson' : 'application/json', 'Cache-Control' => 'private, no-store'];
        if ($document->nextPart !== null) {
            $headers['X-Synloquent-Next-Part'] = CanonicalJson::encode($document->nextPart);
        }
        if ($document->confirmationToken !== null) {
            $headers['X-Synloquent-Confirmation-Token'] = $document->confirmationToken;
        }
        if ($bundle) {
            $headers['X-Synloquent-Part-Index'] = CanonicalJson::encode($document->partIndex);
        }

        return $headers;
    }
}

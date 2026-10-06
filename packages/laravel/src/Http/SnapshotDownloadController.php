<?php

declare(strict_types=1);

namespace Synloquent\Laravel\Http;

use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\StreamedResponse;
use Synloquent\Laravel\Contracts\ActorResolver;
use Synloquent\Laravel\Protocol\ProtocolException;
use Synloquent\Laravel\Sync\SnapshotDownloadAction;
use Synloquent\Laravel\Sync\StageProfiler;

final class SnapshotDownloadController
{
    public function __construct(private ActorResolver $actors, private SnapshotDownloadAction $download, private SnapshotResponse $responses, private StageProfiler $profiler) {}

    public function __invoke(Request $request, string $generation, string $hash): JsonResponse|StreamedResponse
    {
        try {
            if (config('synloquent.profile_snapshots', false)) {
                $this->profiler->collect();
            }
            $started = hrtime(true);
            $response = $this->responses->make($this->download->stream($generation, $hash, $this->actors->resolve($request)));
            $response->headers->set('Server-Timing', 'snapshot-download;dur='.number_format((hrtime(true) - $started) / 1e6, 3, '.', ''));
            if (config('synloquent.profile_snapshots', false)) {
                $response->headers->set('X-Synloquent-Profile', json_encode($this->profiler->report($started), JSON_THROW_ON_ERROR));
            }

            return $response;
        } catch (ProtocolException $exception) {
            return response()->json(['error' => $exception->payload()], $exception->status);
        } finally {
            $this->profiler->observe(null);
        }
    }
}

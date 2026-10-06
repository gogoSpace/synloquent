<?php

declare(strict_types=1);

namespace Synloquent\Laravel\Http;

use Illuminate\Http\JsonResponse;
use Symfony\Component\HttpFoundation\StreamedResponse;
use Synloquent\Laravel\Contracts\ActorResolver;
use Synloquent\Laravel\Export\ManifestBuilder;
use Synloquent\Laravel\Protocol\CanonicalJson;
use Synloquent\Laravel\Protocol\ProtocolException;
use Synloquent\Laravel\Protocol\ProtocolValidator;
use Synloquent\Laravel\Protocol\WirePayload;
use Synloquent\Laravel\Query\QueryAction;
use Synloquent\Laravel\Sync\CommandAction;
use Synloquent\Laravel\Sync\MutationAction;
use Synloquent\Laravel\Sync\PullAction;
use Synloquent\Laravel\Sync\SnapshotAction;
use Synloquent\Laravel\Sync\SnapshotPrepareAction;
use Synloquent\Laravel\Sync\StageProfiler;

final class ProtocolController
{
    public function __construct(private ActorResolver $actors, private ManifestBuilder $manifest, private QueryAction $query, private MutationAction $mutations, private PullAction $pull, private SnapshotAction $snapshots, private CommandAction $commands, private ProtocolValidator $validator, private SnapshotResponse $snapshotResponse, private StageProfiler $profiler, private SnapshotPrepareAction $snapshotParts) {}

    public function __invoke(ProtocolRequest $request): JsonResponse|StreamedResponse
    {
        $envelope = $request->validated();
        try {
            $actor = $this->actors->resolve($request);
            if ($envelope['session']['accountId'] !== $actor->actorId || $envelope['session']['tenantId'] !== $actor->tenantId || $envelope['session']['deviceId'] !== $actor->deviceId || $envelope['session']['deviceEpoch'] !== $actor->deviceEpoch) {
                throw new ProtocolException('forbidden_operation', 'Authenticated actor does not match the session.', [], 403);
            }
            $manifest = $this->manifest->build();
            if ($envelope['kind'] !== 'manifest' && $envelope['schemaFingerprint'] !== $manifest['fingerprint']) {
                throw new ProtocolException('upgrade_required', 'Installed schema is incompatible.', ['schemaFingerprint' => $manifest['fingerprint']], 409);
            }
            $raw = json_decode($request->getContent(), flags: JSON_THROW_ON_ERROR);
            $payload = WirePayload::restore($envelope['kind'], $envelope['payload'], $raw->payload, $manifest['models']);
            if ($envelope['kind'] === 'snapshot') {
                if (config('synloquent.profile_snapshots', false)) {
                    $this->profiler->collect();
                }
                try {
                    $started = hrtime(true);
                    if (($payload['delivery'] ?? null) === 'parts-v1') {
                        $result = $this->snapshotParts->execute($payload['dataset'], $actor);
                        $wireResult = json_decode(CanonicalJson::encode($result), flags: JSON_THROW_ON_ERROR);
                        $this->validator->validate('snapshot-parts', $wireResult);
                        $response = response()->json(['protocolVersion' => 1, 'requestId' => $envelope['requestId'], 'kind' => 'snapshot', 'schemaFingerprint' => $manifest['fingerprint'], 'session' => $envelope['session'], 'payload' => $wireResult]);
                    } else {
                        $document = $this->snapshots->stream($payload['dataset'] ?? 'catalog', $actor);
                        $response = $this->snapshotResponse->make($document, ['protocolVersion' => 1, 'requestId' => $envelope['requestId'], 'kind' => 'snapshot', 'schemaFingerprint' => $manifest['fingerprint'], 'session' => $envelope['session']]);
                    }
                    $response->headers->set('Server-Timing', 'snapshot;dur='.number_format((hrtime(true) - $started) / 1e6, 3, '.', ''));
                    if (config('synloquent.profile_snapshots', false)) {
                        $response->headers->set('X-Synloquent-Profile', json_encode($this->profiler->report($started), JSON_THROW_ON_ERROR));
                    }

                    return $response;
                } finally {
                    $this->profiler->observe(null);
                }
            }
            $result = match ($envelope['kind']) {
                'manifest' => $manifest,
                'query' => $this->query->execute($payload, $actor),
                'push' => $this->mutations->execute($payload['operations'] ?? [], $actor),
                'pull' => $this->pull->execute($payload['cursor'] ?? null, $payload['dataset'] ?? 'catalog', $actor),
                'command' => $this->commands->execute($payload, $actor),
                default => throw new ProtocolException('unsupported_query', 'Unknown protocol operation.'),
            };

            $wireResult = json_decode(CanonicalJson::encode($result), flags: JSON_THROW_ON_ERROR);
            if (in_array($envelope['kind'], ['manifest', 'query', 'pull', 'snapshot'], true)) {
                $this->validator->validate($envelope['kind'] === 'query' ? 'query-response' : $envelope['kind'], $wireResult);
            }
            if ($envelope['kind'] === 'push') {
                foreach ($wireResult->receipts as $receipt) {
                    $this->validator->validate('receipt', $receipt);
                }
            }

            return response()->json(['protocolVersion' => 1, 'requestId' => $envelope['requestId'], 'kind' => $envelope['kind'], 'schemaFingerprint' => $manifest['fingerprint'], 'session' => $envelope['session'], 'payload' => $wireResult]);
        } catch (ProtocolException $exception) {
            return response()->json(['error' => $exception->payload()], $exception->status);
        }
    }
}

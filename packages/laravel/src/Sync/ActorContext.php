<?php

declare(strict_types=1);

namespace Synloquent\Laravel\Sync;

use Illuminate\Contracts\Auth\Authenticatable;
use Synloquent\Laravel\Protocol\CanonicalJson;

final readonly class ActorContext
{
    public function __construct(public string $actorId, public string $tenantId, public string $deviceEpoch, public string $authorizationGeneration, public ?Authenticatable $user = null, public string $deviceId = 'default') {}

    public function stream(): string
    {
        return hash('sha256', $this->tenantId);
    }

    public function partition(): string
    {
        return CanonicalJson::hash([$this->tenantId, $this->actorId, $this->deviceId, $this->deviceEpoch]);
    }
}

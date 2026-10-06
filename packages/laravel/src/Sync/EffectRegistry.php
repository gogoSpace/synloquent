<?php

declare(strict_types=1);

namespace Synloquent\Laravel\Sync;

use Synloquent\Laravel\Contracts\EffectDestination;
use Synloquent\Laravel\Protocol\ProtocolException;

final class EffectRegistry
{
    /** @var array<string, EffectDestination> */
    private array $destinations = [];

    public function register(EffectDestination $destination): void
    {
        if (! in_array($destination->deliveryContract(), ['idempotent', 'at_least_once'], true)) {
            throw new ProtocolException('validation_failed', 'Effect destination must declare its delivery contract.');
        }
        $this->destinations[$destination->name()] = $destination;
    }

    public function get(string $name): EffectDestination
    {
        return $this->destinations[$name] ?? throw new ProtocolException('forbidden_operation', 'Effect destination is not registered.');
    }
}

<?php

declare(strict_types=1);

namespace Synloquent\Laravel\Contracts;

interface EffectDestination
{
    public function name(): string;

    public function deliveryContract(): string;

    /** @param array<string, mixed> $payload */
    public function deliver(string $idempotencyKey, array $payload): void;
}

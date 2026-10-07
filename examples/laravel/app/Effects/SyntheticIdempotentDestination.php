<?php

declare(strict_types=1);

namespace App\Effects;

use Illuminate\Support\Facades\DB;
use Synloquent\Laravel\Contracts\EffectDestination;

class SyntheticIdempotentDestination implements EffectDestination
{
    public function name(): string
    {
        return 'quantityChanged';
    }

    public function deliveryContract(): string
    {
        return 'idempotent';
    }

    public function deliver(string $idempotencyKey, array $payload): void
    {
        $connectionName = 'synthetic_effect_'.bin2hex(random_bytes(8));
        $connection = DB::connectUsing($connectionName, DB::connection(config('synloquent.connection'))->getConfig());
        try {
            $connection->transaction(function () use ($connection, $idempotencyKey, $payload): void {
                $connection->table('synthetic_effect_attempts')->insert(['destination' => $this->name(), 'idempotency_key' => $idempotencyKey]);
                $connection->table('synthetic_effect_deliveries')->insertOrIgnore(['destination' => $this->name(), 'idempotency_key' => $idempotencyKey, 'payload' => json_encode($payload, JSON_THROW_ON_ERROR)]);
            });
        } finally {
            DB::purge($connectionName);
        }
    }
}

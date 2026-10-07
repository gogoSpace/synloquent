<?php

declare(strict_types=1);

namespace App\Effects;

use Illuminate\Support\Facades\DB;

final class SyntheticAtLeastOnceDestination extends SyntheticIdempotentDestination
{
    public function name(): string
    {
        return 'nonIdempotentControl';
    }

    public function deliveryContract(): string
    {
        return 'at_least_once';
    }

    public function deliver(string $idempotencyKey, array $payload): void
    {
        $connectionName = 'synthetic_effect_'.bin2hex(random_bytes(8));
        $connection = DB::connectUsing($connectionName, DB::connection(config('synloquent.connection'))->getConfig());
        try {
            $connection->transaction(function () use ($connection, $idempotencyKey, $payload): void {
                $connection->table('synthetic_effect_attempts')->insert(['destination' => $this->name(), 'idempotency_key' => $idempotencyKey]);
                $connection->table('synthetic_effect_non_idempotent_deliveries')->insert(['destination' => $this->name(), 'payload' => json_encode($payload, JSON_THROW_ON_ERROR)]);
            });
        } finally {
            DB::purge($connectionName);
        }
    }
}

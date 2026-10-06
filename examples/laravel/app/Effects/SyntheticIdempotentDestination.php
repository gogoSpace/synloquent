<?php

declare(strict_types=1);

namespace App\Effects;

use PDO;
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
        $configuration = config('database.connections.pgsql');
        $connection = new PDO('pgsql:host='.$configuration['host'].';port='.$configuration['port'].';dbname='.$configuration['database'], $configuration['username'], $configuration['password'], [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
        $connection->beginTransaction();
        try {
            $attempt = $connection->prepare('INSERT INTO synthetic_effect_attempts (destination, idempotency_key) VALUES (?, ?)');
            $attempt->execute([$this->name(), $idempotencyKey]);
            $receipt = $connection->prepare('INSERT INTO synthetic_effect_deliveries (destination, idempotency_key, payload) VALUES (?, ?, ?) ON CONFLICT (destination, idempotency_key) DO NOTHING');
            $receipt->execute([$this->name(), $idempotencyKey, json_encode($payload, JSON_THROW_ON_ERROR)]);
            $connection->commit();
        } catch (\Throwable $exception) {
            $connection->rollBack();
            throw $exception;
        }
    }
}

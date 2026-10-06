<?php

declare(strict_types=1);

namespace App\Effects;

use PDO;

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
        $configuration = config('database.connections.pgsql');
        $connection = new PDO('pgsql:host='.$configuration['host'].';port='.$configuration['port'].';dbname='.$configuration['database'], $configuration['username'], $configuration['password'], [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
        $attempt = $connection->prepare('INSERT INTO synthetic_effect_attempts (destination, idempotency_key) VALUES (?, ?)');
        $attempt->execute([$this->name(), $idempotencyKey]);
        $delivery = $connection->prepare('INSERT INTO synthetic_effect_non_idempotent_deliveries (destination, payload) VALUES (?, ?)');
        $delivery->execute([$this->name(), json_encode($payload, JSON_THROW_ON_ERROR)]);
    }
}

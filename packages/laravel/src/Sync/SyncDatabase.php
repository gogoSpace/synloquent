<?php

declare(strict_types=1);

namespace Synloquent\Laravel\Sync;

use Illuminate\Contracts\Config\Repository;
use Illuminate\Database\Connection;
use Illuminate\Database\DatabaseManager;

final class SyncDatabase
{
    public function __construct(private DatabaseManager $databases, private Repository $configuration) {}

    public function connection(): Connection
    {
        return $this->databases->connection($this->configuration->get('synloquent.connection'));
    }
}

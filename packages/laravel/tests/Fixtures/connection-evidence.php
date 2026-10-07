<?php

declare(strict_types=1);

use Synloquent\Laravel\SynloquentServiceProvider;

return static function ($application): array {
    $connection = $application['db']->connection();
    $evidence = ['driver' => $connection->getDriverName(), 'database' => $connection->getDatabaseName(), 'serverVersion' => $connection->selectOne('SELECT VERSION() AS version')->version, 'backend' => $connection->selectOne($connection->getDriverName() === 'pgsql' ? 'SELECT pg_backend_pid() AS identity' : 'SELECT CONNECTION_ID() AS identity')->identity, 'providerSha256' => hash_file('sha256', (new ReflectionClass(SynloquentServiceProvider::class))->getFileName()), 'process' => getmypid()];
    if ($path = getenv('SYNLOQUENT_TEST_CONNECTION_EVIDENCE')) {
        file_put_contents($path, json_encode($evidence, JSON_THROW_ON_ERROR)."\n", FILE_APPEND | LOCK_EX);
    }

    return $evidence;
};

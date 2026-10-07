<?php

declare(strict_types=1);

return static function ($application): void {
    $configuration = getenv('SYNLOQUENT_TEST_CONNECTION');
    if ($configuration !== false) {
        $connection = json_decode($configuration, true, flags: JSON_THROW_ON_ERROR);
    } else {
        $connection = ['driver' => getenv('SYNLOQUENT_TEST_DRIVER') ?: 'pgsql', 'host' => '127.0.0.1', 'port' => getenv('SYNLOQUENT_TEST_PORT') ?: 55432, 'database' => getenv('SYNLOQUENT_TEST_DATABASE') ?: 'synloquent_test', 'username' => getenv('SYNLOQUENT_TEST_USERNAME') ?: 'synloquent', 'password' => '', 'prefix' => '', 'search_path' => 'public', 'sslmode' => 'prefer'];
        $connection += $connection['driver'] === 'pgsql' ? ['charset' => 'utf8', 'timezone' => 'UTC'] : ['charset' => 'utf8mb4', 'collation' => 'utf8mb4_unicode_ci', 'timezone' => '+00:00', 'strict' => true, 'engine' => 'InnoDB'];
    }
    if (! str_starts_with($connection['database'], 'synloquent_') || ! in_array($connection['host'], ['127.0.0.1', 'localhost'], true)) {
        throw new RuntimeException('Tests require an explicitly isolated local Synloquent database.');
    }
    $application['config']->set('database.default', 'synloquent_testing');
    $application['config']->set('database.connections.synloquent_testing', $connection);
    $application['config']->set('synloquent.connection', 'synloquent_testing');
};

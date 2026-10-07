<?php

return [
    'default' => env('DB_CONNECTION', 'pgsql'),
    'connections' => [
        'pgsql' => ['driver' => 'pgsql', 'host' => env('DB_HOST', '127.0.0.1'), 'port' => env('DB_PORT', '55432'), 'database' => env('DB_DATABASE', 'synloquent_example'), 'username' => env('DB_USERNAME', 'synloquent'), 'password' => env('DB_PASSWORD', ''), 'charset' => 'utf8', 'prefix' => '', 'search_path' => 'public', 'sslmode' => 'prefer', 'timezone' => 'UTC'],
        'mysql' => ['driver' => 'mysql', 'host' => env('DB_HOST', '127.0.0.1'), 'port' => env('DB_PORT', '3306'), 'database' => env('DB_DATABASE', 'synloquent_example'), 'username' => env('DB_USERNAME', 'synloquent'), 'password' => env('DB_PASSWORD', ''), 'charset' => 'utf8mb4', 'collation' => 'utf8mb4_unicode_ci', 'prefix' => '', 'timezone' => '+00:00', 'strict' => true, 'engine' => 'InnoDB'],
        'mariadb' => ['driver' => 'mariadb', 'host' => env('DB_HOST', '127.0.0.1'), 'port' => env('DB_PORT', '3306'), 'database' => env('DB_DATABASE', 'synloquent_example'), 'username' => env('DB_USERNAME', 'synloquent'), 'password' => env('DB_PASSWORD', ''), 'charset' => 'utf8mb4', 'collation' => 'utf8mb4_unicode_ci', 'prefix' => '', 'timezone' => '+00:00', 'strict' => true, 'engine' => 'InnoDB'],
    ],
    'migrations' => ['table' => 'migrations', 'update_date_on_publish' => true],
];

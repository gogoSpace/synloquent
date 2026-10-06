<?php

return ['default' => 'pgsql', 'connections' => ['pgsql' => ['driver' => 'pgsql', 'host' => env('DB_HOST', '127.0.0.1'), 'port' => env('DB_PORT', '55432'), 'database' => env('DB_DATABASE', 'synloquent_example'), 'username' => env('DB_USERNAME', 'synloquent'), 'password' => env('DB_PASSWORD', ''), 'charset' => 'utf8', 'prefix' => '', 'search_path' => 'public', 'sslmode' => 'prefer', 'timezone' => 'UTC']], 'migrations' => ['table' => 'migrations', 'update_date_on_publish' => true]];

<?php

declare(strict_types=1);

$repository = dirname(__DIR__);
$example = $repository.'/examples/laravel';
foreach (['bootstrap/cache', 'storage/logs', 'storage/framework/cache', 'storage/framework/sessions', 'storage/framework/views'] as $directory) {
    $path = $example.'/'.$directory;
    if (! is_dir($path) && ! mkdir($path, 0755, true) && ! is_dir($path)) {
        throw new RuntimeException('Cannot create '.$path);
    }
}
$environmentPath = $example.'/.env';
if (file_exists($environmentPath)) {
    fwrite(STDOUT, "Existing example configuration preserved.\n");
    exit(0);
}
$environment = file_get_contents($example.'/.env.example');
$environment = str_replace("APP_KEY=\n", 'APP_KEY=base64:'.base64_encode(random_bytes(32))."\n", $environment);
$environment = str_replace("SYNLOQUENT_CURSOR_SECRET=\n", 'SYNLOQUENT_CURSOR_SECRET='.bin2hex(random_bytes(32))."\n", $environment);
$handle = fopen($environmentPath, 'x');
if ($handle === false) {
    throw new RuntimeException('Cannot create fresh example configuration.');
}
chmod($environmentPath, 0600);
fwrite($handle, $environment);
fclose($handle);
fwrite(STDOUT, "Created examples/laravel/.env. Set the credentials for your dedicated example database.\n");

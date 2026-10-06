<?php

declare(strict_types=1);

use Illuminate\Contracts\Console\Kernel;
use Illuminate\Database\Events\QueryExecuted;
use Illuminate\Http\Request;
use Synloquent\Laravel\Protocol\ProtocolException;
use Synloquent\Laravel\Sync\StageProfiler;

$repository = dirname(__DIR__, 4);
$cleanupBootstrapCaches = require __DIR__.'/isolated-bootstrap-cache.php';
require getenv('SYNLOQUENT_TEST_AUTOLOAD') ?: $repository.'/examples/laravel/vendor/autoload.php';
$application = require $repository.'/examples/laravel/bootstrap/app.php';
$application->make(Kernel::class)->bootstrap();
$cleanupBootstrapCaches();
$application['config']->set('database.connections.pgsql.database', getenv('SYNLOQUENT_TEST_DATABASE') ?: 'synloquent_test');
$application['config']->set('synloquent.cursor_secret', 'synthetic-tests-stable-cursor-secret');
$application['config']->set('synloquent.profile_snapshots', false);
$directory = getenv('SYNLOQUENT_TEST_ARTIFACTS');
if (! is_string($directory) || ! is_dir($directory)) {
    throw new RuntimeException('The HTTP fixture requires its owned artifact directory.');
}
$request = Request::capture();
file_put_contents($directory.'/request', json_encode(['barrier' => $request->header('X-Synloquent-Test-Barrier'), 'failure' => $request->header('X-Synloquent-Test-Failure')], JSON_THROW_ON_ERROR));
if ($request->header('X-Synloquent-Test-Barrier') === 'writer') {
    $held = false;
    $application['events']->listen(QueryExecuted::class, static function (QueryExecuted $query) use (&$held, $directory): void {
        if (str_contains($query->sql, 'synloquent_streams')) {
            file_put_contents($directory.'/queries', $query->sql."\n", FILE_APPEND);
        }
        if ($held || ! str_contains($query->sql, 'synloquent_streams') || ! str_contains($query->sql, 'for update')) {
            return;
        }
        $held = true;
        file_put_contents($directory.'/locked', 'writer');
        $deadline = microtime(true) + 10;
        while (! is_file($directory.'/release')) {
            if (microtime(true) > $deadline) {
                throw new RuntimeException('The HTTP writer barrier was not released.');
            }
            usleep(1000);
        }
    });
}
$failure = $request->header('X-Synloquent-Test-Failure');
if (in_array($failure, ['catalog', 'membership', 'persistence'], true)) {
    $validationCount = 0;
    $application->make(StageProfiler::class)->observe(static function (string $stage, array $measurement) use ($failure, &$validationCount): void {
        if ($stage === 'snapshot.schemaValidation') {
            $validationCount++;
        }
        if (($failure === 'catalog' && $stage === 'snapshot.schemaValidation' && $validationCount === 5) || ($failure === 'membership' && $stage === 'membership.copy') || ($failure === 'persistence' && $stage === 'snapshot.contentPersistence')) {
            throw new ProtocolException('invalid_snapshot', 'Injected HTTP snapshot '.$failure.' failure.');
        }
    });
}
$application->handleRequest($request);

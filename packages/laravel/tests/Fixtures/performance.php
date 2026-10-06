<?php

declare(strict_types=1);

use App\Models\Item;
use App\Models\User;
use Illuminate\Contracts\Console\Kernel;
use Illuminate\Database\Events\QueryExecuted;
use Illuminate\Support\Facades\DB;
use Synloquent\Laravel\Protocol\CanonicalJson;
use Synloquent\Laravel\Query\QueryAction;
use Synloquent\Laravel\Sync\ActorContext;
use Synloquent\Laravel\Sync\PullAction;
use Synloquent\Laravel\Sync\SnapshotAction;
use Synloquent\Laravel\Sync\StageProfiler;
use Synloquent\Laravel\Sync\WriteContext;
use Synloquent\Laravel\Sync\WriteGateway;

$repository = dirname(__DIR__, 4);
$cleanupBootstrapCaches = require __DIR__.'/isolated-bootstrap-cache.php';
require getenv('SYNLOQUENT_TEST_AUTOLOAD') ?: $repository.'/examples/laravel/vendor/autoload.php';
$application = require $repository.'/examples/laravel/bootstrap/app.php';
$kernel = $application->make(Kernel::class);
$kernel->bootstrap();
$cleanupBootstrapCaches();
$database = getenv('SYNLOQUENT_TEST_DATABASE') ?: 'synloquent_performance_laravel';
if (! str_starts_with($database, 'synloquent_performance_')) {
    throw new RuntimeException('Benchmark reset is restricted to task-owned performance databases.');
}
$application['config']->set('database.connections.pgsql.database', $database);
$application['db']->purge('pgsql');
$sqlQueries = 0;
$lockedHook = null;
$streamLockedAt = null;
$captureProfile = false;
$queryProfile = [];
DB::listen(function (QueryExecuted $query) use (&$sqlQueries, &$lockedHook, &$streamLockedAt, &$captureProfile, &$queryProfile): void {
    $sqlQueries++;
    if (str_contains($query->sql, 'synloquent_streams') && str_contains($query->sql, 'for update')) {
        $streamLockedAt = hrtime(true);
    }
    if ($captureProfile && str_starts_with(strtolower($query->sql), 'select')) {
        $queryProfile[] = ['sql' => $query->sql, 'milliseconds' => $query->time, 'bindings' => $query->bindings];
    }
    if ($lockedHook !== null && str_contains($query->sql, 'synloquent_streams') && str_contains($query->sql, 'for update')) {
        $handler = $lockedHook;
        $lockedHook = null;
        $handler();
    }
});
$samples = [];
foreach ([[1000, 6000], [17000, 100000]] as [$itemCount, $childCount]) {
    $kernel->call('migrate:fresh', ['--force' => true]);
    User::create(['id' => 1, 'tenant_id' => 1, 'name' => 'Synthetic benchmark actor']);
    $actor = new ActorContext('1', '1', 'performance-epoch', '1', User::find(1), 'performance-device');
    $start = hrtime(true);
    $application->make(WriteGateway::class)->transaction($actor, function (WriteContext $context) use ($itemCount, $childCount): void {
        $timestamp = '2026-10-02 00:00:00+00';
        for ($offset = 0; $offset < $itemCount; $offset += 500) {
            $rows = [];
            for ($index = $offset; $index < min($offset + 500, $itemCount); $index++) {
                $rows[] = ['title' => 'Benchmark '.str_pad((string) $index, 6, '0', STR_PAD_LEFT), 'tenant_id' => 1, 'price' => '12.50', 'quantity' => $index % 20, 'active' => true, 'created_at' => $timestamp, 'updated_at' => $timestamp];
            }
            DB::table('items')->insert($rows);
        }
        for ($offset = 0; $offset < $childCount; $offset += 1000) {
            $rows = [];
            for ($index = $offset; $index < min($offset + 1000, $childCount); $index++) {
                $rows[] = ['item_id' => ($index % $itemCount) + 1, 'tenant_id' => 1, 'url' => 'https://example.invalid/performance/'.$index, 'created_at' => $timestamp, 'updated_at' => $timestamp];
            }
            DB::table('images')->insert($rows);
        }
        $context->invalidateAuthorization();
    });
    $fixtureSeconds = (hrtime(true) - $start) / 1e9;
    DB::statement('ANALYZE items, images');
    $measure = static function (callable $operation, bool $profile = false) use (&$sqlQueries, &$streamLockedAt, &$captureProfile, &$queryProfile): array {
        $sqlQueries = 0;
        $streamLockedAt = null;
        $captureProfile = $profile;
        $queryProfile = [];
        memory_reset_peak_usage();
        $baselineResident = (int) trim(shell_exec('ps -o rss= -p '.getmypid())) * 1024;
        $baselineMaximumResident = getrusage()['ru_maxrss'] * (PHP_OS_FAMILY === 'Darwin' ? 1 : 1024);
        $baselineAllocated = memory_get_usage(true);
        $baselineLogical = memory_get_usage(false);
        $start = hrtime(true);
        $result = $operation();
        $ended = hrtime(true);
        $operationQueries = $sqlQueries;
        $captureProfile = false;
        $profileResult = [];
        $plans = [];
        foreach ($queryProfile as $query) {
            $profileResult[] = ['sql' => $query['sql'], 'milliseconds' => $query['milliseconds'], 'parameterCount' => count($query['bindings'])];
            foreach (['synloquent_projection_memberships', 'items', 'item_tag'] as $table) {
                if (! isset($plans[$table]) && (str_contains($query['sql'], 'from "'.$table.'"') || str_contains($query['sql'], 'FROM '.$table))) {
                    $plan = DB::selectOne('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) '.$query['sql'], $query['bindings']);
                    $plans[$table] = json_decode($plan->{'QUERY PLAN'}, true, flags: JSON_THROW_ON_ERROR);
                }
            }
        }
        $captureProfile = false;

        return ['result' => $result, 'seconds' => ($ended - $start) / 1e9, 'streamLockHeldSeconds' => $streamLockedAt === null ? null : ($ended - $streamLockedAt) / 1e9, 'rssBytes' => (int) trim(shell_exec('ps -o rss= -p '.getmypid())) * 1024, 'baselineRssBytes' => $baselineResident, 'maximumRssBytes' => getrusage()['ru_maxrss'] * (PHP_OS_FAMILY === 'Darwin' ? 1 : 1024), 'maximumRssGrowthBytes' => max(0, getrusage()['ru_maxrss'] * (PHP_OS_FAMILY === 'Darwin' ? 1 : 1024) - $baselineMaximumResident), ...($profile ? ['sqlProfile' => $profileResult, 'plans' => $plans] : []), 'sqlQueries' => $operationQueries, 'baselineAllocatedBytes' => $baselineAllocated, 'baselineLogicalBytes' => $baselineLogical, 'peakBytes' => memory_get_peak_usage(true), 'peakGrowthBytes' => max(0, memory_get_peak_usage(true) - $baselineAllocated), 'logicalGrowthBytes' => max(0, memory_get_peak_usage(false) - $baselineLogical)];
    };
    $phases = [];
    $application->make(StageProfiler::class)->observe(static function (string $stage, array $measurement) use (&$phases): void {
        $phase = $phases[$stage] ?? ['seconds' => 0.0, 'calls' => 0, 'items' => 0];
        $phases[$stage] = ['seconds' => $phase['seconds'] + $measurement['seconds'], 'calls' => $phase['calls'] + 1, 'items' => $phase['items'] + $measurement['items'], 'logicalPeakBytes' => $measurement['logicalPeakBytes'], 'allocatedBytes' => $measurement['allocatedBytes']];
    });
    $snapshot = $measure(fn () => $application->make(SnapshotAction::class)->stream('catalog', $actor));
    $application->make(StageProfiler::class)->observe(null);
    $snapshot['phases'] = $phases;
    $document = $snapshot['result'];
    $snapshot['recordCount'] = $document->content->counts()['records'];
    $snapshot['relationSetCount'] = $document->content->counts()['relationSets'];
    $snapshot['byteSize'] = $document->metadata['byteSize'];
    $snapshot['path'] = 'Public HTTP and CLI bounded snapshot stream, including strict catalog schema validation';
    unset($snapshot['result']);
    $cursor = $document->metadata['cursor'];
    unset($document);
    DB::statement('ANALYZE synloquent_projection_memberships');
    $unchanged = $measure(fn () => $application->make(PullAction::class)->execute($cursor, 'catalog', $actor), true);
    if ($unchanged['result']['batches'] !== []) {
        throw new RuntimeException('Unchanged catalog produced pull changes.');
    }
    unset($unchanged['result']);
    $application->make(WriteGateway::class)->transaction($actor, function (WriteContext $context): void {
        $model = Item::findOrFail(1);
        $model->quantity = 99;
        $model->save();
        $context->capture($model);
    });
    $changed = $measure(fn () => $application->make(PullAction::class)->execute($cursor, 'catalog', $actor), true);
    $changes = $changed['result']['batches'][0]['changes'];
    if (count($changes) !== 1 || $changes[0]['record']['attributes']['quantity'] !== 99) {
        throw new RuntimeException('Single mutation did not produce exactly one canonical delta.');
    }
    $changed['changeCount'] = count($changes);
    $changed['responseBytes'] = strlen(CanonicalJson::encode($changed['result']));
    $changedCursor = $changed['result']['cursor'];
    unset($changed['result'], $changes);
    $application->make(WriteGateway::class)->transaction($actor, function (WriteContext $context): void {
        foreach (Item::orderBy('id')->limit(100)->get() as $model) {
            $model->quantity = 100;
            $model->save();
            $context->capture($model);
        }
    });
    $batch = $measure(fn () => $application->make(PullAction::class)->execute($changedCursor, 'catalog', $actor), true);
    $batch['changeCount'] = count($batch['result']['batches'][0]['changes']);
    if ($batch['changeCount'] !== 100) {
        throw new RuntimeException('Batch mutation did not produce exactly100 canonical changes.');
    }
    $batchCursor = $batch['result']['cursor'];
    $batch['responseBytes'] = strlen(CanonicalJson::encode($batch['result']));
    unset($batch['result']);
    $environment = getenv();
    $environment['SYNLOQUENT_TEST_DATABASE'] = $database;
    $writer = proc_open([PHP_BINARY, __DIR__.'/concurrency-worker.php', 'performanceWriter'], [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes, null, $environment);
    if ($writer === false) {
        throw new RuntimeException('Cannot start owned writer process.');
    }
    try {
        stream_set_timeout($pipes[1], 20);
        $ready = json_decode(fgets($pipes[1]), true, flags: JSON_THROW_ON_ERROR);
        if ($ready['stage'] !== 'ready') {
            throw new RuntimeException('Writer did not reach barrier.');
        }
        $application->make(WriteGateway::class)->transaction($actor, function (WriteContext $context): void {
            $model = Item::findOrFail(1);
            $model->quantity = 101;
            $model->save();
            $context->capture($model);
        });
        $lockedHook = static function () use ($pipes): void {
            fwrite($pipes[0], "release\n");
            fflush($pipes[0]);
        };
        $concurrent = $measure(fn () => $application->make(PullAction::class)->execute($batchCursor, 'catalog', $actor), true);
        $concurrentCursor = $concurrent['result']['cursor'];
        if ($concurrent['result']['batches'][0]['changes'][0]['record']['attributes']['quantity'] !== 101) {
            throw new RuntimeException('Concurrent pull changed its anchored high-water.');
        }
        unset($concurrent['result']);
        $committed = json_decode(fgets($pipes[1]), true, flags: JSON_THROW_ON_ERROR);
        if ($committed['stage'] !== 'committed') {
            throw new RuntimeException('Writer did not commit.');
        }
        $concurrent['writerLockWaitSeconds'] = $committed['lockWaitSeconds'];
        $tail = $application->make(PullAction::class)->execute($concurrentCursor, 'catalog', $actor);
        if ($tail['batches'][0]['changes'][0]['record']['attributes']['quantity'] !== 102) {
            throw new RuntimeException('Concurrent writer was lost after anchored pull.');
        }
        $concurrent['tailPreserved'] = true;
    } finally {
        $lockedHook = null;
        foreach ($pipes as $pipe) {
            fclose($pipe);
        }
        $state = proc_get_status($writer);
        if ($state['running']) {
            proc_terminate($writer);
        }
        proc_close($writer);
    }
    $query = $measure(fn () => $application->make(QueryAction::class)->execute(['model' => 'Item', 'limit' => 100, 'include' => ['images' => []]], $actor));
    $query['rootCount'] = count($query['result']['records']);
    $query['relatedCount'] = count($query['result']['related']);
    unset($query['result']);
    $samples[] = ['items' => $itemCount, 'children' => $childCount, 'fixtureSeconds' => $fixtureSeconds, 'snapshot' => $snapshot, 'unchangedPull' => $unchanged, 'singleEditPull' => $changed, 'hundredEditPull' => $batch, 'concurrentWriterPull' => $concurrent, 'eagerQuery' => $query];
    fwrite(STDERR, 'Measured '.$itemCount.' items and '.$childCount." children.\n");
}
$report = ['fixture' => 'synthetic-only', 'engine' => DB::selectOne('select version() as version')->version, 'laravel' => $application->version(), 'pdoDriver' => DB::connection()->getPdo()::class, 'database' => $database, 'bootstrapContract' => 'Fresh task database, bulk fixture import under stream lock before any subscriptions, authorization invalidation publication before baseline snapshot.', 'pullAlgorithm' => 'Row-local host contract and explicit capture permit indexed historical membership deltas, unchanged pull avoids projection reads, bounded changes reauthorize affected rows and pivot targets. Unknown dependencies or invalidation require full bounded materialization. Coalesced intervals preserve transaction high-water and response bounds.', 'samples' => $samples];
fwrite(STDOUT, json_encode($report, JSON_THROW_ON_ERROR | JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES)."\n");

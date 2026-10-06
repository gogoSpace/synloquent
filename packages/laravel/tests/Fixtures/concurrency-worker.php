<?php

declare(strict_types=1);

use App\Models\Item;
use App\Models\User;
use Illuminate\Contracts\Console\Kernel;
use Synloquent\Laravel\Export\ManifestBuilder;
use Synloquent\Laravel\Sync\ActorContext;
use Synloquent\Laravel\Sync\CommandAction;
use Synloquent\Laravel\Sync\EffectDelivery;
use Synloquent\Laravel\Sync\MutationAction;
use Synloquent\Laravel\Sync\SnapshotAction;
use Synloquent\Laravel\Sync\WriteContext;
use Synloquent\Laravel\Sync\WriteGateway;

$repository = dirname(__DIR__, 4);
$cleanupBootstrapCaches = require __DIR__.'/isolated-bootstrap-cache.php';
require getenv('SYNLOQUENT_TEST_AUTOLOAD') ?: $repository.'/examples/laravel/vendor/autoload.php';
$application = require $repository.'/examples/laravel/bootstrap/app.php';
$application->make(Kernel::class)->bootstrap();
$cleanupBootstrapCaches();
$application['config']->set('database.connections.pgsql.database', getenv('SYNLOQUENT_TEST_DATABASE') ?: 'synloquent_test');
$application['config']->set('synloquent.cursor_secret', 'synthetic-tests-stable-cursor-secret');
$actor = new ActorContext('1', '1', 'epoch-1', '1', User::find(1), 'example-device');
$mode = $argv[1];
$backend = $application['db']->connection()->selectOne('select pg_backend_pid() as identity')->identity;
if ($mode === 'performanceWriter') {
    $application->make(ManifestBuilder::class)->build();
    fwrite(STDOUT, json_encode(['stage' => 'ready', 'backend' => $backend])."\n");
    fflush(STDOUT);
    if (trim(fgets(STDIN)) !== 'release') {
        throw new RuntimeException('Performance writer barrier ended without release.');
    }
    $started = hrtime(true);
    $waitSeconds = null;
    $application->make(WriteGateway::class)->transaction($actor, function (WriteContext $context) use ($started, &$waitSeconds): void {
        $waitSeconds = (hrtime(true) - $started) / 1e9;
        $model = Item::findOrFail(1);
        $model->quantity++;
        $model->save();
        $context->capture($model);
    });
    fwrite(STDOUT, json_encode(['stage' => 'committed', 'lockWaitSeconds' => $waitSeconds])."\n");
    fflush(STDOUT);
    exit(0);
}
if ($mode === 'snapshot') {
    fwrite(STDOUT, json_encode(['stage' => 'attempting', 'backend' => $backend])."\n");
    fflush(STDOUT);
    $snapshot = $application->make(SnapshotAction::class)->execute('catalog', $actor);
    fwrite(STDOUT, json_encode(['stage' => 'materialized', 'snapshot' => $snapshot], JSON_THROW_ON_ERROR)."\n");
    fflush(STDOUT);
    exit(0);
}
if ($mode === 'effectCrash') {
    $delivery = $application->make(EffectDelivery::class);
    $delivery->afterDelivery(fn () => exit(22));
    $delivery->deliverOne();
    exit(23);
}
if ($mode === 'lostResponse') {
    $application->make(MutationAction::class)->execute([['operationId' => 'lost-response', 'model' => 'Item', 'localIdentity' => 'local-lost-response', 'action' => 'create', 'values' => ['title' => 'Lost response'], 'dependsOn' => []]], $actor);
    exit(21);
}
if ($mode === 'lostCommandResponse') {
    $application->make(CommandAction::class)->execute(['name' => 'increaseQuantity', 'operationId' => 'lost-command-response', 'arguments' => ['item_id' => '1', 'delta' => 4]], $actor);
    exit(24);
}
if ($mode === 'second') {
    fwrite(STDOUT, json_encode(['stage' => 'attempting', 'backend' => $backend])."\n");
    fflush(STDOUT);
}
$application->make(WriteGateway::class)->transaction($actor, function (WriteContext $context) use ($mode, $backend): void {
    if ($mode !== 'second') {
        if ($mode === 'beforeCommit') {
            $context->capture(Item::create(['title' => 'Killed transaction', 'tenant_id' => 1]));
        }
        fwrite(STDOUT, json_encode(['stage' => 'locked', 'backend' => $backend])."\n");
        fflush(STDOUT);
        if (trim(fgets(STDIN)) !== 'release') {
            throw new RuntimeException('Barrier ended without release.');
        }
    }
    if ($mode !== 'beforeCommit') {
        $context->capture(Item::create(['title' => 'Concurrent '.$mode, 'tenant_id' => 1]));
    }
});
fwrite(STDOUT, json_encode(['stage' => 'committed'])."\n");
fflush(STDOUT);

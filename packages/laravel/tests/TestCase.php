<?php

declare(strict_types=1);

namespace Synloquent\Tests;

use App\Commands\IncreaseQuantity;
use App\Commands\InspectItemLocked;
use App\Effects\SyntheticAtLeastOnceDestination;
use App\Effects\SyntheticIdempotentDestination;
use App\Exports\ExampleActorResolver;
use App\Models\Category;
use App\Models\Item;
use App\Models\User;
use App\Policies\CatalogPolicy;
use App\Scopes\ActivePriced;
use App\Scopes\MetadataContains;
use Illuminate\Contracts\Console\Kernel;
use Illuminate\Database\Eloquent\Relations\Relation;
use Illuminate\Support\Facades\Gate;
use Orchestra\Testbench\TestCase as OrchestraTestCase;
use Synloquent\Laravel\Contracts\ActorResolver;
use Synloquent\Laravel\Export\ExportRegistry;
use Synloquent\Laravel\Sync\ActorContext;
use Synloquent\Laravel\SynloquentServiceProvider;

abstract class TestCase extends OrchestraTestCase
{
    protected function getPackageProviders($application): array
    {
        return [SynloquentServiceProvider::class];
    }

    protected function defineEnvironment($application): void
    {
        $example = dirname(__DIR__, 3).'/examples/laravel';
        require_once $example.'/app/Exports/ExampleExport.php';
        foreach ([...glob($example.'/app/Enums/*.php'), ...glob($example.'/app/Casts/*.php')] as $path) {
            require_once $path;
        }
        foreach (glob($example.'/app/Models/*.php') as $path) {
            require_once $path;
        }
        foreach (glob($example.'/app/Exports/*.php') as $path) {
            require_once $path;
        }
        require_once $example.'/app/Policies/CatalogPolicy.php';
        require_once $example.'/app/Commands/IncreaseQuantity.php';
        require_once $example.'/app/Commands/InspectItemLocked.php';
        require_once $example.'/app/Scopes/ActivePriced.php';
        require_once $example.'/app/Scopes/MetadataContains.php';
        require_once $example.'/app/Effects/SyntheticIdempotentDestination.php';
        require_once $example.'/app/Effects/SyntheticAtLeastOnceDestination.php';
        (require __DIR__.'/Fixtures/database.php')($application);
        $application['config']->set('synloquent.additional_capabilities', ['json.object-contains.remote.v1']);
        $application['config']->set('synloquent.exports', (require $example.'/config/synloquent.php')['exports']);
        $application['config']->set('synloquent.effects', [SyntheticIdempotentDestination::class, SyntheticAtLeastOnceDestination::class]);
        $application['config']->set('synloquent.commands', [IncreaseQuantity::class, InspectItemLocked::class]);
        $application['config']->set('synloquent.scopes', [ActivePriced::class, MetadataContains::class]);
        $application['config']->set('synloquent.actor_resolver', ExampleActorResolver::class);
        $application['config']->set('synloquent.middleware', []);
        $application['config']->set('synloquent.capture_contract', 'gateway');
        $application['config']->set('synloquent.cursor_secret', 'synthetic-tests-stable-cursor-secret');
        $application->bind(ActorResolver::class, ExampleActorResolver::class);
        $application->make(Kernel::class)->addCommandRoutePaths([$example.'/routes/console.php']);
    }

    protected function defineDatabaseMigrations(): void
    {
        $this->app['migrator']->path(dirname(__DIR__, 3).'/examples/laravel/database/migrations');
    }

    protected function setUp(): void
    {
        parent::setUp();
        Relation::enforceMorphMap(['item' => Item::class, 'category' => Category::class]);
        $this->app['migrator']->path(dirname(__DIR__, 3).'/examples/laravel/database/migrations');
        (require __DIR__.'/Fixtures/connection-evidence.php')($this->app);
        $this->artisan('migrate:fresh', ['--force' => true])->assertSuccessful();
        foreach ($this->app->make(ExportRegistry::class)->all() as $resource) {
            Gate::policy($resource->modelClass(), CatalogPolicy::class);
        }
        User::create(['id' => 1, 'name' => 'Actor one', 'tenant_id' => 1]);
        User::create(['id' => 2, 'name' => 'Actor two', 'tenant_id' => 1]);
    }

    protected function workerEnvironment(): array
    {
        return [...getenv(), 'SYNLOQUENT_TEST_CONNECTION' => json_encode($this->app['db']->connection()->getConfig(), JSON_THROW_ON_ERROR), 'SYNLOQUENT_TEST_AUTOLOAD' => getenv('SYNLOQUENT_TEST_AUTOLOAD') ?: dirname(__DIR__).'/vendor/autoload.php'];
    }

    protected function assertWorkerIdentity(array $message): void
    {
        $this->assertSame($this->app['db']->connection()->getDriverName(), $message['driver']);
        $this->assertSame($this->app['db']->connection()->getDatabaseName(), $message['database']);
        $this->assertSame(hash_file('sha256', (new \ReflectionClass(SynloquentServiceProvider::class))->getFileName()), $message['providerSha256']);
    }

    protected function lockActivity(?int $identity = null): ?object
    {
        $manager = $this->app['db'];
        $connection = $manager->getConnections()['synloquent_lock_observer'] ?? $manager->connectUsing('synloquent_lock_observer', $manager->connection()->getConfig());
        if ($connection->getDriverName() === 'pgsql') {
            return $identity === null
                ? $connection->selectOne("select wait_event_type, query from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid() and wait_event_type = 'Lock' and query like '%synloquent_streams%' limit 1")
                : $connection->selectOne('select wait_event_type, query from pg_stat_activity where pid = ?', [$identity]);
        }

        // InnoDB's transaction snapshot refreshes only after at least 100 ms without a read.
        usleep(150000);

        return $connection->selectOne("SELECT 'Lock' AS wait_event_type, transactions.trx_query AS query FROM information_schema.innodb_trx AS transactions JOIN information_schema.processlist AS processes ON processes.id = transactions.trx_mysql_thread_id WHERE transactions.trx_state = 'LOCK WAIT' AND processes.db = ?".($identity === null ? '' : ' AND processes.id = ?')." AND transactions.trx_query LIKE '%synloquent_streams%' LIMIT 1", [$connection->getDatabaseName(), ...($identity === null ? [] : [$identity])]);
    }

    protected function actor(string $identity = '1'): ActorContext
    {
        return new ActorContext($identity, '1', 'epoch-1', '1', User::find($identity), 'example-device');
    }

    protected function operation(string $identity, string $action, array $values, array $extra = []): array
    {
        return [...['operationId' => $identity, 'model' => 'Item', 'localIdentity' => 'local-'.$identity, 'action' => $action, 'values' => $values, 'dependsOn' => []], ...$extra];
    }

    protected function worker(string $mode): array
    {
        $environment = $this->workerEnvironment();
        $process = proc_open([PHP_BINARY, __DIR__.'/Fixtures/concurrency-worker.php', $mode], [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes, null, $environment);
        if ($process === false) {
            throw new \RuntimeException('Could not launch an independent database process.');
        }
        stream_set_timeout($pipes[1], 10);

        return ['process' => $process, 'pipes' => $pipes];
    }

    protected function closeWorker(array $worker, bool $terminate = true): void
    {
        fclose($worker['pipes'][0]);
        $output = stream_get_contents($worker['pipes'][1]);
        $error = stream_get_contents($worker['pipes'][2]);
        fclose($worker['pipes'][1]);
        fclose($worker['pipes'][2]);
        $state = proc_get_status($worker['process']);
        if ($terminate && $state['running']) {
            proc_terminate($worker['process']);
        }
        proc_close($worker['process']);
        $this->assertSame('', $error, $output);
    }
}

<?php

declare(strict_types=1);

namespace Synloquent\Laravel;

use Illuminate\Support\ServiceProvider;
use Synloquent\Laravel\Contracts\ActorResolver;
use Synloquent\Laravel\Export\ExportRegistry;
use Synloquent\Laravel\Export\ManifestBuilder;
use Synloquent\Laravel\Query\ScopeRegistry;
use Synloquent\Laravel\Sync\CommandRegistry;
use Synloquent\Laravel\Sync\EffectRegistry;
use Synloquent\Laravel\Sync\WriteGateway;

final class SynloquentServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        $this->mergeConfigFrom(__DIR__.'/../config/synloquent.php', 'synloquent');
        $this->app->singleton(ExportRegistry::class, function ($application): ExportRegistry {
            $registry = new ExportRegistry;
            foreach ($application['config']->get('synloquent.exports', []) as $definition) {
                $registry->register($application->make($definition));
            }

            return $registry;
        });
        $this->app->singleton(ManifestBuilder::class);
        $this->app->singleton(ScopeRegistry::class, function ($application) {
            $registry = new ScopeRegistry;
            foreach ($application['config']->get('synloquent.scopes', []) as $scope) {
                $registry->register($application->make($scope));
            }

            return $registry;
        });
        $this->app->singleton(WriteGateway::class);
        $this->app->singleton(Sync\StageProfiler::class);
        $this->app->singleton(Protocol\ProtocolValidator::class);
        $this->app->singleton(EffectRegistry::class, function ($application) {
            $registry = new EffectRegistry;
            foreach ($application['config']->get('synloquent.effects', []) as $destination) {
                $registry->register($application->make($destination));
            }

            return $registry;
        });
        $this->app->singleton(CommandRegistry::class, function ($application) {
            $registry = new CommandRegistry;
            foreach ($application['config']->get('synloquent.commands', []) as $command) {
                $registry->register($application->make($command));
            }

            return $registry;
        });
        if ($resolver = $this->app['config']->get('synloquent.actor_resolver')) {
            $this->app->bind(ActorResolver::class, $resolver);
        }
    }

    public function boot(): void
    {
        $migrations = glob(__DIR__.'/../database/migrations/*.php');
        $migrations = array_map(static fn (string $path): string => basename($path) === '2026_10_02_114329_create_synloquent_active_projection_index.php' ? __DIR__.'/../database/compatibility/'.basename($path) : $path, $migrations);
        $this->loadMigrationsFrom($migrations);
        $this->loadRoutesFrom(__DIR__.'/../routes/api.php');
        $this->publishes([__DIR__.'/../config/synloquent.php' => config_path('synloquent.php')], 'synloquent-config');
        $this->publishes(array_combine($migrations, array_map(static fn (string $path): string => database_path('migrations/'.basename($path)), $migrations)), 'synloquent-migrations');
        if ($this->app->runningInConsole()) {
            $this->commands([Commands\GenerateCommand::class, Commands\ManifestCommand::class, Commands\DoctorCommand::class, Commands\SnapshotCommand::class, Commands\DeliverEffectsCommand::class]);
        }
    }
}

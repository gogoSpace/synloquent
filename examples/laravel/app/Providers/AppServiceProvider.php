<?php

declare(strict_types=1);

namespace App\Providers;

use App\Models\Category;
use App\Models\Item;
use App\Policies\CatalogPolicy;
use Illuminate\Database\Eloquent\Relations\Relation;
use Illuminate\Foundation\Http\Events\RequestHandled;
use Illuminate\Support\Facades\Gate;
use Illuminate\Support\ServiceProvider;
use Illuminate\Support\Str;
use Synloquent\Laravel\Export\ExportRegistry;

final class AppServiceProvider extends ServiceProvider
{
    public function boot(): void
    {
        Relation::enforceMorphMap(['item' => Item::class, 'category' => Category::class]);
        foreach (app(ExportRegistry::class)->all() as $resource) {
            Gate::policy($resource->modelClass(), CatalogPolicy::class);
        }
        $directory = config('synloquent.profile_directory');
        if (is_string($directory) && is_dir($directory)) {
            $this->app['events']->listen(RequestHandled::class, function (RequestHandled $event) use ($directory): void {
                $identity = $event->request->header('X-Synloquent-Profile-Id');
                if (! is_string($identity) || ! Str::isUuid($identity)) {
                    return;
                }
                $profile = $event->response->headers->get('X-Synloquent-Profile');
                if ($profile === null) {
                    return;
                }
                $status = $event->response->getStatusCode();
                $this->app->terminating(static function () use ($directory, $identity, $profile, $status): void {
                    $report = ['profileId' => $identity, 'status' => $status, 'elapsedLifecycleSeconds' => microtime(true) - (defined('LARAVEL_START') ? LARAVEL_START : $_SERVER['REQUEST_TIME_FLOAT']), 'logicalPeakBytes' => memory_get_peak_usage(false), 'allocatedPeakBytes' => memory_get_peak_usage(true), 'memoryLimit' => ini_get('memory_limit'), 'profile' => json_decode($profile, true, flags: JSON_THROW_ON_ERROR)];
                    file_put_contents($directory.'/'.$identity.'.json', json_encode($report, JSON_THROW_ON_ERROR | JSON_PRETTY_PRINT), LOCK_EX);
                });
            });
        }
    }
}

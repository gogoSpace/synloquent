<?php

declare(strict_types=1);

namespace Synloquent\Laravel\Commands;

use Illuminate\Console\Command;
use Synloquent\Laravel\Concerns\PreservesJsonTypes;
use Synloquent\Laravel\Contracts\ActorResolver;
use Synloquent\Laravel\Export\ExportRegistry;
use Synloquent\Laravel\Export\ManifestBuilder;
use Synloquent\Laravel\Sync\SyncDatabase;

final class DoctorCommand extends Command
{
    protected $signature = 'synloquent:doctor';

    protected $description = 'Check exported schema, actor binding, database and capture declaration';

    public function handle(ManifestBuilder $manifest, SyncDatabase $database): int
    {
        if (! app()->bound(ActorResolver::class)) {
            $this->error('Configure synloquent.actor_resolver.');

            return self::FAILURE;
        }
        if ($database->connection()->getDriverName() !== 'pgsql') {
            $this->error('V1 production verification supports PostgreSQL only.');

            return self::FAILURE;
        }
        if (! in_array($database->connection()->selectOne("select current_setting('TimeZone') as timezone")->timezone, ['UTC', 'Etc/UTC'], true)) {
            $this->error('Configure the PostgreSQL connection timezone as UTC to preserve canonical datetime instants.');

            return self::FAILURE;
        }
        if (config('synloquent.capture_contract') !== 'gateway') {
            $this->error('Declare capture_contract=gateway and route all exported instance, bulk, pivot and cascade writes through WriteGateway.');

            return self::FAILURE;
        }
        $manifest->build();
        foreach (app(ExportRegistry::class)->all() as $resource) {
            $model = new ($resource->modelClass());
            if (in_array(PreservesJsonTypes::class, class_uses_recursive($model), true)) {
                continue;
            }
            foreach ($model->getCasts() as $field => $cast) {
                if (in_array($field, $resource->writable(), true) && in_array($cast, ['array', 'json', 'object'], true)) {
                    $this->warn($resource->name().'.'.$field.' uses a standard JSON cast. Add Synloquent\\Laravel\\Concerns\\PreservesJsonTypes to preserve {} and [] dirty comparison. An equivalent host comparator may also satisfy the runtime guard.');
                }
            }
        }
        $this->info('Schema and PostgreSQL connection ready. Host capture declaration is gateway.');

        return self::SUCCESS;
    }
}

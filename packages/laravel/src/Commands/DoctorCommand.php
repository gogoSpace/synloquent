<?php

declare(strict_types=1);

namespace Synloquent\Laravel\Commands;

use Illuminate\Console\Command;
use Illuminate\Database\Eloquent\Relations\BelongsToMany;
use Illuminate\Database\MySqlConnection;
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
        $connection = $database->connection();
        $usesPostgreSql = $connection->getDriverName() === 'pgsql';
        $usesMariaDb = $connection instanceof MySqlConnection && $connection->isMaria();
        if (! $usesPostgreSql && ! $usesMariaDb) {
            $this->error('Verified database engines are PostgreSQL and MariaDB. Oracle MySQL is not qualified.');

            return self::FAILURE;
        }
        $timezone = $connection->selectOne($usesPostgreSql ? "select current_setting('TimeZone') as timezone" : 'select @@session.time_zone as timezone')->timezone;
        if (! in_array($timezone, $usesPostgreSql ? ['UTC', 'Etc/UTC'] : ['+00:00', 'UTC'], true)) {
            $this->error('Configure the connection timezone as UTC to preserve canonical datetime instants. Use +00:00 for MariaDB.');

            return self::FAILURE;
        }
        if ($usesMariaDb) {
            if (version_compare($connection->getServerVersion(), '10.7.0', '<')) {
                $this->error('MariaDB requires JSON_EQUALS and SKIP LOCKED, available together from 10.7. See the tested version matrix.');

                return self::FAILURE;
            }
            $tables = [];
            foreach (app(ExportRegistry::class)->all() as $resource) {
                $model = new ($resource->modelClass());
                $tables[] = $model->getTable();
                foreach ($resource->relations() as $relationName) {
                    $relation = $model->{$relationName}();
                    if ($relation instanceof BelongsToMany) {
                        $tables[] = $relation->getTable();
                    }
                }
            }
            $schemaBuilder = $connection->getSchemaBuilder();
            $defaultSchema = $connection->getDatabaseName();
            $schemas = [$defaultSchema];
            $qualifiedTables = [];
            foreach ($tables as $reference) {
                [$schema, $table] = $schemaBuilder->parseSchemaAndTable($reference, $defaultSchema);
                $schemas[] = $schema;
                $qualifiedTables[] = $schema.'.'.$connection->getTablePrefix().$table;
            }
            foreach ($schemaBuilder->getTables(array_unique($schemas)) as $table) {
                $internal = $table['schema'] === $defaultSchema && str_starts_with($table['name'], $connection->getTablePrefix().'synloquent_');
                if (($internal || in_array($table['schema_qualified_name'], $qualifiedTables, true)) && strcasecmp($table['engine'] ?? '', 'InnoDB') !== 0) {
                    $this->error('Synloquent and exported tables must use InnoDB: '.$table['schema_qualified_name']);

                    return self::FAILURE;
                }
            }
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
        $this->info('Schema and '.($usesPostgreSql ? 'PostgreSQL' : 'MariaDB').' connection ready. Host capture declaration is gateway.');

        return self::SUCCESS;
    }
}

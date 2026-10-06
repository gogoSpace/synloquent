<?php

declare(strict_types=1);

namespace Synloquent\Laravel\Sync;

use Illuminate\Database\Eloquent\Model;
use Synloquent\Laravel\Export\ExportRegistry;
use Synloquent\Laravel\Protocol\ProtocolException;

final class DeletionCapture
{
    /** @var array<string, list<array<array-key, mixed>>> */
    private array $foreignKeys = [];

    public function __construct(private ExportRegistry $registry, private SyncDatabase $database, private CaptureStreamGuard $streams) {}

    /** @return array<string, Model> */
    public function stage(Model $model, WriteContext $context): array
    {
        $affected = [];
        $pending = [$model];
        $visited = [];
        $streamVerified = false;
        $maximum = (int) config('synloquent.max_delta_records', 1000);
        $incoming = [];
        foreach ($this->registry->all() as $resource) {
            $child = new ($resource->modelClass());
            $foreignKeys = $this->foreignKeys[$child->getTable()] ??= $this->database->connection()->getSchemaBuilder()->getForeignKeys($child->getTable());
            foreach ($foreignKeys as $foreignKey) {
                if (in_array($foreignKey['on_delete'], ['cascade', 'set null'], true)) {
                    $incoming[$foreignKey['foreign_table']][] = ['model' => $child, 'foreignKey' => $foreignKey];
                }
            }
        }
        while ($pending !== []) {
            $parent = array_pop($pending);
            $key = $parent::class.':'.$parent->getKey();
            if (isset($visited[$key])) {
                continue;
            }
            $visited[$key] = true;
            $context->captureDeletionRelations($parent);
            foreach ($incoming[$parent->getTable()] ?? [] as $declaration) {
                $child = $declaration['model'];
                $foreignKey = $declaration['foreignKey'];
                if ($child->getConnection()->getName() !== $this->database->connection()->getName()) {
                    throw new ProtocolException('unsupported_query', 'Atomic deletion dependencies must use one database connection.');
                }
                $query = $child->newQueryWithoutScopes();
                foreach ($foreignKey['columns'] as $position => $column) {
                    $query->where($column, $parent->getAttribute($foreignKey['foreign_columns'][$position]));
                }
                foreach ($query->limit($maximum + 1)->lockForUpdate()->get() as $dependent) {
                    if (! $streamVerified) {
                        $this->streams->ensure($model, $context->actor);
                        $streamVerified = true;
                    }
                    $this->streams->ensure($dependent, $context->actor);
                    $dependentKey = $dependent::class.':'.$dependent->getKey();
                    $affected[$dependentKey] = $dependent;
                    if (count($affected) > $maximum) {
                        throw new ProtocolException('validation_failed', 'Deletion dependency set exceeds the atomic capture bound.');
                    }
                    if ($foreignKey['on_delete'] === 'cascade') {
                        $pending[] = $dependent;
                    }
                }
            }
        }
        unset($affected[$model::class.':'.$model->getKey()]);

        return $affected;
    }

    /** @param array<string, Model> $affected */
    public function complete(array $affected, WriteContext $context): void
    {
        $groups = [];
        foreach ($affected as $previous) {
            $groups[$previous::class][] = $previous;
        }
        $deleted = [];
        $upserts = [];
        foreach ($groups as $models) {
            foreach (array_chunk($models, 1000) as $chunk) {
                $currentModels = $chunk[0]->newQueryWithoutScopes()->whereKey(array_map(fn (Model $model): mixed => $model->getKey(), $chunk))->get()->keyBy(fn (Model $model): string => (string) $model->getKey());
                foreach ($chunk as $previous) {
                    $current = $currentModels->get((string) $previous->getKey());
                    if ($current === null) {
                        $deleted[] = $previous;
                    } else {
                        $this->streams->ensure($current, $context->actor);
                        $upserts[] = $current;
                    }
                }
            }
        }
        $context->captureMany($deleted, 'delete', true);
        $context->captureMany($upserts);
    }
}

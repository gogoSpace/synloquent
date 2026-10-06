<?php

declare(strict_types=1);

namespace Synloquent\Laravel\Sync;

use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Query\Builder as QueryBuilder;
use Synloquent\Laravel\Export\ExportRegistry;
use Synloquent\Laravel\Protocol\CanonicalJson;
use Synloquent\Laravel\Protocol\ProtocolException;

final class UpdateCapture
{
    /** @var array<string, list<array<string, mixed>>> */
    private array $incoming = [];

    /** @var array<string, Model>|null */
    private ?array $models = null;

    public function __construct(private ExportRegistry $registry, private SyncDatabase $database, private CaptureStreamGuard $streams) {}

    /**
     * @param  list<string>  $changedColumns
     * @return array{root: Model, affected: array<string, Model>, stagedColumns: array<string, list<string>>, referencedColumns: list<string>}
     */
    public function stage(Model $model, WriteContext $context, array $changedColumns = []): array
    {
        if ($model->getConnection()->getName() !== $this->database->connection()->getName()) {
            throw new ProtocolException('unsupported_query', 'Atomic update capture must use one database connection.');
        }
        $previous = clone $model;
        $previous->setRawAttributes($model->getRawOriginal(), true);
        $changedColumns = array_unique([...array_keys($model->getDirty()), ...$changedColumns]);
        if ($model->usesTimestamps() && $model->getUpdatedAtColumn() !== null) {
            $changedColumns[] = $model->getUpdatedAtColumn();
        }
        $rootKey = $model::class.':'.$previous->getKey();
        $affected = [$rootKey => $previous];
        $pending = [$rootKey => ['model' => $previous, 'columns' => $changedColumns]];
        $visited = [];
        $referenced = [];
        foreach ($this->foreignKeys($previous->getTable()) as $foreignKey) {
            $referenced = array_unique([...$referenced, ...$foreignKey['foreign_columns']]);
        }
        $maximum = (int) config('synloquent.max_delta_records', 1000);
        $streamVerified = false;
        while ($pending !== []) {
            $groups = [];
            foreach ($pending as $parentKey => $entry) {
                $parent = $entry['model'];
                $columns = array_diff($entry['columns'], $visited[$parentKey] ?? []);
                if ($columns === []) {
                    continue;
                }
                if (in_array($parent->getKeyName(), $columns, true)) {
                    throw new ProtocolException('validation_failed', 'An update cascade cannot change a canonical identity.');
                }
                $visited[$parentKey] = $this->mergeColumns($visited[$parentKey] ?? [], $columns);
                sort($columns, SORT_STRING);
                $groupKey = $parent::class.':'.CanonicalJson::hash($columns);
                $groups[$groupKey]['models'][] = $parent;
                $groups[$groupKey]['columns'] = $columns;
            }
            $pending = [];
            foreach ($groups as $group) {
                $parents = $group['models'];
                $columns = $group['columns'];
                foreach ($this->foreignKeys($parents[0]->getTable()) as $foreignKey) {
                    $changedPositions = array_keys(array_intersect($foreignKey['foreign_columns'], $columns));
                    if ($changedPositions === []) {
                        continue;
                    }
                    $child = $this->registeredModel($foreignKey['schema'], $foreignKey['table']);
                    if ($child === null || $foreignKey['on_update'] !== 'c') {
                        $table = $this->database->connection()->getQueryGrammar()->wrapTable($foreignKey['schema'].'.'.$foreignKey['table'], '');
                        $query = $this->database->connection()->query()->fromRaw($table);
                        if ($this->matchParents($query, $foreignKey, $parents) && $query->exists()) {
                            throw new ProtocolException('unsupported_query', $child === null ? 'An update cascade reaches an unregistered dependency table.' : 'This foreign-key update action requires explicit host capture.');
                        }

                        continue;
                    }
                    if ($child->getConnection()->getName() !== $this->database->connection()->getName()) {
                        throw new ProtocolException('unsupported_query', 'Atomic update dependencies must use one database connection.');
                    }
                    $changedChildColumns = array_map(fn (int $position): string => $foreignKey['columns'][$position], $changedPositions);
                    $dependents = $child->newQueryWithoutScopes();
                    if (! $this->matchParents($dependents, $foreignKey, $parents)) {
                        continue;
                    }
                    foreach ($dependents->limit($maximum + 1)->lockForUpdate()->get() as $dependent) {
                        if (! $streamVerified) {
                            $this->streams->ensure($previous, $context->actor);
                            $streamVerified = true;
                        }
                        $this->streams->ensure($dependent, $context->actor);
                        $dependentKey = $dependent::class.':'.$dependent->getKey();
                        $affected[$dependentKey] ??= $dependent;
                        if (count($affected) > $maximum) {
                            throw new ProtocolException('validation_failed', 'Update dependency set exceeds the atomic capture bound.');
                        }
                        $pending[$dependentKey] = ['model' => $affected[$dependentKey], 'columns' => $this->mergeColumns($pending[$dependentKey]['columns'] ?? [], $changedChildColumns)];
                        if (count($pending) > $maximum) {
                            throw new ProtocolException('validation_failed', 'Update dependency frontier exceeds the atomic capture bound.');
                        }
                    }
                }
            }
        }

        return ['root' => $previous, 'affected' => $affected, 'stagedColumns' => $visited, 'referencedColumns' => array_values($referenced)];
    }

    /**
     * @param  Builder<Model>|QueryBuilder  $query
     * @param  array<string, mixed>  $foreignKey
     * @param  list<Model>  $parents
     */
    private function matchParents(Builder|QueryBuilder $query, array $foreignKey, array $parents): bool
    {
        $tuples = [];
        foreach ($parents as $parent) {
            $tuple = [];
            foreach ($foreignKey['columns'] as $position => $column) {
                $tuple[$column] = $parent->getRawOriginal($foreignKey['foreign_columns'][$position]);
            }
            if (in_array(null, $tuple, true)) {
                continue;
            }
            $tuples[CanonicalJson::hash($tuple)] = $tuple;
        }
        $tuples = array_values($tuples);
        if ($tuples === []) {
            return false;
        }
        $varying = [];
        foreach ($foreignKey['columns'] as $column) {
            $value = $tuples[0][$column];
            $different = false;
            foreach ($tuples as $tuple) {
                if ($tuple[$column] !== $value) {
                    $different = true;
                    break;
                }
            }
            if ($different) {
                $varying[] = $column;
            } else {
                $query->where($column, $value);
            }
        }
        if (count($tuples) * count($varying) + count($foreignKey['columns']) > 60000) {
            throw new ProtocolException('validation_failed', 'Update dependency tuple set exceeds the parameter bound.');
        }
        if (count($varying) === 1) {
            $query->whereIn($varying[0], array_column($tuples, $varying[0]));
        } elseif ($varying !== []) {
            $query->where(function ($group) use ($tuples, $varying): void {
                foreach ($tuples as $tuple) {
                    $group->orWhere(function ($branch) use ($tuple, $varying): void {
                        foreach ($varying as $column) {
                            $branch->where($column, $tuple[$column]);
                        }
                    });
                }
            });
        }

        return true;
    }

    /**
     * @param  list<string>  $existing
     * @param  array<array-key, string>  $additional
     * @return list<string>
     */
    private function mergeColumns(array $existing, array $additional): array
    {
        return array_values(array_unique([...$existing, ...$additional]));
    }

    /** @param array{root: Model, affected: array<string, Model>, stagedColumns: array<string, list<string>>, referencedColumns: list<string>} $plan */
    public function complete(array $plan, Model $current, WriteContext $context): void
    {
        $previous = $plan['root'];
        if ((string) $previous->getKey() !== (string) $current->getKey()) {
            throw new ProtocolException('validation_failed', 'An existing canonical identity is immutable.');
        }
        if (count($plan['affected']) > 1) {
            $this->streams->ensure($current, $context->actor);
        }
        $rootKey = $previous::class.':'.$previous->getKey();
        foreach ($plan['referencedColumns'] as $column) {
            if (! in_array($column, $plan['stagedColumns'][$rootKey] ?? [], true) && $previous->getRawOriginal($column) !== $current->getAttributes()[$column]) {
                throw new ProtocolException('unsupported_query', 'A host event changed a referenced key outside staged update capture.');
            }
        }
        $groups = [];
        foreach ($plan['affected'] as $key => $dependent) {
            if ($key === $rootKey) {
                continue;
            }
            $groups[$dependent::class][] = $dependent;
        }
        $changed = [];
        foreach ($groups as $models) {
            $updatedModels = $models[0]->newQueryWithoutScopes()->whereKey(array_map(fn (Model $model): mixed => $model->getKey(), $models))->get()->keyBy(fn (Model $model): string => (string) $model->getKey());
            foreach ($models as $dependent) {
                $updated = $updatedModels->get((string) $dependent->getKey());
                if ($updated === null) {
                    throw new ProtocolException('unsupported_query', 'An update dependency lost its canonical identity.');
                }
                $this->streams->ensure($updated, $context->actor);
                if ($dependent->getAttributes() !== $updated->getAttributes()) {
                    $changed[] = $updated;
                }
            }
        }
        $context->captureMany($changed);
    }

    /** @return list<array<string, mixed>> */
    private function foreignKeys(string $table): array
    {
        if (! isset($this->incoming[$table])) {
            $reference = $this->database->connection()->getQueryGrammar()->wrapTable($table);
            $rows = $this->database->connection()->selectFromWriteConnection(<<<'SQL'
SELECT child_schema.nspname AS schema, child.relname AS table,
       constraint_row.confupdtype AS on_update,
       json_agg(child_column.attname ORDER BY key_position.ordinality) AS columns,
       json_agg(parent_column.attname ORDER BY key_position.ordinality) AS foreign_columns
FROM pg_constraint AS constraint_row
JOIN pg_class AS child ON child.oid = constraint_row.conrelid
JOIN pg_namespace AS child_schema ON child_schema.oid = child.relnamespace
JOIN LATERAL unnest(constraint_row.conkey) WITH ORDINALITY AS key_position(number, ordinality) ON true
JOIN pg_attribute AS child_column ON child_column.attrelid = child.oid AND child_column.attnum = key_position.number
JOIN pg_attribute AS parent_column ON parent_column.attrelid = constraint_row.confrelid AND parent_column.attnum = constraint_row.confkey[key_position.ordinality]
WHERE constraint_row.contype = 'f' AND constraint_row.confrelid = to_regclass(?)
  AND constraint_row.confupdtype IN ('c', 'n', 'd')
GROUP BY constraint_row.oid, child_schema.nspname, child.relname, constraint_row.confupdtype
ORDER BY child_schema.nspname, child.relname, constraint_row.oid
SQL, [$reference]);
            $this->incoming[$table] = array_map(static fn (object $row): array => ['schema' => $row->schema, 'table' => $row->table, 'columns' => json_decode($row->columns, true, flags: JSON_THROW_ON_ERROR), 'foreign_columns' => json_decode($row->foreign_columns, true, flags: JSON_THROW_ON_ERROR), 'on_update' => $row->on_update], $rows);
        }

        return $this->incoming[$table];
    }

    private function registeredModel(string $schema, string $table): ?Model
    {
        if ($this->models === null) {
            $this->models = [];
            $builder = $this->database->connection()->getSchemaBuilder();
            $defaultSchema = $builder->getCurrentSchemaName();
            foreach ($this->registry->all() as $resource) {
                $model = new ($resource->modelClass());
                [$modelSchema, $modelTable] = $builder->parseSchemaAndTable($model->getTable());
                $this->models[($modelSchema ?? $defaultSchema).'.'.$this->database->connection()->getTablePrefix().$modelTable] = $model;
            }
        }

        return $this->models[$schema.'.'.$table] ?? null;
    }
}

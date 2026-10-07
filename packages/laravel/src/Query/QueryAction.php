<?php

declare(strict_types=1);

namespace Synloquent\Laravel\Query;

use Illuminate\Database\Eloquent\Model;
use Synloquent\Laravel\Export\ExactDecimal;
use Synloquent\Laravel\Export\ExportRegistry;
use Synloquent\Laravel\Export\ManifestBuilder;
use Synloquent\Laravel\Export\ValueCodec;
use Synloquent\Laravel\Protocol\ProtocolException;
use Synloquent\Laravel\Sync\ActorContext;
use Synloquent\Laravel\Sync\RelationSetReader;
use Synloquent\Laravel\Sync\RevisionStore;
use Synloquent\Laravel\Sync\SyncDatabase;

final class QueryAction
{
    public function __construct(private QueryCompiler $compiler, private ExportRegistry $registry, private ManifestBuilder $manifest, private RevisionStore $revisions, private RelationSetReader $relationSets, private ValueCodec $values, private SyncDatabase $database, private HavingCompiler $having) {}

    /**
     * @param  array<array-key, mixed>  $definition
     * @return array<array-key, mixed>
     */
    public function execute(array $definition, ActorContext $actor): array
    {
        $connection = $this->database->connection();
        if ($connection->transactionLevel() !== 0) {
            throw new ProtocolException('unsupported_query', 'Query must own its consistent read transaction.');
        }

        if ($connection->getDriverName() !== 'pgsql') {
            $connection->statement('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
        }

        return $connection->transaction(function () use ($connection, $definition, $actor): array {
            if ($connection->getDriverName() === 'pgsql') {
                $connection->statement('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
            }

            return $this->read($definition, $actor);
        });
    }

    /**
     * @param  array<array-key, mixed>  $definition
     * @return array<array-key, mixed>
     */
    private function read(array $definition, ActorContext $actor): array
    {
        if (isset($definition['aggregate'])) {
            return $this->aggregate($definition, $actor);
        }
        $query = $this->compiler->compile($definition, $actor);
        $related = [];
        $records = [];
        $computed = [];
        $through = [];
        foreach ($query->get() as $model) {
            $record = $this->record($model, $definition['model'], $actor, $definition['select'] ?? null, $this->projectionKeys($definition['model'], $definition));
            $records[] = $record;
            foreach ($definition['relationAggregates'] ?? [] as $aggregateIndex => $aggregate) {
                $field = $aggregate['field'] ?? '*';
                $alias = $aggregate['alias'] ?? $aggregate['relation'].'_'.$aggregate['function'].($field !== '*' ? '_'.$field : '');
                $relatedModel = $model->{$aggregate['relation']}()->getRelated();
                $relatedName = $this->registry->nameForClass($relatedModel::class);
                $value = $model->getAttribute($alias);
                $computed[$record['model'].':'.$record['id']]['aggregates'][$alias] = $aggregate['function'] === 'exists' ? (bool) $value : $this->aggregateValue($value, $aggregate['function'], $field, $relatedName, $model->getAttribute('__synloquent_sum_guard_'.$aggregateIndex));
            }
            foreach ($definition['subqueries'] ?? [] as $subqueryIndex => $subquery) {
                if (($subquery['kind'] ?? '') !== 'select') {
                    continue;
                }
                $inner = $subquery['query'];
                $value = $model->getAttribute($subquery['alias']);
                if (isset($inner['aggregate'])) {
                    $value = $this->aggregateValue($value, $inner['aggregate']['function'], $inner['aggregate']['field'] ?? '*', $inner['model'], $model->getAttribute('__synloquent_projection_sum_'.$subqueryIndex));
                } else {
                    $field = $inner['select'][0];
                    $innerModel = new ($this->registry->get($inner['model'])->modelClass());
                    $innerModel->setRawAttributes([$field => $value]);
                    $value = $this->values->modelAttribute($innerModel, $field, $this->manifest->build()['models'][$inner['model']]['fields'][$field]);
                }
                $computed[$record['model'].':'.$record['id']]['projections'][$subquery['alias']] = $value;
            }
            $this->related($model, $actor, $related, $definition, $through);
        }

        $this->through($through, $actor, $related);
        $all = $this->revisions->hydrate([...$records, ...array_values($related)], $actor->stream());
        $related = array_slice($all, count($records));
        $records = array_slice($all, 0, count($records));

        return [...($computed !== [] ? ['computed' => $computed] : []), 'records' => $records, 'related' => $related, 'relationSets' => $this->relationSets->read([...$records, ...$related], $actor), 'completeness' => 'partial', 'scope' => ['dataset' => 'query', 'authorizationGeneration' => $actor->authorizationGeneration, 'projectionGeneration' => '1', 'schemaFingerprint' => $this->manifest->build()['fingerprint']]];
    }

    /**
     * @param  array<array-key, mixed>  $definition
     * @return array<array-key, mixed>
     */
    private function aggregate(array $definition, ActorContext $actor): array
    {
        $resource = $this->registry->get($definition['model']);
        $function = $definition['aggregate']['function'] ?? '';
        $field = $definition['aggregate']['field'] ?? '*';
        if (! in_array($function, ['count', 'min', 'max', 'sum', 'avg'], true) || ($field === '*' && $function !== 'count') || ($field !== '*' && ! in_array($field, $resource->readable(), true))) {
            throw new ProtocolException('unsupported_query', 'Invalid aggregate field or function.');
        }
        if (in_array($field, $resource->materialized(), true)) {
            throw new ProtocolException('unsupported_query', 'Materialized PHP fields cannot execute in server SQL aggregates.');
        }
        if (in_array($function, ['sum', 'avg'], true) && ! in_array($this->manifest->build()['models'][$definition['model']]['fields'][$field]['type'] ?? '', ['integer', 'float', 'decimal'], true)) {
            throw new ProtocolException('unsupported_query', 'Sum and average require a numeric field.');
        }
        $base = $definition;
        unset($base['aggregate'], $base['groupBy'], $base['having'], $base['include'], $base['select'], $base['orderBy'], $base['limit'], $base['offset']);
        $query = $this->compiler->compile($base, $actor)->reorder();
        $grammar = $query->getQuery()->getGrammar();
        $hasUnions = ($base['unions'] ?? []) !== [];
        $aggregateColumn = $field === '*' ? '*' : $grammar->wrap($hasUnions ? $field : $query->getModel()->qualifyColumn($field));
        if (($this->manifest->build()['models'][$definition['model']]['fields'][$field]['type'] ?? null) === 'string') {
            $aggregateColumn = QueryExpressions::text($aggregateColumn, $grammar);
        }
        $expression = $function.'('.$aggregateColumn.')';
        $aggregate = [];
        if (isset($definition['groupBy'])) {
            $groups = $definition['groupBy'];
            if (! is_array($groups) || count($groups) > 16) {
                throw new ProtocolException('unsupported_query', 'Group complexity exceeded.');
            }
            foreach ($groups as $group) {
                if (! in_array($group, $resource->readable(), true) || in_array($group, $resource->materialized(), true)) {
                    throw new ProtocolException('unknown_field', 'Grouping field must be a readable physical field.');
                }
            }
            $query->select([]);
            foreach (array_unique([...$groups, ...($field === '*' ? [] : [$field])]) as $projected) {
                $column = $grammar->wrap($hasUnions ? $projected : $query->getModel()->qualifyColumn($projected));
                if ($this->manifest->build()['models'][$definition['model']]['fields'][$projected]['type'] === 'string') {
                    $column = QueryExpressions::text($column, $grammar);
                }
                $query->selectRaw($column.' AS '.$grammar->wrap($projected));
            }
            if ($groups === [] && $field === '*') {
                $query->selectRaw('1 AS __synloquent_group_source');
            }
            $model = $query->getModel();
            $query = $model->newModelQuery()->fromSub($query->toBase()->cloneWithout(['limit', 'offset', 'unionLimit', 'unionOffset']), '__synloquent_groups');
            foreach ($groups as $group) {
                $query->addSelect($group)->groupBy($group);
            }
            $expression = $function.'('.($field === '*' ? '*' : $grammar->wrap($field)).')';
            $query->selectRaw($expression.' AS aggregate_value');
            if ($function === 'avg' && ($this->manifest->build()['models'][$definition['model']]['fields'][$field]['type'] ?? null) === 'integer') {
                $query->selectRaw('sum('.$grammar->wrap($field).') AS aggregate_sum');
            }
            if (isset($definition['having'])) {
                $fields = array_intersect_key($this->manifest->build()['models'][$definition['model']]['fields'], array_fill_keys($groups, true));
                foreach ($fields as $group => &$declaration) {
                    $declaration['column'] = $group;
                }
                unset($declaration);
                [$sql, $bindings] = $this->having->compile($definition['having'], $fields, $expression, $grammar);
                $query->havingRaw($sql, $bindings);
            }
            $order = $definition['orderBy'] ?? [];
            if (! is_array($order) || count($order) > 10) {
                throw new ProtocolException('unsupported_query', 'Grouped order complexity exceeded.');
            }
            $ordered = [];
            foreach ($order as $ordering) {
                $group = $ordering['field'] ?? '';
                $direction = $ordering['direction'] ?? '';
                if (! in_array($group, $groups, true) || ! in_array($direction, ['asc', 'desc'], true)) {
                    throw new ProtocolException('unsupported_query', 'Grouped order requires a declared group field.');
                }
                $column = $grammar->wrap($group);
                $query->orderByRaw(QueryExpressions::order($column, $direction, $grammar));
                $ordered[] = $group;
            }
            foreach (array_diff($groups, $ordered) as $group) {
                $column = $grammar->wrap($group);
                $query->orderByRaw(QueryExpressions::order($column, 'asc', $grammar));
            }
            $aggregate = ['value' => null, 'groups' => []];
            $maximum = (int) config('synloquent.max_page_size', 1000);
            $limit = $definition['limit'] ?? $maximum;
            $offset = $definition['offset'] ?? 0;
            if (! is_int($limit) || $limit < 0 || $limit > $maximum || ! is_int($offset) || $offset < 0 || $offset > 100000) {
                throw new ProtocolException('unsupported_query', 'Grouped pagination exceeds declared bounds.');
            }
            $rows = $query->offset($offset)->limit(isset($definition['limit']) ? $limit : $maximum + 1)->get();
            if ($rows->count() > $maximum) {
                throw new ProtocolException('unsupported_query', 'Grouped aggregate exceeds the result bound.');
            }
            foreach ($rows as $row) {
                $keys = [];
                foreach ($groups as $group) {
                    $keys[$group] = $this->values->encode($row->getAttribute($group), $this->manifest->build()['models'][$definition['model']]['fields'][$group], $row->getCasts()[$group] ?? null);
                }
                $aggregate['groups'][] = ['keys' => $keys, 'value' => $this->aggregateValue($row->getAttribute('aggregate_value'), $function, $field, $definition['model'], $row->getAttribute('aggregate_sum'))];
            }
        } else {
            if (isset($definition['having'])) {
                throw new ProtocolException('unsupported_query', 'HAVING requires a grouped query.');
            }
            $value = $query->{$function}($query->getQuery()->raw($aggregateColumn));
            $sum = $function === 'avg' && ($this->manifest->build()['models'][$definition['model']]['fields'][$field]['type'] ?? null) === 'integer' ? (clone $query)->sum($field) : null;
            $aggregate = ['value' => $this->aggregateValue($value, $function, $field, $definition['model'], $sum)];
        }

        return ['records' => [], 'related' => [], 'relationSets' => [], 'aggregate' => $aggregate, 'completeness' => 'partial', 'scope' => ['dataset' => 'query', 'authorizationGeneration' => $actor->authorizationGeneration, 'projectionGeneration' => '1', 'schemaFingerprint' => $this->manifest->build()['fingerprint']]];
    }

    private function aggregateValue(mixed $value, string $function, string $field, string $model, mixed $sum = null): mixed
    {
        if ($function === 'count') {
            return (int) $value;
        }
        if ($value === null) {
            return null;
        }
        $declaration = $this->manifest->build()['models'][$model]['fields'][$field] ?? [];
        if (($declaration['type'] ?? null) === 'decimal') {
            return ExactDecimal::scale((string) $value, $declaration['precision'] ?? 2);
        }
        if (($declaration['type'] ?? null) === 'integer' && is_numeric($value)) {
            if ($function === 'avg') {
                return $sum !== null && ! $this->safeInteger((string) $sum) ? rtrim(rtrim(ExactDecimal::scale((string) $value, 18), '0'), '.') : (float) $value;
            }

            return $this->safeInteger((string) $value) ? (int) $value : (string) $value;
        }
        if (($declaration['type'] ?? null) === 'float' && is_numeric($value)) {
            return (float) $value;
        }

        return $value;
    }

    private function safeInteger(string $value): bool
    {
        $absolute = ltrim(ltrim($value, '-'), '0');

        return strlen($absolute) < 16 || (strlen($absolute) === 16 && strcmp($absolute, '9007199254740991') <= 0);
    }

    /**
     * @param  list<string>|null  $selection
     * @param  list<string>  $retained
     * @return array<array-key, mixed>
     */
    public function record(Model $model, string $resource, ActorContext $actor, ?array $selection = null, array $retained = []): array
    {
        $attributes = $this->registry->get($resource)->project($model, $actor);
        if ($selection !== null) {
            $attributes = array_intersect_key($attributes, array_flip([...$selection, $model->getKeyName(), ...$retained]));
        }

        return ['model' => $resource, 'id' => (string) $model->getKey(), 'revision' => '0', 'attributes' => $attributes];
    }

    /**
     * @param  array<array-key, mixed>  $definition
     * @return list<string>
     */
    private function projectionKeys(string $name, array $definition): array
    {
        $keys = [];
        foreach (array_keys($definition['include'] ?? []) as $relationName) {
            $relation = $this->manifest->build()['models'][$name]['relations'][$relationName];
            foreach (in_array($relation['type'], ['belongsTo', 'morphTo'], true) ? ['foreignKey', 'morphType'] : ['localKey'] as $key) {
                if (isset($relation[$key])) {
                    $keys[] = $relation[$key];
                }
            }
        }

        return $keys;
    }

    /**
     * @param  array<string, array<string, list<mixed>>>  $through
     * @param  array<array-key, mixed>  $records
     */
    private function through(array $through, ActorContext $actor, array &$records): void
    {
        foreach ($through as $name => $fields) {
            $resource = $this->registry->get($name);
            if (! $resource->authorize('query', $actor)) {
                throw new ProtocolException('forbidden_operation', 'Through projection is not authorized.', [], 403);
            }
            foreach ($fields as $field => $identities) {
                foreach (array_chunk(array_values(array_unique($identities)), 1000) as $chunk) {
                    $query = ($resource->modelClass())::query()->whereIn($field, $chunk);
                    $resource->scope($query, $actor);
                    foreach ($query->get() as $intermediate) {
                        $records[$name.':'.$intermediate->getKey()] = $this->record($intermediate, $name, $actor);
                    }
                }
            }
        }
    }

    /**
     * @param  array<array-key, mixed>  $through
     * @param  array<array-key, mixed>  $records
     * @param  array<array-key, mixed>  $definition
     */
    private function related(Model $model, ActorContext $actor, array &$records, array $definition, array &$through): void
    {
        foreach ($model->getRelations() as $relation => $value) {
            if (! array_key_exists($relation, $definition['include'] ?? [])) {
                continue;
            }
            foreach ($value instanceof Model ? [$value] : ($value ?? []) as $related) {
                if (! $related instanceof Model) {
                    continue;
                }
                $name = $this->registry->nameForClass($related::class);
                $options = $definition['include'][$relation] ?? [];
                $metadata = $this->manifest->build()['models'][$this->registry->nameForClass($model::class)]['relations'][$relation];
                $keys = isset($metadata['through']) ? [$metadata['secondKey']] : (in_array($metadata['type'], ['belongsTo', 'morphTo'], true) ? [$metadata['ownerKey'] ?? $related->getKeyName()] : [$metadata['foreignKey'] ?? $related->getKeyName(), $metadata['morphType'] ?? $related->getKeyName()]);
                $records[$name.':'.$related->getKey()] = $this->record($related, $name, $actor, $options['select'] ?? null, [...$keys, ...$this->projectionKeys($name, $options)]);
                if (isset($metadata['through'])) {
                    $through[$metadata['through']][$metadata['secondLocalKey'] ?? 'id'][] = $related->getAttribute($metadata['secondKey']);
                }
                $this->related($related, $actor, $records, $options, $through);
            }
        }
    }
}

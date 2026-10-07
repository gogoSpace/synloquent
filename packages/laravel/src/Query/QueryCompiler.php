<?php

declare(strict_types=1);

namespace Synloquent\Laravel\Query;

use Illuminate\Contracts\Config\Repository;
use Illuminate\Contracts\Validation\Factory;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\MorphTo;
use Illuminate\Database\Eloquent\Relations\Relation;
use Synloquent\Laravel\Contracts\ResourceExport;
use Synloquent\Laravel\Export\ExportRegistry;
use Synloquent\Laravel\Export\ManifestBuilder;
use Synloquent\Laravel\Export\ValueCodec;
use Synloquent\Laravel\Protocol\ProtocolException;
use Synloquent\Laravel\Sync\ActorContext;

final class QueryCompiler
{
    private int $nodes = 0;

    public function __construct(private ExportRegistry $registry, private Repository $configuration, private ScopeRegistry $scopes, private Factory $validation, private ValueCodec $values, private ManifestBuilder $manifest) {}

    /**
     * @param  array<array-key, mixed>  $definition
     * @return Builder<Model>
     */
    public function compile(array $definition, ActorContext $actor): Builder
    {
        $this->nodes = 0;

        return $this->compileTree($definition, $actor, 0);
    }

    /**
     * @param  array<array-key, mixed>  $definition
     * @return Builder<Model>
     */
    private function compileTree(array $definition, ActorContext $actor, int $depth, ?string $tableAlias = null): Builder
    {
        if (++$this->nodes > $this->configuration->get('synloquent.max_query_nodes', 100) || $depth > $this->configuration->get('synloquent.max_query_depth', 8)) {
            throw new ProtocolException('unsupported_query', 'Query complexity exceeded.');
        }
        $resource = $this->registry->get($definition['model'] ?? '');
        $this->authorize($resource, $actor);
        $model = new ($resource->modelClass());
        $table = $model->getTable();
        if ($tableAlias !== null) {
            $model->setTable($tableAlias);
        }
        $query = $model->newQuery();
        if ($tableAlias !== null) {
            $query->from($table.' as '.$tableAlias);
        }
        $resource->scope($query, $actor);

        return $this->options($query, $definition, $resource, $actor, $depth);
    }

    /**
     * @param  Builder<Model>  $query
     * @param  array<array-key, mixed>  $definition
     */
    private function applyScopes(Builder $query, array $definition, ResourceExport $resource, ActorContext $actor): void
    {
        foreach ($definition['scopes'] ?? [] as $declaration) {
            $scope = $this->scopes->get($declaration['name'] ?? '');
            if ($scope->model() !== $resource->name() || ! $scope->authorize($actor)) {
                throw new ProtocolException('forbidden_operation', 'Scope is not authorized for this resource.', [], 403);
            }
            $arguments = $declaration['arguments'] ?? [];
            if (array_diff(array_keys($arguments), array_keys($scope->arguments())) !== []) {
                throw new ProtocolException('validation_failed', 'Unknown scope argument.');
            }
            foreach ($arguments as $field => $value) {
                $this->values->validate($value, $scope->arguments()[$field], $field);
            }
            $validator = $this->validation->make($this->values->validationData($arguments), $scope->rules());
            if ($validator->fails()) {
                throw new ProtocolException('validation_failed', 'Scope arguments are invalid.');
            }
            $scope->apply($query, $this->values->validatedValues($validator->validated(), $arguments, $scope->arguments()), $actor);
        }
    }

    /**
     * @param  Builder<Model>  $query
     * @param  array<array-key, mixed>  $definition
     * @return Builder<Model>
     */
    private function options(Builder $query, array $definition, ResourceExport $resource, ActorContext $actor, int $depth = 0): Builder
    {
        $allowed = ['model', 'select', 'where', 'orderBy', 'limit', 'offset', 'include', 'distinct', 'groupBy', 'having', 'aggregate', 'trashed', 'scopes', 'relationAggregates', 'joins', 'joinedWhere', 'subqueries', 'unions'];
        foreach (array_keys($definition) as $key) {
            if (! in_array($key, $allowed, true)) {
                throw new ProtocolException('unsupported_query', 'Unknown query option '.$key);
            }
        }
        $this->applyScopes($query, $definition, $resource, $actor);
        if (isset($definition['aggregate'])) {
            throw new ProtocolException('unsupported_query', 'Aggregate result requests require a registered typed capability.');
        }
        $this->advanced($query, $definition, $resource, $actor, $depth);
        $fields = $definition['select'] ?? $resource->readable();
        if (! is_array($fields) || ! array_is_list($fields)) {
            throw new ProtocolException('unsupported_query', 'select must be a field list.');
        }
        foreach ($fields as $field) {
            $this->field($resource, $field, true);
        }
        $model = $query->getModel();
        if ($resource->materialized() !== []) {
            $fields = array_values(array_unique([...$fields, ...array_diff($resource->readable(), $resource->materialized())]));
        }
        $fields = array_values(array_unique([...$fields, $model->getKeyName()]));
        foreach ($resource->relations() as $name) {
            $relation = $model->{$name}();
            if (method_exists($relation, 'getForeignKeyName') && $relation instanceof BelongsTo) {
                $fields[] = $relation->getForeignKeyName();
            }
        }
        foreach (array_keys($definition['include'] ?? []) as $name) {
            $metadata = $this->manifest->build()['models'][$resource->name()]['relations'][$name] ?? [];
            if (isset($metadata['localKey'])) {
                $fields[] = $metadata['localKey'];
            }
        }
        $selection = [];
        foreach (array_unique($fields) as $field) {
            if (in_array($field, $resource->materialized(), true)) {
                continue;
            }
            $column = $model->qualifyColumn($field);
            $selection[] = ($this->manifest->build()['models'][$resource->name()]['fields'][$field]['type'] ?? '') === 'json' && $model->getConnection()->getDriverName() === 'pgsql' ? $query->getQuery()->raw($query->getQuery()->getGrammar()->wrap($column).'::jsonb AS '.$query->getQuery()->getGrammar()->wrap($field)) : $column;
        }
        $query->addSelect($selection);
        if (isset($definition['where'])) {
            $this->predicate($query, $definition['where'], $resource, $actor, 0);
        }
        if (isset($definition['trashed'])) {
            if (! method_exists($model, 'getDeletedAtColumn') || ! in_array($definition['trashed'], ['include', 'only'], true)) {
                throw new ProtocolException('unsupported_query', 'Unsupported soft-delete selection.');
            }
            $query->__call($definition['trashed'] === 'only' ? 'onlyTrashed' : 'withTrashed', []);
        }
        if ($definition['distinct'] ?? false) {
            if (($definition['unions'] ?? []) !== []) {
                throw new ProtocolException('unsupported_query', 'Distinct union combinations are not declared.');
            }
            $grammar = $query->getQuery()->getGrammar();
            $partition = array_map(function (string $field) use ($grammar, $model, $resource): string {
                $column = $grammar->wrap($model->qualifyColumn($field));

                return $this->manifest->build()['models'][$resource->name()]['fields'][$field]['type'] === 'string' ? QueryExpressions::text($column, $grammar) : $column;
            }, $definition['select'] ?? $resource->readable());
            if ($partition === [] || array_intersect($definition['select'] ?? $resource->readable(), $resource->materialized()) !== []) {
                throw new ProtocolException('unsupported_query', 'Distinct requires declared physical projection fields.');
            }
            $primary = $model->getQualifiedKeyName();
            $representatives = $query->toBase()->cloneWithout(['columns', 'orders', 'limit', 'offset'])->cloneWithoutBindings(['select', 'order'])->select($primary)->selectRaw('ROW_NUMBER() OVER(PARTITION BY '.implode(', ', $partition).' ORDER BY '.$grammar->wrap($primary).' ASC) AS __distinct_row');
            $identities = $model->getConnection()->query()->fromSub($representatives, '__synloquent_distinct')->select($model->getKeyName())->where('__distinct_row', 1);
            $query->whereIn($primary, $identities);
        }
        $hasUnions = ($definition['unions'] ?? []) !== [];
        if ($hasUnions) {
            $query = $model->newModelQuery()->fromSub($query->toBase(), '__synloquent_union')->select('__synloquent_union.*');
        }
        $order = $definition['orderBy'] ?? [];
        if (! is_array($order) || count($order) > 10) {
            throw new ProtocolException('unsupported_query', 'Order complexity exceeded.');
        }
        foreach ($order as $ordering) {
            $this->field($resource, $ordering['field'] ?? '');
            if (! in_array($ordering['direction'] ?? '', ['asc', 'desc'], true)) {
                throw new ProtocolException('unsupported_query', 'Invalid order direction.');
            }
            $column = $hasUnions ? '__synloquent_union.'.$ordering['field'] : $model->qualifyColumn($ordering['field']);
            $wrapped = $query->getQuery()->getGrammar()->wrap($column);
            if (($this->manifest->build()['models'][$resource->name()]['fields'][$ordering['field']]['type'] ?? '') === 'string') {
                $wrapped = QueryExpressions::text($wrapped, $query->getQuery()->getGrammar());
            }
            $query->orderByRaw(QueryExpressions::order($wrapped, $ordering['direction'], $query->getQuery()->getGrammar()));
        }
        if (! in_array($model->getKeyName(), array_column($order, 'field'), true)) {
            $query->orderByRaw(QueryExpressions::order($this->comparisonColumn($query, $resource, $model->getKeyName(), $hasUnions ? '__synloquent_union' : null), 'asc', $query->getQuery()->getGrammar()));
        }
        if ($depth > $this->configuration->get('synloquent.max_query_depth', 8)) {
            throw new ProtocolException('unsupported_query', 'Include depth exceeded.');
        }
        $limit = $definition['limit'] ?? $this->configuration->get('synloquent.max_page_size', 1000);
        $offset = $definition['offset'] ?? 0;
        if (! is_int($limit) || $limit < 0 || $limit > $this->configuration->get('synloquent.max_page_size', 1000) || ! is_int($offset) || $offset < 0 || $offset > 1000000) {
            throw new ProtocolException('unsupported_query', 'Invalid or excessive pagination.');
        }
        $query->limit($limit)->offset($offset);
        if (isset($definition['groupBy']) || isset($definition['having'])) {
            throw new ProtocolException('unsupported_query', 'Grouped result queries require a registered typed server capability.');
        }
        foreach ($definition['include'] ?? [] as $name => $options) {
            $this->relationName($resource, $name);
            $relation = $model->{$name}();
            $related = $this->registry->get($this->registry->nameForClass($relation->getRelated()::class));
            $this->authorize($related, $actor);
            $query->with([$name => function ($relatedQuery) use ($options, $actor, $depth): void {
                $builder = $relatedQuery instanceof Relation ? $relatedQuery->getQuery() : $relatedQuery;
                $actualRelated = $this->registry->get($this->registry->nameForClass($builder->getModel()::class));
                $this->authorize($actualRelated, $actor);
                $actualRelated->scope($builder, $actor);
                $this->options($builder, $options, $actualRelated, $actor, $depth + 1);
            }]);
        }

        return $query;
    }

    /**
     * @param  Builder<Model>  $query
     * @param  array<array-key, mixed>  $predicate
     */
    public function predicate(Builder $query, array $predicate, ResourceExport $resource, ActorContext $actor, int $depth, ?string $qualifier = null): void
    {
        $this->nodes++;
        if ($depth > $this->configuration->get('synloquent.max_query_depth', 8) || $this->nodes > $this->configuration->get('synloquent.max_query_nodes', 100)) {
            throw new ProtocolException('unsupported_query', 'Predicate complexity exceeded.');
        }
        $kind = $predicate['kind'] ?? null;
        if ($kind === 'group') {
            if (! in_array($predicate['boolean'] ?? '', ['and', 'or'], true) || ! is_array($predicate['predicates'] ?? null)) {
                throw new ProtocolException('unsupported_query', 'Invalid predicate group.');
            }
            $query->where(function (Builder $group) use ($predicate, $resource, $actor, $depth, $qualifier): void {
                foreach ($predicate['predicates'] as $child) {
                    $method = $predicate['boolean'] === 'or' ? 'orWhere' : 'where';
                    $group->{$method}(fn (Builder $branch) => $this->predicate($branch, $child, $resource, $actor, $depth + 1, $qualifier));
                }
            });

            return;
        }
        if ($kind === 'not') {
            $query->whereNot(fn (Builder $branch) => $this->predicate($branch, $predicate['predicate'], $resource, $actor, $depth + 1, $qualifier));

            return;
        }
        if ($kind === 'relation') {
            if ($qualifier !== null) {
                throw new ProtocolException('unsupported_query', 'Joined aliases support scalar predicates only.');
            }
            $name = $predicate['relation'] ?? '';
            $this->relationName($resource, $name);
            $relation = $query->getModel()->{$name}();
            if (! $relation instanceof MorphTo) {
                $this->authorize($this->registry->get($this->registry->nameForClass($relation->getRelated()::class)), $actor);
            }
            $operator = $predicate['operator'] ?? '>=';
            $count = $predicate['count'] ?? 1;
            if (! in_array($operator, ['=', '!=', '<', '<=', '>', '>='], true) || ! is_int($count) || $count < 0) {
                throw new ProtocolException('unsupported_query', 'Invalid relation predicate.');
            }
            $callback = function (Builder $relatedQuery) use ($actor, $predicate, $depth): void {
                $related = $this->registry->get($this->registry->nameForClass($relatedQuery->getModel()::class));
                $this->authorize($related, $actor);
                $related->scope($relatedQuery, $actor);
                if (isset($predicate['predicate'])) {
                    $this->predicate($relatedQuery, $predicate['predicate'], $related, $actor, $depth + 1);
                }
            };
            if ($relation instanceof MorphTo) {
                $declared = array_values($this->manifest->build()['models'][$resource->name()]['relations'][$name]['morphMap']);
                $targets = $predicate['morphModels'] ?? $declared;
                if (! is_array($targets) || ! array_is_list($targets) || $targets === [] || count($targets) > 32 || count(array_unique($targets)) !== count($targets) || array_diff($targets, $declared) !== []) {
                    throw new ProtocolException('unsupported_query', 'Polymorphic target must be a declared exported model.');
                }
                $classes = array_map(fn (string $target) => $this->registry->get($target)->modelClass(), $targets);
                $query->whereHasMorph($name, $classes, $callback, $operator, $count);
            } else {
                if (isset($predicate['morphModels'])) {
                    throw new ProtocolException('unsupported_query', 'Explicit polymorphic targets require a morphTo relation.');
                }
                $query->whereHas($name, $callback, $operator, $count);
            }

            return;
        }
        $field = $predicate['field'] ?? '';
        $this->field($resource, $field);
        $fieldDefinition = $this->manifest->build()['models'][$resource->name()]['fields'][$field];
        $fieldType = $fieldDefinition['type'];
        $field = $qualifier === null ? $query->getModel()->qualifyColumn($field) : $qualifier.'.'.$field;
        if ($fieldType === 'string') {
            $field = $query->getQuery()->raw(QueryExpressions::text($query->getQuery()->getGrammar()->wrap($field), $query->getQuery()->getGrammar()));
        }
        $operator = $predicate['operator'] ?? '';
        if ($kind === 'column') {
            $this->field($resource, $predicate['otherField'] ?? '');
            if (! in_array($operator, ['=', '!=', '<', '<=', '>', '>='], true)) {
                throw new ProtocolException('unsupported_query', 'Invalid column comparison.');
            }
            $query->whereColumn([[$field, $operator, $query->getQuery()->raw($this->comparisonColumn($query, $resource, $predicate['otherField'], $qualifier))]]);

            return;
        }
        if ($kind !== 'comparison') {
            throw new ProtocolException('unsupported_query', 'Unknown predicate kind.');
        }
        $value = $predicate['value'] ?? null;
        switch ($operator) {
            case 'jsonContains':
                if ($fieldType !== 'json' || (! is_scalar($value) && $value !== null)) {
                    throw new ProtocolException('unsupported_query', 'JSON containment requires a declared JSON field and scalar value.');
                }
                QueryExpressions::jsonContains($query, $field, $value);
                break;
            case 'jsonPath':
                if ($fieldType !== 'json' || ! is_array($value) || ! is_string($value['path'] ?? null) || ! array_key_exists('value', $value) || (! is_scalar($value['value']) && $value['value'] !== null) || ! preg_match('/^\$(?:\.[A-Za-z_][A-Za-z0-9_]*|\[\d+\])+$/D', $value['path'])) {
                    throw new ProtocolException('unsupported_query', 'JSON path requires an allowlisted path and scalar value.');
                }
                preg_match_all('/\.[A-Za-z_][A-Za-z0-9_]*|\[\d+\]/', $value['path'], $matches);
                if (count($matches[0]) > 16) {
                    throw new ProtocolException('unsupported_query', 'JSON path complexity exceeded.');
                }
                QueryExpressions::jsonPath($query, $field, $matches[0], $value['value']);
                break;
            case 'isNull': $query->whereNull($field);
                break;
            case 'isNotNull': $query->whereNotNull($field);
                break;
            case 'in': case 'notIn':
                if (! is_array($value) || ! array_is_list($value) || count($value) > 1000) {
                    throw new ProtocolException('unsupported_query', 'Invalid set predicate.');
                }
                foreach ($value as $entry) {
                    $this->comparisonValue($entry, $fieldDefinition);
                }
                if ($fieldType === 'integer' && $value !== []) {
                    $query->whereRaw($query->getQuery()->getGrammar()->wrap($field).($operator === 'in' ? ' IN (' : ' NOT IN (').implode(', ', array_fill(0, count($value), QueryExpressions::integer($query->getQuery()->getGrammar()))).')', $value);
                    break;
                }
                $operator === 'in' ? $query->whereIn($field, $value) : $query->whereNotIn($field, $value);
                break;
            case 'between': case 'notBetween':
                if (! is_array($value) || count($value) !== 2) {
                    throw new ProtocolException('unsupported_query', 'Invalid range predicate.');
                }
                foreach ($value as $entry) {
                    $this->comparisonValue($entry, $fieldDefinition);
                }
                if ($fieldType === 'integer') {
                    $query->whereRaw($query->getQuery()->getGrammar()->wrap($field).($operator === 'between' ? ' BETWEEN ' : ' NOT BETWEEN ').QueryExpressions::integer($query->getQuery()->getGrammar()).' AND '.QueryExpressions::integer($query->getQuery()->getGrammar()), $value);
                    break;
                }
                $operator === 'between' ? $query->whereBetween($field, $value) : $query->whereNotBetween($field, $value);
                break;
            case '=': case '!=': case '<': case '<=': case '>': case '>=': case 'like':
                if ($operator === 'like' && ! in_array($fieldType, ['string', 'enum'], true)) {
                    throw new ProtocolException('unsupported_query', 'LIKE requires a declared string field.');
                }
                $this->comparisonValue($value, $operator === 'like' ? ['type' => 'string'] : $fieldDefinition);
                if ($value === null && ! in_array($operator, ['=', '!='], true)) {
                    throw new ProtocolException('unsupported_query', 'Null comparison requires equality or null predicate.');
                }
                if ($fieldType === 'integer' && $value !== null) {
                    $query->whereRaw($query->getQuery()->getGrammar()->wrap($field).' '.$operator.' '.QueryExpressions::integer($query->getQuery()->getGrammar()), [$value]);
                } else {
                    $query->where($field, $operator, $value);
                }
                break;
            default: throw new ProtocolException('unsupported_query', 'Unknown comparison operator '.$operator);
        }
    }

    /**
     * @param  Builder<Model>  $query
     * @param  array<array-key, mixed>  $definition
     */
    private function advanced(Builder $query, array $definition, ResourceExport $resource, ActorContext $actor, int $depth): void
    {
        $aliases = [];
        foreach ($definition['joins'] ?? [] as $join) {
            $alias = $join['alias'] ?? '';
            $this->alias($alias);
            if (isset($aliases[$alias]) || ! in_array($join['type'] ?? '', ['inner', 'left'], true)) {
                throw new ProtocolException('unsupported_query', 'Invalid declared join.');
            }
            $related = $this->registry->get($join['model'] ?? '');
            $this->authorize($related, $actor);
            $joined = ($related->modelClass())::query();
            $related->scope($joined, $actor);
            $joined->select($related->readable());
            $on = $join['on'] ?? [];
            if (! is_array($on) || $on === [] || count($on) > 16) {
                throw new ProtocolException('unsupported_query', 'Join requires bounded equality keys.');
            }
            foreach ($on as $condition) {
                $this->field($resource, $condition['field'] ?? '');
                $this->field($related, $condition['otherField'] ?? '');
            }
            $method = $join['type'] === 'left' ? 'leftJoinSub' : 'joinSub';
            $query->{$method}($joined, $alias, function ($clause) use ($on, $query, $alias, $related, $resource): void {
                foreach ($on as $condition) {
                    $clause->on($query->getQuery()->raw($this->comparisonColumn($query, $resource, $condition['field'])), '=', $query->getQuery()->raw($this->comparisonColumn($query, $related, $condition['otherField'], $alias)));
                }
            });
            $aliases[$alias] = $related;
        }
        foreach ($definition['joinedWhere'] ?? [] as $condition) {
            $alias = $condition['alias'] ?? '';
            if (! isset($aliases[$alias])) {
                throw new ProtocolException('unsupported_query', 'Joined predicate alias is undeclared.');
            }
            $this->predicate($query, $condition['predicate'], $aliases[$alias], $actor, $depth + 1, $alias);
        }
        foreach ($definition['relationAggregates'] ?? [] as $aggregateIndex => $aggregate) {
            $name = $aggregate['relation'] ?? '';
            $this->relationName($resource, $name);
            $relation = $query->getModel()->{$name}();
            $related = $this->registry->get($this->registry->nameForClass($relation->getRelated()::class));
            $this->authorize($related, $actor);
            $function = $aggregate['function'] ?? '';
            if (! in_array($function, ['count', 'exists', 'sum', 'min', 'max', 'avg'], true)) {
                throw new ProtocolException('unsupported_query', 'Relation aggregate is not supported.');
            }
            $field = $aggregate['field'] ?? '*';
            if (! in_array($function, ['count', 'exists'], true)) {
                $this->field($related, $field);
            }
            $alias = $aggregate['alias'] ?? $name.'_'.$function.($field !== '*' ? '_'.$field : '');
            $this->alias($alias);
            if (in_array($alias, $resource->readable(), true)) {
                throw new ProtocolException('unsupported_query', 'Computed alias collides with a canonical field.');
            }
            $relations = [$name.' as '.$alias => fn (Builder $builder) => $related->scope($builder, $actor)];
            if ($function === 'count') {
                $query->withCount($relations);
            } elseif ($function === 'exists') {
                $query->withExists($relations);
            } else {
                if (($this->manifest->build()['models'][$related->name()]['fields'][$field]['type'] ?? null) === 'string') {
                    $relations = [$name.' as '.$alias => function (Builder $builder) use ($related, $actor, $function, $field): void {
                        $related->scope($builder, $actor);
                        $grammar = $builder->getQuery()->getGrammar();
                        $column = QueryExpressions::text($grammar->wrap($builder->getModel()->qualifyColumn($field)), $grammar);
                        $builder->select([])->selectRaw($function.'('.$column.')');
                    }];
                }
                $query->withAggregate($relations, $field, $function);
                if ($function === 'avg' && ($this->manifest->build()['models'][$related->name()]['fields'][$field]['type'] ?? null) === 'integer') {
                    $query->withSum([$name.' as __synloquent_sum_guard_'.$aggregateIndex => fn (Builder $builder) => $related->scope($builder, $actor)], $field);
                }
            }
        }
        foreach ($definition['subqueries'] ?? [] as $subqueryIndex => $subquery) {
            $innerDefinition = $subquery['query'] ?? [];
            $innerBase = $innerDefinition;
            unset($innerBase['aggregate']);
            if (isset($innerDefinition['aggregate']) && (isset($innerDefinition['groupBy']) || isset($innerDefinition['having']))) {
                throw new ProtocolException('unsupported_query', 'Scalar aggregate subqueries cannot return grouped rows.');
            }
            $inner = $this->compileTree($innerBase, $actor, $depth + 1, '__synloquent_subquery_'.$this->nodes);
            $innerQualifier = ($innerDefinition['unions'] ?? []) !== [] ? '__synloquent_union' : $inner->getModel()->getTable();
            $innerResource = $this->registry->get($innerDefinition['model']);
            foreach ($subquery['correlate'] ?? [] as $keys) {
                $this->field($innerResource, $keys['innerField'] ?? '');
                $this->field($resource, $keys['outerField'] ?? '');
            }
            $outerQualifier = null;
            if ($query->getModel()->getConnection()->getDriverName() !== 'pgsql' && array_filter($subquery['correlate'] ?? [], fn (array $keys): bool => $this->manifest->build()['models'][$resource->name()]['fields'][$keys['outerField']]['type'] === 'string') !== []) {
                // MariaDB caches correlated results using the host collation of outer columns.
                // Correlate the local source by identity so case variants cannot share a cache entry.
                $outerModel = new ($resource->modelClass());
                $outerQualifier = '__synloquent_correlation_'.$this->nodes;
                $inner->join($outerModel->getTable().' as '.$outerQualifier, $outerQualifier.'.'.$outerModel->getKeyName(), '=', $query->getModel()->getQualifiedKeyName());
            }
            foreach ($subquery['correlate'] ?? [] as $keys) {
                $inner->whereColumn([[$inner->getQuery()->raw($this->comparisonColumn($inner, $innerResource, $keys['innerField'], $innerQualifier)), '=', $query->getQuery()->raw($this->comparisonColumn($query, $resource, $keys['outerField'], $outerQualifier))]]);
            }
            $kind = $subquery['kind'] ?? '';
            if (in_array($kind, ['exists', 'notExists'], true)) {
                if (isset($innerDefinition['aggregate'])) {
                    throw new ProtocolException('unsupported_query', 'Exists aggregate subqueries are not declared.');
                } $query->getQuery()->addWhereExistsQuery($inner->toBase(), 'and', $kind === 'notExists');

                continue;
            }
            $selected = $innerDefinition['select'] ?? [];
            if ((! isset($innerDefinition['aggregate']) && count($selected) !== 1) || ($innerDefinition['limit'] ?? null) !== 1) {
                throw new ProtocolException('unsupported_query', 'Scalar subquery requires one declared field or aggregate and limit1.');
            }
            if (isset($innerDefinition['aggregate'])) {
                $function = $innerDefinition['aggregate']['function'];
                $field = $innerDefinition['aggregate']['field'] ?? '*';
                if (! in_array($function, ['count', 'min', 'max', 'sum', 'avg'], true) || ($field === '*' && $function !== 'count')) {
                    throw new ProtocolException('unsupported_query', 'Invalid scalar aggregate subquery.');
                }
                if ($field !== '*') {
                    $this->field($innerResource, $field);
                }
                $column = $field === '*' ? '*' : $inner->getQuery()->getGrammar()->wrap($innerQualifier.'.'.$field);
                if (($this->manifest->build()['models'][$innerResource->name()]['fields'][$field]['type'] ?? null) === 'string') {
                    $column = QueryExpressions::text($column, $inner->getQuery()->getGrammar());
                }
                $inner->select([])->selectRaw($function.'('.$column.')')->reorder();
            } else {
                $inner->select($innerQualifier.'.'.$selected[0]);
            }
            if ($kind === 'select') {
                $alias = $subquery['alias'] ?? '';
                $this->alias($alias);
                if (in_array($alias, $resource->readable(), true)) {
                    throw new ProtocolException('unsupported_query', 'Projection alias collides with a canonical field.');
                } $query->selectSub($inner, $alias);
                if (isset($innerDefinition['aggregate']) && $innerDefinition['aggregate']['function'] === 'avg' && ($this->manifest->build()['models'][$innerResource->name()]['fields'][$innerDefinition['aggregate']['field']]['type'] ?? null) === 'integer') {
                    $sumQuery = clone $inner;
                    $sumColumn = $inner->getQuery()->getGrammar()->wrap($innerQualifier.'.'.$innerDefinition['aggregate']['field']);
                    $query->selectSub($sumQuery->select([])->selectRaw('sum('.$sumColumn.')'), '__synloquent_projection_sum_'.$subqueryIndex);
                }
            } elseif ($kind === 'where') {
                $this->field($resource, $subquery['field'] ?? '');
                $operator = $subquery['operator'] ?? '=';
                if (! in_array($operator, ['=', '!=', '<', '<=', '>', '>='], true)) {
                    throw new ProtocolException('unsupported_query', 'Invalid scalar subquery comparison.');
                }
                $query->where($query->getQuery()->raw($this->comparisonColumn($query, $resource, $subquery['field'])), $operator, $inner);
            } else {
                throw new ProtocolException('unsupported_query', 'Unknown subquery kind.');
            }
        }
        foreach ($definition['unions'] ?? [] as $union) {
            $branch = $union['query'] ?? [];
            if (($branch['model'] ?? '') !== $resource->name() || ($branch['select'] ?? $resource->readable()) !== ($definition['select'] ?? $resource->readable())) {
                throw new ProtocolException('unsupported_query', 'Union branches require equal resource and projection.');
            }
            $query->union($this->compileTree($branch, $actor, $depth + 1), (bool) ($union['all'] ?? false));
        }
    }

    /** @param Builder<Model> $query */
    private function comparisonColumn(Builder $query, ResourceExport $resource, string $field, ?string $qualifier = null): string
    {
        $grammar = $query->getQuery()->getGrammar();
        $column = $grammar->wrap($qualifier === null ? $query->getModel()->qualifyColumn($field) : ($qualifier === '' ? $field : $qualifier.'.'.$field));

        return $this->manifest->build()['models'][$resource->name()]['fields'][$field]['type'] === 'string' ? QueryExpressions::text($column, $grammar) : $column;
    }

    /** @param array<array-key, mixed> $definition */
    private function comparisonValue(mixed $value, array $definition): void
    {
        if ($value === null) {
            return;
        }
        if ($definition['type'] === 'integer') {
            $text = is_int($value) ? (string) $value : $value;
            if (! is_string($text) || $text === '-0' || ! preg_match('/^-?(?:0|[1-9][0-9]*)$/D', $text)) {
                throw new ProtocolException('validation_failed', 'Integer query values require a canonical integer or decimal identity string.');
            }
            $absolute = ltrim(ltrim($text, '-'), '0');
            $maximum = str_starts_with($text, '-') ? '9223372036854775808' : '9223372036854775807';
            if (strlen($absolute) > 19 || (strlen($absolute) === 19 && strcmp($absolute, $maximum) > 0)) {
                throw new ProtocolException('validation_failed', 'Integer query value exceeds the signed 64-bit range.');
            }

            return;
        }
        if ($definition['type'] === 'json') {
            throw new ProtocolException('unsupported_query', 'JSON comparisons require a declared JSON operator.');
        }
        $this->values->validate($value, $definition, 'query');
    }

    private function alias(string $alias): void
    {
        if (! preg_match('/^[A-Za-z][A-Za-z0-9_]{0,63}$/D', $alias)) {
            throw new ProtocolException('unsupported_query', 'Invalid declared alias.');
        }
    }

    private function field(ResourceExport $resource, mixed $field, bool $projection = false): void
    {
        if (! is_string($field) || ! in_array($field, $resource->readable(), true)) {
            throw new ProtocolException('unknown_field', 'Field is not readable: '.(is_string($field) ? $field : 'invalid'));
        }
        if (! $projection && in_array($field, $resource->materialized(), true)) {
            throw new ProtocolException('unsupported_query', 'Materialized PHP fields cannot execute in server SQL predicates or ordering.');
        }
    }

    private function relationName(ResourceExport $resource, string $name): void
    {
        if (! in_array($name, $resource->relations(), true)) {
            throw new ProtocolException('unknown_relation', 'Relation is not exported: '.$name);
        }
    }

    private function authorize(ResourceExport $resource, ActorContext $actor): void
    {
        if (! in_array('query', $resource->operations(), true) || ! $resource->authorize('query', $actor)) {
            throw new ProtocolException('forbidden_operation', 'Resource query is forbidden.', [], 403);
        }
    }
}

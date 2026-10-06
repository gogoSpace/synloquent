<?php

declare(strict_types=1);

namespace Synloquent\Laravel\Export;

use Illuminate\Contracts\Config\Repository;
use Illuminate\Contracts\Database\Query\Expression;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\BelongsToMany;
use Illuminate\Database\Eloquent\Relations\HasOne;
use Illuminate\Database\Eloquent\Relations\HasOneOrManyThrough;
use Illuminate\Database\Eloquent\Relations\MorphOne;
use Illuminate\Database\Eloquent\Relations\MorphTo;
use Illuminate\Database\Eloquent\Relations\MorphToMany;
use Illuminate\Database\Eloquent\Relations\Relation;
use ReflectionMethod;
use ReflectionNamedType;
use Synloquent\Laravel\Protocol\CanonicalJson;
use Synloquent\Laravel\Protocol\ProtocolException;
use Synloquent\Laravel\Query\ScopeRegistry;
use Synloquent\Laravel\Sync\CommandRegistry;

final class ManifestBuilder
{
    /** @var array<array-key, mixed>|null */
    private ?array $cached = null;

    public function __construct(private ExportRegistry $registry, private Repository $configuration, private ValueCodec $values, private ScopeRegistry $scopes, private CommandRegistry $commands) {}

    /** @return array<array-key, mixed> */
    public function build(): array
    {
        if ($this->cached !== null) {
            return $this->cached;
        }
        $models = [];
        foreach ($this->registry->all() as $resource) {
            $model = new ($resource->modelClass());
            $columns = array_column($model->getConnection()->getSchemaBuilder()->getColumns($model->getTable()), null, 'name');
            $fields = [];
            if (array_intersect($resource->materialized(), $resource->writable()) !== []) {
                throw new ProtocolException('schema_mismatch', 'Materialized fields must be read-only.');
            }
            foreach (array_unique([...$resource->readable(), ...$resource->writable()]) as $name) {
                if (! isset($columns[$name]) && ! isset($resource->fields()[$name])) {
                    throw new ProtocolException('schema_mismatch', 'Declare materialized field '.$resource->name().'.'.$name.' explicitly.');
                }
                $column = $columns[$name] ?? [];
                if (! isset($columns[$name]) && ! in_array($name, $resource->materialized(), true)) {
                    throw new ProtocolException('schema_mismatch', 'Declare nonphysical field as materialized: '.$resource->name().'.'.$name);
                }
                $cast = $model->getCasts()[$name] ?? null;
                if (str_starts_with($cast ?? '', 'encrypted')) {
                    throw new ProtocolException('forbidden_field', 'Encrypted fields cannot be exported: '.$resource->name().'.'.$name);
                }
                $declaration = $resource->fields()[$name] ?? $this->inferField($column, $cast, $resource->name().'.'.$name);
                $declaration['nullable'] ??= $column['nullable'] ?? false;
                $declaration['readable'] = in_array($name, $resource->readable(), true);
                $declaration['writable'] = in_array($name, $resource->writable(), true);
                if (in_array($name, $resource->materialized(), true)) {
                    $declaration['materialized'] = true;
                }
                if (array_key_exists($name, $model->getAttributes())) {
                    $declaration['default'] = $this->values->encode($model->getAttribute($name), $declaration, $cast);
                }
                $fields[$name] = $declaration;
            }
            if (! isset($fields[$model->getKeyName()]) || ! $fields[$model->getKeyName()]['readable']) {
                throw new ProtocolException('schema_mismatch', 'Export primary key '.$resource->name().'.'.$model->getKeyName().' as readable.');
            }
            ksort($fields);
            $relations = [];
            foreach ($resource->relations() as $name) {
                $method = new ReflectionMethod($model, $name);
                $returnType = $method->getReturnType();
                if (! $returnType instanceof ReflectionNamedType || ! is_a($returnType->getName(), Relation::class, true) || $method->getNumberOfRequiredParameters() > 0) {
                    throw new ProtocolException('unknown_relation', 'Exported relation requires a declared Eloquent relation return type: '.$resource->name().'.'.$name);
                }
                $relations[$name] = $this->relation($model->{$name}(), $resource->pivotFields($name));
            }
            ksort($relations);
            $indexes = array_filter($model->getConnection()->getSchemaBuilder()->getIndexes($model->getTable()), fn ($index) => array_diff($index['columns'], array_keys($fields)) === []);
            $definition = ['resource' => $resource->name(), 'table' => $model->getTable(), 'primaryKey' => $model->getKeyName(), 'keyType' => $model->getKeyType() === 'int' ? 'integer' : 'string', 'incrementing' => $model->getIncrementing(), 'fields' => $fields, 'relations' => $relations, 'operations' => $resource->operations(), 'unique' => [...array_values(array_map(fn ($index) => $index['columns'], array_filter($indexes, fn ($index) => $index['unique']))), ...$resource->localUnique()], 'indexes' => array_values(array_map(fn ($index) => $index['columns'], $indexes))];
            if ($model->usesTimestamps()) {
                $definition['timestamps'] = ['createdAt' => $model->getCreatedAtColumn(), 'updatedAt' => $model->getUpdatedAtColumn()];
            }
            if (method_exists($model, 'getDeletedAtColumn')) {
                $definition['softDeletes'] = $model->getDeletedAtColumn();
            }
            $models[$resource->name()] = $definition;
        }
        $commands = [];
        foreach ($this->commands->all() as $command) {
            $commands[$command->name()] = ['arguments' => $command->arguments(), 'result' => $command->result()];
        }
        $scopes = [];
        foreach ($this->scopes->all() as $scope) {
            $scopes[$scope->name()] = ['model' => $scope->model(), 'arguments' => $scope->arguments()];
        }
        $manifest = ['commands' => $commands, 'scopes' => $scopes, 'protocolVersion' => 1, 'releaseVersion' => '0.1.0', 'schemaVersion' => (int) $this->configuration->get('synloquent.schema_version', 1), 'capabilities' => ['query.v1', 'mutation.v1', 'sync.v1', 'snapshot.v1', 'relationSets.v1', 'json.scalar-array-contains.v1', 'json.scalar-path.v1', ...$this->configuration->get('synloquent.additional_capabilities', [])], 'models' => $models];

        return $this->cached = [...$manifest, 'fingerprint' => CanonicalJson::hash($manifest)];
    }

    /**
     * @param  array<array-key, mixed>  $column
     * @return array<array-key, mixed>
     */
    private function inferField(array $column, ?string $cast, string $name): array
    {
        $castType = explode(':', $cast ?? '')[0];
        if ($cast !== null && is_subclass_of($cast, \BackedEnum::class)) {
            return ['type' => 'enum', 'enum' => array_map(fn ($case) => $case->value, $cast::cases())];
        }
        $type = match ($castType) {
            'int', 'integer' => 'integer', 'bool', 'boolean' => 'boolean', 'float', 'double', 'real' => 'float', 'decimal' => 'decimal', 'string' => 'string', 'date', 'immutable_date' => 'date', 'datetime', 'immutable_datetime', 'timestamp' => 'datetime', 'array', 'json', 'object', 'collection' => 'json',
            '' => match ($column['type_name'] ?? '') {
                'int2', 'int4', 'int8', 'integer', 'bigint', 'smallint' => 'integer', 'bool', 'boolean' => 'boolean', 'float4', 'float8', 'real', 'double' => 'float', 'numeric', 'decimal' => 'decimal', 'date' => 'date', 'timestamp', 'timestamptz', 'datetime' => 'datetime', 'json', 'jsonb' => 'json', 'varchar', 'char', 'bpchar', 'text', 'uuid' => 'string',
                default => throw new ProtocolException('schema_mismatch', 'Declare field type for '.$name),
            },
            default => throw new ProtocolException('schema_mismatch', 'Declare read-only materialized type for custom cast '.$name),
        };
        $field = ['type' => $type];
        if ($type === 'decimal' && str_contains($cast ?? '', ':')) {
            $field['precision'] = (int) explode(':', $cast)[1];
        }

        return $field;
    }

    /**
     * @param  Relation<Model, Model, mixed>  $relation
     * @param  array<array-key, mixed>  $pivotFields
     * @return array<array-key, mixed>
     */
    private function relation(Relation $relation, array $pivotFields): array
    {
        $type = class_basename($relation);
        $relatedClass = $relation->getRelated()::class;
        if ($relation instanceof MorphTo) {
            $map = Relation::morphMap();
            if ($map === []) {
                throw new ProtocolException('schema_mismatch', 'morphTo requires an explicit morph map.');
            }
            $relatedClass = reset($map);
        }
        $definition = ['type' => lcfirst($type), 'model' => $this->registry->nameForClass($relatedClass)];
        if ($relation instanceof MorphToMany && $relation->getInverse()) {
            $definition['type'] = 'morphedByMany';
        }
        if ($relation instanceof HasOneOrManyThrough) {
            $through = (new \ReflectionProperty($relation, 'throughParent'))->getValue($relation);
            if (! $through instanceof Model) {
                throw new ProtocolException('schema_mismatch', 'Cannot infer through model.');
            }
            $definition['through'] = $this->registry->nameForClass($through::class);
            $definition['secondKey'] = $relation->getForeignKeyName();
            $definition['foreignKey'] = $relation->getFirstKeyName();
        }
        foreach (['getForeignKeyName' => 'foreignKey', 'getLocalKeyName' => 'localKey', 'getOwnerKeyName' => 'ownerKey', 'getSecondLocalKeyName' => 'secondLocalKey', 'getSecondKeyName' => 'secondKey', 'getMorphType' => 'morphType'] as $method => $key) {
            if (method_exists($relation, $method)) {
                if ($key !== 'foreignKey' || ! $relation instanceof HasOneOrManyThrough) {
                    $value = $relation->{$method}();
                    if ($value !== null) {
                        $definition[$key] = $value;
                    }
                }
            }
        }
        if ($relation instanceof BelongsTo && ! $relation instanceof MorphTo) {
            foreach ($relation->getParent()->getConnection()->getSchemaBuilder()->getForeignKeys($relation->getParent()->getTable()) as $foreignKey) {
                if ($foreignKey['columns'] !== [$relation->getForeignKeyName()] || $foreignKey['foreign_table'] !== $relation->getRelated()->getTable()) {
                    continue;
                }
                $onDelete = match ($foreignKey['on_delete']) {
                    'cascade' => 'cascade', 'set null' => 'nullify', 'restrict', 'no action' => 'restrict', default => null
                };
                $onUpdate = match ($foreignKey['on_update']) {
                    'cascade' => 'cascade', 'restrict', 'no action' => 'restrict', default => null
                };
                if ($onDelete !== null) {
                    $definition['onDelete'] = $onDelete;
                }
                if ($onUpdate !== null) {
                    $definition['onUpdate'] = $onUpdate;
                }
            }
        }
        if ($relation instanceof BelongsToMany) {
            $definition['pivot'] = ['table' => $relation->getTable(), 'foreignKey' => $relation->getForeignPivotKeyName(), 'relatedKey' => $relation->getRelatedPivotKeyName(), 'fields' => []];
            foreach ($relation->getPivotColumns() as $column) {
                if (! isset($pivotFields[$column])) {
                    throw new ProtocolException('schema_mismatch', 'Declare exported pivot field '.$relation->getTable().'.'.$column);
                }
                $definition['pivot']['fields'][$column] = $pivotFields[$column];
            }
            $definition['localKey'] = $relation->getParentKeyName();
            $definition['ownerKey'] = $relation->getRelatedKeyName();
        }
        if (isset($definition['morphType'])) {
            $definition['morphType'] = last(explode('.', $definition['morphType']));
        }
        if (str_starts_with($type, 'Morph')) {
            $definition['morphMap'] = array_map($this->registry->nameForClass(...), Relation::morphMap());
        }
        if (($relation instanceof HasOne || $relation instanceof MorphOne) && $relation->isOneOfMany()) {
            $sequence = $this->oneOfMany($relation->getQuery(), $relation);
            if ($sequence === []) {
                throw new ProtocolException('schema_mismatch', 'Cannot infer a deterministic ofMany aggregate.');
            }
            $definition['oneOfMany'] = $sequence;
            $definition['aggregate'] = $sequence[0]['aggregate'];
            $definition['aggregateField'] = $sequence[0]['field'];
        }

        return $definition;
    }

    /**
     * @param  Builder<Model>  $query
     * @param  Relation<Model, Model, mixed>  $relation
     * @return list<array{field: string, aggregate: string}>
     */
    private function oneOfMany(Builder $query, Relation $relation): array
    {
        $sequence = [];
        foreach ($query->getQuery()->beforeQueryCallbacks as $callback) {
            if (! $callback instanceof \Closure) {
                continue;
            }
            $reflection = new \ReflectionFunction($callback);
            $subquery = $reflection->getStaticVariables()['subQuery'] ?? null;
            if ($reflection->getClosureThis() === $relation && $subquery instanceof Builder) {
                array_push($sequence, ...$this->oneOfMany($subquery, $relation));
            }
        }
        foreach ($query->getQuery()->columns ?? [] as $column) {
            $expression = $column instanceof Expression ? $column->getValue($query->getQuery()->getGrammar()) : $column;
            if (preg_match('/^(min|max)\([^)]*"([A-Za-z_][A-Za-z0-9_]*)"\)\s+as\s+/i', $expression, $match)) {
                $sequence[] = ['field' => $match[2], 'aggregate' => strtolower($match[1])];
                break;
            }
        }

        return $sequence;
    }
}

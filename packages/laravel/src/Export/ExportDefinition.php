<?php

declare(strict_types=1);

namespace Synloquent\Laravel\Export;

use Illuminate\Contracts\Auth\Access\Gate;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use Synloquent\Laravel\Contracts\ResourceExport;
use Synloquent\Laravel\Sync\ActorContext;

abstract class ExportDefinition implements ResourceExport
{
    public function __construct(protected Gate $gate, protected ValueCodec $values) {}

    /** @return list<string> */
    public function writable(): array
    {
        return [];
    }

    /** @return list<string> */
    public function relations(): array
    {
        return [];
    }

    /** @return array<array-key, mixed> */
    public function fields(): array
    {
        return [];
    }

    /** @return list<string> */
    public function materialized(): array
    {
        return [];
    }

    public function selfContainedProjection(): bool
    {
        return false;
    }

    public function captureStream(Model $model): ?string
    {
        return null;
    }

    /** @return list<list<string>> */
    public function localUnique(): array
    {
        return [];
    }

    /** @return array<array-key, mixed> */
    public function pivotFields(string $relation): array
    {
        return [];
    }

    public function prepare(Model $model, ActorContext $actor): void {}

    /** @return list<string> */
    public function operations(): array
    {
        return ['query'];
    }

    /** @return array<array-key, mixed> */
    public function rules(string $operation): array
    {
        return [];
    }

    /** @param Builder<Model> $query */
    public function scope(Builder $query, ActorContext $actor): void {}

    public function authorize(string $operation, ActorContext $actor, ?Model $model = null): bool
    {
        return $actor->user !== null && $this->gate->forUser($actor->user)->allows($operation === 'query' ? 'viewAny' : $operation, $model ?? $this->modelClass());
    }

    /** @return array<array-key, mixed> */
    public function project(Model $model, ActorContext $actor): array
    {
        $projection = [];
        foreach ($this->readable() as $field) {
            if (! array_key_exists($field, $model->getAttributes()) && ! $model->hasGetMutator($field) && ! $model->hasAttributeGetMutator($field)) {
                continue;
            }
            $projection[$field] = $this->values->modelAttribute($model, $field, $this->fields()[$field] ?? null);
        }

        return $projection;
    }
}

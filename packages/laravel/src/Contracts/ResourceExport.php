<?php

declare(strict_types=1);

namespace Synloquent\Laravel\Contracts;

use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use Synloquent\Laravel\Sync\ActorContext;

interface ResourceExport
{
    public function name(): string;

    /** @return class-string<Model> */
    public function modelClass(): string;

    /** @return list<string> */
    public function readable(): array;

    /** @return list<string> */
    public function writable(): array;

    /** @return list<string> */
    public function relations(): array;

    /** @return array<array-key, mixed> */
    public function fields(): array;

    /** @return list<string> */
    public function materialized(): array;

    public function selfContainedProjection(): bool;

    public function captureStream(Model $model): ?string;

    /** @return list<list<string>> */
    public function localUnique(): array;

    /** @return array<array-key, mixed> */
    public function pivotFields(string $relation): array;

    public function prepare(Model $model, ActorContext $actor): void;

    /** @return list<string> */
    public function operations(): array;

    /** @return array<array-key, mixed> */
    public function rules(string $operation): array;

    /** @param Builder<Model> $query */
    public function scope(Builder $query, ActorContext $actor): void;

    public function authorize(string $operation, ActorContext $actor, ?Model $model = null): bool;

    /** @return array<array-key, mixed> */
    public function project(Model $model, ActorContext $actor): array;
}

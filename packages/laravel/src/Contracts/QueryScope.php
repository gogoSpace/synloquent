<?php

declare(strict_types=1);

namespace Synloquent\Laravel\Contracts;

use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use Synloquent\Laravel\Sync\ActorContext;

interface QueryScope
{
    public function name(): string;

    public function model(): string;

    /** @return array<string, array<string, mixed>> */
    public function arguments(): array;

    /** @return array<string, mixed> */
    public function rules(): array;

    public function authorize(ActorContext $actor): bool;

    /**
     * @param  Builder<Model>  $query
     * @param  array<string, mixed>  $arguments
     */
    public function apply(Builder $query, array $arguments, ActorContext $actor): void;
}

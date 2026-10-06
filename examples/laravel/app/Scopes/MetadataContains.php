<?php

declare(strict_types=1);

namespace App\Scopes;

use Illuminate\Database\Eloquent\Builder;
use Synloquent\Laravel\Contracts\QueryScope;
use Synloquent\Laravel\Sync\ActorContext;

final class MetadataContains implements QueryScope
{
    public function name(): string
    {
        return 'metadataContains';
    }

    public function model(): string
    {
        return 'Item';
    }

    public function arguments(): array
    {
        return ['value' => ['type' => 'json', 'nullable' => false, 'readable' => true, 'writable' => false]];
    }

    public function rules(): array
    {
        return ['value' => ['required', 'array']];
    }

    public function authorize(ActorContext $actor): bool
    {
        return $actor->user !== null;
    }

    public function apply(Builder $query, array $arguments, ActorContext $actor): void
    {
        $query->whereJsonContains($query->getModel()->qualifyColumn('metadata'), $arguments['value']);
    }
}

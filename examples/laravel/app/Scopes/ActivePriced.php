<?php

declare(strict_types=1);

namespace App\Scopes;

use Illuminate\Database\Eloquent\Builder;
use Synloquent\Laravel\Contracts\QueryScope;
use Synloquent\Laravel\Sync\ActorContext;

final class ActivePriced implements QueryScope
{
    public function name(): string
    {
        return 'activePriced';
    }

    public function model(): string
    {
        return 'Item';
    }

    public function arguments(): array
    {
        return ['minimumPrice' => ['type' => 'decimal', 'precision' => 2, 'nullable' => false, 'readable' => true, 'writable' => true]];
    }

    public function rules(): array
    {
        return ['minimumPrice' => ['required', 'numeric', 'min:0']];
    }

    public function authorize(ActorContext $actor): bool
    {
        return $actor->tenantId === '1';
    }

    public function apply(Builder $query, array $arguments, ActorContext $actor): void
    {
        $query->where('active', true)->where('price', '>=', $arguments['minimumPrice']);
    }
}

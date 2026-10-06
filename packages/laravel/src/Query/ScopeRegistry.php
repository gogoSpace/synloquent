<?php

declare(strict_types=1);

namespace Synloquent\Laravel\Query;

use Synloquent\Laravel\Contracts\QueryScope;
use Synloquent\Laravel\Protocol\ProtocolException;

final class ScopeRegistry
{
    /** @var array<string, QueryScope> */
    private array $scopes = [];

    public function register(QueryScope $scope): void
    {
        $this->scopes[$scope->name()] = $scope;
    }

    public function get(string $name): QueryScope
    {
        return $this->scopes[$name] ?? throw new ProtocolException('unsupported_query', 'Query scope is not registered.');
    }

    /** @return array<string, QueryScope> */
    public function all(): array
    {
        $scopes = $this->scopes;
        ksort($scopes);

        return $scopes;
    }
}

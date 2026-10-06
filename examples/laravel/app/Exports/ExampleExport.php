<?php

declare(strict_types=1);

namespace App\Exports;

use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use Synloquent\Laravel\Export\ExportDefinition;
use Synloquent\Laravel\Sync\ActorContext;

abstract class ExampleExport extends ExportDefinition
{
    public function selfContainedProjection(): bool
    {
        return true;
    }

    public function captureStream(Model $model): ?string
    {
        $tenant = $model->getAttribute('tenant_id');

        return $tenant === null ? null : hash('sha256', (string) $tenant);
    }

    public function operations(): array
    {
        return ['query', 'create', 'update', 'delete', 'increment', 'pivot'];
    }

    public function scope(Builder $query, ActorContext $actor): void
    {
        $query->where($query->getModel()->qualifyColumn('tenant_id'), (int) $actor->tenantId);
    }

    public function prepare(Model $model, ActorContext $actor): void
    {
        $model->tenant_id = (int) $actor->tenantId;
    }
}

<?php

declare(strict_types=1);

namespace App\Policies;

use App\Models\User;
use Illuminate\Database\Eloquent\Model;

final class CatalogPolicy
{
    public function viewAny(User $actor): bool
    {
        return $actor->tenant_id === 1;
    }

    public function create(User $actor): bool
    {
        return $actor->tenant_id === 1;
    }

    public function update(User $actor, Model $model): bool
    {
        return $model->tenant_id === $actor->tenant_id && (! isset($model->actor_id) || $model->actor_id === $actor->id);
    }

    public function delete(User $actor, Model $model): bool
    {
        return $this->update($actor, $model);
    }

    public function restore(User $actor, Model $model): bool
    {
        return $this->update($actor, $model);
    }

    public function forceDelete(User $actor, Model $model): bool
    {
        return $this->update($actor, $model);
    }

    public function increment(User $actor, Model $model): bool
    {
        return $this->update($actor, $model);
    }

    public function pivot(User $actor, Model $model): bool
    {
        return $this->update($actor, $model);
    }
}

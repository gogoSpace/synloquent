<?php

namespace App\Exports;

use App\Models\CollectionEntry;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use Synloquent\Laravel\Sync\ActorContext;

final class CollectionEntryExport extends ExampleExport
{
    public function name(): string
    {
        return 'CollectionEntry';
    }

    public function modelClass(): string
    {
        return CollectionEntry::class;
    }

    public function localUnique(): array
    {
        return [['item_id']];
    }

    public function readable(): array
    {
        return ['id', 'item_id', 'acquired_on', 'note', 'created_at', 'updated_at'];
    }

    public function writable(): array
    {
        return ['item_id', 'acquired_on', 'note'];
    }

    public function relations(): array
    {
        return ['item'];
    }

    public function scope(Builder $query, ActorContext $actor): void
    {
        parent::scope($query, $actor);
        $query->where('actor_id', (int) $actor->actorId);
    }

    public function prepare(Model $model, ActorContext $actor): void
    {
        parent::prepare($model, $actor);
        $model->actor_id = (int) $actor->actorId;
    }
}

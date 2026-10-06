<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

final class CollectionEntry extends Model
{
    protected $fillable = ['tenant_id', 'actor_id', 'item_id', 'acquired_on', 'note'];

    protected function casts(): array
    {
        return ['acquired_on' => 'date', 'tenant_id' => 'integer', 'actor_id' => 'integer'];
    }

    public function item(): BelongsTo
    {
        return $this->belongsTo(Item::class);
    }
}

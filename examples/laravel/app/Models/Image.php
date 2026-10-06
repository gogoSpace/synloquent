<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

final class Image extends Model
{
    protected $fillable = ['tenant_id', 'item_id', 'url'];

    public function item(): BelongsTo
    {
        return $this->belongsTo(Item::class);
    }
}

<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsToMany;
use Illuminate\Database\Eloquent\Relations\MorphToMany;

final class Tag extends Model
{
    protected $fillable = ['tenant_id', 'title'];

    public function items(): BelongsToMany
    {
        return $this->belongsToMany(Item::class)->withPivot('position');
    }

    public function classifiedItems(): MorphToMany
    {
        return $this->morphedByMany(Item::class, 'taggable')->withPivot('position');
    }
}

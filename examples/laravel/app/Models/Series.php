<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\HasMany;

final class Series extends Model
{
    protected $fillable = ['title', 'tenant_id'];

    protected $table = 'series';

    public function items(): HasMany
    {
        return $this->hasMany(Item::class);
    }
}

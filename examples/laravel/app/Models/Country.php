<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\HasMany;

final class Country extends Model
{
    protected $fillable = ['title', 'tenant_id'];

    public function locations(): HasMany
    {
        return $this->hasMany(Location::class);
    }
}

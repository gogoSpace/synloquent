<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Database\Eloquent\Relations\HasManyThrough;
use Illuminate\Database\Eloquent\Relations\HasOneThrough;
use Illuminate\Database\Eloquent\Relations\MorphMany;

final class Category extends Model
{
    protected $fillable = ['title', 'tenant_id'];

    public function items(): HasMany
    {
        return $this->hasMany(Item::class);
    }

    public function imagesThrough(): HasManyThrough
    {
        return $this->hasManyThrough(Image::class, Item::class);
    }

    public function firstImageThrough(): HasOneThrough
    {
        return $this->hasOneThrough(Image::class, Item::class);
    }

    public function notes(): MorphMany
    {
        return $this->morphMany(Note::class, 'notable');
    }
}

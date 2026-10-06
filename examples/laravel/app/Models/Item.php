<?php

namespace App\Models;

use App\Casts\CatalogCode;
use App\Enums\ItemStatus;
use Illuminate\Database\Eloquent\Casts\Attribute;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\BelongsToMany;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Database\Eloquent\Relations\HasOne;
use Illuminate\Database\Eloquent\Relations\MorphMany;
use Illuminate\Database\Eloquent\Relations\MorphOne;
use Illuminate\Database\Eloquent\Relations\MorphToMany;
use Synloquent\Laravel\Concerns\PreservesJsonTypes;

/**
 * @property string $title
 * @property ItemStatus $status
 */
final class Item extends Model
{
    use PreservesJsonTypes;

    protected $attributes = ['price' => '0.00', 'active' => true, 'quantity' => 0, 'metadata' => null, 'labels' => null, 'status' => 'draft'];

    protected $fillable = ['title', 'tenant_id', 'category_id', 'price', 'active', 'quantity', 'metadata', 'labels', 'item_type_id', 'series_id', 'location_id', 'status', 'catalog_code', 'published_on', 'released_at', 'latitude'];

    protected $appends = ['display_label'];

    protected function casts(): array
    {
        return ['price' => 'decimal:2', 'active' => 'boolean', 'quantity' => 'integer', 'metadata' => 'array', 'labels' => 'array', 'tenant_id' => 'integer', 'status' => ItemStatus::class, 'catalog_code' => CatalogCode::class, 'published_on' => 'date', 'released_at' => 'immutable_datetime', 'latitude' => 'float'];
    }

    /** @return BelongsTo<Category, $this> */
    public function category(): BelongsTo
    {
        return $this->belongsTo(Category::class);
    }

    /** @return HasMany<Image, $this> */
    public function images(): HasMany
    {
        return $this->hasMany(Image::class);
    }

    /** @return BelongsToMany<Tag, $this> */
    public function tags(): BelongsToMany
    {
        return $this->belongsToMany(Tag::class)->withPivot('position');
    }

    /** @return HasOne<Image, $this> */
    public function latestImage(): HasOne
    {
        return $this->hasOne(Image::class)->latestOfMany();
    }

    /** @return Attribute<non-falsy-string, never> */
    protected function displayLabel(): Attribute
    {
        return Attribute::get(fn () => $this->title.' / '.$this->status->value);
    }

    /** @return BelongsTo<ItemType, $this> */
    public function itemType(): BelongsTo
    {
        return $this->belongsTo(ItemType::class);
    }

    /** @return BelongsTo<Series, $this> */
    public function series(): BelongsTo
    {
        return $this->belongsTo(Series::class);
    }

    /** @return BelongsTo<Location, $this> */
    public function location(): BelongsTo
    {
        return $this->belongsTo(Location::class);
    }

    /** @return BelongsToMany<Salespoint, $this> */
    public function salespoints(): BelongsToMany
    {
        return $this->belongsToMany(Salespoint::class, 'item_salespoint')->withPivot(['id', 'position']);
    }

    /** @return MorphMany<Note, $this> */
    public function notes(): MorphMany
    {
        return $this->morphMany(Note::class, 'notable');
    }

    /** @return MorphOne<Note, $this> */
    public function firstNote(): MorphOne
    {
        return $this->morphOne(Note::class, 'notable');
    }

    /** @return MorphToMany<Tag, $this> */
    public function classifications(): MorphToMany
    {
        return $this->morphToMany(Tag::class, 'taggable')->withPivot('position');
    }
}

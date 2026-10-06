<?php

namespace App\Exports;

use App\Models\Item;

final class ItemExport extends ExampleExport
{
    public function name(): string
    {
        return 'Item';
    }

    public function modelClass(): string
    {
        return Item::class;
    }

    public function readable(): array
    {
        return ['id', 'category_id', 'title', 'price', 'active', 'quantity', 'metadata', 'labels', 'item_type_id', 'series_id', 'location_id', 'status', 'catalog_code', 'published_on', 'released_at', 'latitude', 'display_label', 'created_at', 'updated_at'];
    }

    public function writable(): array
    {
        return ['category_id', 'title', 'price', 'active', 'quantity', 'metadata', 'labels', 'item_type_id', 'series_id', 'location_id', 'status', 'catalog_code', 'published_on', 'released_at', 'latitude'];
    }

    public function relations(): array
    {
        return ['category', 'images', 'tags', 'latestImage', 'notes', 'firstNote', 'classifications', 'itemType', 'series', 'location', 'salespoints'];
    }

    public function rules(string $operation): array
    {
        return ['title' => [$operation === 'create' ? 'required' : 'sometimes', 'string', 'max:255']];
    }

    public function pivotFields(string $relation): array
    {
        if ($relation === 'salespoints') {
            return ['id' => ['type' => 'integer', 'nullable' => false, 'readable' => true, 'writable' => false], 'position' => ['type' => 'integer', 'nullable' => false, 'readable' => true, 'writable' => true]];
        }

        return in_array($relation, ['tags', 'classifications'], true) ? ['position' => ['type' => 'integer', 'nullable' => false, 'readable' => true, 'writable' => true]] : [];
    }

    public function materialized(): array
    {
        return ['display_label'];
    }

    public function fields(): array
    {
        return ['catalog_code' => ['type' => 'string', 'nullable' => true], 'display_label' => ['type' => 'string', 'nullable' => false], 'latitude' => ['type' => 'float', 'nullable' => true, 'precision' => 6]];
    }
}

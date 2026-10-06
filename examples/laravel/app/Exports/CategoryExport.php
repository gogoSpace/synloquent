<?php

namespace App\Exports;

use App\Models\Category;

final class CategoryExport extends ExampleExport
{
    public function name(): string
    {
        return 'Category';
    }

    public function modelClass(): string
    {
        return Category::class;
    }

    public function readable(): array
    {
        return ['id', 'title', 'created_at', 'updated_at'];
    }

    public function writable(): array
    {
        return ['title'];
    }

    public function relations(): array
    {
        return ['items', 'imagesThrough', 'firstImageThrough', 'notes'];
    }
}

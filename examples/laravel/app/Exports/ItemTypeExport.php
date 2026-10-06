<?php

namespace App\Exports;

use App\Models\ItemType;

final class ItemTypeExport extends ExampleExport
{
    public function name(): string
    {
        return 'ItemType';
    }

    public function modelClass(): string
    {
        return ItemType::class;
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
        return ['items'];
    }
}

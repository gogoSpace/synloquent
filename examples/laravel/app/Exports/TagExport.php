<?php

namespace App\Exports;

use App\Models\Tag;

final class TagExport extends ExampleExport
{
    public function name(): string
    {
        return 'Tag';
    }

    public function modelClass(): string
    {
        return Tag::class;
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
        return ['items', 'classifiedItems'];
    }

    public function pivotFields(string $relation): array
    {
        return ['position' => ['type' => 'integer', 'nullable' => false, 'readable' => true, 'writable' => true]];
    }
}

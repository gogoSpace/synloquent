<?php

namespace App\Exports;

use App\Models\Series;

final class SeriesExport extends ExampleExport
{
    public function name(): string
    {
        return 'Series';
    }

    public function modelClass(): string
    {
        return Series::class;
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

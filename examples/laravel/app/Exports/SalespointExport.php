<?php

namespace App\Exports;

use App\Models\Salespoint;

final class SalespointExport extends ExampleExport
{
    public function name(): string
    {
        return 'Salespoint';
    }

    public function modelClass(): string
    {
        return Salespoint::class;
    }

    public function readable(): array
    {
        return ['id', 'title', 'location_id', 'created_at', 'updated_at'];
    }

    public function writable(): array
    {
        return ['title', 'location_id'];
    }

    public function relations(): array
    {
        return ['location', 'items'];
    }

    public function pivotFields(string $relation): array
    {
        return $relation === 'items' ? ['id' => ['type' => 'integer', 'nullable' => false, 'readable' => true, 'writable' => false], 'position' => ['type' => 'integer', 'nullable' => false, 'readable' => true, 'writable' => true]] : [];
    }
}

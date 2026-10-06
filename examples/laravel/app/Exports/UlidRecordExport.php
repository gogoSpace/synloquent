<?php

namespace App\Exports;

use App\Models\UlidRecord;

final class UlidRecordExport extends ExampleExport
{
    public function name(): string
    {
        return 'UlidRecord';
    }

    public function modelClass(): string
    {
        return UlidRecord::class;
    }

    public function readable(): array
    {
        return ['id', 'title', 'created_at', 'updated_at'];
    }

    public function writable(): array
    {
        return ['id', 'title'];
    }
}

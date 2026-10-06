<?php

namespace App\Exports;

use App\Models\UuidRecord;

final class UuidRecordExport extends ExampleExport
{
    public function name(): string
    {
        return 'UuidRecord';
    }

    public function modelClass(): string
    {
        return UuidRecord::class;
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

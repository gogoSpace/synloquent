<?php

namespace App\Exports;

use App\Models\ExternalRecord;

final class ExternalRecordExport extends ExampleExport
{
    public function name(): string
    {
        return 'ExternalRecord';
    }

    public function modelClass(): string
    {
        return ExternalRecord::class;
    }

    public function readable(): array
    {
        return ['external_key', 'title', 'created_at', 'updated_at'];
    }

    public function writable(): array
    {
        return ['external_key', 'title'];
    }
}

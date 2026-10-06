<?php

namespace App\Exports;

use App\Models\Location;

final class LocationExport extends ExampleExport
{
    public function name(): string
    {
        return 'Location';
    }

    public function modelClass(): string
    {
        return Location::class;
    }

    public function readable(): array
    {
        return ['id', 'title', 'country_id', 'created_at', 'updated_at'];
    }

    public function writable(): array
    {
        return ['title', 'country_id'];
    }

    public function relations(): array
    {
        return ['country', 'items', 'salespoints'];
    }
}

<?php

namespace App\Exports;

use App\Models\Country;

final class CountryExport extends ExampleExport
{
    public function name(): string
    {
        return 'Country';
    }

    public function modelClass(): string
    {
        return Country::class;
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
        return ['locations'];
    }
}

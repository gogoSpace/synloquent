<?php

namespace App\Exports;

use App\Models\Image;

final class ImageExport extends ExampleExport
{
    public function name(): string
    {
        return 'Image';
    }

    public function modelClass(): string
    {
        return Image::class;
    }

    public function readable(): array
    {
        return ['id', 'item_id', 'url', 'created_at', 'updated_at'];
    }

    public function writable(): array
    {
        return ['item_id', 'url'];
    }

    public function relations(): array
    {
        return ['item'];
    }
}

<?php

namespace App\Exports;

use App\Models\Note;

final class NoteExport extends ExampleExport
{
    public function name(): string
    {
        return 'Note';
    }

    public function modelClass(): string
    {
        return Note::class;
    }

    public function readable(): array
    {
        return ['id', 'notable_id', 'notable_type', 'body', 'deleted_at', 'created_at', 'updated_at'];
    }

    public function writable(): array
    {
        return ['notable_id', 'notable_type', 'body'];
    }

    public function relations(): array
    {
        return ['notable'];
    }

    public function operations(): array
    {
        return [...parent::operations(), 'restore', 'forceDelete'];
    }
}

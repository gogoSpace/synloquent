<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\MorphTo;
use Illuminate\Database\Eloquent\SoftDeletes;

final class Note extends Model
{
    use SoftDeletes;

    protected $fillable = ['tenant_id', 'notable_id', 'notable_type', 'body'];

    public function notable(): MorphTo
    {
        return $this->morphTo();
    }
}

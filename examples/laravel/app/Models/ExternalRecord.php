<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

final class ExternalRecord extends Model
{
    protected $primaryKey = 'external_key';

    protected $keyType = 'string';

    public $incrementing = false;

    protected $fillable = ['external_key', 'title', 'tenant_id'];
}

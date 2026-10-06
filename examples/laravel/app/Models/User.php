<?php

namespace App\Models;

use Illuminate\Foundation\Auth\User as Authenticatable;

final class User extends Authenticatable
{
    protected $fillable = ['name', 'tenant_id'];

    public $timestamps = false;

    protected function casts(): array
    {
        return ['tenant_id' => 'integer'];
    }
}

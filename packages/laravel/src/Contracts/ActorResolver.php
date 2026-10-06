<?php

declare(strict_types=1);

namespace Synloquent\Laravel\Contracts;

use Illuminate\Http\Request;
use Synloquent\Laravel\Sync\ActorContext;

interface ActorResolver
{
    public function resolve(Request $request): ActorContext;
}

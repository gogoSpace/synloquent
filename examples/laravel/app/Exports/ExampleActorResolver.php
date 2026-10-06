<?php

declare(strict_types=1);

namespace App\Exports;

use App\Models\User;
use Illuminate\Http\Request;
use Synloquent\Laravel\Contracts\ActorResolver;
use Synloquent\Laravel\Protocol\ProtocolException;
use Synloquent\Laravel\Sync\ActorContext;

final class ExampleActorResolver implements ActorResolver
{
    public function resolve(Request $request): ActorContext
    {
        $token = $request->bearerToken();
        $identity = $token === 'synthetic-actor-2' ? '2' : ($token === 'synthetic-actor-1' ? '1' : $request->header('X-Synloquent-Actor'));
        if (! in_array($identity, ['1', '2'], true)) {
            throw new ProtocolException('forbidden_operation', 'Synthetic example requires its documented local actor token.', [], 401);
        }
        $user = User::find($identity);
        if ($user === null) {
            throw new ProtocolException('forbidden_operation', 'Run the synthetic seed first.', [], 401);
        }

        return new ActorContext($identity, '1', $request->header('X-Synloquent-Device-Epoch', 'epoch-1'), '1', $user, $request->header('X-Synloquent-Device', 'example-device'));
    }
}

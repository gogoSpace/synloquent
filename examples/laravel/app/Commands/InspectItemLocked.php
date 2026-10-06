<?php

declare(strict_types=1);

namespace App\Commands;

use App\Models\Item;
use Synloquent\Laravel\Contracts\ServerCommand;
use Synloquent\Laravel\Protocol\ProtocolException;
use Synloquent\Laravel\Sync\ActorContext;
use Synloquent\Laravel\Sync\WriteContext;

final class InspectItemLocked implements ServerCommand
{
    public function name(): string
    {
        return 'inspectItemLocked';
    }

    public function arguments(): array
    {
        return ['item_id' => ['type' => 'integer', 'nullable' => false, 'readable' => true, 'writable' => true], 'mode' => ['type' => 'enum', 'enum' => ['update', 'shared'], 'nullable' => false, 'readable' => true, 'writable' => true]];
    }

    public function result(): array
    {
        return ['quantity' => ['type' => 'integer', 'nullable' => false, 'readable' => true, 'writable' => false], 'lockMode' => ['type' => 'enum', 'enum' => ['update', 'shared'], 'nullable' => false, 'readable' => true, 'writable' => false]];
    }

    public function argumentRules(): array
    {
        return ['item_id' => ['required', 'integer', 'min:1'], 'mode' => ['required', 'in:update,shared']];
    }

    public function resultRules(): array
    {
        return ['quantity' => ['required', 'integer'], 'lockMode' => ['required', 'in:update,shared']];
    }

    public function authorize(ActorContext $actor): bool
    {
        return $actor->actorId === '1';
    }

    public function replay(array $result, ActorContext $actor): ?array
    {
        return $this->authorize($actor) ? $result : null;
    }

    public function execute(array $arguments, WriteContext $context): array
    {
        $query = Item::where('tenant_id', (int) $context->actor->tenantId);
        $arguments['mode'] === 'update' ? $query->lockForUpdate() : $query->sharedLock();
        $item = $query->find($arguments['item_id']);
        if ($item === null) {
            throw new ProtocolException('forbidden_operation', 'Locked target is outside the authorized scope.', [], 403);
        }

        return ['quantity' => $item->quantity, 'lockMode' => $arguments['mode']];
    }
}

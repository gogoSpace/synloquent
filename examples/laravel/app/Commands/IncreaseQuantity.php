<?php

declare(strict_types=1);

namespace App\Commands;

use App\Models\Item;
use Illuminate\Support\Facades\Gate;
use Synloquent\Laravel\Contracts\ServerCommand;
use Synloquent\Laravel\Protocol\ProtocolException;
use Synloquent\Laravel\Sync\ActorContext;
use Synloquent\Laravel\Sync\WriteContext;

final class IncreaseQuantity implements ServerCommand
{
    public function name(): string
    {
        return 'increaseQuantity';
    }

    public function arguments(): array
    {
        return ['item_id' => ['type' => 'integer', 'nullable' => false, 'readable' => true, 'writable' => true], 'delta' => ['type' => 'integer', 'nullable' => false, 'readable' => true, 'writable' => true]];
    }

    public function result(): array
    {
        return ['quantity' => ['type' => 'integer', 'nullable' => false, 'readable' => true, 'writable' => false]];
    }

    public function argumentRules(): array
    {
        return ['item_id' => ['required', 'integer', 'min:1'], 'delta' => ['required', 'integer', 'between:-100,100']];
    }

    public function resultRules(): array
    {
        return ['quantity' => ['required', 'integer']];
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
        $item = Item::where('tenant_id', (int) $context->actor->tenantId)->lockForUpdate()->find($arguments['item_id']);
        if ($item === null || ! Gate::forUser($context->actor->user)->allows('update', $item)) {
            throw new ProtocolException('forbidden_operation', 'Quantity target is outside the authorized scope.', [], 403);
        }
        $item->increment('quantity', $arguments['delta']);
        $item->refresh();
        $record = $context->capture($item);
        $context->effect('quantityChanged', 'item-'.$item->id.'-revision-'.$record['revision'], ['item_id' => $item->id, 'quantity' => $item->quantity]);

        return ['quantity' => $item->quantity];
    }
}

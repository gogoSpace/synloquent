<?php

declare(strict_types=1);

namespace Synloquent\Laravel\Sync;

final class EffectDelivery
{
    /** @var callable|null */
    private $afterDelivery = null;

    public function __construct(private SyncDatabase $database, private EffectRegistry $destinations) {}

    public function afterDelivery(?callable $hook): void
    {
        $this->afterDelivery = $hook;
    }

    public function deliverOne(): bool
    {
        return $this->database->connection()->transaction(function (): bool {
            $table = $this->database->connection()->table('synloquent_effects');
            $effect = (clone $table)->whereNull('delivered_at')->orderBy('id')->lock('FOR UPDATE SKIP LOCKED')->first();
            if ($effect === null) {
                return false;
            }
            $destination = $this->destinations->get($effect->name);
            $destination->deliver($effect->idempotency_key, json_decode($effect->payload, true, flags: JSON_THROW_ON_ERROR));
            if ($this->afterDelivery !== null) {
                ($this->afterDelivery)($effect->id);
            }
            $table->where('id', $effect->id)->update(['attempts' => $effect->attempts + 1, 'delivered_at' => now()]);

            return true;
        });
    }
}

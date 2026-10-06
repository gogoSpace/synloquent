<?php

declare(strict_types=1);

namespace Synloquent\Laravel\Commands;

use Illuminate\Console\Command;
use Synloquent\Laravel\Sync\EffectDelivery;

final class DeliverEffectsCommand extends Command
{
    protected $signature = 'synloquent:deliver-effects {--limit=100}';

    protected $description = 'Deliver committed durable effects through registered destinations';

    public function handle(EffectDelivery $effects): int
    {
        $limit = filter_var($this->option('limit'), FILTER_VALIDATE_INT, ['options' => ['min_range' => 1, 'max_range' => 1000]]);
        if ($limit === false) {
            $this->error('Effect limit must be between 1 and 1000.');

            return self::FAILURE;
        }
        for ($count = 0; $count < $limit && $effects->deliverOne(); $count++) {
        }
        $this->info('Delivered '.$count.' effects.');

        return self::SUCCESS;
    }
}

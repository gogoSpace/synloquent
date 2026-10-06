<?php

declare(strict_types=1);

namespace Synloquent\Laravel\Commands;

use Illuminate\Console\Command;
use Synloquent\Laravel\Export\ManifestBuilder;
use Synloquent\Laravel\Protocol\CanonicalJson;

final class ManifestCommand extends Command
{
    protected $signature = 'synloquent:manifest';

    protected $description = 'Print the explicit exported schema';

    public function handle(ManifestBuilder $manifest): int
    {
        $this->line(CanonicalJson::encode($manifest->build()));

        return self::SUCCESS;
    }
}

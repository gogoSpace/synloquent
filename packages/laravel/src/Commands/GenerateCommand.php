<?php

declare(strict_types=1);

namespace Synloquent\Laravel\Commands;

use Illuminate\Console\Command;
use Synloquent\Laravel\Export\TypeScriptGenerator;

final class GenerateCommand extends Command
{
    protected $signature = 'synloquent:generate {--output=backend.generated.ts} {--check}';

    protected $description = 'Generate one deterministic TypeScript schema and binding file';

    public function handle(TypeScriptGenerator $generator): int
    {
        $path = (string) $this->option('output');
        $content = $generator->generate();
        if ($this->option('check')) {
            if (! is_file($path) || file_get_contents($path) !== $content) {
                $this->error('Generated definitions are stale.');

                return self::FAILURE;
            }

            return self::SUCCESS;
        }
        if (! is_dir(dirname($path))) {
            mkdir(dirname($path), 0775, true);
        }
        file_put_contents($path, $content);
        $this->info('Generated '.$path);

        return self::SUCCESS;
    }
}

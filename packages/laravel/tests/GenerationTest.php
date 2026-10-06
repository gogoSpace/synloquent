<?php

declare(strict_types=1);

namespace Synloquent\Tests;

use Synloquent\Laravel\Export\ManifestBuilder;
use Synloquent\Laravel\Export\TypeScriptGenerator;
use Synloquent\Laravel\Protocol\CanonicalJson;

final class GenerationTest extends TestCase
{
    public function test_deterministic_manifest_and_single_typescript_file(): void
    {
        $first = $this->app->make(ManifestBuilder::class)->build();
        $second = $this->app->make(ManifestBuilder::class)->build();
        $this->assertSame($first, $second);
        $this->assertSame('decimal', $first['models']['Item']['fields']['price']['type']);
        $this->assertSame(2, $first['models']['Item']['fields']['price']['precision']);
        $this->assertSame('integer', $first['models']['Item']['relations']['tags']['pivot']['fields']['position']['type']);
        $this->assertSame('max', $first['models']['Item']['relations']['latestImage']['aggregate']);
        $generated = $this->app->make(TypeScriptGenerator::class)->generate();
        $this->assertStringContainsString('BindSchema<typeof backendSchema>', $generated);
        $this->assertStringContainsString($first['fingerprint'], $generated);
        $this->assertSame('{"fields":{},"models":{},"relations":{}}', CanonicalJson::encode(['models' => [], 'fields' => [], 'relations' => []]));
        $path = storage_path('generated-check.ts');
        try {
            $this->artisan('synloquent:generate', ['--output' => $path])->assertSuccessful();
            $this->artisan('synloquent:generate', ['--output' => $path, '--check' => true])->assertSuccessful();
            file_put_contents($path, 'stale');
            $this->artisan('synloquent:generate', ['--output' => $path, '--check' => true])->assertFailed();
        } finally {
            if (is_file($path)) {
                unlink($path);
            }
        }
    }
}

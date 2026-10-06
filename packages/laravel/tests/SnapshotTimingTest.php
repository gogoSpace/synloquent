<?php

declare(strict_types=1);

namespace Synloquent\Tests;

use Illuminate\Testing\TestResponse;
use Synloquent\Laravel\Export\ManifestBuilder;
use Synloquent\Laravel\Sync\StageProfiler;

final class SnapshotTimingTest extends TestCase
{
    public function test_bounded_descriptor_reports_actual_snapshot_preparation_without_optional_profile(): void
    {
        $response = $this->snapshot(true);
        $response->assertSuccessful()->assertJsonPath('payload.format', 'canonical-parts-v1');
        $this->assertTiming($response);
        $this->assertFalse($response->headers->has('X-Synloquent-Profile'));
    }

    public function test_bounded_descriptor_reports_optional_profile_and_releases_its_observer(): void
    {
        config(['synloquent.profile_snapshots' => true]);
        $response = $this->snapshot(true);
        $response->assertSuccessful();
        $this->assertTiming($response);
        $profile = json_decode($response->headers->get('X-Synloquent-Profile'), true, flags: JSON_THROW_ON_ERROR);
        $this->assertIsArray($profile);
        $this->assertGreaterThanOrEqual(0, $profile['seconds']);
        $this->assertGreaterThan(0, $profile['allocatedPeakBytes']);
        $this->assertIsArray($profile['phases']);
        $profiler = $this->app->make(StageProfiler::class);
        $before = $profiler->report(hrtime(true))['phases'];
        $profiler->measure('after-response', static fn (): bool => true);
        $this->assertSame($before, $profiler->report(hrtime(true))['phases']);
    }

    public function test_legacy_snapshot_keeps_its_preparation_timing_and_complete_wire_content(): void
    {
        $response = $this->snapshot(false);
        $response->assertSuccessful();
        $this->assertTiming($response);
        $body = json_decode($response->streamedContent(), true, flags: JSON_THROW_ON_ERROR);
        $this->assertSame('snapshot', $body['kind']);
        $this->assertArrayHasKey('records', $body['payload']);
        $this->assertArrayHasKey('relationSets', $body['payload']);
        $this->assertArrayNotHasKey('format', $body['payload']);
    }

    private function snapshot(bool $bounded): TestResponse
    {
        $manifest = $this->app->make(ManifestBuilder::class)->build();

        return $this->withToken('synthetic-actor-1')->postJson('/synloquent/v1/protocol', [
            'protocolVersion' => 1,
            'requestId' => 'preparation-timing',
            'kind' => 'snapshot',
            'schemaFingerprint' => $manifest['fingerprint'],
            'session' => ['accountId' => '1', 'tenantId' => '1', 'deviceId' => 'example-device', 'deviceEpoch' => 'epoch-1', 'generation' => 0],
            'payload' => ['dataset' => 'catalog', ...($bounded ? ['delivery' => 'parts-v1'] : [])],
        ]);
    }

    private function assertTiming(TestResponse $response): void
    {
        $timing = $response->headers->get('Server-Timing');
        $this->assertIsString($timing);
        $this->assertMatchesRegularExpression('/^snapshot;dur=[0-9]+\.[0-9]{3}$/', $timing);
        $milliseconds = (float) substr($timing, strlen('snapshot;dur='));
        $this->assertTrue(is_finite($milliseconds));
        $this->assertGreaterThanOrEqual(0, $milliseconds);
    }
}

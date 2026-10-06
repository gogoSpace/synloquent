<?php

declare(strict_types=1);

namespace Synloquent\Tests;

use Illuminate\Support\Facades\DB;
use Synloquent\Laravel\Export\ManifestBuilder;
use Synloquent\Laravel\Protocol\CanonicalJson;
use Synloquent\Laravel\Protocol\CatalogReader;
use Synloquent\Laravel\Protocol\CatalogSchemaCompiler;
use Synloquent\Laravel\Protocol\ProtocolException;
use Synloquent\Laravel\Protocol\ProtocolValidator;

final class CatalogValidationTest extends TestCase
{
    public function test_compiled_catalog_validation_matches_the_same_schema_on_valid_and_invalid_boundaries(): void
    {
        $record = ['model' => 'Item', 'id' => '1', 'revision' => '0', 'attributes' => ['null' => null, 'boolean' => true, 'number' => 1.5, 'string' => 'žluťoučký', 'array' => [null, true, 1, ['nested' => 'value']], 'object' => (object) []]];
        $relation = ['model' => 'Item', 'relation' => 'tags', 'parentId' => '1', 'revision' => '0', 'completeness' => 'complete', 'targets' => [['id' => '2', 'attributes' => ['position' => 1]]]];
        $cases = [['records', $record], ['relationSets', $relation]];
        foreach (['model', 'id', 'revision'] as $field) {
            $missing = $record;
            unset($missing[$field]);
            $cases[] = ['records', $missing];
            foreach ([null, 1, '', str_repeat('ž', 1024), str_repeat('ž', 1025)] as $value) {
                $cases[] = ['records', [...$record, $field => $value]];
            }
        }
        foreach ([[], (object) [], (object) array_fill_keys(range(1, 256), true), (object) array_fill_keys(range(1, 257), true)] as $attributes) {
            $cases[] = ['records', [...$record, 'attributes' => $attributes]];
        }
        foreach ([128, 129] as $length) {
            $cases[] = ['records', [...$record, 'localIdentity' => str_repeat('x', $length)]];
        }
        $cases[] = ['records', [...$record, 'unexpected' => true]];
        $cases[] = ['records', [...$record, 'attributes' => ['array' => array_fill(0, 10000, null)]]];
        $cases[] = ['records', [...$record, 'attributes' => ['array' => array_fill(0, 10001, null)]]];
        $cases[] = ['records', [...$record, 'attributes' => ['object' => (object) array_fill_keys(range(1, 1000), null)]]];
        $cases[] = ['records', [...$record, 'attributes' => ['object' => (object) array_fill_keys(range(1, 1001), null)]]];
        foreach (['partial', 'invalid'] as $value) {
            $cases[] = ['relationSets', [...$relation, 'completeness' => $value]];
        }
        foreach ([[], (object) [], [['id' => '2', 'attributes' => []]], [['id' => '2', 'attributes' => (object) []]], [['attributes' => (object) []]], [['id' => '2', 'attributes' => (object) [], 'unexpected' => true]]] as $targets) {
            $cases[] = ['relationSets', [...$relation, 'targets' => $targets]];
        }
        $compiler = new CatalogSchemaCompiler;
        $validator = $this->app->make(ProtocolValidator::class);
        foreach ($cases as $position => [$section, $row]) {
            $value = json_decode(json_encode([$row], JSON_THROW_ON_ERROR), flags: JSON_THROW_ON_ERROR);
            $valid = true;
            try {
                $validator->validate('snapshot-'.$section, $value);
            } catch (ProtocolException) {
                $valid = false;
            }
            $this->assertSame($valid, $compiler->valid($section, $value), 'Differential catalog case '.$position);
        }
        foreach (['records' => 500001, 'relationSets' => 100001] as $section => $total) {
            try {
                $validator->validateCatalogChunk($section, '[]', $total);
                $this->fail('Global section limit was ignored.');
            } catch (ProtocolException $exception) {
                $this->assertSame('validation_failed', $exception->errorCode);
            }
        }
    }

    public function test_streamed_http_snapshot_and_download_preserve_canonical_bytes_and_transactional_limits(): void
    {
        $this->artisan('synloquent:seed-example')->assertSuccessful();
        $envelope = ['protocolVersion' => 1, 'requestId' => 'streamed-snapshot', 'kind' => 'snapshot', 'schemaFingerprint' => $this->app->make(ManifestBuilder::class)->build()['fingerprint'], 'session' => ['accountId' => '1', 'tenantId' => '1', 'deviceId' => 'example-device', 'deviceEpoch' => 'epoch-1', 'generation' => 1], 'payload' => ['dataset' => 'catalog']];
        $response = $this->withToken('synthetic-actor-1')->postJson('/synloquent/v1/protocol', $envelope)->assertSuccessful();
        $wire = json_decode($response->streamedContent(), true, flags: JSON_THROW_ON_ERROR);
        $snapshot = $wire['payload'];
        $this->assertSame('streamed-snapshot', $wire['requestId']);
        $bytes = CanonicalJson::catalog($snapshot['records'], $snapshot['relationSets']);
        $this->assertSame($bytes, DB::table('synloquent_snapshots')->where('hash', $snapshot['hash'])->value('document'));
        $this->assertSame(hash('sha256', $bytes), $snapshot['hash']);
        $this->assertSame(strlen($bytes), $snapshot['byteSize']);
        $download = $this->withToken('synthetic-actor-1')->getJson($snapshot['downloadUrl'])->assertSuccessful();
        $this->assertSame($snapshot, json_decode($download->streamedContent(), true, flags: JSON_THROW_ON_ERROR));
        $rows = iterator_to_array((new CatalogReader)->rows($bytes), false);
        $this->assertCount(count($snapshot['records']) + count($snapshot['relationSets']), $rows);
        $this->app['config']->set('synloquent.max_snapshot_rows', 1);
        $this->withToken('synthetic-actor-1')->postJson('/synloquent/v1/protocol', $envelope)->assertUnprocessable()->assertJsonPath('error.code', 'validation_failed');
        $this->assertSame(1, DB::table('synloquent_snapshots')->count());
        $this->assertSame(1, DB::table('synloquent_snapshot_grants')->count());
        $this->app['config']->set('synloquent.max_snapshot_rows', 200000);
        $path = storage_path('streamed-snapshot.json');
        try {
            $this->artisan('synloquent:snapshot', ['--actor' => '1', '--output' => $path])->assertSuccessful();
            $command = json_decode(file_get_contents($path), true, flags: JSON_THROW_ON_ERROR);
            $this->assertSame($snapshot, $command);
        } finally {
            if (is_file($path)) {
                unlink($path);
            }
        }
    }

    public function test_catalog_reader_preserves_escaped_strings_and_rejects_trailing_content(): void
    {
        $record = ['model' => 'Item', 'id' => '1', 'revision' => '0', 'attributes' => ['title' => 'braces {}[] quote " and slash \\', 'nested' => ['array' => [['key' => '\\"[]{}']]]]];
        $bytes = CanonicalJson::catalog([$record], []);
        $rows = iterator_to_array((new CatalogReader)->rows($bytes));
        $this->assertCount(1, $rows);
        $this->assertSame(CanonicalJson::encode($record), $rows[0]['encoded']);
        $this->expectException(ProtocolException::class);
        iterator_to_array((new CatalogReader)->rows($bytes.' '));
    }
}

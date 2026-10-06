<?php

declare(strict_types=1);

namespace Synloquent\Tests;

use App\Models\Category;
use App\Models\Item;
use Illuminate\Contracts\Auth\Access\Gate;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Facades\DB;
use Synloquent\Laravel\Contracts\ServerCommand;
use Synloquent\Laravel\Export\ExportDefinition;
use Synloquent\Laravel\Export\ExportRegistry;
use Synloquent\Laravel\Export\ManifestBuilder;
use Synloquent\Laravel\Export\ValueCodec;
use Synloquent\Laravel\Protocol\CanonicalJson;
use Synloquent\Laravel\Protocol\ProtocolException;
use Synloquent\Laravel\Sync\ActorContext;
use Synloquent\Laravel\Sync\CommandRegistry;
use Synloquent\Laravel\Sync\MutationAction;
use Synloquent\Laravel\Sync\WriteContext;

final class JsonWireConformanceTest extends TestCase
{
    public function test_http_registered_json_arguments_and_command_replay_preserve_object_array_types(): void
    {
        $this->app->make(CommandRegistry::class)->register(new class implements ServerCommand
        {
            public function name(): string
            {
                return 'echoJson';
            }

            public function arguments(): array
            {
                return ['value' => ['type' => 'json', 'nullable' => false, 'readable' => true, 'writable' => true]];
            }

            public function result(): array
            {
                return $this->arguments();
            }

            public function argumentRules(): array
            {
                return ['value' => ['present', 'array']];
            }

            public function resultRules(): array
            {
                return $this->argumentRules();
            }

            public function authorize(ActorContext $actor): bool
            {
                return true;
            }

            public function execute(array $arguments, WriteContext $context): array
            {
                return $arguments;
            }

            public function replay(array $result, ActorContext $actor): ?array
            {
                return $result;
            }
        });
        $variants = [(object) [], [], (object) ['object' => (object) [], 'array' => [], 'nested' => [(object) [], [], true, null]]];
        foreach ($variants as $position => $value) {
            $request = ['name' => 'echoJson', 'operationId' => 'json-command-'.$position, 'arguments' => ['value' => $value]];
            $accepted = $this->send('command', $request)->payload;
            $this->assertSame(CanonicalJson::encode($value), CanonicalJson::encode($accepted->result->value));
            $replayed = $this->send('command', $request)->payload;
            $this->assertTrue($replayed->replayed);
            $this->assertSame(CanonicalJson::encode($value), CanonicalJson::encode($replayed->result->value));
        }
        foreach ([(object) [], []] as $position => $value) {
            $this->send('push', ['operations' => [$this->operation('json-scope-'.$position, 'create', ['title' => 'Scope '.$position, 'metadata' => (object) ['nested' => $value]])]]);
        }
        $options = ['model' => 'Item', 'scopes' => [['name' => 'metadataContains', 'arguments' => ['value' => (object) ['nested' => (object) []]]]]];
        $response = $this->send('query', $options)->payload;
        $this->assertSame(['Scope 0'], array_map(static fn ($record): string => $record->attributes->title, $response->records));
        $options['scopes'][0]['arguments']['value'] = (object) ['nested' => []];
        $response = $this->send('query', $options)->payload;
        $this->assertSame(['Scope 1'], array_map(static fn ($record): string => $record->attributes->title, $response->records));
        $options['unions'] = [['all' => false, 'query' => ['model' => 'Item', 'scopes' => [['name' => 'metadataContains', 'arguments' => ['value' => (object) ['nested' => (object) []]]]]]]];
        $response = $this->send('query', $options)->payload;
        $this->assertSame(['Scope 0', 'Scope 1'], array_map(static fn ($record): string => $record->attributes->title, $response->records));
        $category = Category::create(['title' => 'JSON scope category', 'tenant_id' => 1]);
        Item::query()->update(['category_id' => $category->id]);
        $filteredQuery = ['model' => 'Item', 'scopes' => [['name' => 'metadataContains', 'arguments' => ['value' => (object) ['nested' => (object) []]]]]];
        $response = $this->send('query', ['model' => 'Category', 'include' => (object) ['items' => $filteredQuery]])->payload;
        $this->assertSame(['Scope 0'], array_map(static fn ($record): string => $record->attributes->title, $response->related));
        $response = $this->send('query', ['model' => 'Item', 'subqueries' => [['kind' => 'select', 'alias' => 'filteredTitle', 'query' => [...$filteredQuery, 'select' => ['title'], 'limit' => 1]]]])->payload;
        foreach ($response->computed as $computed) {
            $this->assertSame('Scope 0', $computed->projections->filteredTitle);
        }
        $values = $this->app->make(ValueCodec::class);
        $filtered = $values->validatedValues(['value' => ['kept' => []]], ['value' => (object) ['kept' => (object) [], 'removed' => []]], ['value' => ['type' => 'json']]);
        $this->assertSame('{"kept":{}}', CanonicalJson::encode($filtered['value']));
        $this->assertSame(3, DB::table('synloquent_receipts')->where('operation_id', 'like', 'json-command-%')->count());
    }

    public function test_http_json_object_array_identity_survives_mutation_query_snapshot_download_and_receipt_replay(): void
    {
        $variants = [(object) [], [], (object) ['emptyObject' => (object) [], 'emptyArray' => [], 'attributes' => [], 'fields' => [], 'details' => [], 'nested' => [true, false, null, (object) ['object' => (object) [], 'array' => []]], 'safeInteger' => 9007199254740991, 'exactInteger' => '9007199254740993'], [(object) [], [], true, null, 9007199254740991, '9007199254740993']];
        foreach ($variants as $position => $value) {
            $operation = $this->operation('json-wire-'.$position, 'create', ['title' => 'JSON wire '.$position, 'metadata' => $value]);
            $receipt = $this->send('push', ['operations' => [$operation]])->payload->receipts[0];
            $this->assertSame('accepted', $receipt->status);
            $this->assertSame(CanonicalJson::encode($value), CanonicalJson::encode($receipt->canonical->attributes->metadata));
            $this->assertSame(CanonicalJson::encode($value), CanonicalJson::encode(json_decode(DB::table('items')->where('id', $receipt->canonical->id)->value('metadata'), flags: JSON_THROW_ON_ERROR)));
            $query = $this->send('query', ['model' => 'Item', 'where' => ['kind' => 'comparison', 'field' => 'id', 'operator' => '=', 'value' => $receipt->canonical->id]]);
            $this->assertSame(CanonicalJson::encode($value), CanonicalJson::encode($query->payload->records[0]->attributes->metadata));
            $query = $this->send('query', ['model' => 'Item', 'where' => ['kind' => 'comparison', 'field' => 'id', 'operator' => '=', 'value' => $receipt->canonical->id], 'subqueries' => [['kind' => 'select', 'alias' => 'jsonValue', 'query' => ['model' => 'Item', 'select' => ['metadata'], 'limit' => 1], 'correlate' => [['innerField' => 'id', 'outerField' => 'id']]]]]);
            $this->assertSame(CanonicalJson::encode($value), CanonicalJson::encode($query->payload->computed->{'Item:'.$receipt->canonical->id}->projections->jsonValue));
            $replacement = $variants[($position + 1) % count($variants)];
            $update = $this->operation('json-wire-update-'.$position, 'update', ['metadata' => $replacement], ['id' => $receipt->canonical->id, 'expectedRevision' => $receipt->canonical->revision]);
            $updated = $this->send('push', ['operations' => [$update]])->payload->receipts[0];
            $this->assertSame('accepted', $updated->status);
            $this->assertSame(CanonicalJson::encode($replacement), CanonicalJson::encode($updated->canonical->attributes->metadata));
            $back = $this->operation('json-wire-back-'.$position, 'update', ['metadata' => $value], ['id' => $receipt->canonical->id, 'expectedRevision' => $updated->canonical->revision]);
            $restored = $this->send('push', ['operations' => [$back]])->payload->receipts[0];
            $this->assertSame('accepted', $restored->status);
            $this->assertSame(CanonicalJson::encode($value), CanonicalJson::encode($restored->canonical->attributes->metadata));
            $replay = $this->send('push', ['operations' => [$operation]])->payload->receipts[0];
            $this->assertSame(CanonicalJson::encode($value), CanonicalJson::encode($replay->canonical->attributes->metadata));
        }
        $snapshot = $this->send('snapshot', ['dataset' => 'catalog'])->payload;
        $download = $this->withToken('synthetic-actor-1')->getJson($snapshot->downloadUrl)->assertSuccessful();
        $downloaded = json_decode($download->streamedContent(), flags: JSON_THROW_ON_ERROR);
        $this->assertSame(CanonicalJson::encode($snapshot), CanonicalJson::encode($downloaded));
        foreach ($snapshot->records as $position => $record) {
            $this->assertSame(CanonicalJson::encode($variants[$position]), CanonicalJson::encode($record->attributes->metadata));
        }
        $invalid = $this->operation('json-wire-forbidden', 'create', ['title' => 'Invalid JSON boundary', 'tenant_id' => (object) []]);
        $rejected = $this->send('push', ['operations' => [$invalid]])->payload->receipts[0];
        $this->assertSame('rejected', $rejected->status);
        $this->assertSame('forbidden_field', $rejected->error->code);
    }

    public function test_non_finite_json_numbers_are_rejected_before_model_or_receipt_changes(): void
    {
        $envelope = ['protocolVersion' => 1, 'requestId' => 'non-finite-json', 'kind' => 'push', 'schemaFingerprint' => $this->app->make(ManifestBuilder::class)->build()['fingerprint'], 'session' => ['accountId' => '1', 'tenantId' => '1', 'deviceId' => 'example-device', 'deviceEpoch' => 'epoch-1', 'generation' => 1], 'payload' => ['operations' => [$this->operation('non-finite-json', 'create', ['title' => 'Invalid number', 'metadata' => ['overflow' => '__overflow__']])]]];
        $encoded = str_replace('"__overflow__"', '1e999', json_encode($envelope, JSON_THROW_ON_ERROR));
        $response = $this->call('POST', '/synloquent/v1/protocol', [], [], [], ['CONTENT_TYPE' => 'application/json', 'HTTP_AUTHORIZATION' => 'Bearer synthetic-actor-1'], $encoded);
        $response->assertUnprocessable()->assertJsonPath('error.code', 'validation_failed');
        $this->assertSame(0, Item::count());
        $this->assertSame(0, DB::table('synloquent_receipts')->count());
        try {
            $this->app->make(ValueCodec::class)->validate((object) ['nested' => [INF]], ['type' => 'json'], 'metadata');
            $this->fail('Direct JSON validation accepted an infinite value.');
        } catch (ProtocolException $exception) {
            $this->assertSame('validation_failed', $exception->errorCode);
        }
    }

    public function test_json_trait_preserves_equivalent_object_no_op_and_model_event_semantics(): void
    {
        $this->freezeTime();
        $created = $this->send('push', ['operations' => [$this->operation('json-equivalent', 'create', ['title' => 'Equivalent JSON', 'metadata' => (object) ['alpha' => 1, 'beta' => (object) []]])]])->payload->receipts[0]->canonical;
        $model = Item::findOrFail($created->id);
        $model->metadata = (object) ['beta' => (object) [], 'alpha' => 1];
        $this->assertArrayNotHasKey('metadata', $model->getDirty());
        $this->assertTrue($model->originalIsEquivalent('metadata'));
        $events = [];
        foreach (['saving', 'updating', 'updated', 'saved'] as $event) {
            $this->app['events']->listen('eloquent.'.$event.': '.Item::class, static function () use (&$events, $event): void {
                $events[] = $event;
            });
        }
        $update = $this->operation('json-equivalent-update', 'update', ['metadata' => (object) ['beta' => (object) [], 'alpha' => 1]], ['id' => $created->id, 'expectedRevision' => $created->revision]);
        $this->assertSame('accepted', $this->send('push', ['operations' => [$update]])->payload->receipts[0]->status);
        $this->assertSame(['saving', 'saved'], $events);
        $events = [];
        $model = Item::findOrFail($created->id);
        $model->metadata = [];
        $model->save();
        $this->assertSame(['saving', 'updating', 'updated', 'saved'], $events);
        $this->assertSame('[]', DB::table('items')->where('id', $created->id)->value('metadata'));
    }

    public function test_json_type_transition_without_host_comparator_fails_closed(): void
    {
        $registry = new ExportRegistry;
        $registry->register(new class($this->app->make(Gate::class), $this->app->make(ValueCodec::class)) extends ExportDefinition
        {
            public function name(): string
            {
                return 'JsonGuard';
            }

            public function modelClass(): string
            {
                return JsonGuardModel::class;
            }

            public function readable(): array
            {
                return ['id', 'title', 'metadata'];
            }

            public function writable(): array
            {
                return ['title', 'metadata'];
            }

            public function operations(): array
            {
                return ['query', 'create', 'update'];
            }

            public function authorize(string $operation, ActorContext $actor, ?Model $model = null): bool
            {
                return true;
            }

            public function prepare(Model $model, ActorContext $actor): void
            {
                $model->tenant_id = 1;
            }
        });
        $this->app->instance(ExportRegistry::class, $registry);
        $action = $this->app->make(MutationAction::class);
        $created = $action->execute([$this->operation('json-without-trait', 'create', ['title' => 'Guard', 'metadata' => (object) []], ['model' => 'JsonGuard'])], $this->actor())['receipts'][0]['canonical'];
        $update = $this->operation('json-without-trait-update', 'update', ['metadata' => []], ['model' => 'JsonGuard', 'id' => $created['id'], 'expectedRevision' => $created['revision']]);
        $receipt = $action->execute([$update], $this->actor())['receipts'][0];
        $this->assertSame('rejected', $receipt['status']);
        $this->assertSame('unsupported_query', $receipt['error']['code']);
        $this->assertSame('metadata', $receipt['error']['details']['field']);
        $this->assertSame('{}', DB::table('items')->where('id', $created['id'])->value('metadata'));
        $this->artisan('synloquent:doctor')->expectsOutputToContain('PreservesJsonTypes')->assertSuccessful();
    }

    private function send(string $kind, array $payload): \stdClass
    {
        $envelope = ['protocolVersion' => 1, 'requestId' => 'json-wire-'.$kind, 'kind' => $kind, 'schemaFingerprint' => $this->app->make(ManifestBuilder::class)->build()['fingerprint'], 'session' => ['accountId' => '1', 'tenantId' => '1', 'deviceId' => 'example-device', 'deviceEpoch' => 'epoch-1', 'generation' => 1], 'payload' => $payload];
        $response = $this->withToken('synthetic-actor-1')->postJson('/synloquent/v1/protocol', $envelope);
        $this->assertTrue($response->isSuccessful(), $response->getContent() ?: 'Streamed HTTP response failed.');

        return json_decode($kind === 'snapshot' ? $response->streamedContent() : $response->getContent(), flags: JSON_THROW_ON_ERROR);
    }
}

final class JsonGuardModel extends Model
{
    protected $table = 'items';

    protected $guarded = [];

    protected $casts = ['metadata' => 'array'];
}

<?php

declare(strict_types=1);

namespace Synloquent\Tests;

use App\Models\Category;
use App\Models\Item;
use App\Models\User;
use Illuminate\Support\Facades\DB;
use Synloquent\Laravel\Contracts\ServerCommand;
use Synloquent\Laravel\Export\ManifestBuilder;
use Synloquent\Laravel\Protocol\ProtocolException;
use Synloquent\Laravel\Query\QueryAction;
use Synloquent\Laravel\Sync\ActorContext;
use Synloquent\Laravel\Sync\CommandAction;
use Synloquent\Laravel\Sync\CommandRegistry;
use Synloquent\Laravel\Sync\MutationAction;
use Synloquent\Laravel\Sync\PullAction;
use Synloquent\Laravel\Sync\SnapshotAction;
use Synloquent\Laravel\Sync\WriteContext;
use Synloquent\Laravel\Sync\WriteGateway;

final class AuthorizationTest extends TestCase
{
    public function test_foreign_targets_receipt_replay_and_revocation_fail_closed(): void
    {
        $foreign = Category::create(['title' => 'Other tenant', 'tenant_id' => 2]);
        $action = $this->app->make(MutationAction::class);
        $denied = $action->execute([$this->operation('foreign', 'create', ['title' => 'Denied foreign key', 'category_id' => $foreign->id])], $this->actor())['receipts'][0];
        $this->assertSame('forbidden_operation', $denied['error']['code']);
        $operation = $this->operation('visible', 'create', ['title' => 'Initially visible']);
        $record = $action->execute([$operation], $this->actor())['receipts'][0]['canonical'];
        $snapshot = $this->app->make(SnapshotAction::class)->execute('catalog', $this->actor());
        $this->app->make(WriteGateway::class)->transaction($this->actor(), function (WriteContext $context) use ($record): void {
            $item = Item::find($record['id']);
            $item->tenant_id = 2;
            $item->save();
            $context->capture($item);
            $context->invalidateAuthorization();
        });
        $replay = $action->execute([$operation], $this->actor())['receipts'][0];
        $this->assertSame('accepted', $replay['status']);
        $this->assertArrayNotHasKey('canonical', $replay);
        $pull = $this->app->make(PullAction::class)->execute($snapshot['cursor'], 'catalog', $this->actor());
        $this->assertSame(['kind' => 'remove', 'model' => 'Item', 'id' => $record['id']], $pull['batches'][0]['changes'][0]);
        $other = new ActorContext('1', '1', 'new-epoch', '1', User::find(1), 'example-device');
        try {
            $this->app->make(PullAction::class)->execute($snapshot['cursor'], 'catalog', $other);
            $this->fail('A cursor crossed device epochs.');
        } catch (ProtocolException $exception) {
            $this->assertSame('schema_mismatch', $exception->errorCode);
        }
    }

    public function test_strict_http_schema_preserves_objects_and_rejects_unknown_properties(): void
    {
        $envelope = ['protocolVersion' => 1, 'requestId' => 'strict', 'kind' => 'query', 'schemaFingerprint' => $this->app->make(ManifestBuilder::class)->build()['fingerprint'], 'session' => ['accountId' => '1', 'tenantId' => '1', 'deviceId' => 'example-device', 'deviceEpoch' => 'epoch-1', 'generation' => 1], 'payload' => ['model' => 'Item']];
        $this->withToken('synthetic-actor-1')->postJson('/synloquent/v1/protocol', $envelope)->assertSuccessful()->assertJsonPath('payload.records', []);
        $envelope['payload']['unexpected'] = true;
        $this->withToken('synthetic-actor-1')->postJson('/synloquent/v1/protocol', $envelope)->assertUnprocessable()->assertJsonPath('error.code', 'validation_failed');
        $envelope['payload'] = ['model' => 'Item', 'include' => []];
        $this->withToken('synthetic-actor-1')->postJson('/synloquent/v1/protocol', $envelope)->assertUnprocessable()->assertJsonPath('error.code', 'validation_failed');
        $envelope['kind'] = 'push';
        $envelope['payload'] = ['operations' => [$this->operation('bad-values', 'create', [])]];
        $this->withToken('synthetic-actor-1')->postJson('/synloquent/v1/protocol', $envelope)->assertUnprocessable()->assertJsonPath('error.code', 'validation_failed');
        $this->assertSame(0, DB::table('synloquent_receipts')->count());
    }

    public function test_registered_command_and_scope_argument_authorization_and_result_validation(): void
    {
        $action = $this->app->make(CommandAction::class);
        foreach ([['request' => ['name' => 'increaseQuantity', 'operationId' => 'invalid-argument', 'arguments' => ['item_id' => 1, 'delta' => '4.5']], 'actor' => $this->actor(), 'code' => 'validation_failed'], ['request' => ['name' => 'increaseQuantity', 'operationId' => 'denied', 'arguments' => ['item_id' => 1, 'delta' => 4]], 'actor' => $this->actor('2'), 'code' => 'forbidden_operation']] as $case) {
            try {
                $action->execute($case['request'], $case['actor']);
                $this->fail('Invalid command was accepted.');
            } catch (ProtocolException $exception) {
                $this->assertSame($case['code'], $exception->errorCode);
            }
        }
        try {
            $this->app->make(QueryAction::class)->execute(['model' => 'Item', 'scopes' => [['name' => 'activePriced', 'arguments' => ['minimumPrice' => '1.00', 'sql' => 'TRUE']]]], $this->actor());
            $this->fail('Unknown scope argument was accepted.');
        } catch (ProtocolException $exception) {
            $this->assertSame('validation_failed', $exception->errorCode);
        }
        $this->assertSame(0, DB::table('synloquent_effects')->count());
        $this->assertSame(0, DB::table('synloquent_receipts')->count());
        $invalidResult = new class implements ServerCommand
        {
            public function name(): string
            {
                return 'invalidResult';
            }

            public function arguments(): array
            {
                return [];
            }

            public function result(): array
            {
                return ['quantity' => ['type' => 'integer', 'nullable' => false, 'readable' => true, 'writable' => false]];
            }

            public function argumentRules(): array
            {
                return [];
            }

            public function resultRules(): array
            {
                return ['quantity' => ['required', 'integer']];
            }

            public function authorize(ActorContext $actor): bool
            {
                return true;
            }

            public function replay(array $result, ActorContext $actor): ?array
            {
                return $result;
            }

            public function execute(array $arguments, WriteContext $context): array
            {
                $context->capture(Item::create(['title' => 'Invalid command result', 'tenant_id' => 1]));
                $context->effect('quantityChanged', 'invalid-result', []);

                return ['quantity' => 'string'];
            }
        };
        $this->app->make(CommandRegistry::class)->register($invalidResult);
        try {
            $action->execute(['name' => 'invalidResult', 'operationId' => 'invalid-result', 'arguments' => []], $this->actor());
            $this->fail('Invalid command result was accepted.');
        } catch (ProtocolException $exception) {
            $this->assertSame('validation_failed', $exception->errorCode);
        }
        $this->assertSame(0, Item::count());
        $this->assertSame(0, DB::table('synloquent_publications')->count());
        $this->assertSame(0, DB::table('synloquent_effects')->count());
    }

    public function test_forbidden_fields_and_unknown_exports_fail_closed(): void
    {
        $receipt = $this->app->make(MutationAction::class)->execute([$this->operation('secret', 'create', ['title' => 'Denied', 'tenant_id' => 2])], $this->actor())['receipts'][0];
        $this->assertSame('rejected', $receipt['status']);
        $this->assertSame('forbidden_field', $receipt['error']['code']);
        $this->assertSame('rejected', DB::table('synloquent_receipts')->where('operation_id', 'secret')->value('status'));
        $this->assertSame(0, Item::count());
        $this->expectException(ProtocolException::class);
        $this->app->make(QueryAction::class)->execute(['model' => 'User'], $this->actor());
    }

    public function test_invalid_integer_query_values_are_rejected_before_sql(): void
    {
        foreach (['-0', '00', '+106', 'local-uuid-identity', '9223372036854775808', 1.5] as $identity) {
            try {
                $this->app->make(QueryAction::class)->execute(['model' => 'Item', 'where' => ['kind' => 'comparison', 'field' => 'id', 'operator' => '=', 'value' => $identity]], $this->actor());
                $this->fail('Invalid bigint comparison was accepted.');
            } catch (ProtocolException $exception) {
                $this->assertSame('validation_failed', $exception->errorCode);
            }
        }
    }

    public function test_http_actor_and_schema_negotiation(): void
    {
        $envelope = ['protocolVersion' => 1, 'requestId' => 'request', 'kind' => 'query', 'schemaFingerprint' => $this->app->make(ManifestBuilder::class)->build()['fingerprint'], 'session' => ['accountId' => '2', 'tenantId' => '1', 'deviceId' => 'example-device', 'deviceEpoch' => 'epoch-1', 'generation' => 1], 'payload' => ['model' => 'Item']];
        $this->withToken('synthetic-actor-1')->postJson('/synloquent/v1/protocol', $envelope)->assertForbidden()->assertJsonPath('error.code', 'forbidden_operation');
        $envelope['session']['accountId'] = '1';
        $envelope['schemaFingerprint'] = 'old';
        $this->withToken('synthetic-actor-1')->postJson('/synloquent/v1/protocol', $envelope)->assertStatus(409)->assertJsonPath('error.code', 'upgrade_required');
    }
}

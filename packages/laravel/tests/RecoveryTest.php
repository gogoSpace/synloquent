<?php

declare(strict_types=1);

namespace Synloquent\Tests;

use App\Models\Item;
use Illuminate\Database\Events\QueryExecuted;
use Illuminate\Support\Facades\DB;
use Synloquent\Laravel\Protocol\ProtocolException;
use Synloquent\Laravel\Query\QueryAction;
use Synloquent\Laravel\Sync\CommandAction;
use Synloquent\Laravel\Sync\EffectDelivery;
use Synloquent\Laravel\Sync\MutationAction;
use Synloquent\Laravel\Sync\WriteContext;
use Synloquent\Laravel\Sync\WriteGateway;

final class RecoveryTest extends TestCase
{
    public function test_command_process_exits_after_commit_without_response_and_replays_one_effect(): void
    {
        $this->app->make(MutationAction::class)->execute([$this->operation('lost-command-item', 'create', ['title' => 'Lost command target'])], $this->actor());
        $worker = $this->worker('lostCommandResponse');
        $this->closeWorker($worker, false);
        $this->assertSame(4, Item::findOrFail(1)->quantity);
        $request = ['name' => 'increaseQuantity', 'operationId' => 'lost-command-response', 'arguments' => ['item_id' => '1', 'delta' => 4]];
        $replayed = $this->app->make(CommandAction::class)->execute($request, $this->actor());
        $this->assertTrue($replayed['replayed']);
        $this->assertSame(4, $replayed['result']['quantity']);
        $this->assertSame(4, Item::findOrFail(1)->quantity);
        $this->assertSame(1, DB::table('synloquent_receipts')->where('operation_id', 'lost-command-response')->count());
        $this->assertSame(1, DB::table('synloquent_effects')->count());
        $this->assertSame(2, DB::table('synloquent_publications')->count());
    }

    public function test_query_attributes_and_revisions_share_one_snapshot_during_a_concurrent_commit(): void
    {
        $record = $this->app->make(MutationAction::class)->execute([$this->operation('query-concurrent', 'create', ['title' => 'Consistent query', 'quantity' => 5])], $this->actor())['receipts'][0]['canonical'];
        $writer = $this->worker('performanceWriter');
        $released = false;
        try {
            $this->assertSame('ready', json_decode(fgets($writer['pipes'][1]), true, flags: JSON_THROW_ON_ERROR)['stage']);
            DB::listen(function (QueryExecuted $event) use ($writer, &$released): void {
                if (! $released && str_contains($event->sql, 'from "items"')) {
                    $released = true;
                    fwrite($writer['pipes'][0], "release\n");
                    fflush($writer['pipes'][0]);
                    $this->assertSame('committed', json_decode(fgets($writer['pipes'][1]), true, flags: JSON_THROW_ON_ERROR)['stage']);
                }
            });
            $action = $this->app->make(QueryAction::class);
            $first = $action->execute(['model' => 'Item'], $this->actor())['records'][0];
            $this->assertTrue($released);
            $this->assertSame(5, $first['attributes']['quantity']);
            $this->assertSame($record['revision'], $first['revision']);
            $second = $action->execute(['model' => 'Item'], $this->actor())['records'][0];
            $this->assertSame(6, $second['attributes']['quantity']);
            $this->assertSame('2', $second['revision']);
        } finally {
            $this->closeWorker($writer, false);
        }
    }

    public function test_instance_observers_fire_in_order_and_bulk_writes_bypass_them(): void
    {
        $events = [];
        foreach (['saving', 'creating', 'created', 'saved', 'updating', 'updated', 'deleting', 'deleted'] as $event) {
            Item::registerModelEvent($event, function (Item $model) use (&$events, $event): void {
                $events[] = $event;
            });
        }
        $action = $this->app->make(MutationAction::class);
        $record = $action->execute([$this->operation('observer-create', 'create', ['title' => 'Observer', 'catalog_code' => ' lower '])], $this->actor())['receipts'][0]['canonical'];
        $this->assertSame(['saving', 'creating', 'created', 'saved'], $events);
        $this->assertSame('LOWER', $record['attributes']['catalog_code']);
        $events = [];
        $updated = $action->execute([$this->operation('observer-update', 'update', ['quantity' => 2], ['id' => $record['id'], 'expectedRevision' => $record['revision']])], $this->actor())['receipts'][0]['canonical'];
        $this->assertSame(['saving', 'updating', 'updated', 'saved'], $events);
        $events = [];
        $bulk = $action->execute([$this->operation('bulk-create', 'create', ['title' => 'Bulk observer', 'catalog_code' => ' cast me '], ['eventMode' => 'bulk'])], $this->actor())['receipts'][0]['canonical'];
        $this->assertSame([], $events);
        $this->assertSame('CAST ME', $bulk['attributes']['catalog_code']);
        $bulkUpdated = $action->execute([$this->operation('bulk-update', 'update', ['quantity' => 7], ['id' => $bulk['id'], 'expectedRevision' => $bulk['revision'], 'eventMode' => 'bulk'])], $this->actor())['receipts'][0]['canonical'];
        $this->assertSame([], $events);
        $this->assertSame(7, $bulkUpdated['attributes']['quantity']);
        $this->assertSame('accepted', $action->execute([$this->operation('bulk-delete', 'delete', [], ['id' => $bulk['id'], 'expectedRevision' => $bulkUpdated['revision'], 'eventMode' => 'bulk'])], $this->actor())['receipts'][0]['status']);
        $this->assertSame([], $events);
        $action->execute([$this->operation('observer-delete', 'delete', [], ['id' => $updated['id'], 'expectedRevision' => $updated['revision']])], $this->actor());
        $this->assertSame(['deleting', 'deleted'], $events);
        $this->assertSame(6, DB::table('synloquent_publications')->count());
        $this->assertSame(0, Item::count());
        Item::flushEventListeners();
    }

    public function test_registered_update_and_shared_locks_execute_inside_the_gateway(): void
    {
        $record = $this->app->make(MutationAction::class)->execute([$this->operation('locked-item', 'create', ['title' => 'Locked target', 'quantity' => 9])], $this->actor())['receipts'][0]['canonical'];
        $queries = [];
        DB::listen(function (QueryExecuted $event) use (&$queries): void {
            $queries[] = $event->sql;
        });
        foreach (['update' => 'for update', 'shared' => 'for share'] as $mode => $fragment) {
            $result = $this->app->make(CommandAction::class)->execute(['name' => 'inspectItemLocked', 'operationId' => 'lock-'.$mode, 'arguments' => ['item_id' => (int) $record['id'], 'mode' => $mode]], $this->actor());
            $this->assertSame(['quantity' => 9, 'lockMode' => $mode], $result['result']);
            $this->assertNotEmpty(array_filter($queries, static fn (string $query): bool => str_contains($query, '"items"') && str_contains($query, $fragment)));
        }
        $this->assertSame(1, DB::table('synloquent_publications')->count());
        $this->assertSame(3, DB::table('synloquent_receipts')->count());
    }

    public function test_atomic_failure_rolls_back_domain_revision_publication_and_alias(): void
    {
        $action = $this->app->make(MutationAction::class);
        $first = $this->operation('first', 'create', ['title' => 'Atomic'], ['atomicGroup' => 'group']);
        $second = $this->operation('second', 'create', ['title' => 'Atomic'], ['atomicGroup' => 'group']);
        $receipts = $action->execute([$first, $second], $this->actor())['receipts'];
        $this->assertSame(['rejected', 'rejected'], array_column($receipts, 'status'));
        $this->assertSame('23505', $receipts[1]['error']['details']['sqlState']);
        $this->assertSame(0, Item::count());
        $this->assertSame(0, DB::table('synloquent_revisions')->count());
        $this->assertSame(0, DB::table('synloquent_publications')->count());
        $this->assertSame(0, DB::table('synloquent_aliases')->count());
        $this->assertSame(2, DB::table('synloquent_receipts')->count());
    }

    public function test_conflict_retains_proposal_and_idempotency_hash_is_immutable(): void
    {
        $action = $this->app->make(MutationAction::class);
        $operation = $this->operation('create', 'create', ['title' => 'Original']);
        $record = $action->execute([$operation], $this->actor())['receipts'][0]['canonical'];
        $proposal = $this->operation('update', 'update', ['title' => 'Proposal'], ['id' => $record['id'], 'expectedRevision' => '0']);
        $receipt = $action->execute([$proposal], $this->actor())['receipts'][0];
        $this->assertSame('conflicted', $receipt['status']);
        $this->assertSame('Original', $receipt['canonical']['attributes']['title']);
        $operation['values']['title'] = 'Different';
        $this->expectException(ProtocolException::class);
        $action->execute([$operation], $this->actor());
    }

    public function test_gateway_rollback_and_capture_of_bulk_write(): void
    {
        $gateway = $this->app->make(WriteGateway::class);
        try {
            $gateway->transaction($this->actor(), function (WriteContext $context): void {
                $context->capture(Item::create(['title' => 'Crash', 'tenant_id' => 1]));
                throw new \RuntimeException('fault before commit');
            });
        } catch (\RuntimeException $exception) {
            $this->assertSame('fault before commit', $exception->getMessage());
        }
        $this->assertSame(0, Item::count());
        $gateway->transaction($this->actor(), function (WriteContext $context): void {
            $item = Item::create(['title' => 'Bulk', 'tenant_id' => 1]);
            Item::whereKey($item->id)->update(['quantity' => 7]);
            $context->capture($item->fresh());
        });
        $this->assertSame(1, DB::table('synloquent_publications')->value('sequence'));
        $this->assertSame(7, Item::first()->quantity);
    }

    public function test_independent_connections_block_before_mutation_and_publish_in_commit_order(): void
    {
        $first = $this->worker('first');
        $second = null;
        try {
            $locked = json_decode(fgets($first['pipes'][1]), true, flags: JSON_THROW_ON_ERROR);
            $this->assertSame('locked', $locked['stage']);
            $second = $this->worker('second');
            $attempting = json_decode(fgets($second['pipes'][1]), true, flags: JSON_THROW_ON_ERROR);
            $this->assertSame('attempting', $attempting['stage']);
            $deadline = microtime(true) + 5;
            do {
                $activity = DB::selectOne('select wait_event_type from pg_stat_activity where pid = ?', [$attempting['backend']]);
                if ($activity?->wait_event_type === 'Lock') {
                    break;
                }
                usleep(1000);
            } while (microtime(true) < $deadline);
            $this->assertSame('Lock', $activity?->wait_event_type);
            $this->assertSame(0, DB::table('synloquent_publications')->count());
            fwrite($first['pipes'][0], "release\n");
            fflush($first['pipes'][0]);
            $this->assertSame('committed', json_decode(fgets($first['pipes'][1]), true, flags: JSON_THROW_ON_ERROR)['stage']);
            $this->assertSame('committed', json_decode(fgets($second['pipes'][1]), true, flags: JSON_THROW_ON_ERROR)['stage']);
            $this->assertSame([1, 2], DB::table('synloquent_publications')->orderBy('sequence')->pluck('sequence')->all());
            $this->assertSame(['Concurrent first', 'Concurrent second'], Item::orderBy('id')->pluck('title')->all());
        } finally {
            $this->closeWorker($first);
            if ($second !== null) {
                $this->closeWorker($second);
            }
        }
    }

    public function test_process_kill_before_commit_rolls_back_all_captured_state(): void
    {
        $worker = $this->worker('beforeCommit');
        try {
            $this->assertSame('locked', json_decode(fgets($worker['pipes'][1]), true, flags: JSON_THROW_ON_ERROR)['stage']);
            proc_terminate($worker['process'], 9);
        } finally {
            $this->closeWorker($worker);
        }
        $this->assertSame(0, Item::count());
        $this->assertSame(0, DB::table('synloquent_publications')->count());
        $this->assertSame(0, DB::table('synloquent_revisions')->count());
    }

    public function test_lost_response_after_actual_commit_is_replay_safe(): void
    {
        $worker = $this->worker('lostResponse');
        $this->closeWorker($worker, false);
        $operation = $this->operation('lost-response', 'create', ['title' => 'Lost response']);
        $receipt = $this->app->make(MutationAction::class)->execute([$operation], $this->actor())['receipts'][0];
        $this->assertSame('accepted', $receipt['status']);
        $this->assertSame(1, Item::count());
        $this->assertSame(1, DB::table('synloquent_publications')->count());
        $this->assertSame(1, DB::table('synloquent_receipts')->count());
    }

    public function test_external_success_then_worker_death_uses_downstream_idempotency(): void
    {
        $this->app->make(WriteGateway::class)->transaction($this->actor(), function (WriteContext $context): void {
            $context->effect('quantityChanged', 'idempotent-key', ['quantity' => 5]);
        });
        $worker = $this->worker('effectCrash');
        $this->closeWorker($worker, false);
        $this->assertSame(1, DB::table('synthetic_effect_deliveries')->count());
        $this->assertNull(DB::table('synloquent_effects')->value('delivered_at'));
        $this->assertTrue($this->app->make(EffectDelivery::class)->deliverOne());
        $this->assertSame(1, DB::table('synthetic_effect_deliveries')->count());
        $this->assertSame(2, DB::table('synthetic_effect_attempts')->count());
        $this->assertNotNull(DB::table('synloquent_effects')->value('delivered_at'));
        $this->assertFalse($this->app->make(EffectDelivery::class)->deliverOne());
    }

    public function test_non_idempotent_destination_explicitly_has_at_least_once_delivery(): void
    {
        $this->app->make(WriteGateway::class)->transaction($this->actor(), function (WriteContext $context): void {
            $context->effect('nonIdempotentControl', 'control-key', ['quantity' => 5]);
        });
        $worker = $this->worker('effectCrash');
        $this->closeWorker($worker, false);
        $this->assertSame(1, DB::table('synthetic_effect_non_idempotent_deliveries')->count());
        $this->assertTrue($this->app->make(EffectDelivery::class)->deliverOne());
        $this->assertSame(2, DB::table('synthetic_effect_non_idempotent_deliveries')->count());
    }
}

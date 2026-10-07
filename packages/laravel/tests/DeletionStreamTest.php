<?php

declare(strict_types=1);

namespace Synloquent\Tests;

use App\Models\Item;
use App\Models\Tag;
use App\Models\User;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Events\QueryExecuted;
use Illuminate\Database\Events\TransactionCommitted;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Gate;
use Illuminate\Support\Facades\Schema;
use Synloquent\Laravel\Export\ExportDefinition;
use Synloquent\Laravel\Export\ExportRegistry;
use Synloquent\Laravel\Protocol\ProtocolException;
use Synloquent\Laravel\Sync\ActorContext;
use Synloquent\Laravel\Sync\DeletionCapture;
use Synloquent\Laravel\Sync\MutationAction;
use Synloquent\Laravel\Sync\PullAction;
use Synloquent\Laravel\Sync\RevisionStore;
use Synloquent\Laravel\Sync\SnapshotAction;
use Synloquent\Laravel\Sync\WriteContext;
use Synloquent\Laravel\Sync\WriteGateway;

final class DeletionStreamTest extends TestCase
{
    public function test_context_delete_captures_mixed_private_cascade_and_nullified_rows_with_native_owner_events(): void
    {
        $this->fixture();
        $owner = DeletionOwner::create(['tenant_id' => 1, 'title' => 'Context delete owner']);
        $models = [$owner];
        foreach ([DeletionCascadeChild::class, DeletionNullifiedChild::class] as $class) {
            foreach ([1, 2] as $identity) {
                $models[] = $class::create(['tenant_id' => 1, 'actor_id' => $identity, 'owner_id' => $owner->id, 'title' => 'Private descendant '.$identity]);
            }
        }
        $gateway = $this->app->make(WriteGateway::class);
        $gateway->transaction($this->actor(), fn (WriteContext $context) => $context->captureMany($models));
        $snapshots = [];
        foreach (['1', '2'] as $identity) {
            $snapshots[$identity] = $this->app->make(SnapshotAction::class)->execute('catalog', $this->actor($identity));
        }
        $events = [];
        foreach ([DeletionOwner::class, DeletionCascadeChild::class, DeletionNullifiedChild::class] as $class) {
            foreach (['deleting', 'deleted', 'saving', 'updating', 'updated', 'saved'] as $event) {
                $this->app['events']->listen('eloquent.'.$event.': '.$class, static function () use (&$events, $class, $event): void {
                    $events[] = $class.':'.$event;
                });
            }
        }
        $gateway->transaction($this->actor(), function (WriteContext $context) use ($owner): void {
            $this->assertTrue($context->delete($owner));
        });
        $this->assertSame([DeletionOwner::class.':deleting', DeletionOwner::class.':deleted'], $events);
        $this->assertSame(0, DeletionCascadeChild::count());
        $this->assertSame(2, DeletionNullifiedChild::whereNull('owner_id')->count());
        $this->assertSame(5, DB::table('synloquent_revisions')->where('revision', 2)->count());
        $journal = json_decode(DB::table('synloquent_publications')->orderByDesc('sequence')->value('changes'), true, flags: JSON_THROW_ON_ERROR);
        $this->assertCount(5, $journal);
        foreach ($journal as $change) {
            if ($change['kind'] === 'delete') {
                $this->assertTrue($change['dependenciesCaptured']);
                $this->assertArrayNotHasKey('record', $change);
            } else {
                $this->assertNull($change['record']['attributes']['owner_id']);
            }
        }
        foreach (['1', '2'] as $identity) {
            $pull = $this->app->make(PullAction::class)->execute($snapshots[$identity]['cursor'], 'catalog', $this->actor($identity));
            $this->assertCount(3, $pull['batches'][0]['changes']);
            foreach ($pull['batches'][0]['changes'] as $change) {
                if ($change['model'] !== 'DeletionOwner') {
                    $this->assertSame($identity, $change['id']);
                }
            }
        }
        $stale = $this->operation('context-nullified-stale', 'update', ['title' => 'Stale title'], ['model' => 'DeletionNullifiedChild', 'id' => '1', 'expectedRevision' => '1']);
        $this->assertSame('conflicted', $this->app->make(MutationAction::class)->execute([$stale], $this->actor())['receipts'][0]['status']);
    }

    public function test_context_delete_rejects_unknown_foreign_current_stream_and_capture_cap(): void
    {
        $this->fixture();
        $owner = DeletionOwner::create(['tenant_id' => 1, 'title' => 'Guarded context owner']);
        $child = DeletionNullifiedChild::create(['tenant_id' => 1, 'actor_id' => 1, 'owner_id' => $owner->id, 'title' => 'Guarded child']);
        $gateway = $this->app->make(WriteGateway::class);
        $gateway->transaction($this->actor(), fn (WriteContext $context) => $context->captureMany([$owner, $child]));
        $resource = $this->app->make(ExportRegistry::class)->get('DeletionNullifiedChild');
        $observer = (object) ['enabled' => false];
        $this->app['events']->listen('eloquent.deleted: '.DeletionOwner::class, static function () use ($observer, $child): void {
            if ($observer->enabled) {
                DB::table('fixture_deletion_nullified_children')->where('id', $child->id)->update(['tenant_id' => 2]);
            }
        });
        foreach (['unknown', 'cross-stream', 'current-stream', 'cap'] as $scenario) {
            $resource->knownStream = $scenario !== 'unknown';
            DB::table('fixture_deletion_nullified_children')->where('id', $child->id)->update(['tenant_id' => $scenario === 'cross-stream' ? 2 : 1]);
            config(['synloquent.max_delta_records' => $scenario === 'cap' ? 0 : 1000]);
            $observer->enabled = $scenario === 'current-stream';
            try {
                $gateway->transaction($this->actor(), fn (WriteContext $context) => $context->delete($owner->refresh()));
                $this->fail('Unknown, foreign or changed streams and excessive dependencies must rollback.');
            } catch (ProtocolException $exception) {
                $this->assertSame($scenario === 'cap' ? 'validation_failed' : 'unsupported_query', $exception->errorCode);
            }
            $owner = DeletionOwner::findOrFail($owner->id);
            $this->assertSame($owner->id, $child->refresh()->owner_id);
            $this->assertSame($scenario === 'cross-stream' ? 2 : 1, $child->tenant_id);
            $this->assertSame('1', $this->app->make(RevisionStore::class)->get($this->actor()->stream(), 'DeletionNullifiedChild', (string) $child->id));
            $this->assertSame(1, DB::table('synloquent_publications')->count());
        }
    }

    public function test_physical_delete_fanout_profile_for_hundred_descendants(): void
    {
        $this->profileFanout('cascade', 100);
    }

    public function test_physical_delete_fanout_profile_for_thousand_descendants(): void
    {
        $this->profileFanout('cascade', 1000);
    }

    public function test_set_null_delete_fanout_profile_for_hundred_descendants(): void
    {
        $this->profileFanout('set-null', 100);
    }

    public function test_set_null_delete_fanout_profile_for_thousand_descendants(): void
    {
        $this->profileFanout('set-null', 1000);
    }

    private function profileFanout(string $action, int $count): void
    {
        $this->fixture();
        $class = $action === 'cascade' ? DeletionCascadeChild::class : DeletionNullifiedChild::class;
        $name = $action === 'cascade' ? 'DeletionCascadeChild' : 'DeletionNullifiedChild';
        $model = new $class;
        $owner = DeletionOwner::create(['tenant_id' => 1, 'title' => 'Measured '.$action.' owner']);
        $rows = [];
        foreach (range(1, $count) as $position) {
            $rows[] = ['tenant_id' => 1, 'actor_id' => $position % 2 === 0 ? 2 : 1, 'owner_id' => $owner->id, 'title' => 'Measured child '.$position];
        }
        DB::table($model->getTable())->insert($rows);
        $captureCap = $count === 1000 ? 1024 : 1000;
        config(['synloquent.max_delta_records' => $captureCap]);
        $this->app->make(WriteGateway::class)->transaction($this->actor(), function (WriteContext $context) use ($owner, $class): void {
            $context->capture($owner);
            $context->captureMany($class::all()->all());
        });
        $snapshots = [];
        foreach (['1', '2'] as $actorId) {
            $snapshots[$actorId] = $this->app->make(SnapshotAction::class)->execute('catalog', $this->actor($actorId));
        }
        $operation = $this->operation('measured-delete-'.$action.'-'.$count, 'delete', [], ['model' => 'DeletionOwner', 'id' => (string) $owner->id, 'expectedRevision' => '1']);
        $rejectionCap = $count - 1;
        config(['synloquent.max_delta_records' => $rejectionCap]);
        $rejection = $this->app->make(MutationAction::class)->execute([$operation], $this->actor())['receipts'][0];
        $this->assertSame('rejected', $rejection['status']);
        $this->assertSame('validation_failed', $rejection['error']['code']);
        $this->assertNotNull(DeletionOwner::find($owner->id));
        $this->assertSame($count, $class::where('owner_id', $owner->id)->count());
        $this->assertSame($count + 1, DB::table('synloquent_revisions')->where('revision', 1)->count());
        $this->assertSame(1, DB::table('synloquent_publications')->count());
        config(['synloquent.max_delta_records' => $captureCap]);
        $operation['operationId'] .= '-accepted';
        $events = [];
        $ownerEventTimes = [];
        foreach ([DeletionOwner::class, $class] as $observedClass) {
            foreach (['deleting', 'deleted', 'saving', 'updating', 'updated', 'saved'] as $event) {
                $this->app['events']->listen('eloquent.'.$event.': '.$observedClass, static function () use (&$events, &$ownerEventTimes, $observedClass, $event): void {
                    $events[] = $observedClass.':'.$event;
                    if ($observedClass === DeletionOwner::class) {
                        $ownerEventTimes[$event] = hrtime(true);
                    }
                });
            }
        }
        $active = true;
        $queries = [];
        $lockAcquired = null;
        $committed = null;
        DB::listen(static function (QueryExecuted $event) use (&$active, &$queries, &$lockAcquired): void {
            if ($active) {
                $queries[$event->sql] = ($queries[$event->sql] ?? 0) + 1;
                if (str_contains($event->sql, 'synloquent_streams') && str_contains($event->sql, 'for update')) {
                    $lockAcquired = hrtime(true);
                }
            }
        });
        $this->app['events']->listen(TransactionCommitted::class, static function (TransactionCommitted $event) use (&$active, &$committed): void {
            if ($active && $event->connection->transactionLevel() === 0) {
                $committed = hrtime(true);
            }
        });
        $started = hrtime(true);
        $receipt = $this->app->make(MutationAction::class)->execute([$operation], $this->actor())['receipts'][0];
        $ended = hrtime(true);
        $active = false;
        $this->assertLessThanOrEqual(36, array_sum($queries), 'Deletion completion SQL must scale with model groups rather than descendants.');
        $this->assertSame('accepted', $receipt['status']);
        $this->assertNotNull($lockAcquired);
        $this->assertNotNull($committed);
        $this->assertArrayHasKey('deleting', $ownerEventTimes);
        $this->assertArrayHasKey('deleted', $ownerEventTimes);
        $this->assertNull(DeletionOwner::find($owner->id));
        $this->assertSame($action === 'cascade' ? 0 : $count, $class::count());
        if ($action === 'set-null') {
            $this->assertSame($count, $class::whereNull('owner_id')->count());
        }
        $this->assertSame($count + 1, DB::table('synloquent_revisions')->where('revision', 2)->count());
        $this->assertSame([DeletionOwner::class.':deleting', DeletionOwner::class.':deleted'], $events);
        $this->assertSame(2, DB::table('synloquent_publications')->count());
        $journal = json_decode(DB::table('synloquent_publications')->orderByDesc('sequence')->value('changes'), true, flags: JSON_THROW_ON_ERROR);
        $this->assertCount($count + 1, $journal);
        foreach ($journal as $change) {
            if ($change['kind'] === 'delete') {
                $this->assertTrue($change['dependenciesCaptured']);
                $this->assertArrayNotHasKey('record', $change);
            }
        }
        $authorizedCounts = [];
        foreach (['1', '2'] as $actorId) {
            $pull = $this->app->make(PullAction::class)->execute($snapshots[$actorId]['cursor'], 'catalog', $this->actor($actorId));
            $changes = $pull['batches'][0]['changes'];
            $authorizedCounts[$actorId] = count($changes);
            $this->assertCount(intdiv($count, 2) + 1, $changes);
            foreach ($changes as $change) {
                if ($change['model'] === $name) {
                    $this->assertSame((int) $actorId, (int) $change['id'] % 2 === 0 ? 2 : 1);
                    $this->assertSame($action === 'cascade' ? 'delete' : 'upsert', $change['kind']);
                    if ($action === 'set-null') {
                        $this->assertNull($change['record']['attributes']['owner_id']);
                        $this->assertSame('2', $change['record']['revision']);
                    }
                }
            }
            $this->assertSame([], $this->app->make(PullAction::class)->execute($pull['cursor'], 'catalog', $this->actor($actorId))['batches']);
        }
        $staleStatus = 'record_deleted';
        if ($action === 'set-null') {
            $stale = $this->operation('measured-nullified-stale-'.$count, 'update', ['title' => 'Stale proposal'], ['model' => $name, 'id' => '1', 'expectedRevision' => '1']);
            $staleStatus = $this->app->make(MutationAction::class)->execute([$stale], $this->actor())['receipts'][0]['status'];
            $this->assertSame('conflicted', $staleStatus);
        }
        if (getenv('SYNLOQUENT_DELETE_FANOUT_PROFILE') === '1') {
            $label = getenv('SYNLOQUENT_DELETE_FANOUT_LABEL') ?: 'development';
            if (! preg_match('/^[a-z0-9-]+$/D', $label)) {
                throw new \RuntimeException('Invalid task-owned delete profile label.');
            }
            $sources = ['DeletionCapture' => __DIR__.'/../src/Sync/DeletionCapture.php', 'CaptureStreamGuard' => __DIR__.'/../src/Sync/CaptureStreamGuard.php', 'RevisionStore' => __DIR__.'/../src/Sync/RevisionStore.php', 'WriteContext' => __DIR__.'/../src/Sync/WriteContext.php', 'MutationAction' => __DIR__.'/../src/Sync/MutationAction.php', 'fixture' => __FILE__];
            $profile = ['development' => true, 'action' => $action, 'descendants' => $count, 'ownerPlusDescendants' => $count + 1, 'captureCap' => $captureCap, 'rejectionCap' => $rejectionCap, 'rejectionStatus' => $rejection['status'], 'existingDeletionBound' => 'Counts staged dependents. Root is added to the publication separately.', 'sqlCount' => array_sum($queries), 'elapsedSeconds' => ($ended - $started) / 1e9, 'streamLockHoldSeconds' => ($committed - $lockAcquired) / 1e9, 'phaseSeconds' => ['lockToDeleting' => ($ownerEventTimes['deleting'] - $lockAcquired) / 1e9, 'deletingToDeleted' => ($ownerEventTimes['deleted'] - $ownerEventTimes['deleting']) / 1e9, 'deletedToCommit' => ($committed - $ownerEventTimes['deleted']) / 1e9], 'phaseDefinition' => ['lockToDeleting' => 'Includes scoped root read, revision check, referential staging and dependency stream guards.', 'deletingToDeleted' => 'Includes physical owner SQL deletion, PostgreSQL referential effects and owner event dispatch.', 'deletedToCommit' => 'Includes batched dependent reload and capture, root capture, receipt and durable publication.'], 'sqlProfile' => $queries, 'journalRecords' => count($journal), 'revisionTwoRows' => $count + 1, 'authorizedPullRecords' => $authorizedCounts, 'staleChildStatus' => $staleStatus, 'ownerEvents' => $events, 'databaseVersion' => DB::selectOne('SELECT version() AS version')->version, 'sourceHashes' => array_map(fn (string $path): string => hash_file('sha256', $path), $sources)];
            file_put_contents(dirname(__DIR__, 3).'/.agentic/artifacts/server-delete-fanout-'.$label.'-'.$action.'-'.$count.'.json', json_encode($profile, JSON_PRETTY_PRINT | JSON_THROW_ON_ERROR)."\n");
        }
    }

    public function test_cross_stream_cascade_delete_fails_closed_without_wrong_stream_publication(): void
    {
        $this->crossStream(DeletionCascadeChild::class, 'DeletionCascadeChild');
    }

    public function test_cross_stream_set_null_fails_closed_without_wrong_stream_publication(): void
    {
        $this->crossStream(DeletionNullifiedChild::class, 'DeletionNullifiedChild');
    }

    private function crossStream(string $childClass, string $name): void
    {
        $this->fixture();
        $owner = DeletionOwner::create(['tenant_id' => 1, 'title' => 'Tenant one owner']);
        $child = $childClass::create(['tenant_id' => 2, 'actor_id' => 2, 'owner_id' => $owner->id, 'title' => 'Tenant two child']);
        $user = User::findOrFail(2);
        $user->tenant_id = 2;
        $user->save();
        $other = new ActorContext('2', '2', 'epoch-1', '1', $user, 'example-device');
        $this->app->make(WriteGateway::class)->transaction($this->actor(), fn (WriteContext $context) => $context->capture($owner));
        $this->app->make(WriteGateway::class)->transaction($other, fn (WriteContext $context) => $context->capture($child));
        $before = $this->app->make(SnapshotAction::class)->execute('catalog', $this->actor());
        $otherBefore = $this->app->make(SnapshotAction::class)->execute('catalog', $other);
        $this->assertSame($name, $otherBefore['records'][0]['model']);
        $operation = $this->operation('cross-stream-delete-'.$name, 'delete', [], ['model' => 'DeletionOwner', 'id' => (string) $owner->id, 'expectedRevision' => '1']);
        $receipt = $this->app->make(MutationAction::class)->execute([$operation], $this->actor())['receipts'][0];
        $this->assertSame('rejected', $receipt['status']);
        $this->assertSame('unsupported_query', $receipt['error']['code']);
        $this->assertNotNull(DeletionOwner::find($owner->id));
        $this->assertSame($owner->id, $child->refresh()->owner_id);
        $revisions = $this->app->make(RevisionStore::class);
        $this->assertSame('1', $revisions->get($this->actor()->stream(), 'DeletionOwner', (string) $owner->id));
        $this->assertSame('1', $revisions->get($other->stream(), $name, (string) $child->id));
        $this->assertSame('0', $revisions->get($this->actor()->stream(), $name, (string) $child->id));
        $this->assertSame(2, DB::table('synloquent_publications')->count());
        $this->assertSame([], $this->app->make(PullAction::class)->execute($before['cursor'], 'catalog', $this->actor())['batches']);
        $this->assertSame([], $this->app->make(PullAction::class)->execute($otherBefore['cursor'], 'catalog', $other)['batches']);
    }

    public function test_same_stream_private_cascade_and_nullified_children_publish_and_reauthorize(): void
    {
        $this->fixture();
        $owner = DeletionOwner::create(['tenant_id' => 1, 'title' => 'Shared stream owner']);
        $models = [$owner];
        foreach ([DeletionCascadeChild::class, DeletionNullifiedChild::class] as $class) {
            foreach ([1, 2] as $actorId) {
                $models[] = $class::create(['tenant_id' => 1, 'actor_id' => $actorId, 'owner_id' => $owner->id, 'title' => 'Private actor '.$actorId]);
            }
        }
        $this->app->make(WriteGateway::class)->transaction($this->actor(), fn (WriteContext $context) => $context->captureMany($models));
        $before = $this->app->make(SnapshotAction::class)->execute('catalog', $this->actor());
        $otherBefore = $this->app->make(SnapshotAction::class)->execute('catalog', $this->actor('2'));
        $operation = $this->operation('same-stream-delete', 'delete', [], ['model' => 'DeletionOwner', 'id' => (string) $owner->id, 'expectedRevision' => '1']);
        $receipt = $this->app->make(MutationAction::class)->execute([$operation], $this->actor())['receipts'][0];
        $this->assertSame('accepted', $receipt['status']);
        $this->assertSame(0, DeletionCascadeChild::count());
        $this->assertSame(2, DeletionNullifiedChild::whereNull('owner_id')->count());
        $this->assertSame(5, DB::table('synloquent_revisions')->where('revision', 2)->count());
        $journal = json_decode(DB::table('synloquent_publications')->orderByDesc('sequence')->value('changes'), true, flags: JSON_THROW_ON_ERROR);
        $this->assertCount(5, $journal);
        foreach ([[$this->actor(), $before, '1'], [$this->actor('2'), $otherBefore, '2']] as [$actor, $snapshot, $identity]) {
            $pull = $this->app->make(PullAction::class)->execute($snapshot['cursor'], 'catalog', $actor);
            $this->assertCount(3, $pull['batches'][0]['changes']);
            $changes = collect($pull['batches'][0]['changes'])->keyBy(fn (array $change): string => $change['model'].':'.$change['id']);
            $this->assertSame('delete', $changes['DeletionCascadeChild:'.$identity]['kind']);
            $this->assertSame('upsert', $changes['DeletionNullifiedChild:'.$identity]['kind']);
            $this->assertNull($changes['DeletionNullifiedChild:'.$identity]['record']['attributes']['owner_id']);
            $this->assertSame('2', $changes['DeletionNullifiedChild:'.$identity]['record']['revision']);
            $this->assertArrayNotHasKey('DeletionNullifiedChild:'.($identity === '1' ? '2' : '1'), $changes->all());
        }
        $stale = $this->operation('stale-nullified-child', 'update', ['title' => 'Stale write'], ['model' => 'DeletionNullifiedChild', 'id' => '1', 'expectedRevision' => '1']);
        $this->assertSame('conflicted', $this->app->make(MutationAction::class)->execute([$stale], $this->actor())['receipts'][0]['status']);
    }

    public function test_unknown_deletion_stream_and_current_nullified_partition_change_roll_back(): void
    {
        $this->fixture();
        $owner = DeletionOwner::create(['tenant_id' => 1, 'title' => 'Verified owner']);
        $child = DeletionNullifiedChild::create(['tenant_id' => 1, 'actor_id' => 1, 'owner_id' => $owner->id, 'title' => 'Verified child']);
        $this->app->make(WriteGateway::class)->transaction($this->actor(), fn (WriteContext $context) => $context->captureMany([$owner, $child]));
        foreach (['DeletionOwner', 'DeletionNullifiedChild'] as $name) {
            $resource = $this->app->make(ExportRegistry::class)->get($name);
            $resource->knownStream = false;
            $operation = $this->operation('unknown-delete-stream-'.$name, 'delete', [], ['model' => 'DeletionOwner', 'id' => (string) $owner->id, 'expectedRevision' => '1']);
            $receipt = $this->app->make(MutationAction::class)->execute([$operation], $this->actor())['receipts'][0];
            $this->assertSame('rejected', $receipt['status']);
            $this->assertSame('unsupported_query', $receipt['error']['code']);
            $this->assertSame($owner->id, $child->refresh()->owner_id);
            $resource->knownStream = true;
        }
        $this->app['events']->listen('eloquent.deleted: '.DeletionOwner::class, static function () use ($child): void {
            DB::table('fixture_deletion_nullified_children')->where('id', $child->id)->update(['tenant_id' => 2]);
        });
        $operation = $this->operation('current-nullified-stream', 'delete', [], ['model' => 'DeletionOwner', 'id' => (string) $owner->id, 'expectedRevision' => '1']);
        $receipt = $this->app->make(MutationAction::class)->execute([$operation], $this->actor())['receipts'][0];
        $this->assertSame('rejected', $receipt['status']);
        $this->assertSame('unsupported_query', $receipt['error']['code']);
        $this->assertNotNull(DeletionOwner::find($owner->id));
        $this->assertSame(1, $child->refresh()->tenant_id);
        $this->assertSame($owner->id, $child->owner_id);
        $this->assertSame(2, DB::table('synloquent_revisions')->where('revision', 1)->count());
        $this->assertSame(1, DB::table('synloquent_publications')->count());
    }

    public function test_automatic_pivot_deletion_rejects_a_foreign_stream_owner(): void
    {
        $tag = Tag::create(['tenant_id' => 1, 'title' => 'Local target']);
        $foreignOwner = Item::create(['tenant_id' => 2, 'title' => 'Foreign stream owner', 'price' => '1.00', 'active' => true]);
        $foreignOwner->tags()->attach($tag, ['position' => 1]);
        $other = new ActorContext('2', '2', 'epoch-1', '1', User::findOrFail(2), 'example-device');
        $this->app->make(WriteGateway::class)->transaction($this->actor(), fn (WriteContext $context) => $context->capture($tag));
        $this->app->make(WriteGateway::class)->transaction($other, fn (WriteContext $context) => $context->capture($foreignOwner));
        $operation = $this->operation('cross-stream-pivot-delete', 'delete', [], ['model' => 'Tag', 'id' => (string) $tag->id, 'expectedRevision' => '1']);
        $receipt = $this->app->make(MutationAction::class)->execute([$operation], $this->actor())['receipts'][0];
        $this->assertSame('rejected', $receipt['status']);
        $this->assertSame('unsupported_query', $receipt['error']['code']);
        $this->assertNotNull(Tag::find($tag->id));
        $this->assertSame(1, DB::table('item_tag')->count());
        $this->assertSame(0, DB::table('synloquent_relation_revisions')->count());
        $this->assertSame(2, DB::table('synloquent_publications')->count());
        $this->assertSame('1', $this->app->make(RevisionStore::class)->get($other->stream(), 'Item', (string) $foreignOwner->id));
    }

    public function test_batched_capture_rejects_unsupported_descriptor_kinds_before_revision_changes(): void
    {
        $this->fixture();
        $owner = DeletionOwner::create(['tenant_id' => 1, 'title' => 'Descriptor guard']);
        $this->app->make(WriteGateway::class)->transaction($this->actor(), fn (WriteContext $context) => $context->capture($owner));
        foreach ([['unknown', false], ['relation', false], ['remove', false], ['upsert', true]] as [$kind, $dependenciesCaptured]) {
            try {
                $this->app->make(WriteGateway::class)->transaction($this->actor(), fn (WriteContext $context) => $context->captureMany([$owner], $kind, $dependenciesCaptured));
                $this->fail('Unsupported batch descriptors must fail before revision advancement.');
            } catch (ProtocolException $exception) {
                $this->assertSame('unsupported_query', $exception->errorCode);
            }
            $this->assertSame('1', $this->app->make(RevisionStore::class)->get($this->actor()->stream(), 'DeletionOwner', (string) $owner->id));
            $this->assertSame(1, DB::table('synloquent_publications')->count());
        }
    }

    public function test_stage_indexes_incoming_dependencies_once_and_refreshes_registry_between_invocations(): void
    {
        $this->fixture();
        Schema::create('fixture_deletion_stage_probes', function (Blueprint $table): void {
            $table->id();
        });
        $this->app->make(ExportRegistry::class)->register($this->app->make(DeletionStageProbeExport::class));
        $owner = DeletionOwner::create(['tenant_id' => 1, 'title' => 'Indexed owner']);
        $children = [];
        foreach (range(1, 100) as $position) {
            $children[] = DeletionCascadeChild::create(['tenant_id' => 1, 'actor_id' => 1, 'owner_id' => $owner->id, 'title' => 'Indexed child '.$position]);
        }
        $gateway = $this->app->make(WriteGateway::class);
        $deletions = $this->app->make(DeletionCapture::class);
        $gateway->transaction($this->actor(), fn (WriteContext $context) => $context->captureMany([$owner, ...$children]));
        DeletionStageProbe::$constructions = 0;
        $first = $gateway->transaction($this->actor(), fn (WriteContext $context) => $deletions->stage($owner, $context));
        $this->assertCount(100, $first);
        $this->assertSame(3, DeletionStageProbe::$constructions, 'One FK index construction and one incoming-relation inspection per visited model class.');
        $this->assertSame(1, DB::table('synloquent_publications')->count());

        Schema::table('fixture_deletion_cascade_children', fn (Blueprint $table) => $table->unique(['id', 'tenant_id']));
        Schema::create('fixture_deletion_stage_leaves', function (Blueprint $table): void {
            $table->id();
            $table->bigInteger('tenant_id');
            $table->bigInteger('actor_id');
            $table->foreignId('child_id')->nullable();
            $table->string('title');
            $table->foreign(['child_id', 'tenant_id'])->references(['id', 'tenant_id'])->on('fixture_deletion_cascade_children')->cascadeOnDelete();
        });
        $resource = $this->app->make(DeletionStageLeafExport::class);
        $this->app->make(ExportRegistry::class)->register($resource);
        Gate::policy($resource->modelClass(), DeletionFixturePolicy::class);
        $leaf = DeletionStageLeaf::create(['tenant_id' => 1, 'actor_id' => 1, 'child_id' => $children[0]->id, 'title' => 'New recursive leaf']);
        $nullTuple = DeletionStageLeaf::create(['tenant_id' => 1, 'actor_id' => 1, 'child_id' => null, 'title' => 'Unrelated null tuple']);
        $gateway->transaction($this->actor(), fn (WriteContext $context) => $context->captureMany([$leaf, $nullTuple]));
        DeletionStageProbe::$constructions = 0;
        $second = $gateway->transaction($this->actor(), function (WriteContext $context) use ($deletions, $owner): array {
            $affected = $deletions->stage($owner, $context);
            $owner->delete();
            $deletions->complete($affected, $context);
            $context->capture($owner, 'delete', true);

            return $affected;
        });
        $this->assertCount(101, $second);
        $this->assertSame(4, DeletionStageProbe::$constructions, 'The next invocation rebuilds declarations and sees the newly registered deeper model.');
        $this->assertArrayHasKey(DeletionStageLeaf::class.':'.$leaf->id, $second);
        $this->assertArrayNotHasKey(DeletionStageLeaf::class.':'.$nullTuple->id, $second);
        $this->assertNull(DeletionOwner::find($owner->id));
        $this->assertSame(0, DeletionCascadeChild::count());
        $this->assertNull(DeletionStageLeaf::find($leaf->id));
        $this->assertNotNull(DeletionStageLeaf::find($nullTuple->id));
        $this->assertSame('2', $this->app->make(RevisionStore::class)->get($this->actor()->stream(), 'DeletionStageLeaf', (string) $leaf->id));
        $this->assertSame('1', $this->app->make(RevisionStore::class)->get($this->actor()->stream(), 'DeletionStageLeaf', (string) $nullTuple->id));
        $journal = json_decode(DB::table('synloquent_publications')->orderByDesc('sequence')->value('changes'), true, flags: JSON_THROW_ON_ERROR);
        $this->assertCount(102, $journal);
        foreach ($journal as $change) {
            $this->assertSame('delete', $change['kind']);
            $this->assertTrue($change['dependenciesCaptured']);
        }
    }

    private function fixture(): void
    {
        Schema::create('fixture_deletion_owners', function (Blueprint $table): void {
            $table->id();
            $table->bigInteger('tenant_id');
            $table->string('title');
        });
        foreach (['cascade', 'nullified'] as $action) {
            Schema::create('fixture_deletion_'.$action.'_children', function (Blueprint $table) use ($action): void {
                $table->id();
                $table->bigInteger('tenant_id');
                $table->bigInteger('actor_id');
                $table->foreignId('owner_id')->nullable()->constrained('fixture_deletion_owners')->onDelete($action === 'cascade' ? 'cascade' : 'set null');
                $table->string('title');
            });
        }
        foreach ([DeletionOwnerExport::class, DeletionCascadeExport::class, DeletionNullifiedExport::class] as $class) {
            $resource = $this->app->make($class);
            $this->app->make(ExportRegistry::class)->register($resource);
            Gate::policy($resource->modelClass(), DeletionFixturePolicy::class);
        }
    }
}

final class DeletionOwner extends Model
{
    protected $table = 'fixture_deletion_owners';

    protected $guarded = [];

    public $timestamps = false;
}

final class DeletionCascadeChild extends Model
{
    protected $table = 'fixture_deletion_cascade_children';

    protected $guarded = [];

    public $timestamps = false;
}

final class DeletionNullifiedChild extends Model
{
    protected $table = 'fixture_deletion_nullified_children';

    protected $guarded = [];

    public $timestamps = false;
}

final class DeletionStageProbe extends Model
{
    public static int $constructions = 0;

    protected $table = 'fixture_deletion_stage_probes';

    public function __construct(array $attributes = [])
    {
        self::$constructions++;
        parent::__construct($attributes);
    }
}

final class DeletionStageLeaf extends Model
{
    protected $table = 'fixture_deletion_stage_leaves';

    protected $guarded = [];

    public $timestamps = false;
}

abstract class DeletionFixtureExport extends ExportDefinition
{
    public bool $knownStream = true;

    public function selfContainedProjection(): bool
    {
        return true;
    }

    public function captureStream(Model $model): ?string
    {
        return $this->knownStream ? hash('sha256', (string) $model->getAttribute('tenant_id')) : null;
    }

    public function readable(): array
    {
        return $this->modelClass() === DeletionOwner::class ? ['id', 'title'] : ['id', 'owner_id', 'title'];
    }

    public function writable(): array
    {
        return ['title'];
    }

    public function operations(): array
    {
        return ['query', 'update', 'delete'];
    }

    public function scope(Builder $query, ActorContext $actor): void
    {
        $query->where($query->getModel()->qualifyColumn('tenant_id'), (int) $actor->tenantId);
        if ($this->modelClass() !== DeletionOwner::class) {
            $query->where($query->getModel()->qualifyColumn('actor_id'), (int) $actor->actorId);
        }
    }
}

final class DeletionOwnerExport extends DeletionFixtureExport
{
    public function name(): string
    {
        return 'DeletionOwner';
    }

    public function modelClass(): string
    {
        return DeletionOwner::class;
    }
}

final class DeletionCascadeExport extends DeletionFixtureExport
{
    public function name(): string
    {
        return 'DeletionCascadeChild';
    }

    public function modelClass(): string
    {
        return DeletionCascadeChild::class;
    }
}

final class DeletionNullifiedExport extends DeletionFixtureExport
{
    public function name(): string
    {
        return 'DeletionNullifiedChild';
    }

    public function modelClass(): string
    {
        return DeletionNullifiedChild::class;
    }
}

final class DeletionStageProbeExport extends DeletionFixtureExport
{
    public function name(): string
    {
        return 'DeletionStageProbe';
    }

    public function modelClass(): string
    {
        return DeletionStageProbe::class;
    }
}

final class DeletionStageLeafExport extends DeletionFixtureExport
{
    public function name(): string
    {
        return 'DeletionStageLeaf';
    }

    public function modelClass(): string
    {
        return DeletionStageLeaf::class;
    }
}

final class DeletionFixturePolicy
{
    public function viewAny(User $actor): bool
    {
        return true;
    }

    public function update(User $actor, Model $model): bool
    {
        return $actor->tenant_id === $model->tenant_id && (! isset($model->actor_id) || $actor->id === $model->actor_id);
    }

    public function delete(User $actor, Model $model): bool
    {
        return $this->update($actor, $model);
    }
}

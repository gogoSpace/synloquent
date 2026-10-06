<?php

declare(strict_types=1);

namespace Synloquent\Tests;

use App\Models\Item;
use App\Models\Tag;
use App\Models\User;
use App\Policies\CatalogPolicy;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Events\QueryExecuted;
use Illuminate\Database\Events\TransactionCommitted;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Gate;
use Illuminate\Support\Facades\Schema;
use Synloquent\Laravel\Export\ExportDefinition;
use Synloquent\Laravel\Export\ExportRegistry;
use Synloquent\Laravel\Export\ManifestBuilder;
use Synloquent\Laravel\Protocol\CanonicalJson;
use Synloquent\Laravel\Protocol\ProtocolException;
use Synloquent\Laravel\Sync\ActorContext;
use Synloquent\Laravel\Sync\MutationAction;
use Synloquent\Laravel\Sync\PullAction;
use Synloquent\Laravel\Sync\RevisionStore;
use Synloquent\Laravel\Sync\SnapshotAction;
use Synloquent\Laravel\Sync\WriteContext;
use Synloquent\Laravel\Sync\WriteGateway;

final class UpdateCascadeTest extends TestCase
{
    public function test_context_save_orchestrates_recursive_owner_key_capture_and_stale_child_conflict(): void
    {
        [$owner, $child, $leaf] = $this->baseline();
        $hidden = UpdateChild::create(['tenant_id' => 1, 'actor_id' => 2, 'owner_code' => '00106', 'owner_number' => '9007199254740993', 'title' => 'Private child']);
        $gateway = $this->app->make(WriteGateway::class);
        $gateway->transaction($this->actor(), fn (WriteContext $context) => $context->capture($hidden));
        $snapshots = [];
        foreach (['1', '2'] as $identity) {
            $snapshots[$identity] = $this->app->make(SnapshotAction::class)->execute('catalog', $this->actor($identity));
        }
        $events = [];
        foreach ([UpdateOwner::class, UpdateChild::class, UpdateLeaf::class] as $class) {
            foreach (['saving', 'updating', 'updated', 'saved'] as $event) {
                $this->app['events']->listen('eloquent.'.$event.': '.$class, static function () use (&$events, $class, $event): void {
                    $events[] = $class.':'.$event;
                });
            }
        }
        $gateway->transaction($this->actor(), function (WriteContext $context) use ($owner): void {
            $owner->natural_key = 'new-owner-key';
            $owner->exact_key = '9007199254740995';
            // The preserved pre-API authoring path reproduces a missed dependent capture.
            if (method_exists($context, 'save')) {
                $this->assertTrue($context->save($owner));
            } else {
                $this->assertTrue($owner->save());
                $context->capture($owner);
            }
        });
        $this->assertSame('new-owner-key', $child->refresh()->owner_code);
        $this->assertSame('9007199254740995', (string) $child->owner_number);
        $this->assertSame('new-owner-key', $leaf->refresh()->owner_code);
        $this->assertSame('new-owner-key', $hidden->refresh()->owner_code);
        foreach (['UpdateOwner' => $owner, 'UpdateChild' => $child, 'UpdateLeaf' => $leaf] as $name => $model) {
            $this->assertSame('2', $this->app->make(RevisionStore::class)->get($this->actor()->stream(), $name, (string) $model->getKey()));
        }
        $this->assertSame('2', $this->app->make(RevisionStore::class)->get($this->actor()->stream(), 'UpdateChild', (string) $hidden->id));
        $this->assertSame(array_map(fn (string $event): string => UpdateOwner::class.':'.$event, ['saving', 'updating', 'updated', 'saved']), $events);
        foreach (['1', '2'] as $identity) {
            $pull = $this->app->make(PullAction::class)->execute($snapshots[$identity]['cursor'], 'catalog', $this->actor($identity));
            $children = array_values(array_filter($pull['batches'][0]['changes'], fn (array $change): bool => $change['model'] === 'UpdateChild'));
            $this->assertCount(1, $children);
            $this->assertSame((string) ($identity === '1' ? $child->id : $hidden->id), $children[0]['id']);
            $this->assertSame('2', $children[0]['record']['revision']);
        }
        $stale = $this->operation('context-stale-child', 'update', ['title' => 'Stale proposal'], ['model' => 'UpdateChild', 'id' => (string) $child->id, 'expectedRevision' => '1']);
        $this->assertSame('conflicted', $this->app->make(MutationAction::class)->execute([$stale], $this->actor())['receipts'][0]['status']);
    }

    public function test_context_save_rejects_cap_unknown_cross_stream_and_post_observer_partition_changes_atomically(): void
    {
        [$owner, $child, $leaf] = $this->baseline();
        $gateway = $this->app->make(WriteGateway::class);
        $resource = $this->app->make(ExportRegistry::class)->get('UpdateChild');
        $observer = (object) ['subject' => null];
        $this->app['events']->listen('eloquent.saved: '.UpdateOwner::class, static function (UpdateOwner $model) use ($observer, $child): void {
            if ($observer->subject !== null) {
                DB::table($observer->subject === 'owner' ? 'fixture_update_owners' : 'fixture_update_children')->where('id', $observer->subject === 'owner' ? $model->id : $child->id)->update(['tenant_id' => 2]);
            }
        });
        foreach (['cap', 'unknown', 'cross-stream', 'owner', 'child'] as $scenario) {
            config(['synloquent.max_delta_records' => $scenario === 'cap' ? 2 : 1000]);
            $resource->knownCaptureStream = $scenario !== 'unknown';
            DB::table('fixture_update_children')->where('id', $child->id)->update(['tenant_id' => $scenario === 'cross-stream' ? 2 : 1]);
            $observer->subject = in_array($scenario, ['owner', 'child'], true) ? $scenario : null;
            try {
                $gateway->transaction($this->actor(), function (WriteContext $context) use ($owner): void {
                    $owner->refresh();
                    $owner->natural_key = 'Rejected context key';
                    $context->save($owner);
                });
                $this->fail('An unsupported dependency stream or bound must reject the model write.');
            } catch (ProtocolException $exception) {
                $this->assertSame($scenario === 'cap' ? 'validation_failed' : 'unsupported_query', $exception->errorCode);
            }
            $this->assertSame('00106', $owner->refresh()->natural_key);
            $this->assertSame('00106', $child->refresh()->owner_code);
            $this->assertSame('00106', $leaf->refresh()->owner_code);
            $this->assertSame(1, $owner->tenant_id);
            $this->assertSame($scenario === 'cross-stream' ? 2 : 1, $child->tenant_id);
            $this->assertSame('1', $this->app->make(RevisionStore::class)->get($this->actor()->stream(), 'UpdateChild', (string) $child->id));
            $this->assertSame(1, DB::table('synloquent_publications')->count());
        }
        $observer->subject = null;
        $this->app->make(ExportRegistry::class)->get('UpdateOwner')->knownCaptureStream = false;
        $gateway->transaction($this->actor(), function (WriteContext $context) use ($owner): void {
            $owner->title = 'Ordinary write without automatic dependencies';
            $this->assertTrue($context->save($owner));
        });
        $this->assertSame('Ordinary write without automatic dependencies', $owner->refresh()->title);
        $this->assertSame('1', $this->app->make(RevisionStore::class)->get($this->actor()->stream(), 'UpdateChild', (string) $child->id));
        $this->assertSame(2, DB::table('synloquent_publications')->count());
    }

    public function test_context_save_rejects_unstaged_observer_owner_key_and_preserves_original_rows(): void
    {
        [$owner, $child, $leaf] = $this->baseline();
        $this->app['events']->listen('eloquent.saving: '.UpdateOwner::class, static function (UpdateOwner $model): void {
            $model->natural_key = 'Observer key';
        });
        try {
            $this->app->make(WriteGateway::class)->transaction($this->actor(), function (WriteContext $context) use ($owner): void {
                $owner->title = 'Ordinary update';
                $context->save($owner);
            });
            $this->fail('An observer cannot introduce an unstaged referential key mutation.');
        } catch (ProtocolException $exception) {
            $this->assertSame('unsupported_query', $exception->errorCode);
        }
        $this->assertSame('Before', $owner->refresh()->title);
        $this->assertSame('00106', $owner->natural_key);
        $this->assertSame('00106', $child->refresh()->owner_code);
        $this->assertSame('00106', $leaf->refresh()->owner_code);
        $this->assertSame(3, DB::table('synloquent_revisions')->where('revision', 1)->count());
        $this->assertSame(1, DB::table('synloquent_publications')->count());
    }

    public function test_hundred_update_descendants_profile_sql_and_stream_lock_cost(): void
    {
        $this->profileFanout(100);
    }

    public function test_thousand_update_descendants_profile_sql_and_stream_lock_cost(): void
    {
        $this->profileFanout(1000);
    }

    private function profileFanout(int $count): void
    {
        $this->fixture();
        $owner = UpdateOwner::create(['tenant_id' => 1, 'natural_key' => '00106', 'exact_key' => '9007199254740993', 'title' => 'Fan-out owner']);
        $rows = [];
        foreach (range(1, $count) as $position) {
            $rows[] = ['tenant_id' => 1, 'actor_id' => $position === $count ? 2 : 1, 'owner_code' => '00106', 'owner_number' => '9007199254740993', 'title' => 'Child '.$position];
        }
        DB::table('fixture_update_children')->insert($rows);
        $this->app->make(WriteGateway::class)->transaction($this->actor(), function (WriteContext $context) use ($owner): void {
            $context->capture($owner);
            foreach (UpdateChild::all() as $child) {
                $context->capture($child);
            }
        });
        $snapshot = $this->app->make(SnapshotAction::class)->execute('catalog', $this->actor());
        $operation = $this->operation('fanout-'.$count, 'update', ['natural_key' => 'fanout-key'], ['model' => 'UpdateOwner', 'id' => (string) $owner->id, 'expectedRevision' => '1']);
        $defaultStatus = 'not_exceeded';
        if ($count === 1000) {
            $rejected = $this->app->make(MutationAction::class)->execute([$operation], $this->actor())['receipts'][0];
            $this->assertSame('rejected', $rejected['status']);
            $this->assertSame('validation_failed', $rejected['error']['code']);
            $this->assertSame(1, DB::table('synloquent_publications')->count());
            $this->assertSame($count, DB::table('fixture_update_children')->where('owner_code', '00106')->count());
            $this->assertSame($count + 1, DB::table('synloquent_revisions')->where('revision', 1)->count());
            $defaultStatus = 'rejected_root_plus_1000';
            config(['synloquent.max_delta_records' => 1024]);
            $operation['operationId'] = 'fanout-1000-cap1024';
        }
        $active = true;
        $queries = [];
        $acquired = null;
        $committed = null;
        DB::listen(static function (QueryExecuted $event) use (&$active, &$queries, &$acquired): void {
            if (! $active) {
                return;
            }
            $queries[$event->sql] = ($queries[$event->sql] ?? 0) + 1;
            if (str_contains($event->sql, '"synloquent_streams"') && str_contains($event->sql, 'for update')) {
                $acquired = hrtime(true);
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
        $this->assertLessThanOrEqual(24, array_sum($queries), 'Cascade SQL must scale with registered frontiers rather than descendants.');
        $this->assertSame(1, array_sum(array_filter($queries, fn (string $sql): bool => str_starts_with($sql, 'INSERT INTO "synloquent_revisions"'), ARRAY_FILTER_USE_KEY)));
        $this->assertSame('accepted', $receipt['status']);
        $this->assertNotNull($acquired);
        $this->assertNotNull($committed);
        $this->assertSame($count, DB::table('fixture_update_children')->where('owner_code', 'fanout-key')->count());
        $this->assertSame($count + 1, DB::table('synloquent_revisions')->where('revision', 2)->count());
        $journal = json_decode(DB::table('synloquent_publications')->orderByDesc('sequence')->value('changes'), true, flags: JSON_THROW_ON_ERROR);
        $this->assertCount($count + 1, $journal);
        $pull = $this->app->make(PullAction::class)->execute($snapshot['cursor'], 'catalog', $this->actor());
        $this->assertCount($count, $pull['batches'][0]['changes']);
        $this->assertCount($count - 1, array_filter($pull['batches'][0]['changes'], fn ($change) => $change['model'] === 'UpdateChild'));
        foreach ($pull['batches'][0]['changes'] as $change) {
            $this->assertSame('2', $change['record']['revision']);
            if ($change['model'] === 'UpdateChild') {
                $this->assertSame('fanout-key', $change['record']['attributes']['owner_code']);
            }
        }
        $stale = $this->operation('fanout-stale-'.$count, 'update', ['title' => 'Stale edit'], ['model' => 'UpdateChild', 'id' => '1', 'expectedRevision' => '1']);
        $this->assertSame('conflicted', $this->app->make(MutationAction::class)->execute([$stale], $this->actor())['receipts'][0]['status']);
        if (getenv('SYNLOQUENT_UPDATE_FANOUT_PROFILE') === '1') {
            $profile = ['descendants' => $count, 'ownerPlusDescendants' => $count + 1, 'captureCap' => config('synloquent.max_delta_records'), 'defaultCap' => $defaultStatus, 'sqlCount' => array_sum($queries), 'elapsedSeconds' => ($ended - $started) / 1e9, 'streamLockHoldSeconds' => ($committed - $acquired) / 1e9, 'sqlProfile' => $queries, 'journalRecords' => count($journal), 'authorizedPullRecords' => count($pull['batches'][0]['changes']), 'canonicalChildRevision' => '2', 'staleChildStatus' => 'conflicted', 'sourceHash' => hash_file('sha256', __DIR__.'/../src/Sync/UpdateCapture.php'), 'sourceHashes' => array_combine(['UpdateCapture', 'WriteContext', 'RevisionStore', 'MutationAction', 'test'], array_map(fn (string $file): string => hash_file('sha256', $file), [__DIR__.'/../src/Sync/UpdateCapture.php', __DIR__.'/../src/Sync/WriteContext.php', __DIR__.'/../src/Sync/RevisionStore.php', __DIR__.'/../src/Sync/MutationAction.php', __FILE__])), 'databaseVersion' => DB::selectOne('SELECT version() AS version')->version];
            $label = getenv('SYNLOQUENT_UPDATE_FANOUT_LABEL') ?: 'development';
            if (! preg_match('/^[a-z0-9-]+$/D', $label)) {
                throw new \RuntimeException('Invalid task-owned profile label.');
            }
            file_put_contents(dirname(__DIR__, 3).'/.local/test-results/server-update-fanout-'.$label.'-'.$count.'.json', json_encode($profile, JSON_PRETTY_PRINT | JSON_THROW_ON_ERROR)."\n");
        }
    }

    public function test_owner_key_update_captures_recursive_cascades_and_rejects_stale_child_revision(): void
    {
        $this->fixture();
        $owner = UpdateOwner::create(['tenant_id' => 1, 'natural_key' => '00106', 'exact_key' => '9007199254740993', 'title' => 'Before']);
        $child = UpdateChild::create(['tenant_id' => 1, 'owner_code' => '00106', 'owner_number' => '9007199254740993', 'title' => 'Visible child']);
        $hidden = UpdateChild::create(['tenant_id' => 1, 'actor_id' => 2, 'owner_code' => '00106', 'owner_number' => '9007199254740993', 'title' => 'Hidden child']);
        $leaf = UpdateLeaf::create(['tenant_id' => 1, 'child_id' => $child->id, 'owner_code' => '00106', 'title' => 'Recursive leaf']);
        $this->app->make(WriteGateway::class)->transaction($this->actor(), function (WriteContext $context) use ($owner, $child, $hidden, $leaf): void {
            foreach ([$owner, $child, $hidden, $leaf] as $model) {
                $context->capture($model);
            }
        });
        $snapshot = $this->app->make(SnapshotAction::class)->execute('catalog', $this->actor());
        $events = [];
        $otherSnapshot = $this->app->make(SnapshotAction::class)->execute('catalog', $this->actor('2'));
        foreach ([UpdateOwner::class, UpdateChild::class, UpdateLeaf::class] as $class) {
            foreach (['saving', 'updating', 'updated', 'saved'] as $event) {
                $this->app['events']->listen('eloquent.'.$event.': '.$class, static function () use (&$events, $class, $event): void {
                    $events[] = $class.':'.$event;
                });
            }
        }
        $operation = $this->operation('cascade-owner-update', 'update', ['natural_key' => '00206', 'exact_key' => '9007199254740995'], ['model' => 'UpdateOwner', 'id' => (string) $owner->id, 'expectedRevision' => '1']);
        $receipt = $this->app->make(MutationAction::class)->execute([$operation], $this->actor())['receipts'][0];
        $this->assertSame('accepted', $receipt['status']);
        $this->assertSame(array_map(fn (string $event): string => UpdateOwner::class.':'.$event, ['saving', 'updating', 'updated', 'saved']), $events);
        $this->assertSame('00206', $child->refresh()->owner_code);
        $this->assertSame('9007199254740995', (string) $child->owner_number);
        $this->assertSame('00206', $leaf->refresh()->owner_code);
        $revisions = $this->app->make(RevisionStore::class);
        if (getenv('SYNLOQUENT_UPDATE_CASCADE_BASELINE') === '1') {
            $journal = json_decode(DB::table('synloquent_publications')->orderByDesc('sequence')->value('changes'), true, flags: JSON_THROW_ON_ERROR);
            $baselinePull = $this->app->make(PullAction::class)->execute($snapshot['cursor'], 'catalog', $this->actor());
            $stale = $this->operation('cascade-baseline-stale-child', 'update', ['title' => 'Stale accepted write'], ['model' => 'UpdateChild', 'id' => (string) $child->id, 'expectedRevision' => '1']);
            $baseline = ['databaseVersion' => DB::selectOne('SELECT version() AS version')->version, 'parentStatus' => $receipt['status'], 'childForeignKey' => $child->owner_code, 'childExactKey' => (string) $child->owner_number, 'leafForeignKey' => $leaf->owner_code, 'childRevision' => $revisions->get($this->actor()->stream(), 'UpdateChild', (string) $child->id), 'leafRevision' => $revisions->get($this->actor()->stream(), 'UpdateLeaf', (string) $leaf->id), 'journalModels' => array_column($journal, 'model'), 'pullModels' => array_column($baselinePull['batches'][0]['changes'], 'model'), 'staleChildStatus' => $this->app->make(MutationAction::class)->execute([$stale], $this->actor())['receipts'][0]['status'], 'mutationSourceHash' => hash_file('sha256', __DIR__.'/../src/Sync/MutationAction.php'), 'contextSourceHash' => hash_file('sha256', __DIR__.'/../src/Sync/WriteContext.php')];
            file_put_contents(dirname(__DIR__, 3).'/.local/test-results/server-update-cascade-baseline.json', json_encode($baseline, JSON_PRETTY_PRINT | JSON_THROW_ON_ERROR)."\n");
        }
        $this->assertSame('2', $revisions->get($this->actor()->stream(), 'UpdateChild', (string) $child->id));
        $this->assertSame('2', $revisions->get($this->actor()->stream(), 'UpdateLeaf', (string) $leaf->id));
        $this->assertSame('2', $revisions->get($this->actor()->stream(), 'UpdateChild', (string) $hidden->id));
        $journal = json_decode(DB::table('synloquent_publications')->orderByDesc('sequence')->value('changes'), true, flags: JSON_THROW_ON_ERROR);
        $this->assertCount(4, $journal);
        $this->assertSame(['UpdateChild:1', 'UpdateChild:2', 'UpdateLeaf:1', 'UpdateOwner:1'], array_values(collect($journal)->map(fn ($change) => $change['model'].':'.$change['id'])->sort()->all()));
        $pull = $this->app->make(PullAction::class)->execute($snapshot['cursor'], 'catalog', $this->actor());
        $records = collect($pull['batches'][0]['changes'])->keyBy(fn ($change) => $change['model'].':'.$change['id']);
        $this->assertSame(['UpdateChild:1', 'UpdateLeaf:1', 'UpdateOwner:1'], array_values($records->keys()->sort()->all()));
        $this->assertSame('00206', $records['UpdateChild:1']['record']['attributes']['owner_code']);
        $this->assertSame('9007199254740995', $records['UpdateChild:1']['record']['attributes']['owner_number']);
        $this->assertSame('2', $records['UpdateLeaf:1']['record']['revision']);
        $otherPull = $this->app->make(PullAction::class)->execute($otherSnapshot['cursor'], 'catalog', $this->actor('2'));
        $otherRecords = collect($otherPull['batches'][0]['changes'])->keyBy(fn ($change) => $change['model'].':'.$change['id']);
        $this->assertArrayNotHasKey('UpdateChild:1', $otherRecords->all());
        $this->assertSame('2', $otherRecords['UpdateChild:2']['record']['revision']);
        $this->assertSame('9007199254740995', $otherRecords['UpdateChild:2']['record']['attributes']['owner_number']);
        $this->assertSame([], $this->app->make(PullAction::class)->execute($pull['cursor'], 'catalog', $this->actor())['batches']);
        $stale = $this->operation('cascade-stale-child', 'update', ['title' => 'Stale write'], ['model' => 'UpdateChild', 'id' => (string) $child->id, 'expectedRevision' => '1']);
        $conflict = $this->app->make(MutationAction::class)->execute([$stale], $this->actor())['receipts'][0];
        $this->assertSame('conflicted', $conflict['status']);
        $this->assertSame('2', $conflict['canonical']['revision']);
        $this->assertSame('00206', $conflict['canonical']['attributes']['owner_code']);
        $this->assertSame('Visible child', $child->refresh()->title);
        $this->assertSame(2, DB::table('synloquent_publications')->count());
        $replay = $this->app->make(MutationAction::class)->execute([$operation], $this->actor())['receipts'][0];
        $this->assertSame(CanonicalJson::encode($receipt), CanonicalJson::encode($replay));
        $this->assertSame(2, DB::table('synloquent_publications')->count());
    }

    public function test_batched_capture_inserts_new_revisions_preserves_exact_counters_and_rolls_back(): void
    {
        [$owner, $child] = $this->baseline();
        $newChild = UpdateChild::create(['tenant_id' => 1, 'owner_code' => $owner->natural_key, 'owner_number' => $owner->exact_key, 'title' => 'New captured child']);
        DB::table('synloquent_revisions')->where(['model' => 'UpdateChild', 'identity' => (string) $child->id])->update(['revision' => '9007199254740993']);
        $this->app->make(WriteGateway::class)->transaction($this->actor(), function (WriteContext $context) use ($child, $newChild): void {
            $context->captureMany([$child, $newChild, $child]);
        });
        $revisions = $this->app->make(RevisionStore::class);
        $this->assertSame('9007199254740994', $revisions->get($this->actor()->stream(), 'UpdateChild', (string) $child->id));
        $this->assertSame('1', $revisions->get($this->actor()->stream(), 'UpdateChild', (string) $newChild->id));
        $journal = json_decode(DB::table('synloquent_publications')->orderByDesc('sequence')->value('changes'), true, flags: JSON_THROW_ON_ERROR);
        $this->assertCount(2, $journal);
        $this->assertSame(['9007199254740994', '1'], array_column(array_column($journal, 'record'), 'revision'));
        try {
            $this->app->make(WriteGateway::class)->transaction($this->actor(), function (WriteContext $context) use ($child, $newChild): void {
                $child->update(['title' => 'Aborted title']);
                $context->captureMany([$child, $newChild]);
                throw new \RuntimeException('Injected capture rollback.');
            });
            $this->fail('The injected failure must escape the gateway.');
        } catch (\RuntimeException $exception) {
            $this->assertSame('Injected capture rollback.', $exception->getMessage());
        }
        $this->assertSame('Visible child', $child->refresh()->title);
        $this->assertSame('9007199254740994', $revisions->get($this->actor()->stream(), 'UpdateChild', (string) $child->id));
        $this->assertSame('1', $revisions->get($this->actor()->stream(), 'UpdateChild', (string) $newChild->id));
        $this->assertSame(2, DB::table('synloquent_publications')->count());
        config(['synloquent.max_delta_records' => 1]);
        try {
            $this->app->make(WriteGateway::class)->transaction($this->actor(), fn (WriteContext $context) => $context->captureMany([$child, $newChild]));
            $this->fail('Batched capture must enforce its configured identity bound.');
        } catch (ProtocolException $exception) {
            $this->assertSame('validation_failed', $exception->errorCode);
        }
        $this->assertSame('9007199254740994', $revisions->get($this->actor()->stream(), 'UpdateChild', (string) $child->id));
        $this->assertSame(2, DB::table('synloquent_publications')->count());
    }

    public function test_recursive_frontier_batches_ordered_composite_foreign_key_tuples(): void
    {
        $this->fixture();
        Schema::table('fixture_update_children', function (Blueprint $table): void {
            $table->unique(['id', 'title', 'owner_code']);
        });
        Schema::table('fixture_update_leaves', function (Blueprint $table): void {
            $table->string('child_title');
            $table->foreign(['child_id', 'child_title', 'owner_code'])->references(['id', 'title', 'owner_code'])->on('fixture_update_children')->cascadeOnUpdate();
        });
        $owner = UpdateOwner::create(['tenant_id' => 1, 'natural_key' => '00106', 'exact_key' => '9007199254740993', 'title' => 'Tuple owner']);
        $models = [$owner];
        foreach (['Left', 'Right'] as $title) {
            $child = UpdateChild::create(['tenant_id' => 1, 'owner_code' => '00106', 'owner_number' => '9007199254740993', 'title' => $title]);
            $leaf = UpdateLeaf::create(['tenant_id' => 1, 'child_id' => $child->id, 'child_title' => $title, 'owner_code' => '00106', 'title' => 'Leaf '.$title]);
            array_push($models, $child, $leaf);
        }
        $this->app->make(WriteGateway::class)->transaction($this->actor(), fn (WriteContext $context) => $context->captureMany($models));
        $tupleQueries = [];
        DB::listen(static function (QueryExecuted $event) use (&$tupleQueries): void {
            if (str_starts_with($event->sql, 'select * from "fixture_update_leaves"') && str_contains($event->sql, '"child_title"')) {
                $tupleQueries[] = $event->sql;
            }
        });
        $operation = $this->operation('cascade-composite-frontier', 'update', ['natural_key' => 'paired-key'], ['model' => 'UpdateOwner', 'id' => (string) $owner->id, 'expectedRevision' => '1']);
        $receipt = $this->app->make(MutationAction::class)->execute([$operation], $this->actor())['receipts'][0];
        $this->assertSame('accepted', $receipt['status']);
        $this->assertCount(1, $tupleQueries);
        $this->assertStringContainsString('"child_id" = ? and "child_title" = ?) or ("child_id" = ? and "child_title" = ?', $tupleQueries[0]);
        $this->assertSame(2, UpdateLeaf::where('owner_code', 'paired-key')->count());
        $this->assertSame(['Left', 'Right'], UpdateLeaf::orderBy('id')->pluck('child_title')->all());
        $this->assertSame(5, DB::table('synloquent_revisions')->where('revision', 2)->count());
        $journal = json_decode(DB::table('synloquent_publications')->orderByDesc('sequence')->value('changes'), true, flags: JSON_THROW_ON_ERROR);
        $this->assertCount(5, $journal);
    }

    public function test_batched_capture_nominates_all_incoming_pivot_owners_with_morph_isolation(): void
    {
        Schema::table('tags', fn (Blueprint $table) => $table->bigInteger('actor_id')->default(1));
        $registry = new ExportRegistry;
        foreach ($this->app->make(ExportRegistry::class)->all() as $resource) {
            if ($resource->name() !== 'Tag') {
                $registry->register($resource);
            }
        }
        $registry->register($this->app->make(UpdateActorScopedTagExport::class));
        $this->app->instance(ExportRegistry::class, $registry);
        $this->app->forgetInstance(ManifestBuilder::class);
        $this->app->forgetInstance(WriteGateway::class);
        $items = [];
        $tags = [];
        foreach (range(1, 3) as $position) {
            $items[] = Item::create(['tenant_id' => 1, 'title' => 'Pivot owner '.$position, 'price' => '1.00', 'active' => true]);
            if ($position <= 2) {
                $tags[] = Tag::create(['tenant_id' => 1, 'title' => 'Captured tag '.$position]);
                $items[$position - 1]->tags()->attach($tags[$position - 1], ['position' => 1]);
                $items[$position - 1]->classifications()->attach($tags[$position - 1], ['position' => 2]);
            }
        }
        DB::table('taggables')->insert(['tag_id' => $tags[0]->id, 'taggable_id' => $items[2]->id, 'taggable_type' => 'category', 'position' => 3]);
        $this->app->make(WriteGateway::class)->transaction($this->actor(), fn (WriteContext $context) => $context->captureMany([...$items, ...$tags]));
        $snapshot = $this->app->make(SnapshotAction::class)->execute('catalog', $this->actor());
        $active = true;
        $pivotQueries = [];
        DB::listen(static function (QueryExecuted $event) use (&$active, &$pivotQueries): void {
            if ($active && (str_starts_with($event->sql, 'select distinct "item_id" from "item_tag"') || str_starts_with($event->sql, 'select distinct "taggable_id" from "taggables"'))) {
                $pivotQueries[] = $event->sql;
            }
        });
        $this->app->make(WriteGateway::class)->transaction($this->actor(), function (WriteContext $context) use ($tags): void {
            foreach ($tags as $tag) {
                $tag->actor_id = 2;
                $tag->save();
            }
            $context->captureMany($tags);
        });
        $active = false;
        $this->assertCount(2, $pivotQueries, 'Each declared incoming relation must use one bounded target lookup.');
        $this->assertStringContainsString('"taggable_type" = ?', $pivotQueries[1]);
        $journal = json_decode(DB::table('synloquent_publications')->orderByDesc('sequence')->value('changes'), true, flags: JSON_THROW_ON_ERROR);
        $relations = array_values(array_filter($journal, fn (array $change): bool => $change['kind'] === 'relation'));
        $this->assertCount(4, $relations);
        $this->assertSame(['1', '1', '2', '2'], array_values(collect($relations)->pluck('id')->sort()->all()));
        $pull = $this->app->make(PullAction::class)->execute($snapshot['cursor'], 'catalog', $this->actor());
        $this->assertSame(['remove', 'remove'], array_column($pull['batches'][0]['changes'], 'kind'));
        $this->assertCount(8, $pull['batches'][0]['relationSets']);
        $this->assertCount(4, array_filter($pull['batches'][0]['relationSets'], fn (array $set): bool => $set['model'] === 'Item'));
        foreach ($pull['batches'][0]['relationSets'] as $set) {
            $this->assertSame([], $set['targets']);
            $this->assertContains($set['parentId'], ['1', '2']);
        }
    }

    public function test_bulk_owner_key_update_captures_children_without_instance_events(): void
    {
        [$owner, $child] = $this->baseline();
        $events = [];
        foreach ([UpdateOwner::class, UpdateChild::class] as $class) {
            foreach (['saving', 'updating', 'updated', 'saved'] as $event) {
                $this->app['events']->listen('eloquent.'.$event.': '.$class, static function () use (&$events, $event): void {
                    $events[] = $event;
                });
            }
        }
        $operation = $this->operation('cascade-bulk-owner', 'update', ['natural_key' => 'bulk-key'], ['model' => 'UpdateOwner', 'id' => (string) $owner->id, 'expectedRevision' => '1', 'eventMode' => 'bulk']);
        $receipt = $this->app->make(MutationAction::class)->execute([$operation], $this->actor())['receipts'][0];
        $this->assertSame('accepted', $receipt['status']);
        $this->assertSame('bulk-key', $child->refresh()->owner_code);
        $this->assertSame('2', $this->app->make(RevisionStore::class)->get($this->actor()->stream(), 'UpdateChild', (string) $child->id));
        $this->assertSame([], $events);
    }

    public function test_update_dependency_bound_and_atomic_group_failure_roll_back_cascades(): void
    {
        [$owner, $child, $leaf] = $this->baseline();
        config(['synloquent.max_delta_records' => 2]);
        $operation = $this->operation('cascade-bound', 'update', ['natural_key' => 'bounded-key'], ['model' => 'UpdateOwner', 'id' => (string) $owner->id, 'expectedRevision' => '1']);
        $receipt = $this->app->make(MutationAction::class)->execute([$operation], $this->actor())['receipts'][0];
        $this->assertSame('rejected', $receipt['status']);
        $this->assertSame('validation_failed', $receipt['error']['code']);
        config(['synloquent.max_delta_records' => 1000]);
        $operation['operationId'] = 'cascade-group-owner';
        $operation['atomicGroup'] = 'cascade-rollback';
        $stale = $this->operation('cascade-group-child', 'update', ['title' => 'Stale grouped edit'], ['model' => 'UpdateChild', 'id' => (string) $child->id, 'expectedRevision' => '1', 'atomicGroup' => 'cascade-rollback', 'dependsOn' => ['cascade-group-owner']]);
        $receipts = $this->app->make(MutationAction::class)->execute([$operation, $stale], $this->actor())['receipts'];
        $this->assertSame(['rejected', 'conflicted'], array_column($receipts, 'status'));
        $this->assertSame('1', $receipts[1]['canonical']['revision']);
        $this->assertSame('00106', $receipts[1]['canonical']['attributes']['owner_code']);
        $this->assertSame($receipts[1]['canonical'], $receipts[1]['error']['details']['canonical']);
        $this->assertSame('00106', $owner->refresh()->natural_key);
        $this->assertSame('00106', $child->refresh()->owner_code);
        $this->assertSame('00106', $leaf->refresh()->owner_code);
        foreach ([['UpdateOwner', $owner], ['UpdateChild', $child], ['UpdateLeaf', $leaf]] as [$name, $model]) {
            $this->assertSame('1', $this->app->make(RevisionStore::class)->get($this->actor()->stream(), $name, (string) $model->id));
        }
        $this->assertSame(1, DB::table('synloquent_publications')->count());
        $this->assertSame(3, DB::table('synloquent_receipts')->count());
        $this->assertSame(1, DB::table('synloquent_streams')->value('sequence'));
    }

    public function test_unstaged_observer_key_change_and_unregistered_dependencies_fail_closed(): void
    {
        [$owner, $child, $leaf] = $this->baseline();
        $enabled = true;
        $this->app['events']->listen('eloquent.saving: '.UpdateOwner::class, static function (UpdateOwner $model) use (&$enabled): void {
            if ($enabled) {
                $model->natural_key = 'observer-key';
            }
        });
        $operation = $this->operation('cascade-observer', 'update', [], ['model' => 'UpdateOwner', 'id' => (string) $owner->id, 'expectedRevision' => '1']);
        $receipt = $this->app->make(MutationAction::class)->execute([$operation], $this->actor())['receipts'][0];
        $this->assertSame('rejected', $receipt['status']);
        $this->assertSame('unsupported_query', $receipt['error']['code']);
        $this->assertSame('00106', $child->refresh()->owner_code);
        $enabled = false;
        Schema::create('fixture_update_unregistered', function (Blueprint $table): void {
            $table->id();
            $table->string('owner_code');
            $table->foreign('owner_code')->references('natural_key')->on('fixture_update_owners')->cascadeOnUpdate();
        });
        DB::table('fixture_update_unregistered')->insert(['owner_code' => '00106']);
        $operation['operationId'] = 'cascade-unregistered';
        $operation['values'] = ['natural_key' => 'unregistered-key'];
        $receipt = $this->app->make(MutationAction::class)->execute([$operation], $this->actor())['receipts'][0];
        $this->assertSame('rejected', $receipt['status']);
        $this->assertSame('unsupported_query', $receipt['error']['code']);
        $this->assertSame('00106', $owner->refresh()->natural_key);
        $this->assertSame('00106', $leaf->refresh()->owner_code);
        $this->assertSame('00106', DB::table('fixture_update_unregistered')->value('owner_code'));
        $this->assertSame(1, DB::table('synloquent_publications')->count());
    }

    public function test_update_cascade_cannot_rename_child_primary_identity(): void
    {
        [$owner, $child] = $this->baseline();
        DB::statement('UPDATE fixture_update_owners SET exact_key = 1');
        Schema::table('fixture_update_children', function (Blueprint $table): void {
            $table->foreign('id')->references('exact_key')->on('fixture_update_owners')->cascadeOnUpdate();
        });
        $operation = $this->operation('cascade-child-identity', 'update', ['exact_key' => 2], ['model' => 'UpdateOwner', 'id' => (string) $owner->id, 'expectedRevision' => '1']);
        $receipt = $this->app->make(MutationAction::class)->execute([$operation], $this->actor())['receipts'][0];
        $this->assertSame('rejected', $receipt['status']);
        $this->assertSame('validation_failed', $receipt['error']['code']);
        $this->assertSame('1', (string) $owner->refresh()->exact_key);
        $this->assertSame(1, $child->refresh()->id);
        $this->assertSame(1, DB::table('synloquent_publications')->count());
    }

    public function test_unchanged_key_does_not_advance_children_and_increment_captures_exact_integer_dependency(): void
    {
        [$owner, $child, $leaf] = $this->baseline();
        $operation = $this->operation('cascade-unchanged', 'update', ['natural_key' => '00106', 'exact_key' => '9007199254740993'], ['model' => 'UpdateOwner', 'id' => (string) $owner->id, 'expectedRevision' => '1']);
        $receipt = $this->app->make(MutationAction::class)->execute([$operation], $this->actor())['receipts'][0];
        $this->assertSame('accepted', $receipt['status']);
        $this->assertSame('1', $this->app->make(RevisionStore::class)->get($this->actor()->stream(), 'UpdateChild', (string) $child->id));
        $delta = $this->operation('cascade-counter-key', 'increment', ['field' => 'exact_key', 'delta' => 2], ['model' => 'UpdateOwner', 'id' => (string) $owner->id, 'expectedRevision' => $receipt['canonical']['revision']]);
        $receipt = $this->app->make(MutationAction::class)->execute([$delta], $this->actor())['receipts'][0];
        $this->assertSame('accepted', $receipt['status']);
        $this->assertSame('9007199254740995', $receipt['canonical']['attributes']['exact_key']);
        $this->assertSame('9007199254740995', (string) $child->refresh()->owner_number);
        $this->assertSame('2', $this->app->make(RevisionStore::class)->get($this->actor()->stream(), 'UpdateChild', (string) $child->id));
        $this->assertSame('1', $this->app->make(RevisionStore::class)->get($this->actor()->stream(), 'UpdateLeaf', (string) $leaf->id));
    }

    public function test_owner_update_policy_denial_preserves_cascade_rows_and_revisions(): void
    {
        [$owner, $child] = $this->baseline();
        Gate::policy(UpdateOwner::class, UpdateOwnerDeniedPolicy::class);
        $operation = $this->operation('cascade-policy-denied', 'update', ['natural_key' => 'denied-key'], ['model' => 'UpdateOwner', 'id' => (string) $owner->id, 'expectedRevision' => '1']);
        $receipt = $this->app->make(MutationAction::class)->execute([$operation], $this->actor())['receipts'][0];
        $this->assertSame('rejected', $receipt['status']);
        $this->assertSame('forbidden_operation', $receipt['error']['code']);
        $this->assertSame('00106', $owner->refresh()->natural_key);
        $this->assertSame('00106', $child->refresh()->owner_code);
        $this->assertSame('1', $this->app->make(RevisionStore::class)->get($this->actor()->stream(), 'UpdateChild', (string) $child->id));
        $this->assertSame(1, DB::table('synloquent_publications')->count());
    }

    public function test_cross_stream_foreign_key_cascade_fails_closed_for_both_tenant_streams(): void
    {
        $this->fixture();
        $owner = UpdateOwner::create(['tenant_id' => 1, 'natural_key' => '00106', 'exact_key' => '9007199254740993', 'title' => 'Tenant one owner']);
        $child = UpdateChild::create(['tenant_id' => 2, 'actor_id' => 2, 'owner_code' => '00106', 'owner_number' => '9007199254740993', 'title' => 'Tenant two child']);
        $user = User::findOrFail(2);
        $user->tenant_id = 2;
        $user->save();
        $otherActor = new ActorContext('2', '2', 'epoch-1', '1', $user, 'example-device');
        Gate::policy(UpdateChild::class, UpdateTenantQueryPolicy::class);
        $this->app->make(WriteGateway::class)->transaction($this->actor(), fn (WriteContext $context) => $context->capture($owner));
        $this->app->make(WriteGateway::class)->transaction($otherActor, fn (WriteContext $context) => $context->capture($child));
        $snapshot = $this->app->make(SnapshotAction::class)->execute('catalog', $this->actor());
        $otherSnapshot = $this->app->make(SnapshotAction::class)->execute('catalog', $otherActor);
        $this->assertSame('UpdateChild', $otherSnapshot['records'][0]['model']);
        $operation = $this->operation('cascade-cross-stream', 'update', ['natural_key' => 'cross-stream-key'], ['model' => 'UpdateOwner', 'id' => (string) $owner->id, 'expectedRevision' => '1']);
        $receipt = $this->app->make(MutationAction::class)->execute([$operation], $this->actor())['receipts'][0];
        $this->assertSame('rejected', $receipt['status']);
        $this->assertSame('unsupported_query', $receipt['error']['code']);
        $this->assertSame('00106', $owner->refresh()->natural_key);
        $this->assertSame('00106', $child->refresh()->owner_code);
        $this->assertSame(2, $child->tenant_id);
        $revisions = $this->app->make(RevisionStore::class);
        $this->assertSame('1', $revisions->get($this->actor()->stream(), 'UpdateOwner', (string) $owner->id));
        $this->assertSame('1', $revisions->get($otherActor->stream(), 'UpdateChild', (string) $child->id));
        $this->assertSame('0', $revisions->get($this->actor()->stream(), 'UpdateChild', (string) $child->id));
        $this->assertSame(2, DB::table('synloquent_publications')->count());
        $this->assertSame([], $this->app->make(PullAction::class)->execute($snapshot['cursor'], 'catalog', $this->actor())['batches']);
        $this->assertSame([], $this->app->make(PullAction::class)->execute($otherSnapshot['cursor'], 'catalog', $otherActor)['batches']);
    }

    public function test_unknown_stream_resolver_and_partition_change_fail_closed(): void
    {
        [$owner, $child, $leaf] = $this->baseline();
        $registry = $this->app->make(ExportRegistry::class);
        foreach (['UpdateOwner', 'UpdateChild', 'UpdateLeaf'] as $name) {
            $resource = $registry->get($name);
            $resource->knownCaptureStream = false;
            $operation = $this->operation('cascade-unknown-stream-'.$name, 'update', ['natural_key' => 'unknown-stream-key'], ['model' => 'UpdateOwner', 'id' => (string) $owner->id, 'expectedRevision' => '1']);
            $receipt = $this->app->make(MutationAction::class)->execute([$operation], $this->actor())['receipts'][0];
            $this->assertSame('rejected', $receipt['status']);
            $this->assertSame('unsupported_query', $receipt['error']['code']);
            $this->assertSame('00106', $owner->refresh()->natural_key);
            $this->assertSame('00106', $child->refresh()->owner_code);
            $this->assertSame('00106', $leaf->refresh()->owner_code);
            $resource->knownCaptureStream = true;
        }
        $registry->get('UpdateOwner')->knownCaptureStream = false;
        $ordinary = $this->operation('ordinary-without-resolver', 'update', ['title' => 'Allowed ordinary write'], ['model' => 'UpdateOwner', 'id' => (string) $owner->id, 'expectedRevision' => '1']);
        $this->assertSame('accepted', $this->app->make(MutationAction::class)->execute([$ordinary], $this->actor())['receipts'][0]['status']);
        $registry->get('UpdateOwner')->knownCaptureStream = true;
        foreach (['owner', 'child'] as $subject) {
            $observer = (object) ['enabled' => true];
            $this->app['events']->listen('eloquent.saved: '.UpdateOwner::class, static function (UpdateOwner $model) use ($observer, $subject, $child): void {
                if ($observer->enabled) {
                    DB::table($subject === 'owner' ? 'fixture_update_owners' : 'fixture_update_children')->where('id', $subject === 'owner' ? $model->id : $child->id)->update(['tenant_id' => 2]);
                }
            });
            $operation = $this->operation('cascade-current-partition-'.$subject, 'update', ['natural_key' => 'moved-partition-key'], ['model' => 'UpdateOwner', 'id' => (string) $owner->id, 'expectedRevision' => '2']);
            $receipt = $this->app->make(MutationAction::class)->execute([$operation], $this->actor())['receipts'][0];
            $observer->enabled = false;
            $this->assertSame('rejected', $receipt['status']);
            $this->assertSame('unsupported_query', $receipt['error']['code']);
            $this->assertSame(1, $owner->refresh()->tenant_id);
            $this->assertSame(1, $child->refresh()->tenant_id);
            $this->assertSame('00106', $leaf->refresh()->owner_code);
            $this->assertSame(2, DB::table('synloquent_publications')->count());
        }
    }

    private function baseline(): array
    {
        $this->fixture();
        $owner = UpdateOwner::create(['tenant_id' => 1, 'natural_key' => '00106', 'exact_key' => '9007199254740993', 'title' => 'Before']);
        $child = UpdateChild::create(['tenant_id' => 1, 'owner_code' => '00106', 'owner_number' => '9007199254740993', 'title' => 'Visible child']);
        $leaf = UpdateLeaf::create(['tenant_id' => 1, 'child_id' => $child->id, 'owner_code' => '00106', 'title' => 'Recursive leaf']);
        $this->app->make(WriteGateway::class)->transaction($this->actor(), function (WriteContext $context) use ($owner, $child, $leaf): void {
            foreach ([$owner, $child, $leaf] as $model) {
                $context->capture($model);
            }
        });

        return [$owner, $child, $leaf];
    }

    private function fixture(): void
    {
        Schema::create('fixture_update_owners', function (Blueprint $table): void {
            $table->id();
            $table->bigInteger('tenant_id');
            $table->string('natural_key')->unique();
            $table->bigInteger('exact_key')->unique();
            $table->string('title');
        });
        Schema::create('fixture_update_children', function (Blueprint $table): void {
            $table->id();
            $table->bigInteger('tenant_id');
            $table->bigInteger('actor_id')->default(1);
            $table->string('owner_code');
            $table->bigInteger('owner_number');
            $table->string('title');
            $table->unique(['id', 'owner_code']);
            $table->foreign('owner_code')->references('natural_key')->on('fixture_update_owners')->cascadeOnUpdate();
            $table->foreign('owner_number')->references('exact_key')->on('fixture_update_owners')->cascadeOnUpdate();
        });
        Schema::create('fixture_update_leaves', function (Blueprint $table): void {
            $table->id();
            $table->bigInteger('tenant_id');
            $table->bigInteger('child_id');
            $table->string('owner_code');
            $table->string('title');
            $table->foreign(['child_id', 'owner_code'])->references(['id', 'owner_code'])->on('fixture_update_children')->cascadeOnUpdate();
        });
        foreach ([UpdateOwnerExport::class, UpdateChildExport::class, UpdateLeafExport::class] as $class) {
            $resource = $this->app->make($class);
            $this->app->make(ExportRegistry::class)->register($resource);
            Gate::policy($resource->modelClass(), CatalogPolicy::class);
        }
    }
}

final class UpdateOwner extends Model
{
    protected $table = 'fixture_update_owners';

    protected $guarded = [];

    public $timestamps = false;
}

final class UpdateChild extends Model
{
    protected $table = 'fixture_update_children';

    protected $guarded = [];

    public $timestamps = false;

    public function owner(): BelongsTo
    {
        return $this->belongsTo(UpdateOwner::class, 'owner_code', 'natural_key');
    }
}

final class UpdateLeaf extends Model
{
    protected $table = 'fixture_update_leaves';

    protected $guarded = [];

    public $timestamps = false;
}

abstract class UpdateExport extends ExportDefinition
{
    public bool $knownCaptureStream = true;

    public function captureStream(Model $model): ?string
    {
        return $this->knownCaptureStream ? hash('sha256', (string) $model->getAttribute('tenant_id')) : null;
    }

    public function selfContainedProjection(): bool
    {
        return true;
    }

    public function operations(): array
    {
        return ['query', 'update', 'increment'];
    }

    public function writable(): array
    {
        return ['title'];
    }

    public function scope(Builder $query, ActorContext $actor): void
    {
        $query->where($query->getModel()->qualifyColumn('tenant_id'), (int) $actor->tenantId);
    }
}

final class UpdateOwnerDeniedPolicy
{
    public function update(mixed $user, Model $model): bool
    {
        return false;
    }
}

final class UpdateTenantQueryPolicy
{
    public function viewAny(User $actor): bool
    {
        return true;
    }
}

final class UpdateOwnerExport extends UpdateExport
{
    public function name(): string
    {
        return 'UpdateOwner';
    }

    public function modelClass(): string
    {
        return UpdateOwner::class;
    }

    public function readable(): array
    {
        return ['id', 'natural_key', 'exact_key', 'title'];
    }

    public function writable(): array
    {
        return ['natural_key', 'exact_key', 'title'];
    }
}

final class UpdateChildExport extends UpdateExport
{
    public function name(): string
    {
        return 'UpdateChild';
    }

    public function modelClass(): string
    {
        return UpdateChild::class;
    }

    public function readable(): array
    {
        return ['id', 'owner_code', 'owner_number', 'title'];
    }

    public function relations(): array
    {
        return ['owner'];
    }

    public function scope(Builder $query, ActorContext $actor): void
    {
        parent::scope($query, $actor);
        $query->where($query->getModel()->qualifyColumn('actor_id'), (int) $actor->actorId);
    }
}

final class UpdateLeafExport extends UpdateExport
{
    public function name(): string
    {
        return 'UpdateLeaf';
    }

    public function modelClass(): string
    {
        return UpdateLeaf::class;
    }

    public function readable(): array
    {
        return ['id', 'child_id', 'owner_code', 'title'];
    }
}

final class UpdateActorScopedTagExport extends ExportDefinition
{
    public function selfContainedProjection(): bool
    {
        return true;
    }

    public function name(): string
    {
        return 'Tag';
    }

    public function modelClass(): string
    {
        return Tag::class;
    }

    public function readable(): array
    {
        return ['id', 'title'];
    }

    public function relations(): array
    {
        return ['items', 'classifiedItems'];
    }

    public function scope(Builder $query, ActorContext $actor): void
    {
        $query->where($query->getModel()->qualifyColumn('tenant_id'), (int) $actor->tenantId);
        $query->where($query->getModel()->qualifyColumn('actor_id'), (int) $actor->actorId);
    }

    public function pivotFields(string $relation): array
    {
        return ['position' => ['type' => 'integer', 'nullable' => false, 'readable' => true, 'writable' => true]];
    }
}

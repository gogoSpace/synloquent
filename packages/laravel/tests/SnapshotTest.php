<?php

declare(strict_types=1);

namespace Synloquent\Tests;

use App\Models\Category;
use App\Models\Item;
use App\Models\Salespoint;
use App\Models\User;
use Illuminate\Support\Facades\DB;
use Synloquent\Laravel\Protocol\CanonicalJson;
use Synloquent\Laravel\Protocol\ProtocolException;
use Synloquent\Laravel\Sync\ActorContext;
use Synloquent\Laravel\Sync\MutationAction;
use Synloquent\Laravel\Sync\PullAction;
use Synloquent\Laravel\Sync\SnapshotAction;
use Synloquent\Laravel\Sync\WriteContext;
use Synloquent\Laravel\Sync\WriteGateway;

final class SnapshotTest extends TestCase
{
    public function test_snapshot_aliases_are_bound_to_actor_device_and_epoch(): void
    {
        $operation = $this->operation('alias-snapshot', 'create', ['title' => 'Lost response alias']);
        $record = $this->app->make(MutationAction::class)->execute([$operation], $this->actor())['receipts'][0]['canonical'];
        $snapshot = $this->app->make(SnapshotAction::class)->execute('catalog', $this->actor());
        $this->assertSame($operation['localIdentity'], $snapshot['records'][0]['localIdentity']);
        $this->assertSame($record['id'], $snapshot['records'][0]['id']);
        $this->assertSame($snapshot['hash'], CanonicalJson::hash(['records' => $snapshot['records'], 'relationSets' => $snapshot['relationSets']]));
        $actors = [$this->actor('2'), new ActorContext('1', '1', 'epoch-1', '1', User::find(1), 'different-device'), new ActorContext('1', '1', 'different-epoch', '1', User::find(1), 'example-device')];
        foreach ($actors as $actor) {
            $foreign = $this->app->make(SnapshotAction::class)->execute('catalog', $actor);
            $this->assertArrayNotHasKey('localIdentity', $foreign['records'][0]);
        }
        $this->assertSame(1, Item::count());
    }

    public function test_authenticated_immutable_http_download_reauthorizes_and_detects_corruption(): void
    {
        $action = $this->app->make(MutationAction::class);
        $record = $action->execute([$this->operation('download', 'create', ['title' => 'Immutable download'])], $this->actor())['receipts'][0]['canonical'];
        $snapshot = $this->app->make(SnapshotAction::class)->execute('catalog', $this->actor());
        $this->withToken('synthetic-actor-1')->getJson($snapshot['downloadUrl'])->assertSuccessful()->assertJsonPath('generation', $snapshot['generation'])->assertJsonPath('records.0.attributes.title', 'Immutable download');
        $action->execute([$this->operation('download-update', 'update', ['title' => 'Current title'], ['id' => $record['id'], 'expectedRevision' => $record['revision']])], $this->actor());
        $this->withToken('synthetic-actor-1')->getJson($snapshot['downloadUrl'])->assertSuccessful()->assertJsonPath('records.0.attributes.title', 'Immutable download');
        $this->withToken('synthetic-actor-2')->getJson($snapshot['downloadUrl'])->assertForbidden();
        $stored = DB::table('synloquent_snapshots')->where('hash', $snapshot['hash'])->value('document');
        DB::table('synloquent_snapshots')->where('hash', $snapshot['hash'])->update(['document' => $stored.' ']);
        $this->withToken('synthetic-actor-1')->getJson($snapshot['downloadUrl'])->assertUnprocessable()->assertJsonPath('error.code', 'invalid_snapshot');
        DB::table('synloquent_snapshots')->where('hash', $snapshot['hash'])->update(['document' => $stored]);
        $this->app->make(WriteGateway::class)->transaction($this->actor(), function (WriteContext $context) use ($record): void {
            $model = Item::find($record['id']);
            $model->tenant_id = 2;
            $model->save();
            $context->capture($model);
            $context->invalidateAuthorization();
        });
        $this->withToken('synthetic-actor-1')->getJson($snapshot['downloadUrl'])->assertForbidden()->assertJsonPath('error.code', 'forbidden_operation');
    }

    public function test_same_content_at_a_new_cursor_has_a_distinct_immutable_generation(): void
    {
        $first = $this->app->make(SnapshotAction::class)->execute('catalog', $this->actor());
        $this->app->make(WriteGateway::class)->transaction($this->actor(), fn (WriteContext $context) => $context->invalidateAuthorization());
        $second = $this->app->make(SnapshotAction::class)->execute('catalog', $this->actor());
        $this->assertSame($first['hash'], $second['hash']);
        $this->assertNotSame($first['cursor'], $second['cursor']);
        $this->assertNotSame($first['generation'], $second['generation']);
        $this->assertNotSame($first['downloadUrl'], $second['downloadUrl']);
        $this->assertSame(1, DB::table('synloquent_snapshots')->count());
        $this->assertSame(2, DB::table('synloquent_snapshot_grants')->count());
    }

    public function test_delete_and_database_cascade_emit_tombstones_and_preserve_retention_floor(): void
    {
        $mutations = $this->app->make(MutationAction::class);
        $record = $mutations->execute([$this->operation('delete-parent', 'create', ['title' => 'Cascaded owner'])], $this->actor())['receipts'][0]['canonical'];
        $image = $mutations->execute([$this->operation('delete-image', 'create', ['item_id' => (int) $record['id'], 'url' => 'https://example.invalid/delete'], ['model' => 'Image'])], $this->actor())['receipts'][0]['canonical'];
        $snapshot = $this->app->make(SnapshotAction::class)->execute('catalog', $this->actor());
        $receipt = $mutations->execute([$this->operation('delete-record', 'delete', [], ['id' => $record['id'], 'expectedRevision' => $record['revision']])], $this->actor())['receipts'][0];
        $this->assertSame('accepted', $receipt['status']);
        $pull = $this->app->make(PullAction::class)->execute($snapshot['cursor'], 'catalog', $this->actor());
        $this->assertEqualsCanonicalizing([['kind' => 'delete', 'model' => 'Item', 'id' => $record['id']], ['kind' => 'delete', 'model' => 'Image', 'id' => $image['id']]], $pull['batches'][0]['changes']);
        DB::table('synloquent_snapshots')->delete();
        $this->app->make(PullAction::class)->prune($this->actor(), 3);
        $this->assertSame(0, DB::table('synloquent_publications')->count());
        try {
            $this->app->make(PullAction::class)->execute($snapshot['cursor'], 'catalog', $this->actor());
            $this->fail('A cursor below the durable retention floor was accepted.');
        } catch (ProtocolException $exception) {
            $this->assertSame('cursor_expired', $exception->errorCode);
        }
    }

    public function test_database_restrict_and_nullify_are_captured_or_conservatively_materialized(): void
    {
        $this->artisan('synloquent:seed-example')->assertSuccessful();
        $action = $this->app->make(MutationAction::class);
        $snapshot = $this->app->make(SnapshotAction::class)->execute('catalog', $this->actor());
        $category = collect($snapshot['records'])->firstWhere('model', 'Category');
        $restricted = $action->execute([$this->operation('restrict-category', 'delete', [], ['model' => 'Category', 'id' => '1', 'expectedRevision' => $category['revision']])], $this->actor())['receipts'][0];
        $this->assertSame('rejected', $restricted['status']);
        $this->assertSame(DB::connection()->getDriverName() === 'pgsql' ? '23001' : '23000', $restricted['error']['details']['sqlState']);
        $this->assertSame(1, Category::count());
        $location = collect($snapshot['records'])->firstWhere('model', 'Location');
        $deleted = $action->execute([$this->operation('nullify-location', 'delete', [], ['model' => 'Location', 'id' => '1', 'expectedRevision' => $location['revision']])], $this->actor())['receipts'][0];
        $this->assertSame('accepted', $deleted['status']);
        $this->assertNull(Item::find(1)->location_id);
        $this->assertNull(Salespoint::find(1)->location_id);
        $result = $this->app->make(PullAction::class)->execute($snapshot['cursor'], 'catalog', $this->actor());
        $changes = collect($result['batches'][0]['changes']);
        $this->assertContains(['kind' => 'delete', 'model' => 'Location', 'id' => '1'], $changes->all());
        $item = $changes->first(fn ($change) => $change['model'] === 'Item' && $change['id'] === '1');
        $salespoint = $changes->firstWhere('model', 'Salespoint');
        $this->assertNull($item['record']['attributes']['location_id']);
        $this->assertNull($salespoint['record']['attributes']['location_id']);
        $this->assertNotSame(collect($snapshot['records'])->firstWhere('model', 'Item')['revision'], $item['record']['revision']);
        $this->assertNotSame(collect($snapshot['records'])->firstWhere('model', 'Salespoint')['revision'], $salespoint['record']['revision']);
        $publication = collect(json_decode(DB::table('synloquent_publications')->latest('sequence')->value('changes'), true, flags: JSON_THROW_ON_ERROR));
        $this->assertTrue($publication->first(fn ($change) => $change['kind'] === 'delete' && $change['model'] === 'Location')['dependenciesCaptured']);
        $this->assertSame([], $this->app->make(PullAction::class)->execute($result['cursor'], 'catalog', $this->actor())['batches']);
    }

    public function test_snapshot_waits_for_stream_lock_before_domain_read(): void
    {
        $writer = $this->worker('first');
        $snapshotWorker = null;
        try {
            $this->assertSame('locked', json_decode(fgets($writer['pipes'][1]), true, flags: JSON_THROW_ON_ERROR)['stage']);
            $snapshotWorker = $this->worker('snapshot');
            $attempting = json_decode(fgets($snapshotWorker['pipes'][1]), true, flags: JSON_THROW_ON_ERROR);
            $deadline = microtime(true) + 5;
            do {
                $activity = $this->lockActivity($attempting['backend']);
                if ($activity?->wait_event_type === 'Lock') {
                    break;
                }
                usleep(1000);
            } while (microtime(true) < $deadline);
            $this->assertSame('Lock', $activity?->wait_event_type);
            $this->assertStringContainsString('synloquent_streams', $activity->query);
            $this->assertSame(0, Item::count());
            fwrite($writer['pipes'][0], "release\n");
            fflush($writer['pipes'][0]);
            $this->assertSame('committed', json_decode(fgets($writer['pipes'][1]), true, flags: JSON_THROW_ON_ERROR)['stage']);
            $message = json_decode(fgets($snapshotWorker['pipes'][1]), true, flags: JSON_THROW_ON_ERROR);
            $this->assertSame('materialized', $message['stage']);
            $this->assertSame('Concurrent first', $message['snapshot']['records'][0]['attributes']['title']);
            $this->assertSame([], $this->app->make(PullAction::class)->execute($message['snapshot']['cursor'], 'catalog', $this->actor())['batches']);
        } finally {
            $this->closeWorker($writer);
            if ($snapshotWorker !== null) {
                $this->closeWorker($snapshotWorker);
            }
        }
    }

    public function test_snapshot_anchor_retains_writes_committed_after_materialization(): void
    {
        $worker = $this->worker('snapshot');
        try {
            $this->assertSame('attempting', json_decode(fgets($worker['pipes'][1]), true, flags: JSON_THROW_ON_ERROR)['stage']);
            $snapshot = json_decode(fgets($worker['pipes'][1]), true, flags: JSON_THROW_ON_ERROR)['snapshot'];
        } finally {
            $this->closeWorker($worker, false);
        }
        $writer = $this->worker('second');
        try {
            $this->assertSame('attempting', json_decode(fgets($writer['pipes'][1]), true, flags: JSON_THROW_ON_ERROR)['stage']);
            $this->assertSame('committed', json_decode(fgets($writer['pipes'][1]), true, flags: JSON_THROW_ON_ERROR)['stage']);
        } finally {
            $this->closeWorker($writer, false);
        }
        $this->assertSame([], $snapshot['records']);
        $pull = $this->app->make(PullAction::class)->execute($snapshot['cursor'], 'catalog', $this->actor());
        $this->assertSame('Concurrent second', $pull['batches'][0]['changes'][0]['record']['attributes']['title']);
        $this->assertSame(1, DB::table('synloquent_publications')->value('sequence'));
        $this->assertSame([], $this->app->make(PullAction::class)->execute($pull['cursor'], 'catalog', $this->actor())['batches']);
    }

    public function test_immutable_snapshot_cursor_pull_replay_and_retention_floor(): void
    {
        $this->app->make(MutationAction::class)->execute([$this->operation('create', 'create', ['title' => 'Snapshot'])], $this->actor());
        $snapshot = $this->app->make(SnapshotAction::class)->execute('catalog', $this->actor());
        $this->assertSame(hash('sha256', CanonicalJson::encode(['records' => $snapshot['records'], 'relationSets' => $snapshot['relationSets']])), $snapshot['hash']);
        $this->assertSame(strlen(CanonicalJson::encode(['records' => $snapshot['records'], 'relationSets' => $snapshot['relationSets']])), $snapshot['byteSize']);
        $pull = $this->app->make(PullAction::class);
        $this->assertSame([], $pull->execute($snapshot['cursor'], 'catalog', $this->actor())['batches']);
        $this->app->make(WriteGateway::class)->transaction($this->actor(), function (WriteContext $context): void {
            $item = Item::first();
            $item->title = 'Changed';
            $item->save();
            $context->capture($item);
        });
        $first = $pull->execute($snapshot['cursor'], 'catalog', $this->actor());
        $second = $pull->execute($snapshot['cursor'], 'catalog', $this->actor());
        $this->assertSame($first, $second);
        $this->assertSame('Changed', $first['batches'][0]['changes'][0]['record']['attributes']['title']);
        $this->assertSame('Snapshot', $snapshot['records'][0]['attributes']['title']);
        $this->expectException(ProtocolException::class);
        $pull->prune($this->actor(), 2);
    }
}

<?php

declare(strict_types=1);

namespace Synloquent\Tests;

use App\Exports\ExampleExport;
use App\Models\Item;
use App\Models\Tag;
use App\Models\User;
use Illuminate\Contracts\Auth\Access\Gate;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Facades\DB;
use Synloquent\Laravel\Contracts\ResourceExport;
use Synloquent\Laravel\Export\ExportRegistry;
use Synloquent\Laravel\Export\ManifestBuilder;
use Synloquent\Laravel\Export\ValueCodec;
use Synloquent\Laravel\Protocol\CanonicalJson;
use Synloquent\Laravel\Protocol\ProtocolException;
use Synloquent\Laravel\Sync\ActorContext;
use Synloquent\Laravel\Sync\PullAction;
use Synloquent\Laravel\Sync\SnapshotAction;
use Synloquent\Laravel\Sync\SnapshotPartDownloadAction;
use Synloquent\Laravel\Sync\SnapshotPrepareAction;
use Synloquent\Laravel\Sync\StageProfiler;
use Synloquent\Laravel\Sync\WriteContext;
use Synloquent\Laravel\Sync\WriteGateway;

final class SnapshotPartsTest extends TestCase
{
    public function test_public_opt_in_descriptor_and_empty_confirmation_preserve_legacy_identity(): void
    {
        $manifest = $this->app->make(ManifestBuilder::class)->build();
        $response = $this->withToken('synthetic-actor-1')->postJson('/synloquent/v1/protocol', ['protocolVersion' => 1, 'requestId' => 'parts-empty', 'kind' => 'snapshot', 'schemaFingerprint' => $manifest['fingerprint'], 'session' => ['accountId' => '1', 'tenantId' => '1', 'deviceId' => 'example-device', 'deviceEpoch' => 'epoch-1', 'generation' => 0], 'payload' => ['dataset' => 'catalog', 'delivery' => 'parts-v1']])->assertSuccessful();
        $descriptor = $response->json('payload');
        $this->assertSame('ready', $descriptor['status']);
        $this->assertSame(0, $descriptor['partCount']);
        $this->assertArrayNotHasKey('firstPart', $descriptor);
        $this->assertSame(hash('sha256', '{"records":[],"relationSets":[]}'), $descriptor['hash']);
        $this->withToken('synthetic-actor-1')->postJson($descriptor['downloadUrl'].'/confirm', ['confirmationToken' => $descriptor['confirmationToken']])->assertSuccessful()->assertJsonPath('confirmed', true)->assertJsonPath('cursor', $descriptor['cursor']);
        $legacy = $this->app->make(SnapshotAction::class)->execute('catalog', $this->actor());
        $this->assertSame($legacy['hash'], $descriptor['hash']);
        $this->assertSame($legacy['generation'], $descriptor['generation']);
        $this->assertArrayNotHasKey('format', $legacy);
    }

    public function test_parts_and_bundles_preserve_exact_catalog_bytes_and_all_bounds(): void
    {
        $this->items(500, 4000);
        $descriptor = $this->prepare();
        $this->assertGreaterThan(16, $descriptor['partCount']);
        $action = $this->app->make(SnapshotPartDownloadAction::class);
        $individual = $action->execute($descriptor['generation'], $descriptor['hash'], 0, $descriptor['firstPart']['continuation'], $this->actor());
        $firstBundle = $action->bundle($descriptor['generation'], $descriptor['hash'], 0, $descriptor['firstPart']['continuation'], $this->actor());
        $this->assertSame(16, count($firstBundle->partIndex));
        $this->assertSame($individual->body, explode("\n", $firstBundle->body)[0]);
        $sections = ['records' => [], 'relationSets' => []];
        $positions = ['records' => 0, 'relationSets' => 0];
        $identity = $descriptor['firstPart'];
        $confirmation = null;
        $totalParts = 0;
        while ($identity !== null) {
            $bundle = $action->bundle($descriptor['generation'], $descriptor['hash'], $identity['ordinal'], $identity['continuation'], $this->actor());
            $this->assertLessThanOrEqual(1048576, strlen($bundle->body));
            $this->assertLessThanOrEqual(16384, strlen(CanonicalJson::encode($bundle->partIndex)));
            $this->assertLessThanOrEqual(16, count($bundle->partIndex));
            $lines = explode("\n", substr($bundle->body, 0, -1));
            $this->assertCount(count($bundle->partIndex), $lines);
            foreach ($lines as $offset => $line) {
                $indexed = $bundle->partIndex[$offset];
                $this->assertSame($totalParts++, $indexed['ordinal']);
                $this->assertSame($indexed['hash'], hash('sha256', $line));
                $this->assertSame($indexed['byteSize'], strlen($line));
                $this->assertLessThanOrEqual(65536, strlen($line));
                $decoded = json_decode($line, true, flags: JSON_THROW_ON_ERROR);
                $this->assertLessThanOrEqual(256, $decoded['rowCount']);
                $this->assertSame($positions[$decoded['section']], $decoded['firstIndex']);
                $positions[$decoded['section']] += $decoded['rowCount'];
                $opening = strpos($line, ',"rows":[') + strlen(',"rows":[');
                $sections[$decoded['section']][] = substr($line, $opening, -2);
            }
            $identity = $bundle->nextPart;
            $confirmation = $bundle->confirmationToken;
        }
        $raw = '{"records":['.implode(',', $sections['records']).'],"relationSets":['.implode(',', $sections['relationSets']).']}';
        $this->assertSame($descriptor['partCount'], $totalParts);
        $this->assertSame($descriptor['recordCount'], $positions['records']);
        $this->assertSame($descriptor['relationSetCount'], $positions['relationSets']);
        $this->assertSame($descriptor['hash'], hash('sha256', $raw));
        $this->assertSame($descriptor['byteSize'], strlen($raw));
        $this->assertSame(DB::table('synloquent_snapshots')->where('hash', $descriptor['hash'])->value('document'), $raw);
        $this->assertTrue($action->confirm($descriptor['generation'], $descriptor['hash'], $confirmation, $this->actor())['confirmed']);
        $this->withToken('synthetic-actor-1')->withHeader('X-Synloquent-Continuation', $descriptor['firstPart']['continuation'])->get($descriptor['firstPart']['downloadUrl'].'/bundle')->assertSuccessful()->assertHeader('Content-Type', 'application/x-ndjson')->assertHeader('X-Synloquent-Part-Index', CanonicalJson::encode($firstBundle->partIndex));
    }

    public function test_unrelated_write_during_transfer_preserves_liveness_and_original_cursor_tail(): void
    {
        $this->items(300);
        $descriptor = $this->prepare();
        $action = $this->app->make(SnapshotPartDownloadAction::class);
        $first = $action->execute($descriptor['generation'], $descriptor['hash'], 0, $descriptor['firstPart']['continuation'], $this->actor());
        $this->app->make(WriteGateway::class)->transaction($this->actor(), function (WriteContext $context): void {
            $item = Item::findOrFail(300);
            $item->title = 'Unrelated tail update';
            $item->save();
            $context->capture($item);
        });
        $identity = $first->nextPart;
        $confirmation = $first->confirmationToken;
        while ($identity !== null) {
            $part = $action->bundle($descriptor['generation'], $descriptor['hash'], $identity['ordinal'], $identity['continuation'], $this->actor());
            $identity = $part->nextPart;
            $confirmation = $part->confirmationToken;
        }
        $this->assertTrue($action->confirm($descriptor['generation'], $descriptor['hash'], $confirmation, $this->actor())['confirmed']);
        $pull = $this->app->make(PullAction::class)->execute($descriptor['cursor'], 'catalog', $this->actor());
        $this->assertSame('Unrelated tail update', $pull['batches'][0]['changes'][0]['record']['attributes']['title']);
    }

    public function test_final_reauthorization_rejects_revocation_of_an_already_delivered_row(): void
    {
        $this->items(300);
        $descriptor = $this->prepare();
        $action = $this->app->make(SnapshotPartDownloadAction::class);
        $first = $action->execute($descriptor['generation'], $descriptor['hash'], 0, $descriptor['firstPart']['continuation'], $this->actor());
        $identity = $first->nextPart;
        while ($identity !== null) {
            $delivered = $action->bundle($descriptor['generation'], $descriptor['hash'], $identity['ordinal'], $identity['continuation'], $this->actor());
            $identity = $delivered->nextPart;
        }

        $this->app->make(WriteGateway::class)->transaction($this->actor(), function (WriteContext $context): void {
            $item = Item::findOrFail(1);
            $item->tenant_id = 2;
            $item->save();
            $context->capture($item);
            $context->invalidateAuthorization();
        });
        $this->failure('forbidden_operation', fn () => $action->bundle($descriptor['generation'], $descriptor['hash'], $first->nextPart['ordinal'], $first->nextPart['continuation'], $this->actor()));
        $this->failure('forbidden_operation', fn () => $action->confirm($descriptor['generation'], $descriptor['hash'], $delivered->confirmationToken, $this->actor()));
        $this->failure('forbidden_operation', fn () => $action->execute($descriptor['generation'], $descriptor['hash'], 0, $descriptor['firstPart']['continuation'], $this->actor()));
    }

    public function test_grants_and_continuations_reject_foreign_scope_wrong_order_and_tampering(): void
    {
        $this->items(300);
        $descriptor = $this->prepare();
        $action = $this->app->make(SnapshotPartDownloadAction::class);
        $token = $descriptor['firstPart']['continuation'];
        foreach ([$this->actor('2'), new ActorContext('1', '1', 'other', '1', User::find(1), 'example-device'), new ActorContext('1', '1', 'epoch-1', '1', User::find(1), 'other'), new ActorContext('1', '1', 'epoch-1', '2', User::find(1), 'example-device')] as $actor) {
            $this->failure('forbidden_operation', fn () => $action->execute($descriptor['generation'], $descriptor['hash'], 0, $token, $actor));
        }
        $this->failure('forbidden_operation', fn () => $action->execute($descriptor['generation'], $descriptor['hash'], 1, $token, $this->actor()));
        $this->failure('forbidden_operation', fn () => $action->execute($descriptor['generation'], $descriptor['hash'], 0, $token.'x', $this->actor()));
        $this->failure('forbidden_operation', fn () => $action->confirm($descriptor['generation'], $descriptor['hash'], $token, $this->actor()));
        $first = $action->execute($descriptor['generation'], $descriptor['hash'], 0, $token, $this->actor());
        $this->assertSame($first->body, $action->execute($descriptor['generation'], $descriptor['hash'], 0, $token, $this->actor())->body);
        $this->app->make(WriteGateway::class)->transaction($this->actor(), fn (WriteContext $context) => $context->invalidateAuthorization());
        $new = $this->prepare();
        $this->assertSame($descriptor['hash'], $new['hash']);
        $this->assertNotSame($descriptor['generation'], $new['generation']);
        $this->failure('forbidden_operation', fn () => $action->execute($new['generation'], $new['hash'], 0, $token, $this->actor()));
    }

    public function test_current_field_scope_rechecks_earlier_parts_at_final_confirmation(): void
    {
        $controlled = $this->controlledExport();
        $registry = new ExportRegistry;
        foreach ($this->app->make(ExportRegistry::class)->all() as $name => $export) {
            $registry->register($name === 'Item' ? $controlled : $export);
        }
        $this->app->instance(ExportRegistry::class, $registry);
        $this->items(300);
        $descriptor = $this->prepare();
        $action = $this->app->make(SnapshotPartDownloadAction::class);
        $first = $action->execute($descriptor['generation'], $descriptor['hash'], 0, $descriptor['firstPart']['continuation'], $this->actor());
        $controlled->redactFirstTitle = true;
        $this->app->make(WriteGateway::class)->transaction($this->actor(), fn (WriteContext $context) => $context->invalidateAuthorization());
        $identity = $first->nextPart;
        while ($identity !== null) {
            $part = $action->bundle($descriptor['generation'], $descriptor['hash'], $identity['ordinal'], $identity['continuation'], $this->actor());
            $identity = $part->nextPart;
        }
        $this->failure('forbidden_operation', fn () => $action->confirm($descriptor['generation'], $descriptor['hash'], $part->confirmationToken, $this->actor()));
        $this->failure('forbidden_operation', fn () => $action->execute($descriptor['generation'], $descriptor['hash'], 0, $descriptor['firstPart']['continuation'], $this->actor()));
        $controlled->declaredSelfContained = false;
        $deferred = $this->prepare();
        $this->assertSame('admission-required', $deferred['status']);
        $this->assertSame('unsupported-host-contract', $deferred['reason']);
    }

    public function test_part_descriptor_metadata_and_final_content_corruption_fail_closed(): void
    {
        $this->items(2);
        $descriptor = $this->prepare();
        $action = $this->app->make(SnapshotPartDownloadAction::class);
        $part = DB::table('synloquent_snapshot_parts')->first();
        DB::table('synloquent_snapshot_parts')->where('ordinal', 0)->update(['body' => $part->body.' ']);
        $this->failure('invalid_snapshot', fn () => $action->execute($descriptor['generation'], $descriptor['hash'], 0, $descriptor['firstPart']['continuation'], $this->actor()));
        DB::table('synloquent_snapshot_parts')->where('ordinal', 0)->update(['body' => $part->body]);
        $transfer = DB::table('synloquent_snapshot_transfers')->first();
        DB::table('synloquent_snapshot_transfers')->update(['descriptor' => $transfer->descriptor.' ']);
        $this->failure('invalid_snapshot', fn () => $action->execute($descriptor['generation'], $descriptor['hash'], 0, $descriptor['firstPart']['continuation'], $this->actor()));
        DB::table('synloquent_snapshot_transfers')->update(['descriptor' => $transfer->descriptor]);
        $grant = DB::table('synloquent_snapshot_grants')->first();
        DB::table('synloquent_snapshot_grants')->update(['metadata' => $grant->metadata.' ']);
        $this->failure('invalid_snapshot', fn () => $action->execute($descriptor['generation'], $descriptor['hash'], 0, $descriptor['firstPart']['continuation'], $this->actor()));
        DB::table('synloquent_snapshot_grants')->update(['metadata' => $grant->metadata]);
        $bundle = $action->bundle($descriptor['generation'], $descriptor['hash'], 0, $descriptor['firstPart']['continuation'], $this->actor());
        DB::table('synloquent_snapshots')->update(['document' => '{}']);
        $this->failure('invalid_snapshot', fn () => $action->confirm($descriptor['generation'], $descriptor['hash'], $bundle->confirmationToken, $this->actor()));
    }

    public function test_legal_oversized_record_and_complete_relation_set_defer_without_narrowing_legacy(): void
    {
        $this->items(1, 70000);
        $descriptor = $this->prepare();
        $this->assertSame('admission-required', $descriptor['status']);
        $this->assertSame('row-exceeds-part-budget', $descriptor['reason']);
        $this->assertGreaterThan(65536, $descriptor['maximumRowBytes']);
        $this->assertSame(0, DB::table('synloquent_snapshot_parts')->count());
        $legacy = $this->app->make(SnapshotAction::class)->execute('catalog', $this->actor());
        $this->assertSame(70000, strlen($legacy['records'][0]['attributes']['metadata']->text));
        $this->app->make(WriteGateway::class)->transaction($this->actor(), function (WriteContext $context): void {
            Item::whereKey(1)->update(['metadata' => null]);
            $rows = [];
            $pivots = [];
            for ($identity = 1; $identity <= 2000; $identity++) {
                $rows[] = ['id' => $identity, 'tenant_id' => 1, 'title' => 'Target '.$identity];
                $pivots[] = ['item_id' => 1, 'tag_id' => $identity, 'position' => $identity];
            }
            Tag::insert($rows);
            DB::table('item_tag')->insert($pivots);
            $context->invalidateAuthorization();
        });
        $relation = $this->prepare();
        $this->assertSame('admission-required', $relation['status']);
        $this->assertSame('row-exceeds-part-budget', $relation['reason']);
        $full = $this->app->make(SnapshotAction::class)->execute('catalog', $this->actor());
        $set = collect($full['relationSets'])->first(fn (array $set): bool => $set['model'] === 'Item' && $set['relation'] === 'tags');
        $this->assertSame('complete', $set['completeness']);
        $this->assertCount(2000, $set['targets']);
        $this->assertSame(0, DB::table('synloquent_snapshot_parts')->count());
    }

    public function test_unsupported_capture_defers_and_prepare_failure_rolls_back_every_anchor(): void
    {
        $this->items(300);
        $profiler = $this->app->make(StageProfiler::class);
        $profiler->observe(function (string $stage): void {
            if ($stage === 'snapshot.partPersistence') {
                throw new ProtocolException('invalid_snapshot', 'Injected part persistence failure.');
            }
        });
        try {
            $this->failure('invalid_snapshot', fn () => $this->prepare());
        } finally {
            $profiler->observe(null);
        }
        foreach (['synloquent_snapshots', 'synloquent_snapshot_grants', 'synloquent_snapshot_transfers', 'synloquent_snapshot_parts', 'synloquent_projection_states', 'synloquent_projection_memberships', 'synloquent_subscriptions'] as $table) {
            $this->assertSame(0, DB::table($table)->count(), $table);
        }
        $descriptor = $this->prepare();
        $this->assertSame(CanonicalJson::encode($descriptor), CanonicalJson::encode($this->prepare()));
        $this->app['config']->set('synloquent.capture_contract', null);
        $deferred = $this->prepare();
        $this->assertSame('admission-required', $deferred['status']);
        $this->assertSame('unsupported-host-contract', $deferred['reason']);
        $this->assertSame($descriptor['partCount'], DB::table('synloquent_snapshot_parts')->count());
        $this->app['config']->set('synloquent.capture_contract', 'gateway');
        $this->assertSame(CanonicalJson::encode($descriptor), CanonicalJson::encode($this->prepare()));
        DB::table('synloquent_snapshots')->delete();
        $this->assertSame(0, DB::table('synloquent_snapshot_transfers')->count());
        $this->assertSame(0, DB::table('synloquent_snapshot_parts')->count());
    }

    public function test_relation_only_part_rejects_current_owner_scope_revocation(): void
    {
        $this->relationScopeRevocation('owner');
    }

    public function test_relation_only_part_rejects_current_target_scope_revocation(): void
    {
        $this->relationScopeRevocation('target');
    }

    public function test_relation_only_part_rechecks_owner_and_target_query_policies(): void
    {
        $this->relationItems();
        $descriptor = $this->prepare();
        $action = $this->app->make(SnapshotPartDownloadAction::class);
        $first = $action->execute($descriptor['generation'], $descriptor['hash'], 0, $descriptor['firstPart']['continuation'], $this->actor());
        $identity = $first->nextPart;
        $original = $action->execute($descriptor['generation'], $descriptor['hash'], $identity['ordinal'], $identity['continuation'], $this->actor());
        $denied = null;
        $this->app->make(Gate::class)->before(function (User $user, string $ability, array $arguments) use (&$denied): ?bool {
            return $ability === 'viewAny' && ($arguments[0] ?? null) === $denied ? false : null;
        });
        foreach ([Item::class, Tag::class] as $denied) {
            $this->failure('forbidden_operation', fn () => $action->execute($descriptor['generation'], $descriptor['hash'], $identity['ordinal'], $identity['continuation'], $this->actor()));
            $this->withToken('synthetic-actor-1')->withHeader('X-Synloquent-Continuation', $identity['continuation'])->get($identity['downloadUrl'].'/bundle')->assertForbidden()->assertJsonPath('error.code', 'forbidden_operation');
        }
        $denied = null;
        $this->assertSame($original->body, $action->execute($descriptor['generation'], $descriptor['hash'], $identity['ordinal'], $identity['continuation'], $this->actor())->body);
    }

    public function test_relation_only_part_rechecks_current_pivot_field_visibility(): void
    {
        $controlled = $this->controlledExport();
        $registry = new ExportRegistry;
        foreach ($this->app->make(ExportRegistry::class)->all() as $name => $export) {
            $registry->register($name === 'Item' ? $controlled : $export);
        }
        $this->app->instance(ExportRegistry::class, $registry);
        $this->relationItems();
        $descriptor = $this->prepare();
        $action = $this->app->make(SnapshotPartDownloadAction::class);
        $first = $action->execute($descriptor['generation'], $descriptor['hash'], 0, $descriptor['firstPart']['continuation'], $this->actor());
        $identity = $first->nextPart;
        $original = $action->execute($descriptor['generation'], $descriptor['hash'], $identity['ordinal'], $identity['continuation'], $this->actor());
        $controlled->hidePivotPosition = true;
        $this->assertSame($descriptor['schemaFingerprint'], $this->app->make(ManifestBuilder::class)->build()['fingerprint']);
        $this->failure('forbidden_operation', fn () => $action->execute($descriptor['generation'], $descriptor['hash'], $identity['ordinal'], $identity['continuation'], $this->actor()));
        $this->withToken('synthetic-actor-1')->withHeader('X-Synloquent-Continuation', $identity['continuation'])->get($identity['downloadUrl'].'/bundle')->assertForbidden()->assertJsonPath('error.code', 'forbidden_operation');
        $controlled->hidePivotPosition = false;
        $this->assertSame($original->body, $action->execute($descriptor['generation'], $descriptor['hash'], $identity['ordinal'], $identity['continuation'], $this->actor())->body);
    }

    public function test_relation_only_part_rechecks_current_owner_and_target_identity_projection(): void
    {
        $controlled = ['Item' => $this->controlledExport('Item'), 'Tag' => $this->controlledExport('Tag')];
        $registry = new ExportRegistry;
        foreach ($this->app->make(ExportRegistry::class)->all() as $name => $export) {
            $registry->register($controlled[$name] ?? $export);
        }
        $this->app->instance(ExportRegistry::class, $registry);
        $this->relationItems();
        $descriptor = $this->prepare();
        $action = $this->app->make(SnapshotPartDownloadAction::class);
        $first = $action->execute($descriptor['generation'], $descriptor['hash'], 0, $descriptor['firstPart']['continuation'], $this->actor());
        $identity = $first->nextPart;
        $original = $action->execute($descriptor['generation'], $descriptor['hash'], $identity['ordinal'], $identity['continuation'], $this->actor());
        foreach ($controlled as $export) {
            $export->hideIdentity = true;
            $this->assertSame($descriptor['schemaFingerprint'], $this->app->make(ManifestBuilder::class)->build()['fingerprint']);
            $this->failure('forbidden_operation', fn () => $action->execute($descriptor['generation'], $descriptor['hash'], $identity['ordinal'], $identity['continuation'], $this->actor()));
            $this->withToken('synthetic-actor-1')->withHeader('X-Synloquent-Continuation', $identity['continuation'])->get($identity['downloadUrl'].'/bundle')->assertForbidden()->assertJsonPath('error.code', 'forbidden_operation');
            $export->hideIdentity = false;
            $this->assertSame($original->body, $action->execute($descriptor['generation'], $descriptor['hash'], $identity['ordinal'], $identity['continuation'], $this->actor())->body);
        }
    }

    public function test_relation_history_survives_current_topology_change_with_exact_bytes(): void
    {
        $this->relationItems();
        $descriptor = $this->prepare();
        $action = $this->app->make(SnapshotPartDownloadAction::class);
        $first = $action->execute($descriptor['generation'], $descriptor['hash'], 0, $descriptor['firstPart']['continuation'], $this->actor());
        $identity = $first->nextPart;
        $original = $action->execute($descriptor['generation'], $descriptor['hash'], $identity['ordinal'], $identity['continuation'], $this->actor());
        $this->app->make(WriteGateway::class)->transaction($this->actor(), function (WriteContext $context): void {
            DB::table('item_tag')->delete();
            DB::table('taggables')->delete();
            $context->invalidateAuthorization();
        });
        $historical = $action->execute($descriptor['generation'], $descriptor['hash'], $identity['ordinal'], $identity['continuation'], $this->actor());
        $this->assertSame($original->body, $historical->body);
        $this->assertSame($identity['hash'], hash('sha256', $historical->body));
        $this->assertTrue($action->confirm($descriptor['generation'], $descriptor['hash'], $historical->confirmationToken, $this->actor())['confirmed']);
    }

    private function relationScopeRevocation(string $revoked): void
    {
        $this->relationItems();
        $descriptor = $this->prepare();
        $action = $this->app->make(SnapshotPartDownloadAction::class);
        $first = $action->execute($descriptor['generation'], $descriptor['hash'], 0, $descriptor['firstPart']['continuation'], $this->actor());
        $identity = $first->nextPart;
        $original = $action->execute($descriptor['generation'], $descriptor['hash'], $identity['ordinal'], $identity['continuation'], $this->actor());
        $body = json_decode($original->body, true, flags: JSON_THROW_ON_ERROR);
        $this->assertSame('relationSets', $body['section']);
        foreach (['tags', 'classifications'] as $relation) {
            $set = collect($body['rows'])->first(fn (array $set): bool => $set['model'] === 'Item' && $set['relation'] === $relation);
            $this->assertSame([['attributes' => ['position' => 7], 'id' => '1']], $set['targets']);
        }
        $this->app->make(WriteGateway::class)->transaction($this->actor(), function (WriteContext $context) use ($revoked): void {
            $model = $revoked === 'owner' ? Item::findOrFail(1) : Tag::findOrFail(1);
            $model->tenant_id = 2;
            $model->save();
            $context->capture($model);
            $context->invalidateAuthorization();
        });
        foreach (['', '/bundle'] as $suffix) {
            $response = $this->withToken('synthetic-actor-1')->withHeader('X-Synloquent-Continuation', $identity['continuation'])->get($identity['downloadUrl'].$suffix)->assertForbidden()->assertJsonPath('error.code', 'forbidden_operation');
            $this->assertFalse($response->headers->has('X-Synloquent-Confirmation-Token'));
            $this->assertArrayNotHasKey('rows', $response->json());
        }
        $this->withToken('synthetic-actor-1')->get($descriptor['downloadUrl'])->assertForbidden();
        $this->withToken('synthetic-actor-1')->postJson($descriptor['downloadUrl'].'/confirm', ['confirmationToken' => $original->confirmationToken])->assertForbidden();
    }

    private function relationItems(): void
    {
        $this->items(1);
        $this->app->make(WriteGateway::class)->transaction($this->actor(), function (WriteContext $context): void {
            Tag::create(['id' => 1, 'tenant_id' => 1, 'title' => 'Visible target']);
            DB::table('item_tag')->insert(['item_id' => 1, 'tag_id' => 1, 'position' => 7]);
            DB::table('taggables')->insert(['taggable_id' => 1, 'taggable_type' => (new Item)->getMorphClass(), 'tag_id' => 1, 'position' => 7]);
            $context->invalidateAuthorization();
        });
    }

    private function controlledExport(string $name = 'Item'): ExampleExport
    {
        return new class($this->app->make(Gate::class), $this->app->make(ValueCodec::class), $this->app->make(ExportRegistry::class)->get($name)) extends ExampleExport
        {
            public bool $redactFirstTitle = false;

            public bool $declaredSelfContained = true;

            public bool $hidePivotPosition = false;

            public bool $hideIdentity = false;

            private ResourceExport $original;

            public function __construct(Gate $gate, ValueCodec $values, ResourceExport $original)
            {
                parent::__construct($gate, $values);
                $this->original = $original;
            }

            public function name(): string
            {
                return $this->original->name();
            }

            public function modelClass(): string
            {
                return $this->original->modelClass();
            }

            public function readable(): array
            {
                return $this->original->readable();
            }

            public function writable(): array
            {
                return $this->original->writable();
            }

            public function relations(): array
            {
                return $this->original->relations();
            }

            public function materialized(): array
            {
                return $this->original->materialized();
            }

            public function fields(): array
            {
                return $this->original->fields();
            }

            public function pivotFields(string $relation): array
            {
                $fields = $this->original->pivotFields($relation);
                if ($this->hidePivotPosition && isset($fields['position'])) {
                    $fields['position']['readable'] = false;
                }

                return $fields;
            }

            public function project(Model $model, ActorContext $actor): array
            {
                $attributes = $this->original->project($model, $actor);
                if ($this->hideIdentity) {
                    unset($attributes[$model->getKeyName()]);
                }
                if ($this->redactFirstTitle && (string) $model->getKey() === '1') {
                    unset($attributes['title']);
                }

                return $attributes;
            }

            public function selfContainedProjection(): bool
            {
                return $this->declaredSelfContained;
            }
        };
    }

    private function items(int $count, int $textBytes = 0): void
    {
        $this->app->make(WriteGateway::class)->transaction($this->actor(), function (WriteContext $context) use ($count, $textBytes): void {
            $rows = [];
            for ($identity = 1; $identity <= $count; $identity++) {
                $rows[] = ['id' => $identity, 'tenant_id' => 1, 'title' => 'Český "řádek" '.$identity, 'metadata' => $textBytes === 0 ? null : json_encode(['text' => str_repeat('a', $textBytes)], JSON_THROW_ON_ERROR)];
            }
            Item::insert($rows);
            $context->invalidateAuthorization();
        });
    }

    private function prepare(): array
    {
        return $this->app->make(SnapshotPrepareAction::class)->execute('catalog', $this->actor());
    }

    private function failure(string $code, callable $operation): void
    {
        try {
            $operation();
            $this->fail('Expected '.$code.' failure.');
        } catch (ProtocolException $exception) {
            $this->assertSame($code, $exception->errorCode);
        }
    }
}

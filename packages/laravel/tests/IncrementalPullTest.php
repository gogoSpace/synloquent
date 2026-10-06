<?php

declare(strict_types=1);

namespace Synloquent\Tests;

use App\Models\Item;
use App\Models\Tag;
use Illuminate\Contracts\Auth\Access\Gate;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Facades\DB;
use Synloquent\Laravel\Export\ExportDefinition;
use Synloquent\Laravel\Export\ExportRegistry;
use Synloquent\Laravel\Export\ManifestBuilder;
use Synloquent\Laravel\Export\ValueCodec;
use Synloquent\Laravel\Protocol\CanonicalJson;
use Synloquent\Laravel\Protocol\ProtocolException;
use Synloquent\Laravel\Sync\ActorContext;
use Synloquent\Laravel\Sync\MembershipIndex;
use Synloquent\Laravel\Sync\PullAction;
use Synloquent\Laravel\Sync\SnapshotAction;
use Synloquent\Laravel\Sync\WriteContext;
use Synloquent\Laravel\Sync\WriteGateway;

final class IncrementalPullTest extends TestCase
{
    public function test_unchanged_pull_reads_no_domain_rows_or_membership_json(): void
    {
        $this->write('Baseline');
        $snapshot = $this->app->make(SnapshotAction::class)->execute('catalog', $this->actor());
        $actor = $this->actor();
        DB::flushQueryLog();
        DB::enableQueryLog();
        $result = $this->app->make(PullAction::class)->execute($snapshot['cursor'], 'catalog', $actor);
        $queries = DB::getQueryLog();
        DB::disableQueryLog();
        $this->assertSame([], $result['batches']);
        $this->assertCount(5, $queries);
        foreach ($queries as $query) {
            $this->assertStringNotContainsString('"items"', $query['query']);
            $this->assertStringNotContainsString('"synloquent_projection_memberships"', $query['query']);
            $this->assertStringNotContainsString('"membership"', $query['query']);
        }
    }

    public function test_historical_membership_replays_coalesced_transaction_intervals(): void
    {
        $this->write('Baseline');
        $snapshot = $this->app->make(SnapshotAction::class)->execute('catalog', $this->actor());
        $pull = $this->app->make(PullAction::class);
        $this->write('First');
        $first = $pull->execute($snapshot['cursor'], 'catalog', $this->actor());
        $this->write('Second');
        $second = $pull->execute($first['cursor'], 'catalog', $this->actor());
        $replayed = $pull->execute($snapshot['cursor'], 'catalog', $this->actor());
        $this->assertSame('First', $first['batches'][0]['changes'][0]['record']['attributes']['title']);
        $this->assertSame('Second', $second['batches'][0]['changes'][0]['record']['attributes']['title']);
        $this->assertSame($second['batches'], $replayed['batches']);
        $this->assertSame($replayed, $pull->execute($snapshot['cursor'], 'catalog', $this->actor()));
        $this->assertSame([], $pull->execute($second['cursor'], 'catalog', $this->actor())['batches']);
        $this->assertSame(3, DB::table('synloquent_publications')->count());
    }

    public function test_hundred_changed_rows_use_a_bounded_number_of_queries(): void
    {
        $this->app->make(WriteGateway::class)->transaction($this->actor(), function (WriteContext $context): void {
            foreach (range(1, 100) as $identity) {
                $context->capture(Item::create(['tenant_id' => 1, 'title' => 'Before '.$identity]));
            }
        });
        $snapshot = $this->app->make(SnapshotAction::class)->execute('catalog', $this->actor());
        $this->app->make(WriteGateway::class)->transaction($this->actor(), function (WriteContext $context): void {
            foreach (Item::get() as $item) {
                $item->title = 'After '.$item->id;
                $item->save();
                $context->capture($item);
            }
        });
        $actor = $this->actor();
        DB::flushQueryLog();
        DB::enableQueryLog();
        $result = $this->app->make(PullAction::class)->execute($snapshot['cursor'], 'catalog', $actor);
        $queries = DB::getQueryLog();
        DB::disableQueryLog();
        $this->assertCount(100, $result['batches'][0]['changes']);
        $this->assertLessThanOrEqual(22, count($queries));
        foreach ($result['batches'][0]['changes'] as $change) {
            $this->assertSame('After '.$change['id'], $change['record']['attributes']['title']);
        }
    }

    public function test_pivot_target_revocation_captures_directed_dependents(): void
    {
        $this->artisan('synloquent:seed-example')->assertSuccessful();
        $snapshot = $this->app->make(SnapshotAction::class)->execute('catalog', $this->actor());
        $this->app->make(WriteGateway::class)->transaction($this->actor(), function (WriteContext $context): void {
            $tag = Tag::findOrFail(1);
            $tag->tenant_id = 2;
            $tag->save();
            $context->capture($tag);
        });
        $result = $this->app->make(PullAction::class)->execute($snapshot['cursor'], 'catalog', $this->actor());
        $this->assertContains(['kind' => 'remove', 'model' => 'Tag', 'id' => '1'], $result['batches'][0]['changes']);
        $sets = collect($result['batches'][0]['relationSets'])->keyBy(fn ($set) => $set['model'].':'.$set['relation'].':'.$set['parentId']);
        foreach (['Item:tags:1', 'Item:classifications:1', 'Tag:items:1', 'Tag:classifiedItems:1'] as $key) {
            $this->assertSame([], $sets[$key]['targets']);
        }
        $journal = json_decode(DB::table('synloquent_publications')->orderByDesc('sequence')->value('changes'), true, flags: JSON_THROW_ON_ERROR);
        $this->assertCount(2, array_filter($journal, fn ($change) => ($change['kind'] ?? '') === 'relation' && $change['model'] === 'Item'));
    }

    public function test_one_way_pivot_export_revoke_and_regain_capture_incoming_owners(): void
    {
        $registry = new ExportRegistry;
        foreach ($this->app->make(ExportRegistry::class)->all() as $resource) {
            if ($resource->name() !== 'Tag') {
                $registry->register($resource);
            }
        }
        $registry->register(new OneWayTagFixtureExport($this->app->make(Gate::class), $this->app->make(ValueCodec::class)));
        $this->app->instance(ExportRegistry::class, $registry);
        $this->app->forgetInstance(ManifestBuilder::class);
        $this->app->forgetInstance(WriteGateway::class);
        $this->artisan('synloquent:seed-example')->assertSuccessful();
        $snapshot = $this->app->make(SnapshotAction::class)->execute('catalog', $this->actor());
        $pull = $this->app->make(PullAction::class);
        foreach ([2, 1] as $tenant) {
            $this->app->make(WriteGateway::class)->transaction($this->actor(), function (WriteContext $context) use ($tenant): void {
                $tag = Tag::findOrFail(1);
                $tag->tenant_id = $tenant;
                $tag->save();
                $context->capture($tag);
            });
            $result = $pull->execute($snapshot['cursor'], 'catalog', $this->actor());
            $sets = collect($result['batches'][0]['relationSets'])->keyBy(fn ($set) => $set['model'].':'.$set['relation'].':'.$set['parentId']);
            foreach (['Item:tags:1', 'Item:classifications:1'] as $key) {
                $this->assertSame($tenant === 2 ? [] : ['1'], array_column($sets[$key]['targets'], 'id'));
            }
            $change = collect($result['batches'][0]['changes'])->firstWhere('model', 'Tag');
            $this->assertSame($tenant === 2 ? 'remove' : 'upsert', $change['kind']);
            $snapshot['cursor'] = $result['cursor'];
        }
    }

    public function test_changed_authorization_generation_rechecks_fields_and_resource_policy_at_same_sequence(): void
    {
        $export = $this->projectionExport();
        $this->write('Private title');
        $snapshot = $this->app->make(SnapshotAction::class)->execute('catalog', $this->actor());
        $export->hideTitle = true;
        $nextActor = new ActorContext('1', '1', 'epoch-1', '2', $this->actor()->user, 'example-device');
        $result = $this->app->make(PullAction::class)->execute($snapshot['cursor'], 'catalog', $nextActor);
        $this->assertSame(['id' => 1], $result['batches'][0]['changes'][0]['record']['attributes']);
        $this->assertSame('2', $result['scope']['authorizationGeneration']);
        $this->assertSame(1, (int) DB::table('synloquent_streams')->value('sequence'));
        $export->queryAllowed = false;
        $lastActor = new ActorContext('1', '1', 'epoch-1', '3', $this->actor()->user, 'example-device');
        $revoked = $this->app->make(PullAction::class)->execute($result['cursor'], 'catalog', $lastActor);
        $this->assertSame([['kind' => 'remove', 'model' => 'Item', 'id' => '1']], $revoked['batches'][0]['changes']);
    }

    public function test_unknown_projection_dependency_fails_closed_until_global_invalidation(): void
    {
        $export = $this->projectionExport();
        $export->rowLocal = false;
        $this->write('Private title');
        $snapshot = $this->app->make(SnapshotAction::class)->execute('catalog', $this->actor());
        $export->hideTitle = true;
        try {
            $this->app->make(PullAction::class)->execute($snapshot['cursor'], 'catalog', $this->actor());
            $this->fail('Uncaptured external projection change was accepted.');
        } catch (ProtocolException $exception) {
            $this->assertSame('cursor_expired', $exception->errorCode);
        }
        $this->app->make(WriteGateway::class)->transaction($this->actor(), fn (WriteContext $context) => $context->invalidateAuthorization());
        $result = $this->app->make(PullAction::class)->execute($snapshot['cursor'], 'catalog', $this->actor());
        $this->assertSame(['id' => 1], $result['batches'][0]['changes'][0]['record']['attributes']);
    }

    public function test_global_invalidation_and_oversized_history_require_bounded_resnapshot(): void
    {
        $this->write('Baseline');
        $snapshot = $this->app->make(SnapshotAction::class)->execute('catalog', $this->actor());
        $this->app['config']->set('synloquent.max_pull_materialization_members', 1);
        $this->app->make(WriteGateway::class)->transaction($this->actor(), fn (WriteContext $context) => $context->invalidateAuthorization());
        try {
            $this->app->make(PullAction::class)->execute($snapshot['cursor'], 'catalog', $this->actor());
            $this->fail('Unbounded fallback was accepted.');
        } catch (ProtocolException $exception) {
            $this->assertSame('cursor_expired', $exception->errorCode);
        }
        $this->app['config']->set('synloquent.max_delta_transactions', 1);
        $this->write('After invalidation');
        $this->expectException(ProtocolException::class);
        $this->app->make(PullAction::class)->execute($snapshot['cursor'], 'catalog', $this->actor());
    }

    public function test_membership_copy_preserves_escaped_identity_and_rolls_back_atomically(): void
    {
        $index = $this->app->make(MembershipIndex::class);
        $actor = $this->actor();
        $scope = hash('sha256', 'copy-rollback-scope');
        $member = ['model' => 'Item', 'id' => "tab\t slash\\ quote\" newline\n", 'hash' => hash('sha256', 'copy-value')];
        try {
            $this->app->make(WriteGateway::class)->transaction($actor, function () use ($index, $actor, $scope, $member): void {
                $index->initialize([$member], $scope, $actor->stream(), 0);
                $this->assertSame(CanonicalJson::encode($member), CanonicalJson::encode($index->lookup([$member], $scope, 0)[$index->key($member)]));
                throw new \RuntimeException('Abort after copy.');
            });
            $this->fail('Expected transaction failure.');
        } catch (\RuntimeException $exception) {
            $this->assertSame('Abort after copy.', $exception->getMessage());
        }
        $this->assertSame(0, DB::table('synloquent_projection_states')->count());
        $this->assertSame(0, DB::table('synloquent_projection_memberships')->count());
        $this->assertSame(0, DB::table('synloquent_publications')->count());
    }

    private function write(string $title): void
    {
        $this->app->make(WriteGateway::class)->transaction($this->actor(), function (WriteContext $context) use ($title): void {
            $item = Item::first() ?? new Item(['tenant_id' => 1]);
            $item->title = $title;
            $item->save();
            $context->capture($item);
        });
    }

    private function projectionExport(): ProjectionFixtureExport
    {
        $registry = new ExportRegistry;
        $export = new ProjectionFixtureExport($this->app->make(Gate::class), $this->app->make(ValueCodec::class));
        $registry->register($export);
        $this->app->instance(ExportRegistry::class, $registry);
        $this->app->forgetInstance(ManifestBuilder::class);
        $this->app->forgetInstance(WriteGateway::class);

        return $export;
    }
}

final class ProjectionFixtureExport extends ExportDefinition
{
    public bool $rowLocal = true;

    public bool $hideTitle = false;

    public bool $queryAllowed = true;

    public function name(): string
    {
        return 'Item';
    }

    public function modelClass(): string
    {
        return Item::class;
    }

    public function readable(): array
    {
        return ['id', 'title'];
    }

    public function writable(): array
    {
        return ['title'];
    }

    public function scope(Builder $query, ActorContext $actor): void
    {
        $query->where('tenant_id', (int) $actor->tenantId);
    }

    public function selfContainedProjection(): bool
    {
        return $this->rowLocal;
    }

    public function authorize(string $operation, ActorContext $actor, ?Model $model = null): bool
    {
        return $this->queryAllowed && parent::authorize($operation, $actor, $model);
    }

    public function project(Model $model, ActorContext $actor): array
    {
        $attributes = parent::project($model, $actor);
        if ($this->hideTitle) {
            unset($attributes['title']);
        }

        return $attributes;
    }
}

final class OneWayTagFixtureExport extends ExportDefinition
{
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

    public function selfContainedProjection(): bool
    {
        return true;
    }

    public function scope(Builder $query, ActorContext $actor): void
    {
        $query->where('tenant_id', (int) $actor->tenantId);
    }
}

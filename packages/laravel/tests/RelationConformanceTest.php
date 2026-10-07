<?php

declare(strict_types=1);

namespace Synloquent\Tests;

use App\Policies\CatalogPolicy;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\BelongsToMany;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Database\Eloquent\Relations\HasOne;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Gate;
use Illuminate\Support\Facades\Schema;
use Synloquent\Laravel\Export\ExportDefinition;
use Synloquent\Laravel\Export\ExportRegistry;
use Synloquent\Laravel\Export\ManifestBuilder;
use Synloquent\Laravel\Query\QueryAction;
use Synloquent\Laravel\Sync\ActorContext;
use Synloquent\Laravel\Sync\MutationAction;

final class RelationConformanceTest extends TestCase
{
    public function test_custom_primary_foreign_and_pivot_keys_and_ordered_one_of_many_ties(): void
    {
        Schema::create('fixture_owners', function (Blueprint $table): void {
            $table->string('catalog_key')->primary();
            $table->string('lookup_code')->unique();
            $table->bigInteger('tenant_id');
            $table->string('title');
        });
        Schema::create('fixture_children', function (Blueprint $table): void {
            $table->id();
            $table->bigInteger('tenant_id');
            $table->string('owner_code');
            $table->integer('rank');
            $table->decimal('amount', 12, 2);
            $table->foreign('owner_code')->references('lookup_code')->on('fixture_owners')->cascadeOnDelete();
        });
        Schema::create('fixture_targets', function (Blueprint $table): void {
            $table->string('sales_code')->primary();
            $table->bigInteger('tenant_id');
            $table->string('title');
        });
        Schema::create('fixture_owner_target', function (Blueprint $table): void {
            $table->string('owner_code');
            $table->string('target_code');
            $table->integer('position');
            $table->primary(['owner_code', 'target_code']);
            $table->foreign('owner_code')->references('lookup_code')->on('fixture_owners')->cascadeOnDelete();
            $table->foreign('target_code')->references('sales_code')->on('fixture_targets')->cascadeOnDelete();
        });
        foreach ([FixtureOwnerExport::class, FixtureChildExport::class, FixtureTargetExport::class] as $class) {
            $resource = $this->app->make($class);
            $this->app->make(ExportRegistry::class)->register($resource);
            Gate::policy($resource->modelClass(), CatalogPolicy::class);
        }
        $owner = FixtureOwner::create(['catalog_key' => 'owner:custom', 'lookup_code' => 'foreign:owner', 'tenant_id' => 1, 'title' => 'Custom owner']);
        foreach ([1, 3, 3, 1] as $rank) {
            FixtureChild::create(['owner_code' => $owner->lookup_code, 'tenant_id' => 1, 'rank' => $rank, 'amount' => '0.10']);
        }
        FixtureTarget::create(['sales_code' => 'target:custom', 'tenant_id' => 1, 'title' => 'Custom target']);
        $manifest = $this->app->make(ManifestBuilder::class)->build();
        $this->assertSame('catalog_key', $manifest['models']['FixtureOwner']['primaryKey']);
        $this->assertSame('owner_code', $manifest['models']['FixtureOwner']['relations']['children']['foreignKey']);
        $this->assertSame('lookup_code', $manifest['models']['FixtureChild']['relations']['owner']['ownerKey']);
        $this->assertSame('lookup_code', $manifest['models']['FixtureOwner']['relations']['children']['localKey']);
        $this->assertSame([['field' => 'rank', 'aggregate' => 'max'], ['field' => 'id', 'aggregate' => 'min']], $manifest['models']['FixtureOwner']['relations']['bestChild']['oneOfMany']);
        $this->assertSame([['field' => 'rank', 'aggregate' => 'max'], ['field' => 'id', 'aggregate' => 'max']], $manifest['models']['FixtureOwner']['relations']['latestChild']['oneOfMany']);
        $this->assertSame([['field' => 'rank', 'aggregate' => 'min'], ['field' => 'id', 'aggregate' => 'max']], $manifest['models']['FixtureOwner']['relations']['oldestChild']['oneOfMany']);
        foreach (['bestChild' => '2', 'latestChild' => '3', 'oldestChild' => '4'] as $relation => $identity) {
            $result = $this->app->make(QueryAction::class)->execute(['model' => 'FixtureOwner', 'include' => [$relation => []]], $this->actor());
            $this->assertSame([$identity], array_column($result['related'], 'id'));
            $this->assertSame('foreign:owner', $result['related'][0]['attributes']['owner_code']);
        }
        $operation = $this->operation('custom-pivot', 'pivot', ['relation' => 'targets', 'action' => 'attach', 'targets' => ['target:custom'], 'attributes' => ['position' => 7], 'expectedRelationRevision' => '0'], ['model' => 'FixtureOwner', 'id' => 'owner:custom']);
        $receipt = $this->app->make(MutationAction::class)->execute([$operation], $this->actor())['receipts'][0];
        $this->assertSame('accepted', $receipt['status']);
        $this->assertSame('owner:custom', $receipt['canonical']['id']);
        $this->assertSame([['id' => 'target:custom', 'attributes' => ['position' => 7]]], $receipt['relationSets'][0]['targets']);
        $computed = $this->app->make(QueryAction::class)->execute(['model' => 'FixtureOwner', 'relationAggregates' => [['relation' => 'children', 'function' => 'sum', 'field' => 'amount'], ['relation' => 'children', 'function' => 'avg', 'field' => 'amount'], ['relation' => 'children', 'function' => 'min', 'field' => 'rank'], ['relation' => 'children', 'function' => 'max', 'field' => 'rank']]], $this->actor());
        $this->assertSame(['children_sum_amount' => '0.40', 'children_avg_amount' => '0.10', 'children_min_rank' => 1, 'children_max_rank' => 3], $computed['computed']['FixtureOwner:owner:custom']['aggregates']);
        Schema::table('fixture_children', static fn (Blueprint $table) => $table->bigInteger('rank')->change());
        FixtureChild::query()->update(['rank' => 4503599627370496]);
        $unsafe = $this->app->make(QueryAction::class)->execute(['model' => 'FixtureOwner', 'relationAggregates' => [['relation' => 'children', 'function' => 'avg', 'field' => 'rank']]], $this->actor());
        $this->assertSame('4503599627370496', $unsafe['computed']['FixtureOwner:owner:custom']['aggregates']['children_avg_rank']);
    }
}

final class FixtureOwner extends Model
{
    protected $table = 'fixture_owners';

    protected $primaryKey = 'catalog_key';

    protected $keyType = 'string';

    public $incrementing = false;

    public $timestamps = false;

    protected $guarded = [];

    public function children(): HasMany
    {
        return $this->hasMany(FixtureChild::class, 'owner_code', 'lookup_code');
    }

    public function bestChild(): HasOne
    {
        return $this->hasOne(FixtureChild::class, 'owner_code', 'lookup_code')->ofMany(['rank' => 'max', 'id' => 'min']);
    }

    public function latestChild(): HasOne
    {
        return $this->hasOne(FixtureChild::class, 'owner_code', 'lookup_code')->latestOfMany('rank');
    }

    public function oldestChild(): HasOne
    {
        return $this->hasOne(FixtureChild::class, 'owner_code', 'lookup_code')->oldestOfMany('rank');
    }

    public function targets(): BelongsToMany
    {
        return $this->belongsToMany(FixtureTarget::class, 'fixture_owner_target', 'owner_code', 'target_code', 'lookup_code', 'sales_code')->withPivot('position');
    }
}

final class FixtureChild extends Model
{
    protected $table = 'fixture_children';

    public $timestamps = false;

    protected $guarded = [];

    protected $casts = ['rank' => 'integer', 'amount' => 'decimal:2'];

    public function owner(): BelongsTo
    {
        return $this->belongsTo(FixtureOwner::class, 'owner_code', 'lookup_code');
    }
}

final class FixtureTarget extends Model
{
    protected $table = 'fixture_targets';

    protected $primaryKey = 'sales_code';

    protected $keyType = 'string';

    public $incrementing = false;

    public $timestamps = false;

    protected $guarded = [];
}

abstract class FixtureRelationExport extends ExportDefinition
{
    public function selfContainedProjection(): bool
    {
        return true;
    }

    public function scope(Builder $query, ActorContext $actor): void
    {
        $query->where($query->getModel()->qualifyColumn('tenant_id'), (int) $actor->tenantId);
    }
}

final class FixtureOwnerExport extends FixtureRelationExport
{
    public function name(): string
    {
        return 'FixtureOwner';
    }

    public function modelClass(): string
    {
        return FixtureOwner::class;
    }

    public function readable(): array
    {
        return ['catalog_key', 'lookup_code', 'title'];
    }

    public function relations(): array
    {
        return ['children', 'bestChild', 'latestChild', 'oldestChild', 'targets'];
    }

    public function operations(): array
    {
        return ['query', 'pivot'];
    }

    public function pivotFields(string $relation): array
    {
        return $relation === 'targets' ? ['position' => ['type' => 'integer', 'nullable' => false, 'readable' => true, 'writable' => true]] : [];
    }
}

final class FixtureChildExport extends FixtureRelationExport
{
    public function name(): string
    {
        return 'FixtureChild';
    }

    public function modelClass(): string
    {
        return FixtureChild::class;
    }

    public function readable(): array
    {
        return ['id', 'owner_code', 'rank', 'amount'];
    }

    public function relations(): array
    {
        return ['owner'];
    }
}

final class FixtureTargetExport extends FixtureRelationExport
{
    public function name(): string
    {
        return 'FixtureTarget';
    }

    public function modelClass(): string
    {
        return FixtureTarget::class;
    }

    public function readable(): array
    {
        return ['sales_code', 'title'];
    }
}

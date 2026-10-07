<?php

declare(strict_types=1);

namespace Synloquent\Tests;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;
use Synloquent\Laravel\Export\ExportDefinition;
use Synloquent\Laravel\Export\ExportRegistry;
use Synloquent\Laravel\Query\QueryAction;
use Synloquent\Laravel\Sync\ActorContext;

final class SelfRelationAggregateTest extends TestCase
{
    public function test_text_aggregates_read_the_related_side_of_self_relations(): void
    {
        Schema::create('aggregate_tree_nodes', static function (Blueprint $table): void {
            $table->id();
            $table->foreignId('parent_id')->nullable()->constrained('aggregate_tree_nodes');
            $table->string('title');
        });
        $this->app->make(ExportRegistry::class)->register($this->app->make(AggregateTreeNodeExport::class));
        $parent = AggregateTreeNode::create(['title' => 'Z-parent']);
        foreach (['A', 'a', 'a '] as $title) {
            AggregateTreeNode::create(['parent_id' => $parent->id, 'title' => $title]);
        }
        $result = $this->app->make(QueryAction::class)->execute(['model' => 'AggregateTreeNode', 'where' => ['kind' => 'comparison', 'field' => 'id', 'operator' => '=', 'value' => $parent->id], 'relationAggregates' => [['relation' => 'children', 'function' => 'min', 'field' => 'title'], ['relation' => 'children', 'function' => 'max', 'field' => 'title']]], $this->actor());
        $this->assertSame(['children_min_title' => 'A', 'children_max_title' => 'a '], $result['computed']['AggregateTreeNode:'.$parent->id]['aggregates']);
    }
}

final class AggregateTreeNode extends Model
{
    public $timestamps = false;

    protected $guarded = [];

    public function children(): HasMany
    {
        return $this->hasMany(self::class, 'parent_id');
    }
}

final class AggregateTreeNodeExport extends ExportDefinition
{
    public function name(): string
    {
        return 'AggregateTreeNode';
    }

    public function modelClass(): string
    {
        return AggregateTreeNode::class;
    }

    public function readable(): array
    {
        return ['id', 'parent_id', 'title'];
    }

    public function relations(): array
    {
        return ['children'];
    }

    public function authorize(string $operation, ActorContext $actor, ?Model $model = null): bool
    {
        return true;
    }
}

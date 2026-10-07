<?php

declare(strict_types=1);

namespace Synloquent\Tests;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;
use Synloquent\Laravel\Export\ExportDefinition;
use Synloquent\Laravel\Export\ExportRegistry;
use Synloquent\Laravel\Query\QueryAction;
use Synloquent\Laravel\Sync\ActorContext;

final class QualifiedSourceTest extends TestCase
{
    private function prepareSource(string $engine = 'InnoDB'): void
    {
        Schema::create('qualified_records', static function (Blueprint $table) use ($engine): void {
            $table->engine = $engine;
            $table->id();
            $table->string('body');
            $table->integer('quantity');
        });
        $this->app->make(ExportRegistry::class)->register($this->app->make(QualifiedRecordExport::class));
        DB::table('qualified_records')->insert([['body' => 'A', 'quantity' => 2], ['body' => 'a', 'quantity' => 4], ['body' => 'a ', 'quantity' => 6]]);
    }

    public function test_qualified_sources_support_grouping_having_unions_and_nested_union_subqueries(): void
    {
        $this->prepareSource();
        $action = $this->app->make(QueryAction::class);
        $base = ['model' => 'QualifiedRecord'];
        $union = [...$base, 'unions' => [['all' => false, 'query' => $base]]];
        foreach ([$base, $union] as $definition) {
            $groups = $action->execute([...$definition, 'groupBy' => ['body'], 'aggregate' => ['function' => 'sum', 'field' => 'quantity']], $this->actor());
            $this->assertSame([['keys' => ['body' => 'A'], 'value' => 2], ['keys' => ['body' => 'a'], 'value' => 4], ['keys' => ['body' => 'a '], 'value' => 6]], $groups['aggregate']['groups']);
            $filtered = $action->execute([...$definition, 'groupBy' => ['body'], 'aggregate' => ['function' => 'avg', 'field' => 'quantity'], 'having' => ['kind' => 'comparison', 'field' => 'body', 'operator' => '=', 'value' => 'a']], $this->actor());
            $this->assertSame([['keys' => ['body' => 'a'], 'value' => 4.0]], $filtered['aggregate']['groups']);
            $this->assertSame('A', $action->execute([...$definition, 'aggregate' => ['function' => 'min', 'field' => 'body']], $this->actor())['aggregate']['value']);
        }
        $this->assertSame(['1', '2', '3'], array_column($action->execute($union, $this->actor())['records'], 'id'));
        $this->assertSame(['3', '2', '1'], array_column($action->execute([...$union, 'orderBy' => [['field' => 'body', 'direction' => 'desc']]], $this->actor())['records'], 'id'));
        $inner = [...$base, 'where' => ['kind' => 'comparison', 'field' => 'quantity', 'operator' => '=', 'value' => 4]];
        $inner['unions'] = [['all' => false, 'query' => $inner]];
        $correlation = [['innerField' => 'body', 'outerField' => 'body']];
        $exists = $action->execute([...$base, 'subqueries' => [['kind' => 'exists', 'query' => $inner, 'correlate' => $correlation]]], $this->actor());
        $this->assertSame(['2'], array_column($exists['records'], 'id'));
        $notExists = $action->execute([...$base, 'subqueries' => [['kind' => 'notExists', 'query' => $inner, 'correlate' => $correlation]]], $this->actor());
        $this->assertSame(['1', '3'], array_column($notExists['records'], 'id'));
        $scalar = [...$inner, 'select' => ['body'], 'limit' => 1];
        $scalar['unions'][0]['query']['select'] = ['body'];
        $where = $action->execute([...$base, 'subqueries' => [['kind' => 'where', 'field' => 'body', 'operator' => '=', 'query' => $scalar]]], $this->actor());
        $this->assertSame(['2'], array_column($where['records'], 'id'));
        $projection = $action->execute([...$base, 'subqueries' => [['kind' => 'select', 'alias' => 'matched', 'query' => $scalar, 'correlate' => $correlation]]], $this->actor());
        $this->assertSame('a', $projection['computed']['QualifiedRecord:2']['projections']['matched']);
        $this->assertNull($projection['computed']['QualifiedRecord:1']['projections']['matched']);
        $this->assertNull($projection['computed']['QualifiedRecord:3']['projections']['matched']);
        $average = $action->execute([...$base, 'subqueries' => [['kind' => 'select', 'alias' => 'average', 'query' => [...$inner, 'aggregate' => ['function' => 'avg', 'field' => 'quantity'], 'limit' => 1]]]], $this->actor());
        $this->assertSame(4.0, $average['computed']['QualifiedRecord:1']['projections']['average']);
    }

    public function test_doctor_checks_the_engine_of_qualified_exported_tables(): void
    {
        $usesPostgreSql = DB::connection()->getDriverName() === 'pgsql';
        $this->prepareSource($usesPostgreSql ? 'InnoDB' : 'MyISAM');
        if ($usesPostgreSql) {
            $this->artisan('synloquent:doctor')->assertSuccessful();
        } else {
            $this->artisan('synloquent:doctor')->expectsOutputToContain('must use InnoDB')->assertFailed();
            Schema::drop('qualified_records');
            Schema::create('qualified_records', static function (Blueprint $table): void {
                $table->engine = 'InnoDB';
                $table->id();
                $table->string('body');
                $table->integer('quantity');
            });
            $this->artisan('synloquent:doctor')->assertSuccessful();
        }
    }
}

final class QualifiedRecord extends Model
{
    public function __construct(array $attributes = [])
    {
        parent::__construct($attributes);
        $this->setTable((DB::connection()->getDriverName() === 'pgsql' ? 'public' : DB::connection()->getDatabaseName()).'.qualified_records');
    }
}

final class QualifiedRecordExport extends ExportDefinition
{
    public function name(): string
    {
        return 'QualifiedRecord';
    }

    public function modelClass(): string
    {
        return QualifiedRecord::class;
    }

    public function readable(): array
    {
        return ['id', 'body', 'quantity'];
    }

    public function fields(): array
    {
        return ['id' => ['type' => 'integer', 'nullable' => false], 'body' => ['type' => 'string', 'nullable' => false], 'quantity' => ['type' => 'integer', 'nullable' => false]];
    }

    public function authorize(string $operation, ActorContext $actor, ?Model $model = null): bool
    {
        return true;
    }
}

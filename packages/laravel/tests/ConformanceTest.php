<?php

declare(strict_types=1);

namespace Synloquent\Tests;

use App\Models\Category;
use App\Models\Country;
use App\Models\Image;
use App\Models\Item;
use App\Models\ItemType;
use App\Models\Location;
use App\Models\Note;
use App\Models\Salespoint;
use App\Models\Series;
use App\Models\Tag;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Events\QueryExecuted;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Synloquent\Laravel\Export\ManifestBuilder;
use Synloquent\Laravel\Protocol\CanonicalJson;
use Synloquent\Laravel\Protocol\ProtocolException;
use Synloquent\Laravel\Query\QueryAction;
use Synloquent\Laravel\Sync\CommandAction;
use Synloquent\Laravel\Sync\MutationAction;
use Synloquent\Laravel\Sync\PullAction;
use Synloquent\Laravel\Sync\SnapshotAction;
use Synloquent\Laravel\Sync\WriteContext;
use Synloquent\Laravel\Sync\WriteGateway;

final class ConformanceTest extends TestCase
{
    public function test_grouped_order_pagination_and_boolean_having_preserve_exact_results(): void
    {
        $this->artisan('synloquent:seed-example')->assertSuccessful();
        $action = $this->app->make(QueryAction::class);
        $query = ['model' => 'Item', 'groupBy' => ['active'], 'aggregate' => ['function' => 'sum', 'field' => 'price'], 'orderBy' => [['field' => 'active', 'direction' => 'desc']], 'limit' => 1];
        $this->assertSame([['keys' => ['active' => true], 'value' => '25.00']], $action->execute($query, $this->actor())['aggregate']['groups']);
        $this->assertSame([['keys' => ['active' => false], 'value' => '7.25']], $action->execute([...$query, 'offset' => 1], $this->actor())['aggregate']['groups']);
        $having = ['kind' => 'group', 'boolean' => 'and', 'predicates' => [
            ['kind' => 'comparison', 'field' => 'active', 'operator' => '=', 'value' => true],
            ['kind' => 'not', 'predicate' => ['kind' => 'comparison', 'field' => '$aggregate', 'operator' => '<', 'value' => '20.00']],
        ]];
        $this->assertSame([['keys' => ['active' => true], 'value' => '25.00']], $action->execute([...$query, 'having' => $having], $this->actor())['aggregate']['groups']);
        $this->assertSame([], $action->execute([...$query, 'having' => $having, 'offset' => 1], $this->actor())['aggregate']['groups']);
        try {
            $action->execute([...$query, 'having' => ['kind' => 'comparison', 'field' => 'title', 'operator' => '=', 'value' => 'Alpine stamp']], $this->actor());
            $this->fail('Ungrouped HAVING field was accepted.');
        } catch (ProtocolException $exception) {
            $this->assertSame('unknown_field', $exception->errorCode);
        }
    }

    public function test_registered_expression_binds_jsonb_operator_and_rejects_input_smuggling(): void
    {
        $this->artisan('synloquent:seed-example')->assertSuccessful();
        $queries = [];
        DB::listen(function (QueryExecuted $event) use (&$queries): void {
            $queries[] = ['sql' => $event->sql, 'bindings' => $event->bindings];
        });
        $action = $this->app->make(QueryAction::class);
        $query = ['model' => 'Item', 'scopes' => [['name' => 'metadataContains', 'arguments' => ['value' => ['region' => 'synthetic']]]]];
        $this->assertSame(['1', '2', '3'], array_column($action->execute($query, $this->actor())['records'], 'id'));
        $expression = collect($queries)->first(fn ($query) => str_contains($query['sql'], DB::connection()->getDriverName() === 'pgsql' ? '::jsonb @> ?' : 'json_contains('));
        $this->assertNotNull($expression);
        $this->assertContains('{"region":"synthetic"}', $expression['bindings']);
        $queries = [];
        $injection = "synthetic' OR TRUE --";
        $this->assertSame([], $action->execute(['model' => 'Item', 'scopes' => [['name' => 'metadataContains', 'arguments' => ['value' => ['region' => $injection]]]]], $this->actor())['records']);
        foreach ($queries as $query) {
            $this->assertStringNotContainsString($injection, $query['sql']);
        }
        try {
            $action->execute(['model' => 'Item', 'scopes' => [['name' => 'metadataContains', 'arguments' => ['value' => ['region' => 'synthetic'], 'expression' => 'TRUE']]]], $this->actor());
            $this->fail('Undeclared expression input was accepted.');
        } catch (ProtocolException $exception) {
            $this->assertSame('validation_failed', $exception->errorCode);
        }
    }

    public function test_revision_bound_increment_and_decrement_reject_stale_deltas(): void
    {
        $action = $this->app->make(MutationAction::class);
        $record = $action->execute([$this->operation('delta-parent', 'create', ['title' => 'Delta', 'quantity' => 5])], $this->actor())['receipts'][0]['canonical'];
        $increment = $action->execute([$this->operation('delta-increment', 'increment', ['field' => 'quantity', 'delta' => 2], ['id' => $record['id'], 'expectedRevision' => $record['revision']])], $this->actor())['receipts'][0]['canonical'];
        $this->assertSame(7, $increment['attributes']['quantity']);
        $stale = $action->execute([$this->operation('delta-stale', 'increment', ['field' => 'quantity', 'delta' => -1], ['id' => $record['id'], 'expectedRevision' => $record['revision']])], $this->actor())['receipts'][0];
        $this->assertSame('conflicted', $stale['status']);
        $this->assertSame(7, $stale['canonical']['attributes']['quantity']);
        $decrement = $action->execute([$this->operation('delta-decrement', 'increment', ['field' => 'quantity', 'delta' => -1], ['id' => $record['id'], 'expectedRevision' => $increment['revision']])], $this->actor())['receipts'][0]['canonical'];
        $this->assertSame(6, $decrement['attributes']['quantity']);
        $this->assertSame(6, Item::findOrFail($record['id'])->quantity);
    }

    public function test_complete_sync_and_other_pivot_actions_preserve_hidden_memberships(): void
    {
        $this->artisan('synloquent:seed-example')->assertSuccessful();
        $action = $this->app->make(MutationAction::class);
        $tag = $action->execute([$this->operation('sync-tag', 'create', ['title' => 'Second target'], ['model' => 'Tag'])], $this->actor())['receipts'][0]['canonical'];
        $hidden = $this->app->make(WriteGateway::class)->transaction($this->actor(), function (WriteContext $context): string {
            $tag = Tag::create(['tenant_id' => 2, 'title' => 'Hidden target']);
            $item = Item::findOrFail(1);
            $item->tags()->attach($tag->id, ['position' => 4]);
            $context->captureRelation($item, 'tags');

            return (string) $tag->id;
        });
        $revision = (string) DB::table('synloquent_relation_revisions')->where(['model' => 'Item', 'relation' => 'tags', 'identity' => '1'])->value('revision');
        $base = ['relation' => 'tags', 'action' => 'sync', 'targets' => [$tag['id']], 'expectedRelationRevision' => $revision];
        $guard = $action->execute([$this->operation('sync-incomplete', 'pivot', $base, ['id' => '1'])], $this->actor())['receipts'][0];
        $this->assertSame('conflicted', $guard['status']);
        $sync = $action->execute([$this->operation('sync-complete', 'pivot', [...$base, 'completeSet' => true, 'attributes' => ['position' => 6]], ['id' => '1'])], $this->actor())['receipts'][0];
        $this->assertSame('accepted', $sync['status']);
        $this->assertEqualsCanonicalizing([$tag['id'], $hidden], Item::findOrFail(1)->tags()->allRelatedIds()->map(fn ($identity) => (string) $identity)->all());
        $revision = collect($sync['relationSets'])->firstWhere('relation', 'tags')['revision'];
        $stale = $action->execute([$this->operation('sync-stale', 'pivot', [...$base, 'completeSet' => true], ['id' => '1'])], $this->actor())['receipts'][0];
        $this->assertSame('conflicted', $stale['status']);
        foreach (['syncWithoutDetaching' => ['1'], 'updateExistingPivot' => [$tag['id']], 'toggle' => ['1']] as $pivotAction => $targets) {
            $receipt = $action->execute([$this->operation('pivot-'.$pivotAction, 'pivot', ['relation' => 'tags', 'action' => $pivotAction, 'targets' => $targets, 'attributes' => ['position' => 9], 'expectedRelationRevision' => $revision], ['id' => '1'])], $this->actor())['receipts'][0];
            $this->assertSame('accepted', $receipt['status']);
            $next = collect($receipt['relationSets'])->firstWhere('relation', 'tags');
            $this->assertGreaterThan((int) $revision, (int) $next['revision']);
            $revision = $next['revision'];
            if ($pivotAction === 'syncWithoutDetaching') {
                $this->assertEqualsCanonicalizing(['1', $tag['id'], $hidden], Item::findOrFail(1)->tags()->allRelatedIds()->map(fn ($identity) => (string) $identity)->all());
            }
            if ($pivotAction === 'updateExistingPivot') {
                $this->assertSame(9, DB::table('item_tag')->where(['item_id' => 1, 'tag_id' => $tag['id']])->value('position'));
            }
            if ($pivotAction === 'toggle') {
                $this->assertEqualsCanonicalizing([$tag['id'], $hidden], Item::findOrFail(1)->tags()->allRelatedIds()->map(fn ($identity) => (string) $identity)->all());
            }
        }
    }

    public function test_query_partial_scope_and_snapshot_complete_scope_are_explicit(): void
    {
        $this->artisan('synloquent:seed-example')->assertSuccessful();
        $query = $this->app->make(QueryAction::class)->execute(['model' => 'Item', 'limit' => 1], $this->actor());
        $this->assertCount(1, $query['records']);
        $this->assertSame('partial', $query['completeness']);
        $this->assertSame('query', $query['scope']['dataset']);
        $snapshot = $this->app->make(SnapshotAction::class)->execute('catalog', $this->actor());
        $this->assertSame('complete', $snapshot['scope']['completeness']);
        $this->assertSame('catalog', $snapshot['scope']['dataset']);
        $this->assertSame($query['scope']['authorizationGeneration'], $snapshot['scope']['authorizationGeneration']);
    }

    public function test_command_integer_arguments_accept_safe_and_exact_unsafe_strings(): void
    {
        $this->app->make(WriteGateway::class)->transaction($this->actor(), function (WriteContext $context): void {
            foreach (['106', '9007199254740993'] as $identity) {
                $model = new Item;
                $model->forceFill(['id' => $identity, 'tenant_id' => 1, 'title' => 'Integer '.$identity, 'quantity' => 5])->save();
                $context->capture($model);
            }
        });
        $commands = $this->app->make(CommandAction::class);
        foreach (['106', '9007199254740993'] as $identity) {
            $request = ['name' => 'increaseQuantity', 'operationId' => 'integer-command-'.$identity, 'arguments' => ['item_id' => $identity, 'delta' => 1]];
            $this->assertSame(6, $commands->execute($request, $this->actor())['result']['quantity']);
            $this->assertTrue($commands->execute($request, $this->actor())['replayed']);
            $this->assertSame(6, Item::findOrFail($identity)->quantity);
        }
        $unsafe = $this->app->make(QueryAction::class)->execute(['model' => 'Item', 'where' => ['kind' => 'comparison', 'field' => 'id', 'operator' => '=', 'value' => '9007199254740993']], $this->actor())['records'][0];
        $this->assertSame('9007199254740993', $unsafe['id']);
        $this->assertSame('9007199254740993', $unsafe['attributes']['id']);
        foreach (['-0', '00', '+106', '106.5', '1e2', 'not-an-integer', 9007199254740992] as $invalid) {
            try {
                $commands->execute(['name' => 'increaseQuantity', 'operationId' => 'invalid-integer-'.hash('sha256', serialize($invalid)), 'arguments' => ['item_id' => $invalid, 'delta' => 1]], $this->actor());
                $this->fail('Noncanonical integer was accepted.');
            } catch (ProtocolException $exception) {
                $this->assertSame('validation_failed', $exception->errorCode);
            }
        }
    }

    public function test_custom_string_uuid_and_ulid_identities_are_immutable_after_creation(): void
    {
        $action = $this->app->make(MutationAction::class);
        $query = $this->app->make(QueryAction::class);
        foreach ([['ExternalRecord', 'external_key', 'external:immutable', 'external:renamed'], ['UuidRecord', 'id', (string) Str::uuid(), (string) Str::uuid()], ['UlidRecord', 'id', (string) Str::ulid(), (string) Str::ulid()]] as [$name, $key, $identity, $replacement]) {
            $create = $this->operation('immutable-create-'.$name, 'create', ['title' => 'Stable '.$name, $key => $identity], ['model' => $name]);
            $record = $action->execute([$create], $this->actor())['receipts'][0]['canonical'];
            $this->assertSame($identity, $record['id']);
            $change = $this->operation('immutable-change-'.$name, 'update', [$key => $replacement], ['model' => $name, 'id' => $identity, 'expectedRevision' => $record['revision']]);
            $rejected = $action->execute([$change], $this->actor())['receipts'][0];
            $this->assertSame('rejected', $rejected['status']);
            $this->assertSame('validation_failed', $rejected['error']['code']);
            $this->assertSame($key, $rejected['error']['details']['field']);
            $unchanged = $this->operation('immutable-unchanged-'.$name, 'update', [$key => $identity, 'title' => 'Same identity '.$name], ['model' => $name, 'id' => $identity, 'expectedRevision' => $record['revision']]);
            $accepted = $action->execute([$unchanged], $this->actor())['receipts'][0];
            $this->assertSame('accepted', $accepted['status']);
            $this->assertSame($identity, $accepted['canonical']['id']);
            $rows = $query->execute(['model' => $name], $this->actor())['records'];
            $this->assertCount(1, $rows);
            $this->assertSame($identity, $rows[0]['id']);
            $this->assertSame($identity, DB::table('synloquent_aliases')->where('local_identity', $create['localIdentity'])->value('identity'));
        }
    }

    public function test_tagged_foreign_and_pivot_references_require_creation_dependencies(): void
    {
        $action = $this->app->make(MutationAction::class);
        $parent = $this->operation('causal-parent', 'create', ['title' => 'Causal parent']);
        $parentRecord = $action->execute([$parent], $this->actor())['receipts'][0]['canonical'];
        $tag = $this->operation('causal-tag', 'create', ['title' => 'Causal tag'], ['model' => 'Tag']);
        $tagRecord = $action->execute([$tag], $this->actor())['receipts'][0]['canonical'];
        $this->assertSame('causal-parent', DB::table('synloquent_aliases')->where('local_identity', 'local-causal-parent')->value('operation_id'));
        $reference = ['$ref' => ['model' => 'Item', 'localIdentity' => $parent['localIdentity']]];
        $rejected = $action->execute([$this->operation('causal-child-missing', 'create', ['item_id' => $reference, 'url' => 'https://example.invalid/causal'], ['model' => 'Image'])], $this->actor())['receipts'][0];
        $this->assertSame('causal_dependency', $rejected['error']['code']);
        $accepted = $action->execute([$this->operation('causal-child', 'create', ['item_id' => $reference, 'url' => 'https://example.invalid/causal'], ['model' => 'Image', 'dependsOn' => ['causal-parent']])], $this->actor())['receipts'][0];
        $this->assertSame('accepted', $accepted['status']);
        $this->assertSame((int) $parentRecord['id'], $accepted['canonical']['attributes']['item_id']);
        $values = ['relation' => 'tags', 'action' => 'attach', 'targets' => [['$ref' => ['model' => 'Tag', 'localIdentity' => $tag['localIdentity']]]], 'attributes' => ['position' => 4]];
        $missing = $action->execute([$this->operation('causal-pivot-missing', 'pivot', $values, ['id' => $parentRecord['id']])], $this->actor())['receipts'][0];
        $this->assertSame('causal_dependency', $missing['error']['code']);
        $attached = $action->execute([$this->operation('causal-pivot', 'pivot', $values, ['id' => $parentRecord['id'], 'dependsOn' => ['causal-tag']])], $this->actor())['receipts'][0];
        $this->assertSame('accepted', $attached['status']);
        $this->assertSame($tagRecord['id'], collect($attached['relationSets'])->firstWhere('relation', 'tags')['targets'][0]['id']);
        $foreignActor = $action->execute([$this->operation('causal-foreign-actor', 'create', ['item_id' => $reference, 'url' => 'https://example.invalid/foreign'], ['model' => 'Image', 'dependsOn' => ['causal-parent']])], $this->actor('2'))['receipts'][0];
        $this->assertSame('causal_dependency', $foreignActor['error']['code']);
        $this->assertSame(1, Image::count());
    }

    public function test_language_independent_query_fixture_has_expected_postgresql_results(): void
    {
        $this->artisan('synloquent:seed-example')->assertSuccessful();
        $corpus = json_decode(file_get_contents(dirname(__DIR__, 3).'/protocol/fixtures/query-conformance.json'), true, flags: JSON_THROW_ON_ERROR);
        $query = $this->app->make(QueryAction::class);
        foreach ($corpus['cases'] as $scenario) {
            try {
                $result = $query->execute($scenario['query'], $this->actor());
            } catch (ProtocolException $exception) {
                $this->assertSame($scenario['error'] ?? null, $exception->errorCode, $scenario['name']);

                continue;
            }
            $this->assertArrayNotHasKey('error', $scenario, $scenario['name']);
            if (array_key_exists('aggregate', $scenario)) {
                $this->assertEquals($scenario['aggregate'], $result['aggregate']['value'], $scenario['name']);
            } else {
                $this->assertSame($scenario['identities'], array_column($result['records'], 'id'), $scenario['name']);
            }
        }
    }

    public function test_eloquent_global_scope_and_unregistered_sql_fail_closed(): void
    {
        $this->app->make(WriteGateway::class)->transaction($this->actor(), function (WriteContext $context): void {
            foreach (['Allowed', 'Globally hidden'] as $title) {
                $context->capture(Item::create(['tenant_id' => 1, 'title' => $title, 'metadata' => ['region' => 'synthetic']]));
            }
        });
        $previousScopes = Item::getAllGlobalScopes();
        Item::addGlobalScope('fixture-title', fn (Builder $query) => $query->where('title', 'Allowed'));
        try {
            $action = $this->app->make(QueryAction::class);
            $this->assertSame(['1'], array_column($action->execute(['model' => 'Item'], $this->actor())['records'], 'id'));
            $scoped = $action->execute(['model' => 'Item', 'scopes' => [['name' => 'metadataContains', 'arguments' => ['value' => ['region' => 'synthetic']]]]], $this->actor());
            $this->assertSame(['1'], array_column($scoped['records'], 'id'));
            foreach ([['scopes' => [['name' => 'unregisteredSql', 'arguments' => []]]], ['where' => ['kind' => 'comparison', 'field' => 'title) OR TRUE --', 'operator' => '=', 'value' => 'Allowed']]] as $invalid) {
                try {
                    $action->execute(['model' => 'Item', ...$invalid], $this->actor());
                    $this->fail('Unregistered SQL was accepted.');
                } catch (ProtocolException $exception) {
                    $this->assertContains($exception->errorCode, ['unsupported_query', 'unknown_field']);
                }
            }
            $mutation = $this->app->make(MutationAction::class)->execute([$this->operation('global-hidden-update', 'update', ['title' => 'Forged'], ['id' => '2', 'expectedRevision' => '1'])], $this->actor())['receipts'][0];
            $this->assertSame('forbidden_operation', $mutation['error']['code']);
        } finally {
            Item::setAllGlobalScopes($previousScopes);
        }
        $this->assertSame('Globally hidden', Item::findOrFail(2)->title);
    }

    public function test_standard_casts_defaults_and_timestamps_have_canonical_wire_types(): void
    {
        Carbon::setTestNow('2026-10-02 08:00:00 UTC');
        try {
            $action = $this->app->make(MutationAction::class);
            $record = $action->execute([$this->operation('wire-casts', 'create', ['title' => 'String cast', 'active' => false, 'quantity' => 7, 'price' => '12.34', 'metadata' => ['nested' => [true, 2]], 'status' => 'published', 'published_on' => '2026-10-02', 'released_at' => '2026-10-02T09:10:11.000000Z', 'latitude' => 49.123456])], $this->actor())['receipts'][0]['canonical'];
            $attributes = $record['attributes'];
            $this->assertSame('String cast', $attributes['title']);
            $this->assertFalse($attributes['active']);
            $this->assertSame(7, $attributes['quantity']);
            $this->assertSame('12.34', $attributes['price']);
            $this->assertSame('{"nested":[true,2]}', CanonicalJson::encode($attributes['metadata']));
            $this->assertSame(['nested' => [true, 2]], Item::findOrFail($record['id'])->metadata);
            $this->assertSame('published', $attributes['status']);
            $this->assertSame('2026-10-02', $attributes['published_on']);
            $this->assertSame('2026-10-02T09:10:11.000000Z', $attributes['released_at']);
            $this->assertSame(49.123456, $attributes['latitude']);
            $this->assertSame('2026-10-02T08:00:00.000000Z', $attributes['created_at']);
            $this->assertSame($attributes['created_at'], $attributes['updated_at']);
            $defaults = $action->execute([$this->operation('wire-defaults', 'create', ['title' => 'Defaults'])], $this->actor())['receipts'][0]['canonical']['attributes'];
            $this->assertTrue($defaults['active']);
            $this->assertSame(0, $defaults['quantity']);
            $this->assertSame('0.00', $defaults['price']);
            $this->assertSame('draft', $defaults['status']);
            Carbon::setTestNow('2026-10-02 08:00:01 UTC');
            $touched = $action->execute([$this->operation('wire-touch', 'update', [], ['id' => $record['id'], 'expectedRevision' => $record['revision']])], $this->actor())['receipts'][0]['canonical'];
            $this->assertSame($attributes['created_at'], $touched['attributes']['created_at']);
            $this->assertSame('2026-10-02T08:00:01.000000Z', $touched['attributes']['updated_at']);
        } finally {
            Carbon::setTestNow();
        }
    }

    public function test_materialized_custom_cast_enum_date_float_and_string_identities(): void
    {
        $action = $this->app->make(MutationAction::class);
        $receipt = $action->execute([$this->operation('cast-item', 'create', ['title' => 'Typed stamp', 'catalog_code' => '  xy-12 ', 'status' => 'published', 'published_on' => '2026-10-02', 'released_at' => '2026-10-02T09:10:11.000000Z', 'latitude' => 49.123456])], $this->actor())['receipts'][0];
        $this->assertSame('accepted', $receipt['status'], json_encode($receipt));
        $attributes = $receipt['canonical']['attributes'];
        $this->assertSame('XY-12', $attributes['catalog_code']);
        $this->assertSame('published', $attributes['status']);
        $this->assertSame('Typed stamp / published', $attributes['display_label']);
        $this->assertSame('2026-10-02', $attributes['published_on']);
        $this->assertSame('2026-10-02T09:10:11.000000Z', $attributes['released_at']);
        $this->assertSame(49.123456, $attributes['latitude']);
        $this->assertSame('rejected', $action->execute([$this->operation('readonly', 'update', ['display_label' => 'Forged'], ['id' => $receipt['canonical']['id'], 'expectedRevision' => $receipt['canonical']['revision']])], $this->actor())['receipts'][0]['status']);
        $query = $this->app->make(QueryAction::class);
        $selected = $query->execute(['model' => 'Item', 'select' => ['display_label']], $this->actor())['records'][0]['attributes'];
        $this->assertSame(['id' => 1, 'display_label' => 'Typed stamp / published'], $selected);
        try {
            $query->execute(['model' => 'Item', 'where' => ['kind' => 'comparison', 'field' => 'display_label', 'operator' => '=', 'value' => 'Typed stamp / published']], $this->actor());
            $this->fail('Materialized PHP SQL predicate was accepted.');
        } catch (ProtocolException $exception) {
            $this->assertSame('unsupported_query', $exception->errorCode);
        }
        foreach (['UuidRecord', 'UlidRecord', 'ExternalRecord'] as $model) {
            $values = ['title' => $model];
            if ($model === 'ExternalRecord') {
                $values['external_key'] = 'external:synthetic-42';
            }
            $operation = $this->operation('key-'.$model, 'create', $values, ['model' => $model]);
            $record = $action->execute([$operation], $this->actor())['receipts'][0]['canonical'];
            $this->assertIsString($record['id']);
            if ($model === 'UuidRecord') {
                $this->assertTrue(Str::isUuid($record['id']));
            } elseif ($model === 'UlidRecord') {
                $this->assertTrue(Str::isUlid($record['id']));
            } else {
                $this->assertSame('external:synthetic-42', $record['id']);
            }
            $this->assertSame($record['id'], $action->execute([$operation], $this->actor())['receipts'][0]['canonical']['id']);
            $this->assertCount(1, $query->execute(['model' => $model], $this->actor())['records']);
        }
        $manifest = $this->app->make(ManifestBuilder::class)->build();
        $this->assertFalse($manifest['models']['Item']['fields']['display_label']['writable']);
        $this->assertSame(['draft', 'published'], $manifest['models']['Item']['fields']['status']['enum']);
        $this->assertFalse($manifest['models']['UuidRecord']['incrementing']);
        $this->assertSame('external_key', $manifest['models']['ExternalRecord']['primaryKey']);
    }

    public function test_json_scalar_subset_and_registered_remote_object_scope(): void
    {
        $action = $this->app->make(MutationAction::class);
        foreach ([[true, 1, '1'], ['nested' => ['values' => [false, 2]]], ['region' => 'synthetic'], ['0' => true, 'object' => true]] as $index => $metadata) {
            $action->execute([$this->operation('json-'.$index, 'create', ['title' => 'JSON '.$index, 'metadata' => $metadata])], $this->actor());
        }
        $query = $this->app->make(QueryAction::class);
        $predicate = static fn (string $operator, mixed $value): array => ['model' => 'Item', 'where' => ['kind' => 'comparison', 'field' => 'metadata', 'operator' => $operator, 'value' => $value]];
        $this->assertSame(['1'], array_column($query->execute($predicate('jsonContains', true), $this->actor())['records'], 'id'));
        $this->assertSame(['2'], array_column($query->execute($predicate('jsonPath', ['path' => '$.nested.values[0]', 'value' => false]), $this->actor())['records'], 'id'));
        $this->assertSame(['1'], array_column($query->execute($predicate('jsonPath', ['path' => '$[0]', 'value' => true]), $this->actor())['records'], 'id'));
        $this->assertSame(['3'], array_column($query->execute(['model' => 'Item', 'scopes' => [['name' => 'metadataContains', 'arguments' => ['value' => ['region' => 'synthetic']]]]], $this->actor())['records'], 'id'));
        foreach ([$predicate('jsonContains', ['region' => 'synthetic']), $predicate('jsonPath', ['path' => '$..region', 'value' => 'synthetic'])] as $invalid) {
            try {
                $query->execute($invalid, $this->actor());
                $this->fail('Unsupported JSON query was accepted.');
            } catch (ProtocolException $exception) {
                $this->assertSame('unsupported_query', $exception->errorCode);
            }
        }
        foreach ([[null, true, 1, 'synthetic'], null, []] as $index => $labels) {
            $action->execute([$this->operation('labels-'.$index, 'create', ['title' => 'Labels '.$index, 'labels' => $labels])], $this->actor());
        }
        $labelsQuery = ['model' => 'Item', 'where' => ['kind' => 'comparison', 'field' => 'labels', 'operator' => 'jsonContains', 'value' => null]];
        $this->assertSame(['5'], array_column($query->execute($labelsQuery, $this->actor())['records'], 'id'));
        $labelsQuery['where'] = ['kind' => 'comparison', 'field' => 'labels', 'operator' => 'jsonPath', 'value' => ['path' => '$[0]', 'value' => null]];
        $this->assertSame(['5'], array_column($query->execute($labelsQuery, $this->actor())['records'], 'id'));
        $labelsQuery['where'] = ['kind' => 'comparison', 'field' => 'labels', 'operator' => 'isNull'];
        $this->assertSame(['1', '2', '3', '4', '6'], array_column($query->execute($labelsQuery, $this->actor())['records'], 'id'));
    }

    public function test_soft_delete_restore_force_delete_and_events_preserve_host_behavior(): void
    {
        $item = Item::create(['title' => 'Soft owner', 'tenant_id' => 1]);
        $events = [];
        Note::restoring(function () use (&$events): void {
            $events[] = 'restoring';
        });
        Note::restored(function () use (&$events): void {
            $events[] = 'restored';
        });
        $action = $this->app->make(MutationAction::class);
        $note = $action->execute([$this->operation('soft-create', 'create', ['notable_type' => 'item', 'notable_id' => $item->id, 'body' => 'Soft note'], ['model' => 'Note'])], $this->actor())['receipts'][0]['canonical'];
        $snapshot = $this->app->make(SnapshotAction::class)->execute('catalog', $this->actor());
        $delete = $this->operation('soft-delete', 'delete', [], ['model' => 'Note', 'id' => $note['id'], 'expectedRevision' => $note['revision']]);
        $receipt = $action->execute([$delete], $this->actor())['receipts'][0];
        $this->assertSame('accepted', $receipt['status']);
        $this->assertSame('2', $receipt['canonical']['revision']);
        $this->assertNotNull($receipt['canonical']['attributes']['deleted_at']);
        $this->assertSame(CanonicalJson::encode($receipt), CanonicalJson::encode($action->execute([$delete], $this->actor())['receipts'][0]));
        $pull = $this->app->make(PullAction::class)->execute($snapshot['cursor'], 'catalog', $this->actor());
        $this->assertSame('upsert', $pull['batches'][0]['changes'][0]['kind']);
        $this->assertNotNull($pull['batches'][0]['changes'][0]['record']['attributes']['deleted_at']);
        $trashedSnapshot = $this->app->make(SnapshotAction::class)->execute('catalog', $this->actor());
        $trashed = collect($trashedSnapshot['records'])->firstWhere('model', 'Note');
        $this->assertSame('2', $trashed['revision']);
        $this->assertNotNull($trashed['attributes']['deleted_at']);
        $query = $this->app->make(QueryAction::class);
        $this->assertSame([], $query->execute(['model' => 'Note'], $this->actor())['records']);
        $this->assertCount(1, $query->execute(['model' => 'Note', 'trashed' => 'only'], $this->actor())['records']);
        $restored = $action->execute([$this->operation('soft-restore', 'restore', [], ['model' => 'Note', 'id' => $note['id'], 'expectedRevision' => '2'])], $this->actor())['receipts'][0]['canonical'];
        $this->assertSame(['restoring', 'restored'], $events);
        $this->assertNull($restored['attributes']['deleted_at']);
        $this->assertSame('accepted', $action->execute([$this->operation('soft-force', 'forceDelete', [], ['model' => 'Note', 'id' => $note['id'], 'expectedRevision' => $restored['revision']])], $this->actor())['receipts'][0]['status']);
        $this->assertSame(0, Note::withTrashed()->count());
        Note::flushEventListeners();
    }

    public function test_complete_demonstrator_resources_ordered_pivot_with_own_identity(): void
    {
        $country = Country::create(['title' => 'Synthetic country', 'tenant_id' => 1]);
        $type = ItemType::create(['title' => 'Synthetic type', 'tenant_id' => 1]);
        $series = Series::create(['title' => 'Synthetic series', 'tenant_id' => 1]);
        $location = Location::create(['title' => 'Synthetic location', 'tenant_id' => 1, 'country_id' => $country->id]);
        $shop = Salespoint::create(['title' => 'Synthetic salespoint', 'tenant_id' => 1, 'location_id' => $location->id]);
        $action = $this->app->make(MutationAction::class);
        $item = $action->execute([$this->operation('demo-item', 'create', ['title' => 'Complete demo item', 'item_type_id' => $type->id, 'series_id' => $series->id, 'location_id' => $location->id])], $this->actor())['receipts'][0]['canonical'];
        $receipt = $action->execute([$this->operation('demo-pivot', 'pivot', ['relation' => 'salespoints', 'action' => 'attach', 'targets' => [(string) $shop->id], 'attributes' => ['position' => 4]], ['id' => $item['id']])], $this->actor())['receipts'][0];
        $set = collect($receipt['relationSets'])->firstWhere('relation', 'salespoints');
        $this->assertSame(1, $set['targets'][0]['attributes']['id']);
        $this->assertSame(4, $set['targets'][0]['attributes']['position']);
        $result = $this->app->make(QueryAction::class)->execute(['model' => 'Item', 'include' => ['itemType' => [], 'series' => [], 'location' => ['include' => ['country' => []]], 'salespoints' => []]], $this->actor());
        $this->assertSame(['Country', 'ItemType', 'Location', 'Salespoint', 'Series'], collect($result['related'])->pluck('model')->sort()->values()->all());
    }

    public function test_integer_parent_child_aliases_replay_and_query_relations(): void
    {
        $mutations = $this->app->make(MutationAction::class);
        $parent = $this->operation('parent', 'create', ['title' => 'Parent', 'price' => '12.50', 'active' => true, 'quantity' => 2]);
        $child = $this->operation('child', 'create', ['item_id' => ['$ref' => ['model' => 'Item', 'localIdentity' => 'local-parent']], 'url' => 'https://example.invalid/image'], ['model' => 'Image', 'dependsOn' => ['parent']]);
        $receipts = $mutations->execute([$parent, $child], $this->actor())['receipts'];
        $this->assertSame(['accepted', 'accepted'], array_column($receipts, 'status'));
        $identity = $receipts[0]['canonical']['id'];
        $this->assertSame((int) $identity, $receipts[1]['canonical']['attributes']['item_id']);
        $mutations->execute([$parent], $this->actor());
        $this->assertSame(1, Item::count());
        $result = $this->app->make(QueryAction::class)->execute(['model' => 'Item', 'where' => ['kind' => 'comparison', 'field' => 'price', 'operator' => '>=', 'value' => '12.50'], 'include' => ['images' => []]], $this->actor());
        $this->assertSame('12.50', $result['records'][0]['attributes']['price']);
        $this->assertTrue($result['records'][0]['attributes']['active']);
        $this->assertCount(1, $result['related']);
        $this->assertSame('Image', $result['related'][0]['model']);
    }

    public function test_group_column_range_and_null_predicates_are_bound(): void
    {
        $this->app->make(WriteGateway::class)->transaction($this->actor(), function (WriteContext $context): void {
            foreach ([['A', '1.00', 1], ['B', '2.50', 2], ['C', '3.00', 3]] as [$title, $price, $quantity]) {
                $context->capture(Item::create(['tenant_id' => 1, 'title' => $title, 'price' => $price, 'quantity' => $quantity]));
            }
        });
        $action = $this->app->make(QueryAction::class);
        $query = ['model' => 'Item', 'where' => ['kind' => 'group', 'boolean' => 'and', 'predicates' => [['kind' => 'comparison', 'field' => 'price', 'operator' => 'between', 'value' => ['1.00', '2.50']], ['kind' => 'comparison', 'field' => 'category_id', 'operator' => 'isNull']]], 'orderBy' => [['field' => 'price', 'direction' => 'desc']]];
        $result = $action->execute($query, $this->actor());
        $this->assertSame(['B', 'A'], array_column(array_column($result['records'], 'attributes'), 'title'));
        $query['where'] = ['kind' => 'comparison', 'field' => 'title', 'operator' => '=', 'value' => "A' OR 1=1 --"];
        $this->assertCount(0, $action->execute($query, $this->actor())['records']);
    }

    public function test_pivot_mutation_receipt_snapshot_pull_and_relation_conflict(): void
    {
        $action = $this->app->make(MutationAction::class);
        $parent = $action->execute([$this->operation('item', 'create', ['title' => 'Pivot owner'])], $this->actor())['receipts'][0]['canonical'];
        $tag = $action->execute([$this->operation('tag', 'create', ['title' => 'Pivot target'], ['model' => 'Tag'])], $this->actor())['receipts'][0]['canonical'];
        $snapshot = $this->app->make(SnapshotAction::class)->execute('catalog', $this->actor());
        $attach = $this->operation('attach', 'pivot', ['relation' => 'tags', 'action' => 'attach', 'targets' => [$tag['id']], 'attributes' => ['position' => 3]], ['id' => $parent['id']]);
        $receipt = $action->execute([$attach], $this->actor())['receipts'][0];
        $this->assertSame('accepted', $receipt['status']);
        $this->assertSame('1', $receipt['relationSets'][0]['revision']);
        $this->assertSame(3, $receipt['relationSets'][0]['targets'][0]['attributes']['position']);
        $pull = $this->app->make(PullAction::class)->execute($snapshot['cursor'], 'catalog', $this->actor());
        $this->assertCount(2, $pull['batches'][0]['relationSets']);
        $this->assertSame('1', $pull['batches'][0]['relationSets'][1]['revision']);
        $stale = $this->operation('stale-pivot', 'pivot', ['relation' => 'tags', 'action' => 'sync', 'targets' => [], 'completeSet' => true, 'expectedRelationRevision' => '0'], ['id' => $parent['id']]);
        $this->assertSame('conflicted', $action->execute([$stale], $this->actor())['receipts'][0]['status']);
        $detach = $this->operation('detach', 'pivot', ['relation' => 'tags', 'action' => 'detach', 'targets' => [$tag['id']]], ['id' => $parent['id']]);
        $receipt = $action->execute([$detach], $this->actor())['receipts'][0];
        $this->assertSame('accepted', $receipt['status'], json_encode($receipt));
        $this->assertSame([], $receipt['relationSets'][0]['targets']);
    }

    public function test_remote_aggregate_group_having_registered_scope_and_command(): void
    {
        $action = $this->app->make(MutationAction::class);
        foreach ([['A', '1.00', true], ['B', '2.50', true], ['C', '3.00', false]] as $index => [$title, $price, $active]) {
            $action->execute([$this->operation('aggregate-'.$index, 'create', ['title' => $title, 'price' => $price, 'active' => $active])], $this->actor());
        }
        $query = $this->app->make(QueryAction::class);
        $this->assertSame(3, $query->execute(['model' => 'Item', 'aggregate' => ['function' => 'count']], $this->actor())['aggregate']['value']);
        $this->assertSame('6.50', $query->execute(['model' => 'Item', 'aggregate' => ['function' => 'sum', 'field' => 'price']], $this->actor())['aggregate']['value']);
        $grouped = $query->execute(['model' => 'Item', 'aggregate' => ['function' => 'count'], 'groupBy' => ['active'], 'having' => ['kind' => 'comparison', 'field' => '$aggregate', 'operator' => '>', 'value' => 1]], $this->actor());
        $this->assertSame([['keys' => ['active' => true], 'value' => 2]], $grouped['aggregate']['groups']);
        $scoped = $query->execute(['model' => 'Item', 'scopes' => [['name' => 'activePriced', 'arguments' => ['minimumPrice' => '2.00']]]], $this->actor());
        $this->assertSame('B', $scoped['records'][0]['attributes']['title']);
        $command = $this->app->make(CommandAction::class);
        $request = ['name' => 'increaseQuantity', 'operationId' => 'quantity-command', 'arguments' => ['item_id' => 1, 'delta' => 4]];
        $this->assertSame(4, $command->execute($request, $this->actor())['result']['quantity']);
        $this->assertSame(4, $command->execute($request, $this->actor())['result']['quantity']);
        $this->assertSame(4, Item::find(1)->quantity);
        $this->assertSame(1, DB::table('synloquent_effects')->count());
    }

    public function test_declared_joins_subqueries_unions_and_relation_aggregates(): void
    {
        $category = Category::create(['title' => 'Joined category', 'tenant_id' => 1]);
        $this->app->make(WriteGateway::class)->transaction($this->actor(), function (WriteContext $context) use ($category): void {
            foreach (['One', 'Two'] as $title) {
                $item = Item::create(['title' => $title, 'tenant_id' => 1, 'category_id' => $category->id]);
                $context->capture($item);
            }
            $context->capture(Image::create(['item_id' => 1, 'tenant_id' => 1, 'url' => 'https://example.invalid/one']));
        });
        $action = $this->app->make(QueryAction::class);
        $join = ['model' => 'Item', 'joins' => [['type' => 'inner', 'model' => 'Category', 'alias' => 'categories_joined', 'on' => [['field' => 'category_id', 'otherField' => 'id']]]], 'joinedWhere' => [['alias' => 'categories_joined', 'predicate' => ['kind' => 'comparison', 'field' => 'title', 'operator' => '=', 'value' => 'Joined category']]]];
        $this->assertCount(2, $action->execute($join, $this->actor())['records']);
        $subquery = ['model' => 'Image', 'select' => ['url'], 'limit' => 1];
        $selected = $action->execute(['model' => 'Item', 'subqueries' => [['kind' => 'select', 'alias' => 'first_url', 'query' => $subquery, 'correlate' => [['innerField' => 'item_id', 'outerField' => 'id']]]]], $this->actor());
        $this->assertSame('https://example.invalid/one', $selected['computed']['Item:1']['projections']['first_url']);
        $this->assertNull($selected['computed']['Item:2']['projections']['first_url']);
        $exists = $action->execute(['model' => 'Item', 'subqueries' => [['kind' => 'exists', 'query' => ['model' => 'Image'], 'correlate' => [['innerField' => 'item_id', 'outerField' => 'id']]]]], $this->actor());
        $this->assertSame('One', $exists['records'][0]['attributes']['title']);
        $predicate = fn ($title) => ['kind' => 'comparison', 'field' => 'title', 'operator' => '=', 'value' => $title];
        $union = $action->execute(['model' => 'Item', 'where' => $predicate('One'), 'unions' => [['all' => false, 'query' => ['model' => 'Item', 'where' => $predicate('Two')]]]], $this->actor());
        $this->assertCount(2, $union['records']);
        $aggregated = $action->execute(['model' => 'Item', 'relationAggregates' => [['relation' => 'images', 'function' => 'count'], ['relation' => 'images', 'function' => 'exists']]], $this->actor());
        $this->assertSame(1, $aggregated['computed']['Item:1']['aggregates']['images_count']);
        $this->assertTrue($aggregated['computed']['Item:1']['aggregates']['images_exists']);
        $this->assertSame(0, $aggregated['computed']['Item:2']['aggregates']['images_count']);
    }

    public function test_distinct_projection_and_eager_select_retain_association_keys(): void
    {
        $this->artisan('synloquent:seed-example')->assertSuccessful();
        $query = $this->app->make(QueryAction::class);
        $distinct = $query->execute(['model' => 'Item', 'select' => ['price'], 'distinct' => true], $this->actor());
        $this->assertSame(['1', '2'], array_column($distinct['records'], 'id'));
        $this->assertSame(['12.50', '7.25'], array_column(array_column($distinct['records'], 'attributes'), 'price'));
        $eager = $query->execute(['model' => 'Item', 'include' => ['images' => ['select' => ['url']]]], $this->actor());
        $this->assertSame(1, $eager['related'][0]['attributes']['item_id']);
        $this->assertSame('https://example.invalid/stamp-0.jpg', $eager['related'][0]['attributes']['url']);
        $through = $query->execute(['model' => 'Category', 'include' => ['imagesThrough' => ['select' => ['url']]]], $this->actor());
        $intermediates = array_filter($through['related'], fn ($record) => $record['model'] === 'Item');
        $this->assertCount(3, $intermediates);
        foreach ($intermediates as $record) {
            $this->assertSame(1, $record['attributes']['category_id']);
        }
    }

    public function test_where_morph_relation_checks_each_declared_target_scope(): void
    {
        $this->artisan('synloquent:seed-example')->assertSuccessful();
        $query = $this->app->make(QueryAction::class);
        foreach ([['Item', 'Alpine stamp', '1'], ['Category', 'Mountains', '2']] as [$target, $title, $identity]) {
            $predicate = ['kind' => 'relation', 'relation' => 'notable', 'morphModels' => [$target], 'predicate' => ['kind' => 'comparison', 'field' => 'title', 'operator' => '=', 'value' => $title]];
            $this->assertSame([$identity], array_column($query->execute(['model' => 'Note', 'where' => $predicate], $this->actor())['records'], 'id'));
        }
        Category::find(1)->update(['tenant_id' => 2]);
        $scoped = $query->execute(['model' => 'Note', 'where' => ['kind' => 'relation', 'relation' => 'notable', 'morphModels' => ['Category']]], $this->actor());
        $this->assertSame([], $scoped['records']);
        $this->expectException(ProtocolException::class);
        $query->execute(['model' => 'Note', 'where' => ['kind' => 'relation', 'relation' => 'notable', 'morphModels' => ['User']]], $this->actor());
    }

    public function test_unsafe_integer_and_decimal_aggregates_keep_exact_wire_values(): void
    {
        DB::connection()->getSchemaBuilder()->table('items', static fn (Blueprint $table) => $table->bigInteger('quantity')->default(0)->change());
        foreach (range(1, 3) as $identity) {
            Item::create(['tenant_id' => 1, 'title' => 'Exact '.$identity, 'quantity' => 4503599627370496, 'price' => '0.10', 'active' => true]);
        }
        $query = $this->app->make(QueryAction::class);
        $this->assertSame('13510798882111488', $query->execute(['model' => 'Item', 'aggregate' => ['function' => 'sum', 'field' => 'quantity']], $this->actor())['aggregate']['value']);
        $this->assertSame('4503599627370496', $query->execute(['model' => 'Item', 'aggregate' => ['function' => 'avg', 'field' => 'quantity']], $this->actor())['aggregate']['value']);
        $groups = $query->execute(['model' => 'Item', 'aggregate' => ['function' => 'sum', 'field' => 'quantity'], 'groupBy' => ['active']], $this->actor());
        $this->assertSame('13510798882111488', $groups['aggregate']['groups'][0]['value']);
        $averages = $query->execute(['model' => 'Item', 'aggregate' => ['function' => 'avg', 'field' => 'quantity'], 'groupBy' => ['active']], $this->actor());
        $this->assertSame('4503599627370496', $averages['aggregate']['groups'][0]['value']);
        $threshold = $query->execute(['model' => 'Item', 'aggregate' => ['function' => 'sum', 'field' => 'quantity'], 'groupBy' => ['active'], 'having' => ['kind' => 'comparison', 'field' => '$aggregate', 'operator' => '>', 'value' => '13510798882111487']], $this->actor());
        $this->assertCount(1, $threshold['aggregate']['groups']);
        $this->assertSame('0.30', $query->execute(['model' => 'Item', 'aggregate' => ['function' => 'sum', 'field' => 'price']], $this->actor())['aggregate']['value']);
        $this->assertSame('0.10', $query->execute(['model' => 'Item', 'aggregate' => ['function' => 'avg', 'field' => 'price']], $this->actor())['aggregate']['value']);
        foreach (['sum' => '0.30', 'avg' => '0.10'] as $function => $value) {
            $this->assertSame($value, $query->execute(['model' => 'Item', 'aggregate' => ['function' => $function, 'field' => 'price'], 'groupBy' => ['active']], $this->actor())['aggregate']['groups'][0]['value']);
        }
        $subquery = ['kind' => 'select', 'alias' => 'quantity_total', 'query' => ['model' => 'Item', 'aggregate' => ['function' => 'sum', 'field' => 'quantity'], 'limit' => 1]];
        $scalar = $query->execute(['model' => 'Item', 'limit' => 1, 'subqueries' => [$subquery]], $this->actor());
        $this->assertSame('13510798882111488', $scalar['computed']['Item:1']['projections']['quantity_total']);
    }

    public function test_through_polymorphic_eager_loading_and_metadata_families(): void
    {
        $category = Category::create(['title' => 'Through', 'tenant_id' => 1]);
        $item = Item::create(['title' => 'Morph owner', 'tenant_id' => 1, 'category_id' => $category->id]);
        Image::create(['item_id' => $item->id, 'tenant_id' => 1, 'url' => 'https://example.invalid/through']);
        $note = Note::create(['tenant_id' => 1, 'notable_type' => 'item', 'notable_id' => $item->id, 'body' => 'Portable note']);
        $query = $this->app->make(QueryAction::class);
        $through = $query->execute(['model' => 'Category', 'include' => ['imagesThrough' => [], 'firstImageThrough' => []]], $this->actor());
        $this->assertSame('https://example.invalid/through', $through['related'][0]['attributes']['url']);
        $morph = $query->execute(['model' => 'Note', 'include' => ['notable' => []]], $this->actor());
        $this->assertSame('Item', $morph['related'][0]['model']);
        $owner = $query->execute(['model' => 'Item', 'include' => ['notes' => [], 'firstNote' => []]], $this->actor());
        $this->assertSame((string) $note->id, $owner['related'][0]['id']);
        $manifest = $this->app->make(ManifestBuilder::class)->build();
        $this->assertSame('Item', $manifest['models']['Category']['relations']['imagesThrough']['through']);
        $this->assertSame('item_id', $manifest['models']['Category']['relations']['imagesThrough']['secondKey']);
        $this->assertSame(['item' => 'Item', 'category' => 'Category'], $manifest['models']['Note']['relations']['notable']['morphMap']);
        $this->assertSame('morphToMany', $manifest['models']['Item']['relations']['classifications']['type']);
        $this->assertSame('morphedByMany', $manifest['models']['Tag']['relations']['classifiedItems']['type']);
        $this->assertSame('cascade', $manifest['models']['Image']['relations']['item']['onDelete']);
    }
}

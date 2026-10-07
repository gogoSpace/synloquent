<?php

declare(strict_types=1);

namespace Synloquent\Tests;

use App\Models\ExternalRecord;
use App\Models\Item;
use App\Models\Note;
use Illuminate\Database\QueryException;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;
use Synloquent\Laravel\Query\QueryAction;
use Synloquent\Laravel\Sync\MembershipIndex;
use Synloquent\Laravel\Sync\MutationAction;
use Synloquent\Laravel\Sync\RevisionStore;
use Synloquent\Laravel\Sync\SnapshotAction;
use Synloquent\Laravel\Sync\WriteContext;
use Synloquent\Laravel\Sync\WriteGateway;

final class DatabaseCompatibilityTest extends TestCase
{
    public function test_receipts_aliases_revisions_and_effect_keys_preserve_case_and_trailing_spaces(): void
    {
        $action = $this->app->make(MutationAction::class);
        foreach (['Operation', 'operation', 'operation '] as $index => $identity) {
            $receipt = $action->execute([$this->operation($identity, 'create', ['title' => 'Identity '.$index])], $this->actor())['receipts'][0];
            $this->assertSame('accepted', $receipt['status'], json_encode($receipt, JSON_THROW_ON_ERROR));
            $this->assertEquals($receipt, $action->execute([$this->operation($identity, 'create', ['title' => 'Identity '.$index])], $this->actor())['receipts'][0]);
        }
        $this->assertSame(3, DB::table('synloquent_receipts')->count());
        $this->assertSame(3, DB::table('synloquent_aliases')->count());
        $this->app->make(WriteGateway::class)->transaction($this->actor(), function (WriteContext $context): void {
            foreach (['Record', 'record', 'record '] as $identity) {
                $model = new ExternalRecord;
                $model->setAttribute('external_key', $identity);
                $model->setAttribute('title', $identity);
                $model->setAttribute('tenant_id', 1);
                $model->save();
                $context->capture($model);
                $context->effect('quantityChanged', $identity, ['quantity' => 1]);
            }
        });
        $this->assertSame(3, ExternalRecord::count());
        $this->assertSame(3, DB::table('synloquent_effects')->count());
        $revisions = $this->app->make(RevisionStore::class);
        $this->assertSame('2', $revisions->advance($this->actor()->stream(), 'ExternalRecord', 'record'));
        $this->assertSame('1', $revisions->get($this->actor()->stream(), 'ExternalRecord', 'Record'));
        $this->assertSame('1', $revisions->get($this->actor()->stream(), 'ExternalRecord', 'record '));
    }

    public function test_text_comparison_grouping_distinct_and_aggregates_ignore_host_collation(): void
    {
        $item = Item::create(['title' => 'Text parent', 'tenant_id' => 1]);
        foreach (['A', 'a', 'a ', 'á'] as $body) {
            Note::create(['tenant_id' => 1, 'notable_type' => 'item', 'notable_id' => $item->id, 'body' => $body]);
        }
        $action = $this->app->make(QueryAction::class);
        $definition = ['model' => 'Note', 'orderBy' => [['field' => 'body', 'direction' => 'asc']]];
        $this->assertSame(['A', 'a', 'a ', 'á'], array_column(array_column($action->execute($definition, $this->actor())['records'], 'attributes'), 'body'));
        $groups = $action->execute([...$definition, 'groupBy' => ['body'], 'aggregate' => ['function' => 'count']], $this->actor())['aggregate']['groups'];
        $this->assertSame(['A', 'a', 'a ', 'á'], array_column(array_column($groups, 'keys'), 'body'));
        $this->assertSame([1, 1, 1, 1], array_column($groups, 'value'));
        $filteredGroups = $action->execute([...$definition, 'groupBy' => ['body'], 'aggregate' => ['function' => 'count'], 'having' => ['kind' => 'comparison', 'field' => 'body', 'operator' => '=', 'value' => 'a ']], $this->actor())['aggregate']['groups'];
        $this->assertSame(['a '], array_column(array_column($filteredGroups, 'keys'), 'body'));
        $this->assertCount(4, $action->execute([...$definition, 'select' => ['body'], 'distinct' => true], $this->actor())['records']);
        foreach (['min' => 'A', 'max' => 'á'] as $function => $expected) {
            $this->assertSame($expected, $action->execute(['model' => 'Note', 'aggregate' => ['function' => $function, 'field' => 'body']], $this->actor())['aggregate']['value']);
        }
        $selected = $action->execute([...$definition, 'where' => ['kind' => 'comparison', 'field' => 'body', 'operator' => '=', 'value' => 'a ']], $this->actor());
        $this->assertSame(['3'], array_column($selected['records'], 'id'));
        $singleCharacters = $action->execute([...$definition, 'where' => ['kind' => 'comparison', 'field' => 'body', 'operator' => 'like', 'value' => '_']], $this->actor());
        $this->assertSame(['1', '2', '4'], array_column($singleCharacters['records'], 'id'));
    }

    public function test_text_unions_joins_correlations_and_scalar_subqueries_use_exact_comparisons(): void
    {
        $item = Item::create(['title' => 'Text parent', 'tenant_id' => 1]);
        foreach (['A', 'a', 'a ', 'á'] as $body) {
            Note::create(['tenant_id' => 1, 'notable_type' => 'item', 'notable_id' => $item->id, 'body' => $body]);
        }
        $action = $this->app->make(QueryAction::class);
        $predicate = static fn (string $value): array => ['kind' => 'comparison', 'field' => 'body', 'operator' => '=', 'value' => $value];
        $joined = $action->execute(['model' => 'Note', 'joins' => [['type' => 'inner', 'model' => 'Note', 'alias' => 'matched_notes', 'on' => [['field' => 'body', 'otherField' => 'body']]]]], $this->actor());
        $this->assertSame(['1', '2', '3', '4'], array_column($joined['records'], 'id'));
        foreach (['A' => '1', 'a' => '2', 'a ' => '3'] as $body => $identity) {
            $inner = ['model' => 'Note', 'where' => $predicate($body)];
            $correlated = $action->execute(['model' => 'Note', 'subqueries' => [['kind' => 'exists', 'query' => $inner, 'correlate' => [['innerField' => 'body', 'outerField' => 'body']]]]], $this->actor());
            $this->assertSame([$identity], array_column($correlated['records'], 'id'));
            $scalar = $action->execute(['model' => 'Note', 'subqueries' => [['kind' => 'where', 'field' => 'body', 'operator' => '=', 'query' => [...$inner, 'select' => ['body'], 'limit' => 1]]]], $this->actor());
            $this->assertSame([$identity], array_column($scalar['records'], 'id'));
        }
        $union = $action->execute(['model' => 'Note', 'where' => $predicate('A'), 'unions' => [['all' => false, 'query' => ['model' => 'Note']]], 'orderBy' => [['field' => 'body', 'direction' => 'asc']]], $this->actor());
        $this->assertSame(['A', 'a', 'a ', 'á'], array_column(array_column($union['records'], 'attributes'), 'body'));
    }

    public function test_json_membership_and_paths_preserve_exact_top_level_scalar_types(): void
    {
        foreach ([[[1]], [0.0000000000001], [0], [true], ['1'], [null], [1], ['é'], (object) ['value' => null], (object) ['value' => (object) []], (object) ['value' => []]] as $index => $metadata) {
            Item::create(['tenant_id' => 1, 'title' => 'Exact JSON '.$index, 'metadata' => $metadata]);
        }
        $action = $this->app->make(QueryAction::class);
        foreach ([[1, ['7']], [0, ['3']], [true, ['4']], ['1', ['5']], [null, ['6']], ['é', ['8']]] as [$value, $identities]) {
            $result = $action->execute(['model' => 'Item', 'where' => ['kind' => 'comparison', 'field' => 'metadata', 'operator' => 'jsonContains', 'value' => $value]], $this->actor());
            $this->assertSame($identities, array_column($result['records'], 'id'));
        }
        $result = $action->execute(['model' => 'Item', 'where' => ['kind' => 'comparison', 'field' => 'metadata', 'operator' => 'jsonPath', 'value' => ['path' => '$.value', 'value' => null]]], $this->actor());
        $this->assertSame(['9'], array_column($result['records'], 'id'));
    }

    public function test_independent_duplicate_requests_wait_then_publish_only_once(): void
    {
        $this->app->make(WriteGateway::class)->transaction($this->actor(), static fn (): null => null);
        DB::beginTransaction();
        DB::table('synloquent_streams')->where('stream', $this->actor()->stream())->lockForUpdate()->first();
        $workers = [];
        try {
            foreach (range(1, 2) as $index) {
                $worker = $this->worker('duplicate');
                $workers[] = $worker;
                $message = json_decode(fgets($worker['pipes'][1]), true, flags: JSON_THROW_ON_ERROR);
                $this->assertWorkerIdentity($message);
                $deadline = microtime(true) + 5;
                do {
                    $activity = $this->lockActivity($message['backend']);
                    if ($activity?->wait_event_type === 'Lock') {
                        break;
                    }
                    usleep(1000);
                } while (microtime(true) < $deadline);
                $this->assertSame('Lock', $activity?->wait_event_type);
            }
            DB::commit();
            $results = [];
            foreach ($workers as $worker) {
                $message = json_decode(fgets($worker['pipes'][1]), true, flags: JSON_THROW_ON_ERROR);
                $this->assertSame('committed', $message['stage']);
                $this->assertSame('accepted', $message['result']['receipts'][0]['status']);
                $results[] = $message['result']['receipts'][0];
            }
            $this->assertEquals($results[0], $results[1]);
            $this->assertSame(1, Item::count());
            $this->assertSame(1, DB::table('synloquent_receipts')->count());
            $this->assertSame(1, DB::table('synloquent_publications')->count());
            $this->assertSame('1', (string) DB::table('synloquent_revisions')->value('revision'));
        } finally {
            if (DB::transactionLevel() !== 0) {
                DB::rollBack();
            }
            foreach ($workers as $worker) {
                $this->closeWorker($worker);
            }
        }
    }

    public function test_signed_integer_bounds_and_utc_timestamps_remain_exact(): void
    {
        Schema::table('items', static function (Blueprint $table): void {
            $table->bigInteger('quantity')->default(0)->change();
        });
        $mutations = $this->app->make(MutationAction::class);
        foreach (['-9223372036854775808', '9223372036854775807'] as $index => $quantity) {
            $receipt = $mutations->execute([$this->operation('signed-bound-'.$index, 'create', ['title' => 'Signed bound '.$index, 'quantity' => $quantity, 'released_at' => '2026-10-07T12:30:45.000000Z'])], $this->actor())['receipts'][0];
            $this->assertSame('accepted', $receipt['status'], json_encode($receipt, JSON_THROW_ON_ERROR));
            $this->assertSame($quantity, $receipt['canonical']['attributes']['quantity']);
            $this->assertSame('2026-10-07T12:30:45.000000Z', $receipt['canonical']['attributes']['released_at']);
            $records = $this->app->make(QueryAction::class)->execute(['model' => 'Item', 'where' => ['kind' => 'comparison', 'field' => 'quantity', 'operator' => '=', 'value' => $quantity]], $this->actor())['records'];
            $this->assertCount(1, $records);
            $this->assertSame($quantity, $records[0]['attributes']['quantity']);
        }
    }

    public function test_large_snapshot_storage_keeps_exact_bytes_and_hash(): void
    {
        $this->app->make(WriteGateway::class)->transaction($this->actor(), function (WriteContext $context): void {
            $context->capture(Item::create(['tenant_id' => 1, 'title' => 'Large JSON', 'metadata' => ['payload' => str_repeat('abcdef', 20000)]]));
        });
        $snapshot = $this->app->make(SnapshotAction::class)->execute('catalog', $this->actor());
        $stored = DB::table('synloquent_snapshots')->where('hash', $snapshot['hash'])->first();
        $this->assertGreaterThan(65535, strlen($stored->document));
        $this->assertSame($snapshot['hash'], hash('sha256', $stored->document));
        $this->assertSame($snapshot['byteSize'], strlen($stored->document));
        $this->assertSame(str_repeat('abcdef', 20000), json_decode($stored->document, true, flags: JSON_THROW_ON_ERROR)['records'][0]['attributes']['metadata']['payload']);
    }

    public function test_failed_repeat_membership_initialization_cleans_temporary_table_without_committing(): void
    {
        $gateway = $this->app->make(WriteGateway::class);
        $memberships = $this->app->make(MembershipIndex::class);
        $scope = hash('sha256', 'temporary-membership');
        $gateway->transaction($this->actor(), fn () => $memberships->initializeStream([], $scope, $this->actor()->stream(), 0));
        $temporaryTable = null;
        $prefix = preg_quote(DB::connection()->getTablePrefix(), '/');
        DB::listen(static function ($event) use (&$temporaryTable, $prefix): void {
            if (preg_match('/create temporary table ["`]?'.$prefix.'(__synloquent_seen_[a-f0-9]+)/i', $event->sql, $matches)) {
                $temporaryTable = $matches[1];
            }
        });
        try {
            $gateway->transaction($this->actor(), function (WriteContext $context) use ($memberships, $scope): void {
                $context->capture(Item::create(['title' => 'Must roll back', 'tenant_id' => 1]));
                $broken = (static function (): \Generator {
                    throw new \RuntimeException('Injected membership failure');
                    yield [];
                })();
                $memberships->initializeStream($broken, $scope, $this->actor()->stream(), 1);
            });
            $this->fail('The injected failure was swallowed.');
        } catch (\RuntimeException $exception) {
            $this->assertSame('Injected membership failure', $exception->getMessage());
        }
        $this->assertSame(0, Item::count());
        $this->assertSame(0, DB::table('synloquent_publications')->count());
        $this->assertSame(0, DB::table('synloquent_revisions')->count());
        $this->assertNotNull($temporaryTable);
        $this->expectException(QueryException::class);
        DB::table($temporaryTable)->count();
    }
}

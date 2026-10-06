<?php

declare(strict_types=1);

namespace Synloquent\Tests;

use App\Enums\ItemStatus;
use App\Models\Item;
use App\Models\Note;
use App\Models\Tag;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;
use Illuminate\Support\Str;
use RuntimeException;
use Synloquent\Laravel\Export\ExportRegistry;
use Synloquent\Laravel\Protocol\ProtocolException;
use Synloquent\Laravel\Sync\RevisionStore;
use Synloquent\Laravel\Sync\WriteContext;
use Synloquent\Laravel\Sync\WriteGateway;

final class WriteContextTest extends TestCase
{
    public function test_save_preserves_casts_and_exact_instance_event_order_in_one_publication(): void
    {
        $events = [];
        foreach (['saving', 'creating', 'created', 'saved', 'updating', 'updated'] as $event) {
            $this->app['events']->listen('eloquent.'.$event.': '.Item::class, static function () use (&$events, $event): void {
                $events[] = $event;
            });
        }
        $item = new Item(['tenant_id' => 1, 'title' => 'Created through context', 'price' => '12.34', 'status' => 'published', 'metadata' => (object) ['nested' => (object) []]]);
        $gateway = $this->app->make(WriteGateway::class);
        $gateway->transaction($this->actor(), function (WriteContext $context) use ($item): void {
            $this->assertSame(1, DB::transactionLevel());
            $this->assertTrue($context->save($item, ['touch' => false]));
            $item->title = 'Updated through context';
            $this->assertTrue($context->save($item));
            $this->assertSame(1, DB::transactionLevel());
        });
        $this->assertSame(['saving', 'creating', 'created', 'saved', 'saving', 'updating', 'updated', 'saved'], $events);
        $this->assertSame(ItemStatus::Published, $item->status);
        $this->assertSame('12.34', $item->price);
        $this->assertSame('2', $this->revision('Item', $item->id));
        $this->assertSame(1, DB::table('synloquent_publications')->count());
        $journal = $this->journal();
        $this->assertCount(1, $journal);
        $this->assertSame('Updated through context', $journal[0]['record']['attributes']['title']);
        $objectJournal = json_decode(DB::table('synloquent_publications')->value('changes'), flags: JSON_THROW_ON_ERROR);
        $this->assertInstanceOf(\stdClass::class, $objectJournal[0]->record->attributes->metadata->nested);
    }

    public function test_cancelled_save_rolls_back_observer_capture_effects_and_retains_earlier_callback_work(): void
    {
        $blocked = Item::create(['tenant_id' => 1, 'title' => 'Original blocked item']);
        $gateway = $this->app->make(WriteGateway::class);
        $gateway->transaction($this->actor(), fn (WriteContext $context) => $context->capture($blocked));
        $activeContext = null;
        $events = [];
        $this->app['events']->listen('eloquent.saving: '.Item::class, static function (Item $model) use ($blocked, &$activeContext, &$events): ?bool {
            if ($model->id !== $blocked->id) {
                return null;
            }
            $events[] = 'saving';
            DB::table('items')->where('id', $model->id)->update(['title' => 'Observer database write']);
            $activeContext->capture($model);
            $activeContext->effect('quantityChanged', 'cancelled-save', ['quantity' => 9]);

            return false;
        });
        $this->app['events']->listen('eloquent.saved: '.Item::class, static function (Item $model) use ($blocked, &$events): void {
            if ($model->id === $blocked->id) {
                $events[] = 'saved';
            }
        });
        $earlier = new Item(['tenant_id' => 1, 'title' => 'Earlier successful work']);
        $gateway->transaction($this->actor(), function (WriteContext $context) use (&$activeContext, $blocked, $earlier): void {
            $activeContext = $context;
            $this->assertTrue($context->save($earlier));
            $context->effect('quantityChanged', 'earlier-effect', ['quantity' => 1]);
            $blocked->title = 'Rejected title';
            $this->assertFalse($context->save($blocked));
            $this->assertSame(1, DB::transactionLevel());
            $this->assertCount(1, $context->changes());
            $this->assertCount(1, $context->effects());
        });
        $this->assertSame(['saving'], $events);
        $this->assertSame('Original blocked item', $blocked->refresh()->title);
        $this->assertSame('1', $this->revision('Item', $blocked->id));
        $this->assertSame('1', $this->revision('Item', $earlier->id));
        $this->assertSame(['earlier-effect'], DB::table('synloquent_effects')->pluck('idempotency_key')->all());
        $this->assertSame((string) $earlier->id, $this->journal()[0]['id']);
    }

    public function test_cancelled_physical_delete_restores_staged_relation_revisions_without_deleted_event(): void
    {
        $item = Item::create(['tenant_id' => 1, 'title' => 'Pivot owner']);
        $tag = Tag::create(['tenant_id' => 1, 'title' => 'Cancelled pivot target']);
        $gateway = $this->app->make(WriteGateway::class);
        $gateway->transaction($this->actor(), function (WriteContext $context) use ($item, $tag): void {
            $context->captureMany([$item, $tag]);
            $item->tags()->attach($tag->id, ['position' => 1]);
            $context->captureRelation($item, 'tags');
        });
        $relations = DB::table('synloquent_relation_revisions')->orderBy('model')->orderBy('relation')->get()->all();
        $events = [];
        $this->app['events']->listen('eloquent.deleting: '.Tag::class, static function () use (&$events): bool {
            $events[] = 'deleting';

            return false;
        });
        $this->app['events']->listen('eloquent.deleted: '.Tag::class, static function () use (&$events): void {
            $events[] = 'deleted';
        });
        $gateway->transaction($this->actor(), function (WriteContext $context) use ($tag): void {
            $this->assertFalse($context->delete($tag));
            $this->assertSame([], $context->changes());
        });
        $this->assertSame(['deleting'], $events);
        $this->assertNotNull($tag->fresh());
        $this->assertSame(1, $item->tags()->count());
        $this->assertEquals($relations, DB::table('synloquent_relation_revisions')->orderBy('model')->orderBy('relation')->get()->all());
        $this->assertSame('1', $this->revision('Tag', $tag->id));
        $this->assertSame(1, DB::table('synloquent_publications')->count());
    }

    public function test_soft_delete_is_upsert_and_force_delete_is_tombstone_with_native_events(): void
    {
        $note = new Note(['tenant_id' => 1, 'notable_type' => 'item', 'notable_id' => 1, 'body' => 'Soft note']);
        $gateway = $this->app->make(WriteGateway::class);
        $gateway->transaction($this->actor(), fn (WriteContext $context) => $context->save($note));
        $events = [];
        foreach (['deleting', 'trashed', 'deleted', 'forceDeleting', 'forceDeleted'] as $event) {
            $this->app['events']->listen('eloquent.'.$event.': '.Note::class, static function () use (&$events, $event): void {
                $events[] = $event;
            });
        }
        $gateway->transaction($this->actor(), fn (WriteContext $context) => $this->assertTrue($context->delete($note)));
        $this->assertSame(['deleting', 'trashed', 'deleted'], $events);
        $this->assertTrue($note->trashed());
        $this->assertSame('upsert', $this->journal()[0]['kind']);
        $this->assertNotNull($this->journal()[0]['record']['attributes']['deleted_at']);
        $this->assertSame('2', $this->revision('Note', $note->id));
        $events = [];
        $gateway->transaction($this->actor(), fn (WriteContext $context) => $this->assertTrue($context->forceDelete($note)));
        $this->assertSame(['forceDeleting', 'deleting', 'deleted', 'forceDeleted'], $events);
        $this->assertSame('delete', $this->journal()[0]['kind']);
        $this->assertTrue($this->journal()[0]['dependenciesCaptured']);
        $this->assertArrayNotHasKey('record', $this->journal()[0]);
        $this->assertSame('3', $this->revision('Note', $note->id));
        $this->assertNull(Note::withTrashed()->find($note->id));
        $gateway->transaction($this->actor(), fn (WriteContext $context) => $this->assertNull($context->delete($note)));
        $this->assertSame(3, DB::table('synloquent_publications')->count());
    }

    public function test_soft_delete_stages_only_native_written_columns_and_discards_unsaved_owner_key_edits(): void
    {
        Schema::table('notes', fn (Blueprint $table) => $table->unique('body'));
        Schema::create('fixture_context_note_dependents', function (Blueprint $table): void {
            $table->id();
            $table->text('note_body');
            $table->foreign('note_body')->references('body')->on('notes')->cascadeOnUpdate();
        });
        try {
            $note = Note::create(['tenant_id' => 1, 'notable_type' => 'item', 'notable_id' => 1, 'body' => 'Original referenced body']);
            DB::table('fixture_context_note_dependents')->insert(['note_body' => $note->body]);
            $gateway = $this->app->make(WriteGateway::class);
            $gateway->transaction($this->actor(), fn (WriteContext $context) => $context->capture($note));
            $note->body = 'Unsaved referenced body';
            $gateway->transaction($this->actor(), fn (WriteContext $context) => $this->assertTrue($context->delete($note)));
            $this->assertTrue($note->trashed());
            $this->assertSame('Original referenced body', $note->body);
            $this->assertSame('Original referenced body', DB::table('fixture_context_note_dependents')->value('note_body'));
            $this->assertSame('2', $this->revision('Note', $note->id));
            $this->assertSame('upsert', $this->journal()[0]['kind']);
            $this->assertSame('Original referenced body', $this->journal()[0]['record']['attributes']['body']);
            $this->assertNotNull($this->journal()[0]['record']['attributes']['deleted_at']);
        } finally {
            Schema::dropIfExists('fixture_context_note_dependents');
        }
    }

    public function test_helper_exception_restores_checkpoint_and_outer_rollback_closes_context(): void
    {
        $gateway = $this->app->make(WriteGateway::class);
        $activeContext = null;
        $this->app['events']->listen('eloquent.saved: '.Item::class, static function (Item $model) use (&$activeContext): void {
            if ($model->title === 'Failing observer') {
                $activeContext->capture($model);
                $activeContext->effect('quantityChanged', 'failed-helper', []);
                throw new RuntimeException('Observer failure');
            }
        });
        $gateway->transaction($this->actor(), function (WriteContext $context) use (&$activeContext): void {
            $activeContext = $context;
            $this->assertTrue($context->save(new Item(['tenant_id' => 1, 'title' => 'Survives caught helper error'])));
            try {
                $context->save(new Item(['tenant_id' => 1, 'title' => 'Failing observer']));
                $this->fail('Observer failure must propagate.');
            } catch (RuntimeException $exception) {
                $this->assertSame('Observer failure', $exception->getMessage());
            }
            $this->assertCount(1, $context->changes());
            $this->assertSame([], $context->effects());
        });
        $this->assertSame(1, Item::count());
        $this->assertSame(0, DB::table('synloquent_effects')->count());
        $escaped = null;
        try {
            $gateway->transaction($this->actor(), function (WriteContext $context) use (&$escaped): void {
                $escaped = $context;
                $context->save(new Item(['tenant_id' => 1, 'title' => 'Outer rollback']));
                throw new RuntimeException('Callback failure');
            });
            $this->fail('Callback error must propagate.');
        } catch (RuntimeException $exception) {
            $this->assertSame('Callback failure', $exception->getMessage());
        }
        $this->assertSame(1, Item::count());
        $this->assertSame(1, DB::table('synloquent_publications')->count());
        $gateway->transaction($this->actor(), function (WriteContext $context) use ($escaped): void {
            $this->assertSame(1, DB::transactionLevel());
            $this->assertClosed(fn () => $escaped->save(new Item(['tenant_id' => 1, 'title' => 'Escaped error context'])));
            $context->invalidateAuthorization();
        });
    }

    public function test_success_context_cannot_mutate_after_callback_even_inside_another_transaction(): void
    {
        $item = Item::create(['tenant_id' => 1, 'title' => 'Existing model']);
        $gateway = $this->app->make(WriteGateway::class);
        $escaped = $gateway->transaction($this->actor(), fn (WriteContext $context): WriteContext => $context);
        $this->assertClosed(fn () => $escaped->capture($item));
        $gateway->transaction($this->actor(), function (WriteContext $context) use ($escaped, $item): void {
            foreach ([fn () => $escaped->save($item), fn () => $escaped->delete($item), fn () => $escaped->forceDelete($item), fn () => $escaped->capture($item), fn () => $escaped->captureMany([$item]), fn () => $escaped->captureDeletionRelations($item), fn () => $escaped->captureRelation($item, 'tags'), fn () => $escaped->invalidateAuthorization(), fn () => $escaped->effect('quantityChanged', 'escaped', []), fn () => $escaped->discard()] as $operation) {
                $this->assertClosed($operation);
            }
            $context->capture($item);
            $context->effect('quantityChanged', 'valid-current-context', []);
        });
        $this->assertSame('1', $this->revision('Item', $item->id));
        $this->assertSame(1, DB::table('synloquent_publications')->count());
        $this->assertSame(['valid-current-context'], DB::table('synloquent_effects')->pluck('idempotency_key')->all());
    }

    public function test_custom_creation_keys_remain_allowed_and_existing_identity_changes_reject_for_save_and_delete(): void
    {
        $gateway = $this->app->make(WriteGateway::class);
        foreach ([['ExternalRecord', 'external_key', 'external:context', 'external:changed'], ['UuidRecord', 'id', (string) Str::uuid(), (string) Str::uuid()], ['UlidRecord', 'id', (string) Str::ulid(), (string) Str::ulid()]] as [$name, $key, $identity, $replacement]) {
            $resource = $this->app->make(ExportRegistry::class)->get($name);
            $model = new ($resource->modelClass())(['tenant_id' => 1, 'title' => 'Custom identity', $key => $identity]);
            $gateway->transaction($this->actor(), fn (WriteContext $context) => $this->assertTrue($context->save($model)));
            $this->assertSame($identity, $model->getKey());
            foreach (['save', 'delete', 'forceDelete'] as $method) {
                $model->setAttribute($key, $replacement);
                try {
                    $gateway->transaction($this->actor(), fn (WriteContext $context) => $context->{$method}($model));
                    $this->fail('An existing canonical identity cannot be changed.');
                } catch (ProtocolException $exception) {
                    $this->assertSame('validation_failed', $exception->errorCode);
                }
                $model->setAttribute($key, $identity);
                $this->assertNotNull($model->fresh());
                $this->assertSame('1', $this->app->make(RevisionStore::class)->get($this->actor()->stream(), $name, $identity));
            }
            $model->title = 'Unchanged custom identity';
            $gateway->transaction($this->actor(), fn (WriteContext $context) => $this->assertTrue($context->save($model)));
            $this->assertSame($identity, $model->getKey());
            $this->assertSame('2', $this->app->make(RevisionStore::class)->get($this->actor()->stream(), $name, $identity));
        }
        $this->assertSame(6, DB::table('synloquent_publications')->count());
    }

    public function test_declared_owner_stream_is_rechecked_after_save_and_physical_delete_observers(): void
    {
        $gateway = $this->app->make(WriteGateway::class);
        $tag = Tag::create(['tenant_id' => 1, 'title' => 'Partition guarded target']);
        $gateway->transaction($this->actor(), fn (WriteContext $context) => $context->capture($tag));
        $enabled = (object) ['event' => null];
        foreach (['saved', 'deleted'] as $event) {
            $this->app['events']->listen('eloquent.'.$event.': '.Tag::class, static function (Tag $model) use ($enabled, $event): void {
                if ($enabled->event === $event) {
                    $model->tenant_id = 2;
                    if ($event === 'saved') {
                        DB::table('tags')->where('id', $model->id)->update(['tenant_id' => 2]);
                    }
                }
            });
        }
        foreach (['save' => 'saved', 'delete' => 'deleted', 'forceDelete' => 'deleted'] as $method => $event) {
            $enabled->event = $event;
            $tag = Tag::findOrFail($tag->id);
            $tag->title = 'Rejected partition update';
            try {
                $gateway->transaction($this->actor(), fn (WriteContext $context) => $context->{$method}($tag));
                $this->fail('An observer partition change must rollback the whole instance write.');
            } catch (ProtocolException $exception) {
                $this->assertSame('unsupported_query', $exception->errorCode);
            }
            $tag = Tag::findOrFail($tag->id);
            $this->assertSame(1, $tag->tenant_id);
            $this->assertSame('Partition guarded target', $tag->title);
            $this->assertSame('1', $this->revision('Tag', $tag->id));
            $this->assertSame(1, DB::table('synloquent_publications')->count());
        }
    }

    public function test_after_commit_observer_sees_committed_publication_and_closed_context(): void
    {
        $item = new Item(['tenant_id' => 1, 'title' => 'Commit boundary']);
        $seen = [];
        $escaped = null;
        $this->app->make(WriteGateway::class)->transaction($this->actor(), function (WriteContext $context) use ($item, &$seen, &$escaped): void {
            $escaped = $context;
            $this->assertTrue($context->save($item));
            DB::afterCommit(function () use ($item, $context, &$seen): void {
                $seen = [DB::transactionLevel(), Item::findOrFail($item->id)->title, DB::table('synloquent_publications')->value('sequence')];
                $this->assertClosed(fn () => $context->capture($item));
            });
            $this->assertSame([], $seen);
        });
        $this->assertSame([0, 'Commit boundary', 1], $seen);
        $this->assertClosed(fn () => $escaped->discard());
    }

    private function assertClosed(callable $operation): void
    {
        try {
            $operation();
            $this->fail('An escaped context must reject mutation before any database write.');
        } catch (ProtocolException $exception) {
            $this->assertSame('unsupported_query', $exception->errorCode);
        }
    }

    private function revision(string $model, int $identity): string
    {
        return $this->app->make(RevisionStore::class)->get($this->actor()->stream(), $model, (string) $identity);
    }

    private function journal(): array
    {
        return json_decode(DB::table('synloquent_publications')->orderByDesc('sequence')->value('changes'), true, flags: JSON_THROW_ON_ERROR);
    }
}

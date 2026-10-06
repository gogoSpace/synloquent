<?php

declare(strict_types=1);

namespace Synloquent\Laravel\Sync;

use Illuminate\Database\Eloquent\Relations\BelongsToMany;
use Synloquent\Laravel\Export\ExportRegistry;
use Synloquent\Laravel\Protocol\ProtocolException;

final class ProjectionReader
{
    public function __construct(private ExportRegistry $registry, private SyncDatabase $database, private StageProfiler $profiler) {}

    /** @return array<array-key, mixed> */
    public function records(ActorContext $actor, string $dataset, ?int $maximum = null): array
    {
        $records = [];
        foreach ($this->chunks($actor, $dataset, $maximum) as $chunk) {
            array_push($records, ...$chunk);
        }

        return $records;
    }

    /** @return \Generator<int, list<array<array-key, mixed>>, mixed, void> */
    public function chunks(ActorContext $actor, string $dataset, ?int $maximum = null): \Generator
    {
        if ($dataset !== 'catalog') {
            throw new ProtocolException('unsupported_query', 'Dataset is not registered.');
        }
        $recordCount = 0;
        $hasAliases = $this->database->connection()->table('synloquent_aliases')->where('partition', $actor->partition())->exists();
        $hasRevisions = $this->database->connection()->table('synloquent_revisions')->where('stream', $actor->stream())->exists();
        foreach ($this->registry->all() as $resource) {
            if (! $resource->authorize('query', $actor)) {
                continue;
            }
            $query = ($resource->modelClass())::query();
            if (method_exists($query->getModel(), 'getDeletedAtColumn')) {
                $query->__call('withTrashed', []);
            }
            $resource->scope($query, $actor);
            $query->orderBy($query->getModel()->getKeyName());
            $started = hrtime(true);
            foreach ($query->lazyById(1000, $query->getModel()->getKeyName())->chunk(1000) as $chunk) {
                $records = [];
                $identities = $chunk->map(static fn ($model): string => (string) $model->getKey())->all();
                $revisions = $hasRevisions ? $this->database->connection()->table('synloquent_revisions')->where(['stream' => $actor->stream(), 'model' => $resource->name()])->whereIn('identity', $identities)->pluck('revision', 'identity') : collect();
                $aliases = $hasAliases ? $this->database->connection()->table('synloquent_aliases')->where(['partition' => $actor->partition(), 'model' => $resource->name()])->whereIn('identity', $identities)->pluck('local_identity', 'identity') : collect();
                foreach ($chunk as $model) {
                    $identity = (string) $model->getKey();
                    $localIdentity = $aliases->get($identity);
                    $records[] = ['model' => $resource->name(), 'id' => $identity, 'revision' => (string) ($revisions->get($identity) ?? '0'), 'attributes' => $resource->project($model, $actor), ...($localIdentity !== null ? ['localIdentity' => $localIdentity] : [])];
                    if (++$recordCount > ($maximum ?? config('synloquent.max_snapshot_rows', 200000))) {
                        throw new ProtocolException($maximum === null ? 'validation_failed' : 'cursor_expired', 'Projection row limit exceeded. Install a fresh bounded snapshot.');
                    }
                }
                $this->profiler->record('snapshot.projectionChunks', (hrtime(true) - $started) / 1e9, count($records));
                yield $records;
                $started = hrtime(true);
            }
        }

    }

    /** @return \Generator<int, list<array<array-key, mixed>>, mixed, void> */
    public function identityChunks(ActorContext $actor, string $dataset): \Generator
    {
        if ($dataset !== 'catalog') {
            throw new ProtocolException('unsupported_query', 'Dataset is not registered.');
        }
        foreach ($this->registry->all() as $resource) {
            if (! $resource->authorize('query', $actor)) {
                continue;
            }
            $model = new ($resource->modelClass());
            $hasPivot = false;
            foreach ($resource->relations() as $relation) {
                if ($model->{$relation}() instanceof BelongsToMany) {
                    $hasPivot = true;
                    break;
                }
            }
            if (! $hasPivot) {
                continue;
            }
            $query = $model->newQuery();
            if (method_exists($model, 'getDeletedAtColumn')) {
                $query->__call('withTrashed', []);
            }
            $resource->scope($query, $actor);
            $column = $model->getKeyName();
            foreach ($query->select($model->qualifyColumn($column))->lazyById(1000, $model->qualifyColumn($column), $column)->chunk(1000) as $chunk) {
                yield $chunk->map(static fn ($record): array => ['model' => $resource->name(), 'id' => (string) $record->getKey()])->values()->all();
            }
        }
    }

    /**
     * @param  list<array<array-key, mixed>>  $descriptors
     * @return list<array<array-key, mixed>>
     */
    public function recordsFor(array $descriptors, ActorContext $actor): array
    {
        $groups = [];
        foreach ($descriptors as $descriptor) {
            $groups[$descriptor['model']][] = $descriptor['id'];
        }
        $records = [];
        foreach ($groups as $name => $identities) {
            $resource = $this->registry->get($name);
            if (! $resource->authorize('query', $actor)) {
                continue;
            }
            foreach (array_chunk(array_values(array_unique($identities)), 1000) as $chunk) {
                $query = ($resource->modelClass())::query();
                if (method_exists($query->getModel(), 'getDeletedAtColumn')) {
                    $query->__call('withTrashed', []);
                }
                $resource->scope($query, $actor);
                $revisions = $this->database->connection()->table('synloquent_revisions')->where(['stream' => $actor->stream(), 'model' => $name])->whereIn('identity', $chunk)->pluck('revision', 'identity');
                $aliases = $this->database->connection()->table('synloquent_aliases')->where(['partition' => $actor->partition(), 'model' => $name])->whereIn('identity', $chunk)->pluck('local_identity', 'identity');
                foreach ($query->whereKey($chunk)->get() as $model) {
                    $identity = (string) $model->getKey();
                    $alias = $aliases->get($identity);
                    $records[] = ['model' => $name, 'id' => $identity, 'revision' => (string) ($revisions->get($identity) ?? '0'), 'attributes' => $resource->project($model, $actor), ...($alias !== null ? ['localIdentity' => $alias] : [])];
                }
            }
        }

        return $records;
    }
}

<?php

declare(strict_types=1);

namespace Synloquent\Laravel\Sync;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsToMany;
use Illuminate\Database\Eloquent\Relations\MorphToMany;
use Synloquent\Laravel\Contracts\ResourceExport;
use Synloquent\Laravel\Export\ExportRegistry;
use Synloquent\Laravel\Protocol\CanonicalJson;
use Synloquent\Laravel\Protocol\ProtocolException;
use Throwable;

final class WriteContext
{
    /** @var array<array-key, mixed> */
    private array $changes = [];

    /** @var array<array-key, mixed> */
    private array $effects = [];

    /** @var array<string, list<array{resource: ResourceExport, owner: Model, name: string, relation: BelongsToMany<Model, Model>}>> */
    private array $incomingRelations = [];

    private CaptureStreamGuard $streams;

    private bool $closed = false;

    public function __construct(public readonly ActorContext $actor, private ExportRegistry $registry, private RevisionStore $revisions, private SyncDatabase $database)
    {
        $this->streams = new CaptureStreamGuard($registry, $database);
    }

    /** @param array<array-key, mixed> $options */
    public function save(Model $model, array $options = []): bool
    {
        return $this->writeModel($model, function () use ($model, $options): bool {
            $updates = new UpdateCapture($this->registry, $this->database, $this->streams);
            $plan = $model->exists ? $updates->stage($model, $this) : null;
            if (! $model->save($options)) {
                return false;
            }
            $model->refresh();
            if ($plan !== null) {
                $updates->complete($plan, $model, $this);
            }
            $this->capture($model);

            return true;
        }) === true;
    }

    public function delete(Model $model): ?bool
    {
        return $this->deleteModel($model, false);
    }

    public function forceDelete(Model $model): ?bool
    {
        return $this->deleteModel($model, true);
    }

    private function deleteModel(Model $model, bool $force): ?bool
    {
        return $this->writeModel($model, function () use ($model, $force): ?bool {
            if (! $model->exists) {
                return $force ? $model->forceDelete() : $model->delete();
            }
            $physical = $force || ! method_exists($model, 'getDeletedAtColumn');
            $deletions = new DeletionCapture($this->registry, $this->database, $this->streams);
            $previous = clone $model;
            $previous->setRawAttributes($model->getRawOriginal(), true);
            $affected = $physical ? $deletions->stage($previous, $this) : null;
            $updates = new UpdateCapture($this->registry, $this->database, $this->streams);
            $updatePlan = $physical ? null : $updates->stage($previous, $this, [$model->getDeletedAtColumn()]);
            $deleted = $force ? $model->forceDelete() : $model->delete();
            if ($deleted !== true) {
                return $deleted;
            }
            if ($physical) {
                $deletions->complete($affected, $this);
                $this->capture($model, 'delete', true);
            } else {
                $model->refresh();
                $updates->complete($updatePlan, $model, $this);
                $this->capture($model);
            }

            return true;
        });
    }

    /** @param callable(): ?bool $handler */
    private function writeModel(Model $model, callable $handler): ?bool
    {
        $this->assertActive();
        $connection = $this->database->connection();
        if ($model->getConnection()->getName() !== $connection->getName()) {
            throw new ProtocolException('unsupported_query', 'Atomic model writes must use one database connection.');
        }
        $resource = $this->registry->get($this->registry->nameForClass($model::class));
        $previous = clone $model;
        if ($model->exists) {
            $previous->setRawAttributes($model->getRawOriginal(), true);
            if ((string) $previous->getKey() !== (string) $model->getKey()) {
                throw new ProtocolException('validation_failed', 'An existing canonical identity is immutable.');
            }
        }
        $knownStream = $resource->captureStream($previous) !== null;
        if ($knownStream) {
            $this->streams->ensure($previous, $this->actor);
        }
        $changes = $this->changes;
        $effects = $this->effects;
        $level = $connection->transactionLevel();
        $connection->beginTransaction();
        try {
            $result = $handler();
            if ($result !== true) {
                $connection->rollBack($level);
                $this->changes = $changes;
                $this->effects = $effects;

                return $result;
            }
            if ($knownStream || $resource->captureStream($model) !== null) {
                $this->streams->ensure($model, $this->actor);
            }
            if ($previous->exists && (string) $previous->getKey() !== (string) $model->getKey()) {
                throw new ProtocolException('validation_failed', 'An existing canonical identity is immutable.');
            }
            $connection->commit();

            return true;
        } catch (Throwable $exception) {
            $connection->rollBack($level);
            $this->changes = $changes;
            $this->effects = $effects;

            throw $exception;
        }
    }

    public function close(): void
    {
        $this->closed = true;
    }

    private function assertActive(): void
    {
        if ($this->closed || $this->database->connection()->transactionLevel() === 0) {
            throw new ProtocolException('unsupported_query', 'Write context is only active during its gateway callback.');
        }
    }

    /** @return array<array-key, mixed> */
    public function capture(Model $model, string $kind = 'upsert', bool $dependenciesCaptured = false): array
    {
        $this->assertActive();
        if ($model->getConnection()->getName() !== $this->database->connection()->getName()) {
            throw new ProtocolException('unsupported_query', 'Atomic capture must use one database connection.');
        }
        $name = $this->registry->nameForClass($model::class);
        $identity = (string) $model->getKey();
        $revision = $this->revisions->advance($this->actor->stream(), $name, $identity);

        return $this->record($model, $name, $revision, $kind, $dependenciesCaptured);
    }

    /** @param list<Model> $models */
    public function captureMany(array $models, string $kind = 'upsert', bool $dependenciesCaptured = false): void
    {
        $this->assertActive();
        if (! in_array($kind, ['upsert', 'delete'], true) || ($dependenciesCaptured && $kind !== 'delete')) {
            throw new ProtocolException('unsupported_query', 'Batched capture supports upsert or delete with declared deletion dependencies.');
        }
        $unique = [];
        $identities = [];
        foreach ($models as $model) {
            if ($model->getConnection()->getName() !== $this->database->connection()->getName()) {
                throw new ProtocolException('unsupported_query', 'Atomic capture must use one database connection.');
            }
            $name = $this->registry->nameForClass($model::class);
            $identity = (string) $model->getKey();
            $key = $name.':'.$identity;
            $unique[$key] = ['model' => $model, 'name' => $name];
            $identities[$key] = ['model' => $name, 'identity' => $identity];
        }
        if (count($unique) > (int) config('synloquent.max_delta_records', 1000)) {
            throw new ProtocolException('validation_failed', 'Batched capture exceeds the atomic identity bound.');
        }
        $revisions = $this->revisions->advanceMany($this->actor->stream(), array_values($identities));
        foreach ($unique as $key => $entry) {
            $this->record($entry['model'], $entry['name'], $revisions[$key], $kind, $dependenciesCaptured, false);
        }
        if ($kind === 'upsert') {
            $this->captureProjectionDependentsMany(array_map(fn (array $entry): Model => $entry['model'], array_values($unique)));
        }
    }

    /** @return array<array-key, mixed> */
    private function record(Model $model, string $name, string $revision, string $kind, bool $dependenciesCaptured, bool $captureDependents = true): array
    {
        $identity = (string) $model->getKey();
        $record = ['model' => $name, 'id' => $identity, 'revision' => $revision, 'attributes' => $this->registry->get($name)->project($model, $this->actor)];
        $change = ['kind' => $kind, 'model' => $name, 'id' => $identity];
        if ($kind === 'delete' && $dependenciesCaptured) {
            $change['dependenciesCaptured'] = true;
        }
        if ($kind === 'upsert') {
            $change['record'] = $record;
        }
        $this->changes[$name.':'.$identity] = $change;
        if ($kind === 'upsert' && $captureDependents) {
            $this->captureProjectionDependents($model, $name);
        }

        return $record;
    }

    public function captureDeletionRelations(Model $model): void
    {
        $this->assertActive();
        $this->captureProjectionDependents($model, $this->registry->nameForClass($model::class), true);
    }

    private function captureProjectionDependents(Model $model, string $name, bool $advanceRevision = false): void
    {
        $this->captureProjectionDependentsMany([$model], $advanceRevision);
    }

    /** @param list<Model> $models */
    private function captureProjectionDependentsMany(array $models, bool $advanceRevision = false): void
    {
        $groups = [];
        foreach ($models as $model) {
            $groups[$model::class][] = $model;
        }
        foreach ($groups as $group) {
            foreach ($this->relationsFor($group[0]::class) as $declaration) {
                $ownerResource = $declaration['resource'];
                $owner = $declaration['owner'];
                $relationName = $declaration['name'];
                $relation = $declaration['relation'];
                $maximum = (int) config('synloquent.max_delta_records', 1000);
                $values = [];
                foreach ($group as $model) {
                    $value = $model->getAttribute($relation->getRelatedKeyName());
                    $values[CanonicalJson::encode($value)] = $value;
                }
                $values = array_values($values);
                $query = $this->database->connection()->table($relation->getTable())->where(function ($query) use ($relation, $values): void {
                    $query->whereIn($relation->getRelatedPivotKeyName(), array_filter($values, fn (mixed $value): bool => $value !== null));
                    if (in_array(null, $values, true)) {
                        $query->orWhereNull($relation->getRelatedPivotKeyName());
                    }
                });
                if ($relation instanceof MorphToMany) {
                    $query->where($relation->getMorphType(), $relation->getMorphClass());
                }
                $identities = $query->distinct()->limit($maximum + 1)->pluck($relation->getForeignPivotKeyName());
                if ($identities->count() > $maximum) {
                    if ($advanceRevision) {
                        throw new ProtocolException('validation_failed', 'Deletion relation dependencies exceed the atomic capture bound.');
                    } $this->invalidateAuthorization();

                    continue;
                }
                if ($relation->getParentKeyName() !== $owner->getKeyName()) {
                    $identities = $owner->newQueryWithoutScopes()->whereIn($relation->getParentKeyName(), $identities)->limit($maximum + 1)->pluck($owner->getKeyName());
                }
                if ($identities->count() > $maximum) {
                    if ($advanceRevision) {
                        throw new ProtocolException('validation_failed', 'Deletion relation dependencies exceed the atomic capture bound.');
                    } $this->invalidateAuthorization();

                    continue;
                }
                if ($advanceRevision && $identities->isNotEmpty()) {
                    foreach ($group as $target) {
                        $this->streams->ensure($target, $this->actor);
                    }
                    $owners = $owner->newQueryWithoutScopes()->whereKey($identities)->limit($maximum + 1)->lockForUpdate()->get();
                    if ($owners->count() !== $identities->count()) {
                        throw new ProtocolException('unsupported_query', 'A relation dependency lost its canonical owner.');
                    }
                    foreach ($owners as $dependentOwner) {
                        $this->streams->ensure($dependentOwner, $this->actor);
                    }
                }
                foreach ($identities as $identity) {
                    $change = ['kind' => 'relation', 'model' => $ownerResource->name(), 'relation' => $relationName, 'id' => (string) $identity];
                    if ($advanceRevision) {
                        $keys = ['stream' => $this->actor->stream(), 'model' => $ownerResource->name(), 'relation' => $relationName, 'identity' => (string) $identity];
                        $table = $this->database->connection()->table('synloquent_relation_revisions');
                        $revision = (int) (clone $table)->where($keys)->value('revision') + 1;
                        $table->updateOrInsert($keys, ['revision' => $revision]);
                        $change['revision'] = (string) $revision;
                    }
                    $this->changes['relation:'.$ownerResource->name().':'.$relationName.':'.$identity] = $change;
                }
            }
        }
    }

    /** @return list<array{resource: ResourceExport, owner: Model, name: string, relation: BelongsToMany<Model, Model>}> */
    private function relationsFor(string $modelClass): array
    {
        if (! isset($this->incomingRelations[$modelClass])) {
            $declarations = [];
            foreach ($this->registry->all() as $resource) {
                $owner = new ($resource->modelClass());
                foreach ($resource->relations() as $name) {
                    $relation = $owner->{$name}();
                    if ($relation instanceof BelongsToMany && $relation->getRelated()::class === $modelClass) {
                        $declarations[] = ['resource' => $resource, 'owner' => $owner, 'name' => $name, 'relation' => $relation];
                    }
                }
            }
            $this->incomingRelations[$modelClass] = $declarations;
        }

        return $this->incomingRelations[$modelClass];
    }

    /** @param list<string> $affectedIdentities */
    public function captureRelation(Model $model, string $relation, array $affectedIdentities = []): string
    {
        $this->assertActive();
        $name = $this->registry->nameForClass($model::class);
        if (! in_array($relation, $this->registry->get($name)->relations(), true)) {
            throw new ProtocolException('unknown_relation', 'Captured relation is not exported.');
        }
        $keys = ['stream' => $this->actor->stream(), 'model' => $name, 'relation' => $relation, 'identity' => (string) $model->getKey()];
        $table = $this->database->connection()->table('synloquent_relation_revisions');
        $revision = (int) (clone $table)->where($keys)->value('revision') + 1;
        $table->updateOrInsert($keys, ['revision' => $revision]);
        $this->changes['relation:'.$name.':'.$relation.':'.$model->getKey()] = ['kind' => 'relation', 'model' => $name, 'relation' => $relation, 'id' => (string) $model->getKey(), 'revision' => (string) $revision];
        $definition = $model->{$relation}();
        if ($definition instanceof BelongsToMany) {
            $maximum = (int) config('synloquent.max_delta_records', 1000);
            $currentIdentities = $definition->newPivotQuery()->limit($maximum + 1)->pluck($definition->getRelatedPivotKeyName())->map(fn ($identity) => (string) $identity)->all();
            $affectedIdentities = array_unique([...$affectedIdentities, ...$currentIdentities]);
            if (count($affectedIdentities) > $maximum) {
                throw new ProtocolException('validation_failed', 'Captured relation exceeds the atomic identity bound.');
            }
            if ($definition->getRelatedKeyName() !== $definition->getRelated()->getKeyName()) {
                $affectedIdentities = $definition->getRelated()->newQueryWithoutScopes()->whereIn($definition->getRelatedKeyName(), $affectedIdentities)->pluck($definition->getRelated()->getKeyName())->map(fn ($identity) => (string) $identity)->all();
            }
            $relatedName = $this->registry->nameForClass($definition->getRelated()::class);
            $relatedResource = $this->registry->get($relatedName);
            foreach ($relatedResource->relations() as $inverseName) {
                $inverse = $definition->getRelated()->{$inverseName}();
                if (! $inverse instanceof BelongsToMany || $inverse->getTable() !== $definition->getTable() || $inverse->getForeignPivotKeyName() !== $definition->getRelatedPivotKeyName() || $inverse->getRelatedPivotKeyName() !== $definition->getForeignPivotKeyName() || $inverse->getRelated()::class !== $model::class) {
                    continue;
                }
                foreach ($affectedIdentities as $identity) {
                    $inverseKeys = ['stream' => $this->actor->stream(), 'model' => $relatedName, 'relation' => $inverseName, 'identity' => $identity];
                    $inverseTable = $this->database->connection()->table('synloquent_relation_revisions');
                    $inverseRevision = (int) (clone $inverseTable)->where($inverseKeys)->value('revision') + 1;
                    $inverseTable->updateOrInsert($inverseKeys, ['revision' => $inverseRevision]);
                    $this->changes['relation:'.$relatedName.':'.$inverseName.':'.$identity] = ['kind' => 'relation', 'model' => $relatedName, 'relation' => $inverseName, 'id' => $identity, 'revision' => (string) $inverseRevision];
                }
            }
        }

        return (string) $revision;
    }

    public function invalidateAuthorization(): void
    {
        $this->assertActive();
        $this->changes['authorization'] = ['kind' => 'authorization'];
    }

    /** @param array<array-key, mixed> $payload */
    public function effect(string $name, string $idempotencyKey, array $payload): void
    {
        $this->assertActive();
        $this->effects[] = ['name' => $name, 'idempotencyKey' => $idempotencyKey, 'payload' => $payload];
    }

    public function discard(): void
    {
        $this->assertActive();
        $this->changes = [];
        $this->effects = [];
    }

    /** @return array<array-key, mixed> */
    public function changes(): array
    {
        return array_values($this->changes);
    }

    /** @return array<array-key, mixed> */
    public function effects(): array
    {
        return $this->effects;
    }
}

<?php

declare(strict_types=1);

namespace Synloquent\Laravel\Sync;

use Illuminate\Database\Eloquent\Relations\BelongsToMany;
use Illuminate\Database\Eloquent\Relations\MorphToMany;
use Synloquent\Laravel\Export\ExportRegistry;
use Synloquent\Laravel\Export\ValueCodec;
use Synloquent\Laravel\Protocol\ProtocolException;

final class RelationSetReader
{
    public function __construct(private ExportRegistry $registry, private SyncDatabase $database, private ValueCodec $values) {}

    /**
     * @param  list<array<array-key, mixed>>  $records
     * @return list<array<array-key, mixed>>
     */
    public function read(array $records, ActorContext $actor, ?int $maximumTargets = null): array
    {
        $owners = [];
        foreach ($records as $record) {
            $owners[$record['model']][] = $record['id'];
        }
        $sets = [];
        $maximumTargets ??= (int) config('synloquent.max_snapshot_rows', 200000);
        $targetCount = 0;
        foreach ($owners as $name => $identities) {
            $identities = array_values(array_unique($identities));
            $resource = $this->registry->get($name);
            $model = new ($resource->modelClass());
            $relations = [];
            foreach ($resource->relations() as $relationName) {
                $relation = $model->{$relationName}();
                if ($relation instanceof BelongsToMany) {
                    $relations[$relationName] = $relation;
                }
            }
            if ($relations === []) {
                continue;
            }
            foreach (array_chunk($identities, 8000) as $identities) {
                $revisions = [];
                foreach ($this->database->connection()->table('synloquent_relation_revisions')->where(['stream' => $actor->stream(), 'model' => $name])->whereIn('identity', $identities)->get() as $revision) {
                    $revisions[$name.':'.$revision->relation.':'.$revision->identity] = (string) $revision->revision;
                }
                foreach ($relations as $relationName => $relation) {
                    $related = $this->registry->get($this->registry->nameForClass($relation->getRelated()::class));
                    $query = ($related->modelClass())::query();
                    $related->scope($query, $actor);
                    $query->select($query->getModel()->qualifyColumn($relation->getRelatedKeyName()));
                    $query->addSelect($query->getModel()->qualifyColumn($query->getModel()->getKeyName()).' as __synloquent_identity');
                    if (! $related->authorize('query', $actor)) {
                        $query->whereRaw('false');
                    }
                    $pivotQuery = $this->database->connection()->table($relation->getTable());
                    if ($relation instanceof MorphToMany) {
                        $pivotQuery->where($relation->getMorphType(), $relation->getMorphClass());
                    }
                    $ownerKeys = array_combine($identities, $identities);
                    if ($relation->getParentKeyName() !== $model->getKeyName()) {
                        $ownerKeys = $model->newQueryWithoutScopes()->whereKey($identities)->pluck($relation->getParentKeyName(), $model->getKeyName())->all();
                    }
                    $canonicalOwners = array_flip($ownerKeys);
                    $rows = $pivotQuery->joinSub($query, '__synloquent_targets', $relation->getTable().'.'.$relation->getRelatedPivotKeyName(), '=', '__synloquent_targets.'.$relation->getRelatedKeyName())->whereIn($relation->getTable().'.'.$relation->getForeignPivotKeyName(), array_values($ownerKeys))->orderBy($relation->getTable().'.'.$relation->getForeignPivotKeyName())->orderBy($relation->getTable().'.'.$relation->getRelatedPivotKeyName())->limit($maximumTargets - $targetCount + 1)->get([$relation->getTable().'.*', '__synloquent_targets.__synloquent_identity']);
                    $targetCount += $rows->count();
                    if ($targetCount > $maximumTargets) {
                        throw new ProtocolException('cursor_expired', 'Relation target set exceeds the bounded response.');
                    }
                    $grouped = [];
                    foreach ($rows as $row) {
                        $attributes = [];
                        foreach ($resource->pivotFields($relationName) as $field => $definition) {
                            if ($definition['readable']) {
                                $attributes[$field] = $this->values->encode($row->{$field}, $definition);
                            }
                        }
                        $grouped[(string) $canonicalOwners[$row->{$relation->getForeignPivotKeyName()}]][] = ['id' => (string) $row->__synloquent_identity, 'attributes' => $attributes];
                    }
                    foreach ($identities as $identity) {
                        $sets[] = ['model' => $name, 'relation' => $relationName, 'parentId' => $identity, 'revision' => $revisions[$name.':'.$relationName.':'.$identity] ?? '0', 'completeness' => 'complete', 'targets' => $grouped[$identity] ?? []];
                    }
                }
            }
        }

        return $sets;
    }
}

<?php

declare(strict_types=1);

namespace Synloquent\Laravel\Sync;

use Illuminate\Contracts\Validation\Factory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsToMany;
use Illuminate\Database\QueryException;
use Synloquent\Laravel\Contracts\ResourceExport;
use Synloquent\Laravel\Export\ExportRegistry;
use Synloquent\Laravel\Export\ManifestBuilder;
use Synloquent\Laravel\Export\ValueCodec;
use Synloquent\Laravel\Protocol\CanonicalJson;
use Synloquent\Laravel\Protocol\ProtocolException;

final class MutationAction
{
    public function __construct(private SyncDatabase $database, private WriteGateway $gateway, private ExportRegistry $registry, private ManifestBuilder $manifest, private ValueCodec $values, private Factory $validation, private RevisionStore $revisions, private RelationSetReader $relationSets, private DeletionCapture $deletions, private UpdateCapture $updates) {}

    /**
     * @param  array<array-key, mixed>  $operations
     * @return array<array-key, mixed>
     */
    public function execute(array $operations, ActorContext $actor): array
    {
        if (! array_is_list($operations) || count($operations) > config('synloquent.max_batch_size', 100)) {
            throw new ProtocolException('validation_failed', 'Invalid mutation batch size.');
        }
        $groups = [];
        foreach ($operations as $operation) {
            $this->validateOperation($operation);
            $groups[$operation['atomicGroup'] ?? $operation['operationId']][] = $operation;
        }
        $receipts = [];
        foreach ($groups as $group) {
            $groupReceipts = $this->gateway->transaction($actor, function (WriteContext $context) use ($group, $actor): array {
                $connection = $this->database->connection();
                $existing = [];
                $fresh = [];
                foreach ($group as $operation) {
                    $receipt = $connection->table('synloquent_receipts')->where(['partition' => $actor->partition(), 'operation_id' => $operation['operationId']])->first();
                    if ($receipt !== null) {
                        if (! hash_equals($receipt->payload_hash, CanonicalJson::hash($operation))) {
                            throw new ProtocolException('idempotency_mismatch', 'Operation identity was reused with a different payload.');
                        }
                        $existing[] = $this->safeReplay(json_decode($receipt->response, true, flags: JSON_THROW_ON_ERROR), $actor);
                    } else {
                        $fresh[] = $operation;
                    }
                }
                if ($fresh === []) {
                    return $existing;
                }
                if ($existing !== []) {
                    throw new ProtocolException('idempotency_mismatch', 'Atomic group cannot mix new and historical operations.');
                }
                $connection->beginTransaction();
                $new = [];
                $failingOperation = null;
                try {
                    foreach ($fresh as $operation) {
                        $failingOperation = $operation['operationId'];
                        foreach ($operation['dependsOn'] as $dependency) {
                            $known = collect($new)->firstWhere('operationId', $dependency);
                            $accepted = $known['status'] ?? $connection->table('synloquent_receipts')->where(['partition' => $actor->partition(), 'operation_id' => $dependency])->value('status');
                            if ($accepted !== 'accepted') {
                                throw new ProtocolException('causal_dependency', 'Causal dependency has not been accepted.', ['dependency' => $dependency]);
                            }
                        }
                        $new[] = $this->mutate($operation, $actor, $context);
                    }
                    $connection->commit();
                } catch (ProtocolException|QueryException $exception) {
                    $connection->rollBack();
                    $error = $exception instanceof ProtocolException ? $exception : new ProtocolException('validation_failed', 'Database constraint rejected the mutation.', ['sqlState' => $exception->errorInfo[0] ?? 'unknown']);
                    $new = array_map(function ($operation) use ($error, $failingOperation): array {
                        $failedHere = $operation['operationId'] === $failingOperation;

                        return ['operationId' => $operation['operationId'], 'localIdentity' => $operation['localIdentity'], 'status' => $failedHere && $error->errorCode === 'conflict' ? 'conflicted' : 'rejected', 'error' => $failedHere ? $error->payload() : ['code' => 'causal_dependency', 'message' => 'Atomic group rolled back after a dependent operation failed.'], ...($failedHere && isset($error->details['canonical']) ? ['canonical' => $error->details['canonical']] : [])];
                    }, $fresh);
                    $context->discard();
                    $new = array_map(fn (array $receipt): array => $this->safeReplay($receipt, $actor), $new);
                }
                foreach ($new as $index => $receipt) {
                    $connection->table('synloquent_receipts')->insert(['partition' => $actor->partition(), 'operation_id' => $fresh[$index]['operationId'], 'payload_hash' => CanonicalJson::hash($fresh[$index]), 'status' => $receipt['status'], 'response' => CanonicalJson::encode($receipt), 'created_at' => now()]);
                }

                return $new;
            });
            array_push($receipts, ...$groupReceipts);
        }

        return ['receipts' => $receipts];
    }

    /**
     * @param  array<array-key, mixed>  $operation
     * @return array<array-key, mixed>
     */
    private function mutate(array $operation, ActorContext $actor, WriteContext $context): array
    {
        $resource = $this->registry->get($operation['model']);
        $action = $operation['action'];
        $bulk = ($operation['eventMode'] ?? 'instance') === 'bulk';
        if (! in_array($action, $resource->operations(), true)) {
            throw new ProtocolException('forbidden_operation', 'Mutation action is not exported.', [], 403);
        }
        $query = ($resource->modelClass())::query();
        $resource->scope($query, $actor);
        if (in_array($action, ['restore', 'forceDelete'], true) && method_exists($query->getModel(), 'getDeletedAtColumn')) {
            $query->__call('withTrashed', []);
        }
        if ($action === 'create') {
            $model = new ($resource->modelClass());
        } else {
            $identity = $operation['id'] ?? $this->resolveIdentity($operation['model'], $operation['localIdentity'], $actor);
            $this->values->validate($identity, ['type' => $query->getModel()->getKeyType() === 'int' ? 'integer' : 'string', 'nullable' => false], 'id');
            $model = $query->whereKey($identity)->lockForUpdate()->first();
            if ($model === null) {
                throw new ProtocolException('forbidden_operation', 'Record does not exist in the authorized scope.', [], 403);
            }
        }
        if (! $resource->authorize($action, $actor, $model)) {
            throw new ProtocolException('forbidden_operation', 'Mutation policy denied the action.', [], 403);
        }
        if (! in_array($action, ['create', 'pivot'], true)) {
            $current = $this->revisions->get($actor->stream(), $operation['model'], (string) $model->getKey());
            if (! isset($operation['expectedRevision']) || $operation['expectedRevision'] !== $current) {
                throw new ProtocolException('conflict', 'Server revision changed.', ['canonical' => ['model' => $operation['model'], 'id' => (string) $model->getKey(), 'revision' => $current, 'attributes' => $resource->project($model, $actor)]]);
            }
        }
        $kind = 'upsert';
        $deletionDependencies = null;
        $updateDependencies = null;
        if ($action === 'forceDelete' || ($action === 'delete' && ! method_exists($model, 'getDeletedAtColumn'))) {
            $deletionDependencies = $this->deletions->stage($model, $context);
        }
        if (in_array($action, ['create', 'update'], true)) {
            $values = $this->attributes($operation['values'], $resource, $operation['model'], $actor, $model, $operation['dependsOn']);
            $primaryKey = $model->getKeyName();
            if ($action === 'update' && array_key_exists($primaryKey, $values) && (string) $values[$primaryKey] !== (string) $model->getKey()) {
                throw new ProtocolException('validation_failed', 'An existing canonical identity is immutable.', ['field' => $primaryKey]);
            }
            $validator = $this->validation->make($this->values->validationData($values), $resource->rules($action));
            if ($validator->fails()) {
                throw new ProtocolException('validation_failed', 'Host validation rejected the mutation.', ['fields' => $validator->errors()->toArray()]);
            }
            foreach ($values as $field => $value) {
                $model->setAttribute($field, $value);
            }
            $resource->prepare($model, $actor);
            if ($action === 'update') {
                foreach (array_keys($values) as $field) {
                    $current = $model->getAttributes()[$field] ?? null;
                    $original = $model->getRawOriginal($field);
                    if (in_array($model->getCasts()[$field] ?? null, ['array', 'json', 'object'], true) && ! $model->hasGetMutator($field) && ! $model->hasAttributeGetMutator($field) && is_string($current) && is_string($original) && CanonicalJson::encode(json_decode($current, flags: JSON_THROW_ON_ERROR)) !== CanonicalJson::encode(json_decode($original, flags: JSON_THROW_ON_ERROR)) && $model->originalIsEquivalent($field)) {
                        throw new ProtocolException('unsupported_query', 'This JSON type transition requires the host model PreservesJsonTypes trait or an equivalent comparator.', ['field' => $field]);
                    }
                }
                $updateDependencies = $this->updates->stage($model, $context);
            }
            if ($bulk) {
                if ($model->usesTimestamps()) {
                    $model->updateTimestamps();
                }
                if ($action === 'create') {
                    if ($model->usesUniqueIds()) {
                        $model->setUniqueIds();
                    }
                    $attributes = $model->getAttributes();
                    if ($model->getIncrementing()) {
                        $identity = $model->getConnection()->table($model->getTable())->insertGetId($attributes, $model->getKeyName());
                        $model->setAttribute($model->getKeyName(), $identity);
                    } else {
                        $model->getConnection()->table($model->getTable())->insert($attributes);
                    }
                    $model->exists = true;
                } else {
                    (clone $query)->whereKey($model->getKey())->update($model->getDirty());
                }
            } else {
                if ($action === 'update' && $values === [] && $model->usesTimestamps()) {
                    $model->touch();
                } else {
                    $model->save();
                }
            }
            $model->refresh();
        } elseif ($action === 'increment') {
            $field = $operation['values']['field'] ?? '';
            if (! in_array($field, $resource->writable(), true) || ! is_numeric($operation['values']['delta'] ?? null)) {
                throw new ProtocolException('forbidden_field', 'Delta field or value is invalid.');
            }
            $type = $this->manifest->build()['models'][$resource->name()]['fields'][$field]['type'];
            if (! in_array($type, ['integer', 'float', 'decimal'], true) || ($type === 'integer' && ! is_int($operation['values']['delta']))) {
                throw new ProtocolException('validation_failed', 'Delta must match a declared numeric field.');
            }
            $updateDependencies = $this->updates->stage($model, $context, [$field]);
            if ($bulk) {
                (clone $query)->whereKey($model->getKey())->increment($field, $operation['values']['delta']);
            } else {
                $model->increment($field, $operation['values']['delta']);
            }
            $model->refresh();
        } elseif ($action === 'restore') {
            if (! method_exists($model, 'restore') || ! method_exists($model, 'getDeletedAtColumn')) {
                throw new ProtocolException('unsupported_query', 'Resource does not implement soft deletes.');
            }
            $updateDependencies = $this->updates->stage($model, $context, [$model->getDeletedAtColumn()]);
            if ($bulk) {
                (clone $query)->whereKey($model->getKey())->__call('restore', []);
            } else {
                $model->restore();
            }
            $model->refresh();
        } elseif ($action === 'forceDelete') {
            if ($bulk) {
                (clone $query)->whereKey($model->getKey())->forceDelete();
            } else {
                $model->forceDelete();
            }
            $kind = 'delete';
        } elseif ($action === 'delete') {
            if ($bulk) {
                (clone $query)->whereKey($model->getKey())->delete();
            } else {
                $model->delete();
            }
            if (method_exists($model, 'getDeletedAtColumn')) {
                $model->refresh();
                $kind = 'upsert';
            } else {
                $kind = 'delete';
            }
        } elseif ($action === 'pivot') {
            $relationName = $operation['values']['relation'] ?? '';
            if (! in_array($relationName, $resource->relations(), true)) {
                throw new ProtocolException('unknown_relation', 'Pivot relation is not exported.');
            }
            $definition = $model->{$relationName}();
            if (! $definition instanceof BelongsToMany) {
                throw new ProtocolException('unsupported_query', 'Pivot mutations require a declared many-to-many relation.');
            }
            $affected = $this->pivotIdentities($definition);
            $this->pivot($model, $operation['values'], $resource, $actor, $operation['dependsOn']);
            $context->captureRelation($model, $relationName, $affected);
            $model->refresh();
        } else {
            throw new ProtocolException('forbidden_operation', 'Unknown mutation action.');
        }
        if ($deletionDependencies !== null) {
            $this->deletions->complete($deletionDependencies, $context);
        }
        if ($updateDependencies !== null) {
            $this->updates->complete($updateDependencies, $model, $context);
        }
        $canonical = $context->capture($model, $kind, $deletionDependencies !== null);
        if ($action === 'create') {
            $this->database->connection()->table('synloquent_aliases')->insert(['partition' => $actor->partition(), 'model' => $operation['model'], 'local_identity' => $operation['localIdentity'], 'identity' => (string) $model->getKey(), 'operation_id' => $operation['operationId']]);
        }

        return ['operationId' => $operation['operationId'], 'status' => 'accepted', 'localIdentity' => $operation['localIdentity'], ...($kind === 'upsert' ? ['canonical' => $canonical] : []), ...($action === 'pivot' ? ['relationSets' => $this->relationSets->read([$canonical], $actor)] : [])];
    }

    /**
     * @param  array<array-key, mixed>  $attributes
     * @param  list<string>  $dependencies
     * @return array<array-key, mixed>
     */
    private function attributes(array $attributes, ResourceExport $resource, string $name, ActorContext $actor, Model $model, array $dependencies): array
    {
        $fields = $this->manifest->build()['models'][$name]['fields'];
        $foreignKeys = [];
        foreach ($this->manifest->build()['models'][$name]['relations'] as $relation) {
            if (! in_array($relation['type'], ['belongsTo', 'morphTo'], true)) {
                continue;
            }
            $target = $relation['model'];
            if ($relation['type'] === 'morphTo') {
                $type = $attributes[$relation['morphType']] ?? $model->getAttribute($relation['morphType']);
                $target = $relation['morphMap'][$type] ?? null;
                if ($target === null) {
                    throw new ProtocolException('validation_failed', 'Unknown explicit morph type.');
                }
            }
            $foreignKeys[$relation['foreignKey']] = ['model' => $target, 'key' => $relation['ownerKey'] ?? $this->manifest->build()['models'][$target]['primaryKey']];
        }
        foreach ($attributes as $field => &$value) {
            if (! in_array($field, $resource->writable(), true)) {
                throw new ProtocolException('forbidden_field', 'Field is not writable: '.$field);
            }
            $reference = is_array($value) && isset($value['$ref']);
            if ($reference) {
                if (! is_array($value['$ref'])) {
                    throw new ProtocolException('causal_dependency', 'Malformed local reference.');
                }
                if (($foreignKeys[$field]['model'] ?? null) !== ($value['$ref']['model'] ?? null)) {
                    throw new ProtocolException('causal_dependency', 'Local reference does not match the declared foreign resource.');
                }
                $value = $this->resolveReference($value['$ref'], $dependencies, $actor);
            }
            if (! $reference) {
                $this->values->validate($value, $fields[$field], $field);
            }
            if ($value !== null && isset($foreignKeys[$field])) {
                $related = $this->registry->get($foreignKeys[$field]['model']);
                $query = ($related->modelClass())::query();
                $related->scope($query, $actor);
                $ownerKey = $foreignKeys[$field]['key'];
                $target = $related->authorize('query', $actor) ? $query->where($reference ? $query->getModel()->getKeyName() : $ownerKey, $value)->first() : null;
                if ($target === null) {
                    throw new ProtocolException('forbidden_operation', 'Foreign record is outside the authorized scope.', [], 403);
                }
                if ($reference) {
                    $value = $target->getAttribute($ownerKey);
                    $this->values->validate($value, $fields[$field], $field);
                }
            }
        }

        return $attributes;
    }

    private function resolveIdentity(string $model, string $identity, ActorContext $actor): string
    {
        return (string) ($this->database->connection()->table('synloquent_aliases')->where(['partition' => $actor->partition(), 'model' => $model, 'local_identity' => $identity])->value('identity') ?? throw new ProtocolException('causal_dependency', 'Referenced local identity has not been accepted.'));
    }

    /**
     * @param  BelongsToMany<Model, Model>  $relation
     * @return list<string>
     */
    private function pivotIdentities(BelongsToMany $relation): array
    {
        $maximum = (int) config('synloquent.max_delta_records', 1000);
        $identities = $relation->newPivotQuery()->limit($maximum + 1)->pluck($relation->getRelatedPivotKeyName())->map(fn ($identity) => (string) $identity)->all();
        if (count($identities) > $maximum) {
            throw new ProtocolException('validation_failed', 'Pivot membership exceeds the atomic capture bound.');
        }

        return $identities;
    }

    /**
     * @param  array<array-key, mixed>  $reference
     * @param  list<string>  $dependencies
     */
    private function resolveReference(array $reference, array $dependencies, ActorContext $actor): string
    {
        if (! is_string($reference['model'] ?? null) || ! is_string($reference['localIdentity'] ?? null) || array_diff(array_keys($reference), ['model', 'localIdentity']) !== []) {
            throw new ProtocolException('causal_dependency', 'Malformed local reference.');
        }
        $alias = $this->database->connection()->table('synloquent_aliases')->where(['partition' => $actor->partition(), 'model' => $reference['model'], 'local_identity' => $reference['localIdentity']])->first();
        if ($alias === null || $alias->operation_id === null || ! in_array($alias->operation_id, $dependencies, true)) {
            throw new ProtocolException('causal_dependency', 'Local reference requires its accepted creation operation in dependsOn.');
        }

        return (string) $alias->identity;
    }

    /**
     * @param  array<array-key, mixed>  $receipt
     * @return array<array-key, mixed>
     */
    private function safeReplay(array $receipt, ActorContext $actor): array
    {
        if (isset($receipt['canonical'])) {
            $resource = $this->registry->get($receipt['canonical']['model']);
            $query = ($resource->modelClass())::query();
            if (method_exists($query->getModel(), 'getDeletedAtColumn')) {
                $query->__call('withTrashed', []);
            }
            $resource->scope($query, $actor);
            $model = $query->whereKey($receipt['canonical']['id'])->first();
            if ($model === null || ! $resource->authorize('query', $actor, $model)) {
                unset($receipt['relationSets']);
                unset($receipt['error']['details']['canonical']);
                unset($receipt['canonical']);
            } else {
                $receipt['canonical']['attributes'] = $resource->project($model, $actor);
                $receipt['canonical']['revision'] = $this->revisions->get($actor->stream(), $resource->name(), (string) $model->getKey());
                if (isset($receipt['relationSets'])) {
                    $receipt['relationSets'] = $this->relationSets->read([$receipt['canonical']], $actor);
                }
                if (isset($receipt['error']['details']['canonical'])) {
                    $receipt['error']['details']['canonical'] = $receipt['canonical'];
                }
            }
        }

        return $receipt;
    }

    private function validateOperation(mixed $operation): void
    {
        if (! is_array($operation) || ! is_string($operation['operationId'] ?? null) || strlen($operation['operationId']) > 128 || ! is_string($operation['localIdentity'] ?? null) || strlen($operation['localIdentity']) > 128 || ! is_string($operation['model'] ?? null) || ! in_array($operation['action'] ?? '', ['create', 'update', 'delete', 'restore', 'forceDelete', 'increment', 'pivot'], true) || ! is_array($operation['values'] ?? null) || ! is_array($operation['dependsOn'] ?? null)) {
            throw new ProtocolException('validation_failed', 'Invalid mutation operation.');
        }
        if (isset($operation['eventMode']) && ! in_array($operation['eventMode'], ['instance', 'bulk'], true)) {
            throw new ProtocolException('validation_failed', 'Invalid mutation event mode.');
        }
        if (! array_is_list($operation['dependsOn']) || count($operation['dependsOn']) > 100 || count(array_unique($operation['dependsOn'], SORT_REGULAR)) !== count($operation['dependsOn'])) {
            throw new ProtocolException('validation_failed', 'Invalid causal dependencies.');
        }
        foreach ($operation['dependsOn'] as $dependency) {
            if (! is_string($dependency) || $dependency === '' || strlen($dependency) > 128 || $dependency === $operation['operationId']) {
                throw new ProtocolException('validation_failed', 'Invalid causal dependency identity.');
            }
        }
    }

    /**
     * @param  array<array-key, mixed>  $values
     * @param  list<string>  $dependencies
     */
    private function pivot(Model $model, array $values, ResourceExport $resource, ActorContext $actor, array $dependencies): void
    {
        $name = $values['relation'] ?? '';
        if (! in_array($name, $resource->relations(), true)) {
            throw new ProtocolException('unknown_relation', 'Pivot relation is not exported.');
        }
        $relation = $model->{$name}();
        if (! $relation instanceof BelongsToMany || ! in_array($values['action'] ?? '', ['attach', 'detach', 'toggle', 'updateExistingPivot', 'sync', 'syncWithoutDetaching'], true)) {
            throw new ProtocolException('unsupported_query', 'Invalid pivot mutation.');
        }
        if (($values['action'] === 'sync') && ! ($values['completeSet'] ?? false)) {
            throw new ProtocolException('conflict', 'sync requires an explicit complete set.');
        }
        $related = $this->registry->get($this->registry->nameForClass($relation->getRelated()::class));
        $targets = $values['targets'] ?? [];
        if (! is_array($targets) || ! array_is_list($targets) || count($targets) > 1000) {
            throw new ProtocolException('validation_failed', 'Pivot target limit exceeded.');
        }
        foreach ($targets as &$target) {
            if (is_array($target) && isset($target['$ref'])) {
                if (! is_array($target['$ref'])) {
                    throw new ProtocolException('causal_dependency', 'Malformed local reference.');
                }
                if (($target['$ref']['model'] ?? null) !== $related->name()) {
                    throw new ProtocolException('causal_dependency', 'Pivot reference does not match the declared target resource.');
                }
                $target = $this->resolveReference($target['$ref'], $dependencies, $actor);
            }
            $primaryKey = $this->manifest->build()['models'][$related->name()]['primaryKey'];
            $this->values->validate($target, $this->manifest->build()['models'][$related->name()]['fields'][$primaryKey], $primaryKey);
        }
        unset($target);
        $query = ($related->modelClass())::query();
        $related->scope($query, $actor);
        $authorizedTargets = $related->authorize('query', $actor) ? $query->whereKey($targets)->get([$query->getModel()->getKeyName(), $relation->getRelatedKeyName()]) : collect();
        if ($authorizedTargets->count() !== count(array_unique($targets))) {
            throw new ProtocolException('forbidden_operation', 'Pivot targets are outside the authorized scope.', [], 403);
        }
        $targets = $authorizedTargets->pluck($relation->getRelatedKeyName())->all();
        $attributes = $values['attributes'] ?? [];
        foreach ($attributes as $field => $value) {
            $declaration = $resource->pivotFields($name)[$field] ?? null;
            if ($declaration === null || ! $declaration['writable']) {
                throw new ProtocolException('forbidden_field', 'Pivot field is not writable: '.$field);
            }
            $this->values->validate($value, $declaration, $field);
        }
        $revision = (string) ($this->database->connection()->table('synloquent_relation_revisions')->where(['stream' => $actor->stream(), 'model' => $resource->name(), 'relation' => $name, 'identity' => (string) $model->getKey()])->value('revision') ?? 0);
        if (isset($values['expectedRelationRevision']) && $values['expectedRelationRevision'] !== $revision) {
            throw new ProtocolException('conflict', 'Relation revision changed.');
        }
        if ($values['action'] === 'sync' && ! isset($values['expectedRelationRevision'])) {
            throw new ProtocolException('conflict', 'sync requires a complete-set relation revision.');
        }
        if ($values['action'] === 'updateExistingPivot') {
            if (count($targets) !== 1) {
                throw new ProtocolException('validation_failed', 'updateExistingPivot requires one target.');
            }
            $relation->updateExistingPivot($targets[0], $attributes);
        } elseif ($values['action'] === 'attach' || $values['action'] === 'toggle') {
            $relation->{$values['action']}($targets, $attributes);
        } elseif ($values['action'] === 'detach') {
            $relation->detach($targets);
        } else {
            $attached = array_fill_keys($targets, $attributes);
            if ($values['action'] === 'sync') {
                $visibleQuery = ($related->modelClass())::query();
                $related->scope($visibleQuery, $actor);
                $existing = $this->pivotIdentities($relation);
                $visible = $visibleQuery->whereIn($relation->getRelatedKeyName(), $existing)->pluck($relation->getRelatedKeyName())->map(fn ($identity) => (string) $identity)->all();
                foreach (array_diff($existing, $visible) as $hidden) {
                    $attached[$hidden] = [];
                }
                $relation->sync($attached);
            } else {
                $relation->syncWithoutDetaching($attached);
            }
        }
    }
}

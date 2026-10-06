import { Collection } from './collection.js'
import { QueryCompiler, pivotTable, resourceTable } from './compiler.js'
import { quoteIdentifier, type TransactionExecutor } from './database.js'
import { SynloquentError } from './errors.js'
import {
  makeModel,
  type ModelInstance,
  type ReadonlyModelInstance,
  Model,
} from './model.js'
import { Query } from './query.js'
import type {
  ReadableFields,
  Attributes,
  ComparisonOperator,
  Operation,
  QueryOptions,
  WireValue,
  CanonicalRecord,
  RelationSet,
} from './types.js'
import {
  validateValue,
  exactDecimalAggregate,
  exactIntegerAggregate,
  decimalOrder,
  integerOrder,
} from './values.js'

const constraintBuilderMethods = [
  'remote',
  'scope',
  'allowPartial',
  'where',
  'orWhere',
  'whereGroup',
  'whereNot',
  'whereColumn',
  'whereIn',
  'whereNotIn',
  'whereNull',
  'whereNotNull',
  'whereBetween',
  'whereNotBetween',
  'whereJsonContains',
  'whereJsonPath',
  'select',
  'addSelect',
  'distinct',
  'orderBy',
  'orderByDesc',
  'reorder',
  'latest',
  'oldest',
  'limit',
  'take',
  'offset',
  'skip',
  'groupBy',
  'having',
  'when',
  'unless',
  'with',
  'withConstrained',
  'withCount',
  'withExists',
  'withSum',
  'withMin',
  'withMax',
  'withAvg',
  'has',
  'doesntHave',
  'orHas',
  'orDoesntHave',
  'whereHas',
  'whereDoesntHave',
  'orWhereHas',
  'orWhereDoesntHave',
  'whereRelation',
  'whereMorphRelation',
  'whereBelongsTo',
  'withTrashed',
  'onlyTrashed',
  'join',
  'leftJoin',
  'whereJoined',
  'union',
  'unionAll',
  'selectSub',
  'whereExists',
  'whereNotExists',
  'whereSub',
] as const satisfies readonly (keyof Query)[]
type ConstraintBuilderMethod = (typeof constraintBuilderMethods)[number]
type ConstraintCallbackArgument<Value> = Value extends {
  readonly options: QueryOptions
}
  ? ConstraintQuery
  : Value

type ConstraintArgument<Value> = Value extends (
  ...arguments_: infer Parameters
) => infer Result
  ? (
      ...arguments_: {
        [Index in keyof Parameters]: ConstraintCallbackArgument<
          Parameters[Index]
        >
      }
    ) => Result extends Query ? ConstraintQuery : Result
  : Value extends { readonly options: QueryOptions }
    ? { readonly options: QueryOptions }
    : Value

type ConstraintQuery = {
  readonly options: QueryOptions
  toAST(): QueryOptions
  select(...fields: string[]): ConstraintQuery
  addSelect(...fields: string[]): ConstraintQuery
  where(field: string, value: WireValue): ConstraintQuery
  where(
    field: string,
    operator: ComparisonOperator,
    value: WireValue,
  ): ConstraintQuery
  orWhere(field: string, value: WireValue): ConstraintQuery
  orWhere(
    field: string,
    operator: ComparisonOperator,
    value: WireValue,
  ): ConstraintQuery
} & {
  [
    Method in Exclude<
      ConstraintBuilderMethod,
      'where' | 'orWhere' | 'select' | 'addSelect'
    >
  ]: Query[Method] extends (...arguments_: infer Parameters) => unknown
    ? (
        ...arguments_: {
          [Index in keyof Parameters]: ConstraintArgument<Parameters[Index]>
        }
      ) => ConstraintQuery
    : never
}

function detachedConstraintQuery(
  query: Query,
  parent: Model<ReadableFields>,
): ConstraintQuery {
  const methods = new Set<string>(constraintBuilderMethods)
  const wrappedQueries = new WeakMap<Query, ConstraintQuery>()
  const wrap = (target: Query): ConstraintQuery => {
    const previous = wrappedQueries.get(target)
    if (previous) return previous
    const facade = new Proxy(
      {},
      {
        get(_facade, property) {
          parent.assertActive()
          if (property === 'options') return target.options
          if (property === 'toAST')
            return () => {
              parent.assertActive()
              return target.toAST()
            }
          if (typeof property !== 'string' || !methods.has(property))
            throw new SynloquentError(
              'forbidden_operation',
              'Detached relation constraints expose only read query builders and their AST.',
            )
          const method = Reflect.get(target, property) as (
            ...arguments_: readonly unknown[]
          ) => unknown
          return (...arguments_: readonly unknown[]) => {
            parent.assertActive()
            const inputs = arguments_.map((argument) =>
              typeof argument === 'function'
                ? (...supplied: readonly unknown[]) => {
                    parent.assertActive()
                    return Reflect.apply(
                      argument,
                      undefined,
                      supplied.map((value) =>
                        value instanceof Query ? wrap(value) : value,
                      ),
                    ) as unknown
                  }
                : argument,
            )
            const result: unknown = Reflect.apply(method, target, inputs)
            return result instanceof Query ? wrap(result) : result
          }
        },
        set() {
          parent.assertActive()
          throw new SynloquentError(
            'forbidden_operation',
            'Detached relation constraint builders are immutable.',
          )
        },
      },
    ) as ConstraintQuery
    wrappedQueries.set(target, facade)
    return facade
  }
  return wrap(query)
}

export interface RelationTarget {
  readonly id: WireValue
  readonly attributes?: Readonly<ReadableFields>
}
type RelationMutation =
  | 'associate'
  | 'dissociate'
  | 'create'
  | 'createMany'
  | 'save'
  | 'saveMany'
  | 'delete'
  | 'attach'
  | 'detach'
  | 'toggle'
  | 'updateExistingPivot'
  | 'sync'
  | 'syncWithoutDetaching'
export type ReadonlyRelation = Omit<
  Relation,
  | RelationMutation
  | 'parent'
  | 'current'
  | 'get'
  | 'first'
  | 'constrain'
  | 'withPivot'
  | 'wherePivot'
  | 'orderByPivot'
> & {
  readonly parent: ReadonlyModelInstance<ReadableFields>
  readonly current: Collection<ReadonlyModelInstance> | undefined
  get(): Promise<Collection<ReadonlyModelInstance>>
  first(): Promise<ReadonlyModelInstance | null>
  constrain(
    callback: (query: ConstraintQuery) => { readonly options: QueryOptions },
  ): ReadonlyRelation
  withPivot(...fields: string[]): ReadonlyRelation
  wherePivot(field: string, value: WireValue): ReadonlyRelation
  orderByPivot(field: string, direction?: 'asc' | 'desc'): ReadonlyRelation
}
export class Relation {
  // Eagerly loaded results belong to the caller. Only optional direct-get retention is evictable.
  private cachedValue: Collection<ModelInstance> | undefined
  private cacheWeight = 0
  private get cached(): Collection<ModelInstance> | undefined {
    if (this.cachedValue) return this.cachedValue
    const cache = this.parent.storage.memoryCache
    const retained = cache.get<Collection<ModelInstance>>(this)
    if (retained && !this.retain(retained)) return undefined
    return retained
  }
  private set cached(value: Collection<ModelInstance> | undefined) {
    this.parent.storage.memoryCache.delete(this)
    this.cacheWeight = 0
    this.cachedValue = value
  }
  private retain(value: Collection<ModelInstance>): boolean {
    try {
      return this.admit(value)
    } catch {
      // Optional cache admission cannot replace an explicit query result or error.
      this.parent.storage.memoryCache.delete(this)
      return false
    }
  }
  private admit(value: Collection<ModelInstance>): boolean {
    const cache = this.parent.storage.memoryCache
    const maximumBytes = Math.min(
      this.parent.storage.configuration.memoryBudget?.current()
        .maximumCacheBytes ?? 4 * 1024 * 1024,
      4 * 1024 * 1024,
    )
    let retainedBytes = 128 + value.length * 1024
    if (retainedBytes > maximumBytes) {
      cache.delete(this)
      return false
    }
    let visited = 0
    const weigh = (entry: unknown, depth = 0): boolean => {
      if (++visited > 4096 || depth > 16) return false
      if (typeof entry === 'string') retainedBytes += 64 + entry.length * 6
      else if (
        entry === null ||
        entry === undefined ||
        typeof entry === 'boolean' ||
        (typeof entry === 'number' && Number.isFinite(entry))
      )
        retainedBytes += 24
      else if (typeof entry !== 'object') return false
      else {
        const prototype = Object.getPrototypeOf(entry)
        if (
          prototype !== Object.prototype &&
          prototype !== Array.prototype &&
          prototype !== null
        )
          return false
        retainedBytes += 64
        for (const field in entry) {
          if (!Object.hasOwn(entry, field)) continue
          if (retainedBytes > maximumBytes || ++visited > 4096) return false
          const descriptor = Object.getOwnPropertyDescriptor(entry, field)
          if (!descriptor || !('value' in descriptor)) return false
          retainedBytes += 64 + field.length * 6
          if (!weigh(descriptor.value, depth + 1)) return false
        }
      }
      return retainedBytes <= maximumBytes
    }
    for (const model of value.items) {
      // Pending state and nested eager results have their own caller or durable owner.
      if (
        model.syncState !== 'synced' ||
        Object.values(model.relations).some(
          (relation) => relation.cachedValue !== undefined,
        ) ||
        !weigh(model.rawAttributes()) ||
        !weigh((model as ModelInstance & { pivot?: Attributes }).pivot)
      ) {
        cache.delete(this)
        return false
      }
    }
    // Do not undercount the original values of a mutable model after a smaller edit.
    this.cacheWeight = Math.max(this.cacheWeight, retainedBytes)
    return cache.set(this, value, this.cacheWeight)
  }
  private options: QueryOptions | undefined
  private pivotPredicates: { field: string; value: WireValue }[] = []
  private pivotOrdering: { field: string; direction: 'asc' | 'desc' }[] = []
  constructor(
    readonly parent: Model<ReadableFields>,
    readonly name: string,
  ) {}
  get definition() {
    const definition = this.parent.definition.relations[this.name]
    if (!definition)
      throw new SynloquentError(
        'unknown_relation',
        `Unknown relation ${this.name}.`,
      )
    return definition
  }
  get loaded(): boolean {
    return this.cached !== undefined
  }
  get current(): Collection<ModelInstance> | undefined {
    this.parent.assertActive()
    return this.cached
  }
  clear(): void {
    this.cached = undefined
  }
  private constraintQuery(): Query {
    return new Query(
      this.parent.storage,
      this.options ?? { model: this.definition.model },
    )
  }
  constrain(
    callback: (query: Query) => { readonly options: QueryOptions },
  ): Relation {
    this.parent.assertActive()
    const relation = new Relation(this.parent, this.name)
    const query = this.constraintQuery()
    relation.options = callback(
      this.parent.remoteResult
        ? (detachedConstraintQuery(query, this.parent) as unknown as Query)
        : query,
    ).options
    return relation
  }
  async get(): Promise<Collection<ModelInstance>> {
    await Relation.load([this.parent], {
      [this.name]: this.options ?? { model: this.definition.model },
    })
    const loadedRelation = this.parent.relation(this.name)
    const loaded = loadedRelation.cached ?? new Collection<ModelInstance>()
    // This load served an explicit get. Transfer its result out of the eager slot.
    loadedRelation.cachedValue = undefined
    loadedRelation.retain(loaded)
    let values = loaded.items
    for (const predicate of this.pivotPredicates)
      values = values.filter(
        (model) =>
          (model as ModelInstance & { pivot?: Attributes }).pivot?.[
            predicate.field
          ] === predicate.value,
      )
    for (const order of [...this.pivotOrdering].reverse())
      values = [...values].sort((left, right) => {
        const leftValue =
          (left as ModelInstance & { pivot?: Attributes }).pivot?.[
            order.field
          ] ?? null
        const rightValue =
          (right as ModelInstance & { pivot?: Attributes }).pivot?.[
            order.field
          ] ?? null
        const definition = this.definition.pivot!.fields[order.field]!
        const key = (value: WireValue): string =>
          value === null
            ? ''
            : definition.type === 'integer'
              ? integerOrder(value)
              : definition.type === 'decimal'
                ? decimalOrder(value, definition.precision ?? 18)
                : String(value)
        return (
          (leftValue === rightValue
            ? 0
            : key(leftValue) < key(rightValue)
              ? -1
              : 1) * (order.direction === 'asc' ? 1 : -1)
        )
      })
    const result = new Collection(values)
    this.cachedValue = undefined
    this.retain(result)
    return result
  }
  static async load(
    parents: readonly Model<ReadableFields>[],
    include: Readonly<Record<string, QueryOptions>>,
  ): Promise<void> {
    const first = parents[0]
    if (!first || !Object.keys(include).length) return
    if (
      parents.some(
        (parent) =>
          parent.remoteResult !== first.remoteResult ||
          parent.storage !== first.storage ||
          parent.modelName !== first.modelName,
      )
    )
      throw new SynloquentError(
        'validation_failed',
        'Batched relation loading requires one model, execution mode and database owner.',
      )
    if (!first.remoteResult) {
      await first.storage.read((executor) =>
        Relation.hydrateMany(parents, include, executor),
      )
      return
    }
    const loaded = await new Query(first.storage, {
      model: first.modelName,
      include,
    })
      .remote()
      .whereIn(
        first.definition.primaryKey,
        parents.map((parent) => parent.id),
      )
      .get()
    for (const parent of parents)
      for (const name of Object.keys(include))
        parent.relation(name).cached =
          (loaded.items as unknown as ModelInstance[])
            .find((model) => String(model.id) === String(parent.id))
            ?.relation(name).current ?? new Collection()
  }
  async first(): Promise<ModelInstance | null> {
    return (await this.get()).first() ?? null
  }
  async count(): Promise<number> {
    return (await this.get()).length
  }
  async exists(): Promise<boolean> {
    return Boolean(await this.first())
  }
  async sum(field: string): Promise<number | string> {
    const values = (this.cached ?? (await this.get())).items.map(
      (model) => model.attributes[field] ?? null,
    )
    const definition =
      this.parent.storage.manifest.models[this.definition.model]?.fields[field]
    if (!definition?.readable)
      throw new SynloquentError(
        'unknown_field',
        `Unknown aggregate field ${field}.`,
      )
    return definition.type === 'integer'
      ? (exactIntegerAggregate(values) ?? 0)
      : definition.type === 'decimal'
        ? (exactDecimalAggregate(values, definition.precision ?? 18, false) ??
          '0')
        : values.reduce<number>((sum, value) => sum + Number(value ?? 0), 0)
  }
  async min(field: string): Promise<WireValue | undefined> {
    return this.orderedValues(field, this.cached ?? (await this.get()))[0]
  }
  async max(field: string): Promise<WireValue | undefined> {
    return this.orderedValues(field, this.cached ?? (await this.get())).at(-1)
  }
  async avg(field: string): Promise<number | string | null> {
    const values = (this.cached ?? (await this.get())).items
      .map((model) => model.attributes[field] ?? null)
      .filter((value) => value !== null)
    const definition =
      this.parent.storage.manifest.models[this.definition.model]?.fields[field]
    if (!definition?.readable)
      throw new SynloquentError(
        'unknown_field',
        `Unknown aggregate field ${field}.`,
      )
    return definition.type === 'integer'
      ? exactIntegerAggregate(values, true)
      : definition.type === 'decimal'
        ? exactDecimalAggregate(values, definition.precision ?? 18, true)
        : values.length
          ? values.reduce<number>((sum, value) => sum + Number(value), 0) /
            values.length
          : null
  }
  private orderedValues(
    field: string,
    collection: Collection<ModelInstance>,
  ): WireValue[] {
    const values = collection.items
      .map((model) => model.attributes[field])
      .filter(
        (value): value is WireValue => value !== null && value !== undefined,
      )
    const definition =
      this.parent.storage.manifest.models[this.definition.model]?.fields[field]
    if (!definition?.readable)
      throw new SynloquentError(
        'unknown_field',
        `Unknown aggregate field ${field}.`,
      )
    return values.sort((left, right) => {
      const key = (value: WireValue): string =>
        definition.type === 'integer'
          ? integerOrder(value)
          : definition.type === 'decimal'
            ? decimalOrder(value, definition.precision ?? 18)
            : String(value)
      return definition.type === 'float'
        ? Number(left) - Number(right)
        : key(left) < key(right)
          ? -1
          : key(left) > key(right)
            ? 1
            : 0
    })
  }
  withPivot(...fields: string[]): Relation {
    for (const field of fields)
      if (!this.definition.pivot?.fields[field])
        throw new SynloquentError(
          'unknown_field',
          `Unknown pivot field ${field}.`,
        )
    return this
  }
  wherePivot(field: string, value: WireValue): Relation {
    if (!this.definition.pivot?.fields[field])
      throw new SynloquentError(
        'unknown_field',
        `Unknown pivot field ${field}.`,
      )
    const relation = this.copy()
    relation.pivotPredicates.push({ field, value })
    return relation
  }
  orderByPivot(field: string, direction: 'asc' | 'desc' = 'asc'): Relation {
    if (!this.definition.pivot?.fields[field])
      throw new SynloquentError(
        'unknown_field',
        `Unknown pivot field ${field}.`,
      )
    const relation = this.copy()
    relation.pivotOrdering.push({ field, direction })
    return relation
  }
  private copy(): Relation {
    const relation = new Relation(this.parent, this.name)
    relation.options = this.options
    relation.pivotPredicates = [...this.pivotPredicates]
    relation.pivotOrdering = [...this.pivotOrdering]
    return relation
  }
  private assertMutableParent(): void {
    this.parent.assertActive()
    if (this.parent.remoteResult)
      throw new SynloquentError(
        'forbidden_operation',
        'Detached remote relations cannot mutate records. Obtain the parent through firstOrNew before editing.',
      )
  }
  async associate(
    model: RelationTarget | string | number,
  ): Promise<Model<ReadableFields>> {
    this.assertMutableParent()
    if (this.definition.type !== 'belongsTo' || !this.definition.foreignKey)
      throw new SynloquentError(
        'unsupported_query',
        'associate requires belongsTo.',
      )
    const owner =
      this.definition.ownerKey ??
      this.parent.storage.manifest.models[this.definition.model]!.primaryKey
    if (model instanceof Model) {
      model.assertActive()
      if (
        model.modelName !== this.definition.model ||
        model.storage.owner !== this.parent.storage.owner
      )
        throw new SynloquentError(
          'validation_failed',
          'Association target must use the declared model and active database owner.',
        )
    }
    const targetDefinition =
      this.parent.storage.manifest.models[this.definition.model]!
    if (!targetDefinition.fields[owner]?.readable)
      throw new SynloquentError(
        'forbidden_field',
        'Association owner key is not readable in the declared target model.',
      )
    const value =
      typeof model === 'object'
        ? ((model instanceof Model
            ? model.rawAttributes()[owner]
            : model.attributes?.[owner]) ??
          (owner ===
          this.parent.storage.manifest.models[this.definition.model]!.primaryKey
            ? model.id
            : undefined))
        : model
    if (value === undefined)
      throw new SynloquentError(
        'validation_failed',
        'Association target does not expose its declared owner key.',
      )
    this.parent.fill({ [this.definition.foreignKey]: value })
    return this.parent
  }
  async dissociate(): Promise<Model<ReadableFields>> {
    this.assertMutableParent()
    if (this.definition.type !== 'belongsTo' || !this.definition.foreignKey)
      throw new SynloquentError(
        'unsupported_query',
        'dissociate requires belongsTo.',
      )
    this.parent.fill({ [this.definition.foreignKey]: null })
    return this.parent
  }
  async create(attributes: Attributes): Promise<ModelInstance> {
    this.assertMutableParent()
    if (
      !this.definition.foreignKey ||
      !['hasOne', 'hasMany', 'morphOne', 'morphMany'].includes(
        this.definition.type,
      )
    )
      throw new SynloquentError(
        'unsupported_query',
        'Relation create requires hasOne/hasMany or a declared morph equivalent.',
      )
    const related = new Query(this.parent.storage, {
      model: this.definition.model,
    })
    const morphName = this.definition.morphType
      ? Object.entries(this.definition.morphMap ?? {}).find(
          ([, model]) => model === this.parent.modelName,
        )?.[0]
      : undefined
    return related.create({
      ...attributes,
      [this.definition.foreignKey]:
        this.parent.rawAttributes()[
          this.definition.localKey ?? this.parent.definition.primaryKey
        ] ?? this.parent.id,
      ...(this.definition.morphType && morphName
        ? { [this.definition.morphType]: morphName }
        : {}),
    })
  }
  async createMany(
    attributes: readonly Attributes[],
  ): Promise<Collection<ModelInstance>> {
    this.assertMutableParent()
    return this.parent.storage.transaction(async (storage) => {
      const parent = await new Query(storage, {
        model: this.parent.modelName,
      }).findOrFail(this.parent.localIdentity)
      const models: ModelInstance[] = []
      for (const row of attributes)
        models.push(await parent.relation(this.name).create(row))
      return new Collection(models)
    })
  }
  async save(model: ModelInstance): Promise<ModelInstance> {
    this.assertMutableParent()
    if (
      !this.definition.foreignKey ||
      model.modelName !== this.definition.model ||
      model.storage.owner !== this.parent.storage.owner
    )
      throw new SynloquentError(
        'unsupported_query',
        'Relation save requires the declared target model and database owner.',
      )
    const morphName = this.definition.morphType
      ? Object.entries(this.definition.morphMap ?? {}).find(
          ([, target]) => target === this.parent.modelName,
        )?.[0]
      : undefined
    model.fill({
      [this.definition.foreignKey]:
        this.parent.rawAttributes()[
          this.definition.localKey ?? this.parent.definition.primaryKey
        ] ?? this.parent.id,
      ...(this.definition.morphType && morphName
        ? { [this.definition.morphType]: morphName }
        : {}),
    })
    return model.save()
  }
  async saveMany(
    models: readonly ModelInstance[],
  ): Promise<Collection<ModelInstance>> {
    this.assertMutableParent()
    return this.parent.storage.transaction(async (storage) => {
      const parent = await new Query(storage, {
        model: this.parent.modelName,
      }).findOrFail(this.parent.localIdentity)
      const saved: ModelInstance[] = []
      for (const model of models) {
        if (
          model.modelName !== this.definition.model ||
          model.storage.owner !== storage.owner
        )
          throw new SynloquentError(
            'validation_failed',
            'Relation saveMany target is outside its declared model or owner.',
          )
        const attributes = Object.fromEntries(
          Object.entries(model.rawAttributes()).filter(
            ([field]) => model.definition.fields[field]?.writable,
          ),
        )
        const related = model.exists
          ? await new Query(storage, { model: model.modelName }).findOrFail(
              model.localIdentity,
            )
          : makeModel(
              storage,
              {
                model: model.modelName,
                localIdentity: model.localIdentity,
                serverIdentity: null,
                revision: null,
                canonical: {},
                proposal: {},
                attributes,
                visible: true,
                deleted: false,
                state: 'pending',
              },
              false,
            )
        related.fill(attributes)
        saved.push(await parent.relation(this.name).save(related))
      }
      return new Collection(saved)
    })
  }
  async delete(): Promise<number> {
    this.assertMutableParent()
    const models = await this.get()
    for (const model of models) await model.delete()
    return models.length
  }
  attach(
    targets: readonly (RelationTarget | string | number)[],
    attributes: Attributes = {},
  ): Promise<void> {
    return this.mutatePivot('attach', targets, attributes)
  }
  detach(
    targets: readonly (RelationTarget | string | number)[],
  ): Promise<void> {
    return this.mutatePivot('detach', targets)
  }
  toggle(
    targets: readonly (RelationTarget | string | number)[],
    attributes: Attributes = {},
  ): Promise<void> {
    return this.mutatePivot('toggle', targets, attributes)
  }
  updateExistingPivot(
    target: RelationTarget | string | number,
    attributes: Attributes,
  ): Promise<void> {
    return this.mutatePivot('updateExistingPivot', [target], attributes)
  }
  sync(
    targets: readonly (RelationTarget | string | number)[],
    options: {
      readonly expectedRelationRevision: string
      readonly completeSet: true
    },
    attributes: Attributes = {},
  ): Promise<void> {
    return this.mutatePivot('sync', targets, attributes, options)
  }
  syncWithoutDetaching(
    targets: readonly (RelationTarget | string | number)[],
    attributes: Attributes = {},
  ): Promise<void> {
    return this.mutatePivot('syncWithoutDetaching', targets, attributes)
  }
  private async mutatePivot(
    action: string,
    targets: readonly (RelationTarget | string | number)[],
    attributes: Attributes = {},
    revision?: {
      readonly expectedRelationRevision: string
      readonly completeSet: true
    },
  ): Promise<void> {
    this.assertMutableParent()
    const pivot = this.definition.pivot
    if (!pivot || !this.parent.definition.operations.includes('pivot'))
      throw new SynloquentError(
        'forbidden_operation',
        'Pivot mutation is not declared for this relation.',
      )
    for (const [field, value] of Object.entries(attributes)) {
      const definition = pivot.fields[field]
      if (!definition || !definition.writable)
        throw new SynloquentError(
          'forbidden_field',
          `Pivot field ${field} is not writable.`,
        )
      validateValue(field, definition, value)
    }
    await this.parent.storage.write(async (executor, changed) => {
      const current = await this.parent.storage.findStored(
        this.parent.modelName,
        this.parent.localIdentity,
        executor,
      )
      if (!current?.visible || current.deleted)
        throw new SynloquentError(
          'forbidden_operation',
          'Pivot owner is outside active authorized membership.',
        )
      const membership = await executor.execute(
        'SELECT revision,completeness FROM syn_relation_sets WHERE partition = ? AND model = ? AND relation = ? AND parent_identity = ?',
        [
          this.parent.storage.partition,
          this.parent.modelName,
          this.name,
          this.parent.localIdentity,
        ],
      )
      if (
        action === 'sync' &&
        (!revision ||
          membership.rows[0]?.completeness !== 'complete' ||
          membership.rows[0]?.revision !== revision.expectedRelationRevision)
      )
        throw new SynloquentError(
          'conflict',
          'Complete-set sync requires current complete canonical membership and its relation revision.',
        )
      const targetIds = targets.map((target) =>
        typeof target === 'object' ? String(target.id) : String(target),
      )
      const wireTargets: WireValue[] = []
      for (const identity of targetIds) {
        const target = await this.parent.storage.findStored(
          this.definition.model,
          identity,
          executor,
        )
        if (target && (!target.visible || target.deleted))
          throw new SynloquentError(
            'forbidden_operation',
            'Pivot target is outside active authorized membership.',
          )
        wireTargets.push(
          target?.serverIdentity === null
            ? {
                $ref: {
                  model: this.definition.model,
                  localIdentity: target.localIdentity,
                },
              }
            : identity,
        )
      }
      const pending = (await this.parent.storage.pending(executor)).filter(
        (entry) =>
          entry.operation.localIdentity === this.parent.localIdentity &&
          ['pending', 'sending'].includes(entry.status),
      )
      const operation: Operation = {
        operationId: this.parent.storage.configuration.generateIdentity(),
        model: this.parent.modelName,
        localIdentity: this.parent.localIdentity,
        action: 'pivot',
        values: {
          relation: this.name,
          action,
          targets: wireTargets,
          attributes,
          ...(revision ?? {}),
        },
        dependsOn: pending.length
          ? [pending[pending.length - 1]!.operation.operationId]
          : [],
        ...(this.parent.canonicalRecord()?.id
          ? { id: this.parent.canonicalRecord()!.id }
          : {}),
      }
      await this.parent.storage.append(operation, executor)
      changed.add(`pivot:${pivot.table}`)
      await this.parent.storage.rebuildRelationOverlays(executor, changed)
    })
    this.clear()
  }
  static hydrateRemote(
    parents: readonly Model<ReadableFields>[],
    include: Readonly<Record<string, QueryOptions>>,
    records: readonly CanonicalRecord[],
    sets: readonly RelationSet[],
  ): void {
    for (const parent of parents)
      for (const [name, options] of Object.entries(include)) {
        const relation = parent.relation(name).definition
        const targetModel =
          relation.type === 'morphTo' && relation.morphType
            ? relation.morphMap?.[
                String(parent.rawAttributes()[relation.morphType])
              ]
            : relation.model
        const target = parent.storage.manifest.models[targetModel ?? '']
        if (!target)
          throw new SynloquentError(
            'schema_mismatch',
            'Unknown remote relation target.',
          )
        const candidates = records.filter(
          (record) => record.model === targetModel,
        )
        const set = sets.find(
          (set) =>
            set.model === parent.modelName &&
            set.relation === name &&
            set.parentId === String(parent.id),
        )
        const parentKey =
          parent.rawAttributes()[
            relation.localKey ?? parent.definition.primaryKey
          ]
        const intermediates = relation.through
          ? records.filter(
              (record) =>
                record.model === relation.through &&
                String(record.attributes[relation.foreignKey ?? '']) ===
                  String(parentKey),
            )
          : []
        const morphName = relation.morphType
          ? Object.entries(relation.morphMap ?? {}).find(
              ([, model]) => model === parent.modelName,
            )?.[0]
          : undefined
        let selected = candidates.filter((record) =>
          relation.pivot
            ? set?.targets.some((target) => target.id === record.id)
            : relation.through
              ? intermediates.some(
                  (through) =>
                    String(record.attributes[relation.secondKey ?? '']) ===
                    String(
                      through.attributes[
                        relation.secondLocalKey ??
                          parent.storage.manifest.models[relation.through!]!
                            .primaryKey
                      ],
                    ),
                )
              : relation.type === 'belongsTo' || relation.type === 'morphTo'
                ? String(
                    record.attributes[relation.ownerKey ?? target.primaryKey],
                  ) ===
                  String(parent.rawAttributes()[relation.foreignKey ?? ''])
                : String(
                    record.attributes[
                      relation.foreignKey ??
                        `${parent.modelName.toLowerCase()}_id`
                    ],
                  ) === String(parentKey) &&
                  (!relation.morphType ||
                    record.attributes[relation.morphType] === morphName),
        )
        if (
          [
            'belongsTo',
            'hasOne',
            'hasOneThrough',
            'morphTo',
            'morphOne',
            'ofMany',
            'latestOfMany',
            'oldestOfMany',
          ].includes(relation.type)
        )
          selected = selected.slice(0, 1)
        const models = selected.map((record) =>
          makeModel(
            parent.storage,
            {
              model: record.model,
              localIdentity: `remote:${record.model}:${record.id}`,
              serverIdentity: record.id,
              revision: record.revision,
              canonical: record.attributes,
              proposal: {},
              attributes: record.attributes,
              visible: true,
              deleted: false,
              state: 'synced',
            },
            true,
            true,
          ),
        )
        for (const model of models)
          if (set)
            Object.assign(model, {
              pivot:
                set.targets.find((target) => target.id === String(model.id))
                  ?.attributes ?? {},
            })
        if (options.include)
          Relation.hydrateRemote(models, options.include, records, sets)
        if (options.select)
          for (const model of models)
            model.project([...options.select, model.definition.primaryKey])
        parent.relation(name).cached = new Collection(models)
      }
  }
  static async hydrateMany(
    parents: readonly Model<ReadableFields>[],
    include: Readonly<Record<string, QueryOptions>>,
    executor: TransactionExecutor,
  ): Promise<void> {
    const first = parents[0]
    if (!first || !parents.length) return
    for (const [name, options] of Object.entries(include)) {
      const relation = first.relation(name).definition
      if (relation.type === 'morphTo') {
        if (!relation.morphType || !relation.foreignKey || !relation.morphMap)
          throw new SynloquentError(
            'schema_mismatch',
            'morphTo requires an explicit map and keys.',
          )
        for (const [type, model] of Object.entries(relation.morphMap)) {
          const matching = parents.filter(
            (parent) => parent.rawAttributes()[relation.morphType!] === type,
          )
          const identities = matching
            .map((parent) => parent.rawAttributes()[relation.foreignKey!])
            .filter(
              (value): value is string | number =>
                typeof value === 'string' || typeof value === 'number',
            )
          if (!identities.length) continue
          const definition = first.storage.manifest.models[model]
          if (!definition)
            throw new SynloquentError(
              'unknown_model',
              `Unknown morph target ${model}.`,
            )
          const result = await executor.execute(
            `SELECT * FROM ${quoteIdentifier(resourceTable(model))} WHERE _partition = ? AND _visible = 1 AND _deleted = 0 AND ${quoteIdentifier(relation.ownerKey ?? definition.primaryKey)} IN (${identities.map(() => '?').join(',')})`,
            [first.storage.partition, ...identities.map(String)],
          )
          const models = result.rows.map((row) =>
            makeModel(first.storage, first.storage.row(model, row)),
          )
          for (const parent of matching)
            parent.relation(name).cached = new Collection(
              models.filter(
                (related) =>
                  String(
                    related.rawAttributes()[
                      relation.ownerKey ?? definition.primaryKey
                    ],
                  ) === String(parent.rawAttributes()[relation.foreignKey!]),
              ),
            )
        }
        for (const parent of parents)
          parent.relation(name).cached ??= new Collection()
        continue
      }
      const compiled = new QueryCompiler(
        first.storage.manifest,
        first.storage.partition,
      ).compileRelation(
        first.modelName,
        name,
        parents.map((parent) => parent.localIdentity),
        options,
      )
      const result = await executor.execute(
        compiled.statement,
        compiled.parameters,
      )
      const grouped = new Map<string, ModelInstance[]>()
      const all: ModelInstance[] = []
      for (const row of result.rows) {
        const model = makeModel(
          first.storage,
          first.storage.row(relation.model, row),
        )
        const key = String(row._parent_identity)
        const group = grouped.get(key) ?? []
        group.push(model)
        grouped.set(key, group)
        all.push(model)
      }
      if (options.include)
        await Relation.hydrateMany(all, options.include, executor)
      if (options.select)
        for (const model of all)
          model.project([...options.select, model.definition.primaryKey])
      if (relation.pivot) {
        const pivot = relation.pivot
        const pivots = await executor.execute(
          `SELECT * FROM ${quoteIdentifier(pivotTable(pivot.table))} WHERE _partition = ? AND ${quoteIdentifier(pivot.foreignKey)} IN (${parents.map(() => '?').join(',')})`,
          [
            first.storage.partition,
            ...parents.map((parent) => String(parent.id)),
          ],
        )
        for (const parent of parents)
          for (const model of grouped.get(parent.localIdentity) ?? []) {
            const row = pivots.rows.find(
              (row) =>
                String(row[pivot.foreignKey]) === String(parent.id) &&
                String(row[pivot.relatedKey]) === String(model.id),
            )
            if (row)
              Object.assign(model, {
                pivot: Object.fromEntries(
                  Object.entries(pivot.fields).map(([field, definition]) => [
                    field,
                    definition.type === 'boolean'
                      ? row[field] === 1
                      : definition.type === 'integer' &&
                          Number.isSafeInteger(Number(row[field]))
                        ? Number(row[field])
                        : definition.type === 'json' &&
                            typeof row[field] === 'string'
                          ? (JSON.parse(row[field]) as WireValue)
                          : (row[field] ?? null),
                  ]),
                ),
              })
          }
      }
      for (const parent of parents) {
        let models = grouped.get(parent.localIdentity) ?? []
        if (
          [
            'belongsTo',
            'hasOne',
            'hasOneThrough',
            'morphOne',
            'ofMany',
            'latestOfMany',
            'oldestOfMany',
          ].includes(relation.type)
        )
          models = models.slice(0, 1)
        if (options.limit !== undefined)
          models = models.slice(
            options.offset ?? 0,
            (options.offset ?? 0) + options.limit,
          )
        parent.relation(name).cached = new Collection(models)
      }
    }
  }
}

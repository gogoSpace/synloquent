import { Collection } from './collection.js'
import { SynloquentError } from './errors.js'
import type {
  ReadableFields,
  Attributes,
  CanonicalRecord,
  Operation,
  SyncState,
  WireValue,
} from './types.js'
import { canonicalJson, validateAttributes, validateValue } from './values.js'
import type { Storage, StoredRecord } from './storage.js'
import { SyncEngine } from './sync.js'
import { Relation, type ReadonlyRelation } from './relations.js'

export type ModelInstance<
  Fields extends ReadableFields = Attributes,
  WritableFields extends Attributes = Attributes,
  RelationNames extends string = string,
  ViewFields extends ReadableFields = Fields,
> = Model<Fields, WritableFields, RelationNames, ViewFields> &
  Readonly<ViewFields>
type ModelMutation =
  | 'set'
  | 'fill'
  | 'forceFill'
  | 'save'
  | 'saveConfirmed'
  | 'update'
  | 'delete'
  | 'forceDelete'
  | 'restore'
  | 'touch'
  | 'increment'
  | 'decrement'
  | 'setAggregate'
  | 'setProjection'
  | 'project'

export type ReadonlyModelInstance<
  Fields extends ReadableFields = Attributes,
  WritableFields extends Attributes = Attributes,
  RelationNames extends string = string,
  ViewFields extends ReadableFields = Fields,
> = Readonly<ViewFields> &
  Omit<
    Model<Fields, WritableFields, RelationNames, ViewFields>,
    | ModelMutation
    | 'relations'
    | 'relation'
    | 'fresh'
    | 'refresh'
    | 'load'
    | 'loadMissing'
  > & {
    readonly relations: Readonly<Record<string, ReadonlyRelation>>
    relation(name: RelationNames): ReadonlyRelation
    fresh(): Promise<ReadonlyModelInstance<
      Fields,
      WritableFields,
      RelationNames
    > | null>
    refresh(): Promise<
      ReadonlyModelInstance<Fields, WritableFields, RelationNames, ViewFields>
    >
    load(
      ...names: RelationNames[]
    ): Promise<
      ReadonlyModelInstance<Fields, WritableFields, RelationNames, ViewFields>
    >
    loadMissing(
      ...names: RelationNames[]
    ): Promise<
      ReadonlyModelInstance<Fields, WritableFields, RelationNames, ViewFields>
    >
  }
export class Model<
  Fields extends ReadableFields = Attributes,
  WritableFields extends Attributes = Attributes,
  RelationNames extends string = string,
  ViewFields extends ReadableFields = Fields,
> {
  private draft: Attributes
  private original: Attributes
  private changes: Attributes = {}
  private persisted: boolean
  private operationIdentity: string | null = null
  get lastOperationId(): string | null {
    return this.operationIdentity
  }
  private readonly activePartition: string
  private activeGeneration: number
  private projection: ReadonlySet<string> | undefined
  private aggregateValues: Attributes = {}
  private projectionValues: Attributes = {}
  get aggregates(): Readonly<Attributes> {
    return Object.freeze({ ...this.aggregateValues })
  }
  get projections(): Readonly<Attributes> {
    return Object.freeze({ ...this.projectionValues })
  }
  setAggregate(name: string, value: WireValue): void {
    this.aggregateValues[name] = value
  }
  setProjection(name: string, value: WireValue): void {
    this.projectionValues[name] = value
  }
  readonly relations: Readonly<Record<string, Relation>>
  private readonly storageSource: Storage
  get storage(): Storage {
    return this.storageSource.modelStorage()
  }
  constructor(
    storage: Storage,
    private record: StoredRecord,
    persisted = true,
    private readonly detached = false,
  ) {
    this.storageSource = storage
    this.activePartition = storage.partition
    this.activeGeneration = storage.owner.generation
    this.draft = { ...record.attributes }
    this.original = persisted ? { ...record.attributes } : {}
    this.persisted = persisted
    this.relations = Object.fromEntries(
      Object.keys(storage.manifest.models[record.model]?.relations ?? {}).map(
        (name) => [name, new Relation(this, name)],
      ),
    )
  }
  get modelName(): string {
    return this.record.model
  }
  get remoteResult(): boolean {
    return this.detached
  }
  get localIdentity(): string {
    if (this.activePartition !== this.storage.partition)
      throw new SynloquentError(
        'session_changed',
        'This identity belongs to a different account or device.',
      )
    return this.record.localIdentity
  }
  get id(): WireValue {
    this.assertActive()
    return (
      this.draft[this.definition.primaryKey] ??
      this.record.serverIdentity ??
      this.record.localIdentity
    )
  }
  get revision(): string | null {
    this.assertActive()
    return this.record.revision
  }
  get syncState(): SyncState {
    this.assertActive()
    return this.record.state
  }
  get attributes(): Readonly<ViewFields> {
    this.assertActive()
    return Object.fromEntries(
      Object.entries(this.draft).filter(
        ([field]) =>
          this.definition.fields[field]?.readable &&
          (!this.projection || this.projection.has(field)),
      ),
    ) as ViewFields
  }
  project(fields: readonly string[]): this {
    this.projection = new Set(fields)
    return this
  }
  rawAttributes(): Readonly<Attributes> {
    this.assertActive()
    return this.draft
  }
  assertActive(): void {
    if (
      this.activePartition !== this.storage.partition ||
      this.activeGeneration !== this.storage.owner.generation
    )
      throw new SynloquentError(
        'session_changed',
        'This model belongs to a replaced database or account session.',
      )
  }
  private assertWritable(): void {
    this.assertActive()
    if (this.detached)
      throw new SynloquentError(
        'forbidden_operation',
        'Remote read results are detached. Use firstOrNew with the canonical identity to obtain an editable local model.',
      )
  }
  get exists(): boolean {
    return this.persisted && !this.record.deleted && this.record.visible
  }
  get definition() {
    const definition = this.storage.manifest.models[this.modelName]
    if (!definition)
      throw new SynloquentError(
        'unknown_model',
        `Unknown model ${this.modelName}.`,
      )
    return definition
  }
  get<Key extends keyof ViewFields & string>(field: Key): ViewFields[Key] {
    return this.attributes[field] as ViewFields[Key]
  }
  set<Key extends keyof WritableFields & string>(
    field: Key,
    value: WritableFields[Key],
  ): this {
    const patch: Partial<WritableFields> = {}
    patch[field] = value
    return this.fill(patch)
  }
  fill(attributes: Partial<WritableFields>): this {
    this.assertWritable()
    Object.assign(
      this.draft,
      validateAttributes(this.definition, attributes as Attributes, true),
    )
    return this
  }
  forceFill(attributes: Partial<WritableFields>): this {
    return this.fill(attributes)
  }
  getOriginal(): Readonly<Fields>
  getOriginal<Key extends keyof Fields & string>(
    field: Key,
  ): Fields[Key] | undefined
  getOriginal(
    field?: keyof Fields & string,
  ): Readonly<Fields> | Fields[keyof Fields & string] | undefined {
    this.assertActive()
    return field === undefined
      ? ({ ...this.original } as Fields)
      : (this.original[field] as Fields[keyof Fields & string] | undefined)
  }
  getChanges(): Readonly<Partial<WritableFields>> {
    this.assertActive()
    return { ...this.changes } as Partial<WritableFields>
  }
  isDirty(field?: keyof Fields & string): boolean {
    this.assertActive()
    return field
      ? canonicalJson(this.draft[field]) !== canonicalJson(this.original[field])
      : Object.keys(this.dirty()).length > 0
  }
  isClean(field?: keyof Fields & string): boolean {
    return !this.isDirty(field)
  }
  wasChanged(field?: keyof Fields & string): boolean {
    return field ? field in this.changes : Object.keys(this.changes).length > 0
  }
  private dirty(): Attributes {
    return Object.fromEntries(
      Object.entries(this.draft).filter(
        ([field, value]) =>
          canonicalJson(value) !== canonicalJson(this.original[field]),
      ),
    )
  }
  async save(
    options: {
      readonly eventMode?: 'instance' | 'bulk'
      readonly atomicGroup?: string
    } = {},
  ): Promise<this> {
    this.assertWritable()
    const action = this.persisted ? 'update' : 'create'
    if (!this.definition.operations.includes(action))
      throw new SynloquentError(
        'forbidden_operation',
        `${action} is not allowed for ${this.modelName}.`,
      )
    let changedAttributes = this.persisted ? this.dirty() : { ...this.draft }
    if (this.persisted && !Object.keys(changedAttributes).length) return this
    const timestamps = this.definition.timestamps
    if (timestamps) {
      const instant = this.storage.configuration.now()
      if (!this.persisted && this.draft[timestamps.createdAt] === undefined)
        this.draft[timestamps.createdAt] = instant
      this.draft[timestamps.updatedAt] = instant
      changedAttributes = this.persisted ? this.dirty() : { ...this.draft }
    }
    const generatedFields = [
      this.definition.primaryKey,
      timestamps?.createdAt,
      timestamps?.updatedAt,
    ].filter((field): field is string => field !== undefined)
    const wireAttributes = Object.fromEntries(
      Object.entries(changedAttributes).filter(
        ([field]) =>
          !generatedFields.includes(field) ||
          this.definition.fields[field]?.writable,
      ),
    )
    validateAttributes(this.definition, wireAttributes, true)
    const next = await this.storage.write(async (executor, changed) => {
      const current = this.persisted
        ? await this.storage.findStored(
            this.modelName,
            this.localIdentity,
            executor,
          )
        : undefined
      if (this.persisted && (!current?.visible || current.deleted))
        throw new SynloquentError(
          'forbidden_operation',
          'This model is no longer authorized.',
        )
      const pending = (await this.storage.pending(executor)).filter(
        (entry) =>
          entry.operation.localIdentity === this.localIdentity &&
          ['pending', 'sending'].includes(entry.status),
      )
      const values = await this.storage.mutationValues(
        this.modelName,
        wireAttributes,
        executor,
      )
      const references = Object.values(values).filter(
        (
          value,
        ): value is {
          readonly $ref: {
            readonly model: string
            readonly localIdentity: string
          }
        } => Boolean(value && typeof value === 'object' && '$ref' in value),
      )
      const allPending = await this.storage.pending(executor)
      const dependencies = [
        ...(await this.storage.mutationDependencies(
          this.modelName,
          wireAttributes,
          executor,
        )),
        ...(pending.length
          ? [pending[pending.length - 1]!.operation.operationId]
          : []),
        ...references.flatMap((reference) =>
          allPending
            .filter(
              (entry) =>
                entry.operation.model === reference.$ref.model &&
                entry.operation.localIdentity ===
                  reference.$ref.localIdentity &&
                entry.operation.action === 'create' &&
                entry.status !== 'accepted',
            )
            .map((entry) => entry.operation.operationId),
        ),
      ]
      const operation: Operation = {
        operationId: this.storage.configuration.generateIdentity(),
        model: this.modelName,
        localIdentity: this.localIdentity,
        action,
        values,
        dependsOn: [...new Set(dependencies)],
        ...options,
        ...(current?.revision ? { expectedRevision: current.revision } : {}),
        ...(current?.serverIdentity ? { id: current.serverIdentity } : {}),
      }
      const record: StoredRecord = {
        ...this.record,
        ...(current ?? {}),
        proposal: {
          ...(current?.proposal ?? this.record.proposal),
          ...changedAttributes,
        },
        attributes: {
          ...(current?.canonical ?? this.record.canonical),
          ...(current?.proposal ?? this.record.proposal),
          ...changedAttributes,
        },
        state: 'pending',
        visible: true,
        deleted: false,
      }
      await this.storage.persist(record, executor, changed)
      await this.storage.append(operation, executor)
      this.operationIdentity = operation.operationId
      changed.add(this.modelName)
      return record
    })
    this.changes = changedAttributes
    this.record = next
    this.persisted = true
    this.original = { ...this.draft }
    return this
  }
  async saveConfirmed(timeoutMilliseconds = 30000): Promise<this> {
    await this.save()
    if (this.operationIdentity) {
      await new SyncEngine(
        this.storage,
        this.storage.configuration.transport,
      ).confirmed(this.operationIdentity, timeoutMilliseconds)
      const changes = this.changes
      await this.refresh()
      this.changes = changes
    }
    return this
  }
  async update(
    attributes: Partial<WritableFields>,
    options: {
      readonly eventMode?: 'instance' | 'bulk'
      readonly atomicGroup?: string
    } = {},
  ): Promise<this> {
    this.fill(attributes)
    return this.save(options)
  }
  async delete(
    options: {
      readonly eventMode?: 'instance' | 'bulk'
      readonly atomicGroup?: string
    } = {},
  ): Promise<void> {
    return this.lifecycle('delete', options)
  }
  async forceDelete(
    options: {
      readonly eventMode?: 'instance' | 'bulk'
      readonly atomicGroup?: string
    } = {},
  ): Promise<void> {
    return this.lifecycle('forceDelete', options)
  }
  async restore(
    options: {
      readonly eventMode?: 'instance' | 'bulk'
      readonly atomicGroup?: string
    } = {},
  ): Promise<this> {
    await this.lifecycle('restore', options)
    return this
  }
  async touch(): Promise<this> {
    this.assertWritable()
    if (!this.definition.timestamps)
      throw new SynloquentError(
        'unsupported_query',
        'touch requires declared timestamps.',
      )
    this.draft[this.definition.timestamps.updatedAt] =
      this.storage.configuration.now()
    return this.save()
  }
  private async lifecycle(
    action: 'delete' | 'forceDelete' | 'restore',
    options: {
      readonly eventMode?: 'instance' | 'bulk'
      readonly atomicGroup?: string
    } = {},
  ): Promise<void> {
    this.assertWritable()
    if (!this.definition.operations.includes(action))
      throw new SynloquentError(
        'forbidden_operation',
        `${action} is not allowed for ${this.modelName}.`,
      )
    await this.storage.write(async (executor, changed) => {
      const current = await this.storage.findStored(
        this.modelName,
        this.localIdentity,
        executor,
      )
      if (!current)
        throw new SynloquentError('not_found', 'The model is not persisted.')
      if (!current.visible || current.deleted)
        throw new SynloquentError(
          'forbidden_operation',
          'This model is outside active authorized membership.',
        )
      const pending = (await this.storage.pending(executor)).filter(
        (entry) =>
          entry.operation.localIdentity === this.localIdentity &&
          ['pending', 'sending'].includes(entry.status),
      )
      const operation: Operation = {
        operationId: this.storage.configuration.generateIdentity(),
        model: this.modelName,
        localIdentity: this.localIdentity,
        action,
        values: {},
        dependsOn: pending.length
          ? [pending[pending.length - 1]!.operation.operationId]
          : [],
        ...options,
        ...(current.revision ? { expectedRevision: current.revision } : {}),
        ...(current.serverIdentity ? { id: current.serverIdentity } : {}),
      }
      if (
        action === 'forceDelete' ||
        (action === 'delete' && !this.definition.softDeletes)
      )
        await this.storage.deleteDependencies(
          this.modelName,
          this.localIdentity,
          executor,
          changed,
          'local',
        )
      const softField = this.definition.softDeletes
      const proposal = {
        ...current.proposal,
        ...(softField
          ? {
              [softField]:
                action === 'restore' ? null : this.storage.configuration.now(),
            }
          : {}),
      }
      const next = {
        ...current,
        proposal,
        visible: current.visible,
        deleted: action !== 'restore' && !(action === 'delete' && softField),
        state: 'pending' as const,
      }
      await this.storage.persist(next, executor, changed)
      await this.storage.append(operation, executor)
      this.operationIdentity = operation.operationId
      changed.add(this.modelName)
      this.record = next
      this.draft = { ...next.canonical, ...next.proposal }
      this.original = { ...this.draft }
    })
  }
  async increment(field: keyof Fields & string, amount = 1): Promise<this> {
    return this.delta(field, amount)
  }
  async decrement(field: keyof Fields & string, amount = 1): Promise<this> {
    return this.delta(field, -amount)
  }
  private async delta(
    field: keyof Fields & string,
    amount: number,
  ): Promise<this> {
    this.assertWritable()
    const definition = this.definition.fields[field]
    if (
      !this.definition.operations.includes('increment') ||
      !definition?.writable ||
      !['integer', 'float'].includes(definition.type) ||
      !Number.isFinite(amount) ||
      (definition.type === 'integer' && !Number.isSafeInteger(amount))
    )
      throw new SynloquentError(
        'forbidden_operation',
        'Atomic delta requires a writable integer/float field and a finite compatible amount.',
      )
    await this.storage.write(async (executor, changed) => {
      const current = await this.storage.findStored(
        this.modelName,
        this.localIdentity,
        executor,
      )
      if (!current)
        throw new SynloquentError('not_found', 'Delta target is not persisted.')
      if (!current.visible || current.deleted)
        throw new SynloquentError(
          'forbidden_operation',
          'This model is outside active authorized membership.',
        )
      const pending = (await this.storage.pending(executor)).filter(
        (entry) =>
          entry.operation.model === this.modelName &&
          entry.operation.localIdentity === this.localIdentity &&
          ['pending', 'sending'].includes(entry.status),
      )
      const operation: Operation = {
        operationId: this.storage.configuration.generateIdentity(),
        model: this.modelName,
        localIdentity: this.localIdentity,
        action: 'increment',
        values: { field, delta: amount },
        dependsOn: pending.length
          ? [pending[pending.length - 1]!.operation.operationId]
          : [],
        ...(current.revision ? { expectedRevision: current.revision } : {}),
        ...(current.serverIdentity ? { id: current.serverIdentity } : {}),
      }
      const exact =
        definition.type === 'integer'
          ? BigInt(String(current.attributes[field])) + BigInt(amount)
          : null
      const value =
        exact === null
          ? Number(current.attributes[field]) + amount
          : exact <= BigInt(Number.MAX_SAFE_INTEGER) &&
              exact >= BigInt(Number.MIN_SAFE_INTEGER)
            ? Number(exact)
            : exact.toString()
      validateValue(field, definition, value)
      const next = {
        ...current,
        proposal: { ...current.proposal, [field]: value },
        attributes: { ...current.attributes, [field]: value },
        state: 'pending' as const,
      }
      await this.storage.persist(next, executor, changed)
      await this.storage.append(operation, executor)
      this.operationIdentity = operation.operationId
      changed.add(this.modelName)
      this.record = next
      this.draft = { ...next.attributes }
      this.original = { ...next.attributes }
      this.changes = { [field]: value }
    })
    return this
  }
  async fresh(): Promise<ModelInstance<
    Fields,
    WritableFields,
    RelationNames
  > | null> {
    if (this.activePartition !== this.storage.partition)
      throw new SynloquentError(
        'session_changed',
        'Cannot refresh a model from a different account or device.',
      )
    if (this.remoteResult) {
      const { Query } = await import('./query.js')
      return new Query<Fields, WritableFields, RelationNames>(this.storage, {
        model: this.modelName,
      })
        .remote()
        .where(this.definition.primaryKey as keyof Fields & string, this.id)
        .first() as Promise<ModelInstance<
        Fields,
        WritableFields,
        RelationNames
      > | null>
    }
    return this.storage.read(async (executor) => {
      const record = await this.storage.findStored(
        this.modelName,
        this.record.localIdentity,
        executor,
      )
      return record?.visible && !record.deleted
        ? makeModel<Fields, WritableFields, RelationNames>(this.storage, record)
        : null
    })
  }
  async refresh(): Promise<this> {
    const fresh = await this.fresh()
    if (!fresh)
      throw new SynloquentError('not_found', 'Model no longer exists.')
    this.activeGeneration = this.storage.owner.generation
    this.record = fresh.record
    this.draft = { ...fresh.draft }
    this.original = { ...fresh.draft }
    this.changes = {}
    for (const relation of Object.values(this.relations)) relation.clear()
    return this
  }
  replicate(
    except: readonly string[] = [],
  ): ModelInstance<Fields, WritableFields, RelationNames> {
    const excluded = [
      this.definition.primaryKey,
      this.definition.timestamps?.createdAt,
      this.definition.timestamps?.updatedAt,
      ...except,
    ]
    const attributes = Object.fromEntries(
      Object.entries(this.draft).filter(
        ([field]) =>
          !excluded.includes(field) && this.definition.fields[field]?.writable,
      ),
    )
    return makeNewModel<Fields, WritableFields, RelationNames>(
      this.storage,
      this.modelName,
      attributes,
    )
  }
  relation(name: RelationNames): Relation {
    const relation = this.relations[name]
    if (!relation)
      throw new SynloquentError('unknown_relation', `Unknown relation ${name}.`)
    return relation
  }
  async load(...names: RelationNames[]): Promise<this> {
    this.assertActive()
    await Relation.load(
      [this],
      Object.fromEntries(
        names.map((name) => [
          name,
          { model: this.relation(name).definition.model },
        ]),
      ),
    )
    return this
  }
  async loadMissing(...names: RelationNames[]): Promise<this> {
    return this.load(...names.filter((name) => !this.relation(name).loaded))
  }
  async loadCount(
    ...names: RelationNames[]
  ): Promise<Readonly<Record<string, number>>> {
    await this.load(...names)
    const counts = Object.fromEntries(
      names.map((name) => [name, this.relation(name).current?.length ?? 0]),
    )
    for (const [name, count] of Object.entries(counts))
      this.aggregateValues[`${name}_count`] = count
    return counts
  }
  async loadExists(...names: RelationNames[]): Promise<Readonly<Attributes>> {
    for (const name of names)
      this.aggregateValues[`${name}_exists`] =
        await this.relation(name).exists()
    return this.aggregates
  }
  async loadSum(
    name: RelationNames,
    field: string,
  ): Promise<Readonly<Attributes>> {
    this.aggregateValues[`${name}_sum_${field}`] =
      await this.relation(name).sum(field)
    return this.aggregates
  }
  async loadMin(
    name: RelationNames,
    field: string,
  ): Promise<Readonly<Attributes>> {
    this.aggregateValues[`${name}_min_${field}`] =
      (await this.relation(name).min(field)) ?? null
    return this.aggregates
  }
  async loadMax(
    name: RelationNames,
    field: string,
  ): Promise<Readonly<Attributes>> {
    this.aggregateValues[`${name}_max_${field}`] =
      (await this.relation(name).max(field)) ?? null
    return this.aggregates
  }
  async loadAvg(
    name: RelationNames,
    field: string,
  ): Promise<Readonly<Attributes>> {
    this.aggregateValues[`${name}_avg_${field}`] =
      await this.relation(name).avg(field)
    return this.aggregates
  }
  toJSON(): Readonly<ViewFields> {
    this.assertActive()
    return Object.fromEntries(
      Object.entries(this.attributes).filter(
        ([field]) => this.definition.fields[field]?.readable,
      ),
    ) as ViewFields
  }
  canonicalRecord(): CanonicalRecord | null {
    return this.record.serverIdentity && this.record.revision
      ? {
          model: this.modelName,
          id: this.record.serverIdentity,
          revision: this.record.revision,
          attributes: this.record.canonical,
        }
      : null
  }
}
export function makeModel<
  Fields extends ReadableFields = Attributes,
  WritableFields extends Attributes = Attributes,
  RelationNames extends string = string,
>(
  storage: Storage,
  record: StoredRecord,
  persisted = true,
  detached = false,
): ModelInstance<Fields, WritableFields, RelationNames> {
  const model = new Model<Fields, WritableFields, RelationNames>(
    storage,
    record,
    persisted,
    detached,
  )
  return new Proxy(model, {
    get(target, property, receiver) {
      if (
        typeof property === 'string' &&
        property in target.definition.fields &&
        !(property in target)
      )
        return target.attributes[property]
      return Reflect.get(target, property, receiver)
    },
    set(target, property, value, receiver) {
      if (
        typeof property === 'string' &&
        property in target.definition.fields &&
        !(property in target)
      ) {
        target.fill({ [property]: value } as Partial<WritableFields>)
        return true
      }
      return Reflect.set(target, property, value, receiver)
    },
  }) as ModelInstance<Fields, WritableFields, RelationNames>
}
export function makeNewModel<
  Fields extends ReadableFields = Attributes,
  WritableFields extends Attributes = Attributes,
  RelationNames extends string = string,
>(
  storage: Storage,
  model: string,
  attributes: Attributes,
): ModelInstance<Fields, WritableFields, RelationNames> {
  const definition = storage.manifest.models[model]
  if (!definition)
    throw new SynloquentError('unknown_model', `Unknown model ${model}.`)
  const defaults = Object.fromEntries(
    Object.entries(definition.fields)
      .filter(([, field]) => field.default !== undefined)
      .map(([name, field]) => [name, field.default!]),
  )
  const values = {
    ...defaults,
    ...validateAttributes(definition, attributes, true),
  }
  return makeModel<Fields, WritableFields, RelationNames>(
    storage,
    {
      model,
      localIdentity: storage.configuration.generateIdentity(),
      serverIdentity: null,
      revision: null,
      canonical: {},
      proposal: {},
      attributes: values,
      visible: true,
      deleted: false,
      state: 'pending',
    },
    false,
  )
}
export type ModelCollection<
  Fields extends ReadableFields = Attributes,
  WritableFields extends Attributes = Attributes,
  RelationNames extends string = string,
> = Collection<ModelInstance<Fields, WritableFields, RelationNames>>

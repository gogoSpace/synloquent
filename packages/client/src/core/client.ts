import { Collection } from './collection.js'
import { QueryCompiler } from './compiler.js'
import { SynloquentError } from './errors.js'
import { type ReadonlyModelInstance } from './model.js'
import {
  ModelBinding,
  Query,
  type QueryModel,
  type QueryMode,
} from './query.js'
import { Storage } from './storage.js'
import { SyncEngine } from './sync.js'
import type {
  ReadableFields,
  Attributes,
  ClientConfiguration,
  QueryOptions,
  Session,
} from './types.js'
import { assertManifest } from './values.js'

export interface QuerySnapshot<
  Fields extends ReadableFields = Attributes,
  WritableFields extends Attributes = Attributes,
  RelationNames extends string = string,
  Selection extends (keyof Fields & string) | undefined = undefined,
  Mode extends QueryMode = 'local',
> {
  readonly data: Collection<
    QueryModel<Fields, WritableFields, RelationNames, Selection, Mode>
  >
  readonly loading: boolean
  readonly error: Error | null
  readonly generation: number
}
export class QuerySubscription<
  Fields extends ReadableFields = Attributes,
  WritableFields extends Attributes = Attributes,
  RelationNames extends string = string,
  Selection extends (keyof Fields & string) | undefined = undefined,
  Mode extends QueryMode = 'local',
> {
  private snapshot: QuerySnapshot<
    Fields,
    WritableFields,
    RelationNames,
    Selection,
    Mode
  >
  private listeners = new Set<() => void>()
  private unsubscribeOwner: (() => void) | undefined
  private disposed = false
  private requestGeneration = 0
  private dependencies: ReadonlySet<string>
  constructor(
    private readonly query: Query<
      Fields,
      WritableFields,
      RelationNames,
      Selection,
      Mode
    >,
  ) {
    this.snapshot = Object.freeze({
      data: new Collection<
        QueryModel<Fields, WritableFields, RelationNames, Selection, Mode>
      >(),
      loading: true,
      error: null,
      generation: query.storage.owner.generation,
    })
    this.dependencies = new QueryCompiler(
      query.storage.manifest,
      query.storage.partition,
    ).compile(query.options).dependencies
    const dependencies = new Set(this.dependencies)
    const collect = (
      model: string,
      includes: Readonly<Record<string, QueryOptions>>,
      depth: number,
    ): void => {
      if (depth > 16)
        throw new SynloquentError(
          'unsupported_query',
          'Subscription relation depth exceeds sixteen.',
        )
      for (const [name, options] of Object.entries(includes)) {
        const relation = query.storage.manifest.models[model]?.relations[name]
        if (!relation)
          throw new SynloquentError(
            'unknown_relation',
            `Unknown subscription relation ${model}.${name}.`,
          )
        dependencies.add(relation.model)
        if (relation.through) dependencies.add(relation.through)
        for (const target of Object.values(relation.morphMap ?? {}))
          dependencies.add(target)
        if (relation.pivot) dependencies.add(`pivot:${relation.pivot.table}`)
        if (options.include) collect(relation.model, options.include, depth + 1)
      }
    }
    collect(
      query.options.model,
      {
        ...query.options.include,
        ...Object.fromEntries(
          (query.options.relationAggregates ?? []).map((aggregate) => [
            aggregate.relation,
            { model: query.definition.relations[aggregate.relation]!.model },
          ]),
        ),
      },
      0,
    )
    this.dependencies = dependencies
  }
  private activate(): void {
    if (!this.unsubscribeOwner)
      this.unsubscribeOwner = this.query.storage.owner.subscribe((changed) => {
        if (
          changed.has('*') ||
          [...changed].some((table) => this.dependencies.has(table))
        )
          void this.refresh()
      })
  }
  getSnapshot = (): QuerySnapshot<
    Fields,
    WritableFields,
    RelationNames,
    Selection,
    Mode
  > => this.snapshot
  subscribe = (listener: () => void): (() => void) => {
    if (this.disposed)
      throw new SynloquentError('closed_database', 'Subscription is disposed.')
    const first = this.listeners.size === 0
    this.activate()
    this.listeners.add(listener)
    if (first) void this.refresh()
    return () => {
      this.listeners.delete(listener)
      if (!this.listeners.size) {
        this.requestGeneration++
        this.unsubscribeOwner?.()
        this.unsubscribeOwner = undefined
      }
    }
  }
  async refresh(): Promise<void> {
    if (this.disposed) return
    this.activate()
    const request = ++this.requestGeneration
    const generation = this.query.storage.owner.generation
    try {
      const data = await this.query.get()
      if (
        this.disposed ||
        request !== this.requestGeneration ||
        generation !== this.query.storage.owner.generation
      )
        return
      this.snapshot = Object.freeze({
        data,
        loading: false,
        error: null,
        generation,
      })
    } catch (error) {
      if (this.disposed || request !== this.requestGeneration) return
      this.snapshot = Object.freeze({
        data: this.snapshot.data,
        loading: false,
        error: error instanceof Error ? error : new Error(String(error)),
        generation,
      })
    }
    for (const listener of this.listeners) listener()
  }
  dispose(): void {
    this.disposed = true
    this.requestGeneration += 1
    this.unsubscribeOwner?.()
    this.unsubscribeOwner = undefined
    this.listeners.clear()
  }
}
export class SynloquentClient<
  Bindings extends object = Record<string, ModelBinding>,
  Commands extends object = Record<
    string,
    (
      arguments_: Attributes,
      operationId: string,
    ) => Promise<import('./types.js').WireValue>
  >,
  Scopes extends object = Record<
    string,
    (
      arguments_: Attributes,
    ) => Query<Attributes, Attributes, string, undefined, 'remote'>
  >,
> {
  readonly models: Bindings
  readonly sync: SyncEngine
  readonly commands: Commands
  readonly scopes: Scopes
  constructor(readonly storage: Storage) {
    this.models = Object.fromEntries(
      Object.keys(storage.manifest.models).map((model) => [
        model,
        new ModelBinding(storage, { model }),
      ]),
    ) as Bindings
    this.sync = new SyncEngine(storage, storage.configuration.transport)
    this.commands = Object.fromEntries(
      Object.keys(storage.manifest.commands ?? {}).map((name) => [
        name,
        (arguments_: Attributes, operationId: string) =>
          this.sync.command(name, arguments_, operationId),
      ]),
    ) as Commands
    this.scopes = Object.fromEntries(
      Object.entries(storage.manifest.scopes ?? {}).map(
        ([name, definition]) => [
          name,
          (arguments_: Attributes) =>
            new Query(storage, { model: definition.model })
              .remote()
              .scope(name, arguments_),
        ],
      ),
    ) as Scopes
  }
  query<Fields extends ReadableFields = Attributes>(
    model: string,
  ): Query<Fields> {
    return new Query<Fields>(this.storage, { model })
  }
  transaction<Result>(
    callback: (
      client: SynloquentClient<Bindings, Commands, Scopes>,
    ) => Promise<Result>,
  ): Promise<Result> {
    return this.storage.transaction((storage) =>
      callback(new SynloquentClient<Bindings, Commands, Scopes>(storage)),
    )
  }
  observe<
    Fields extends ReadableFields = Attributes,
    WritableFields extends Attributes = Attributes,
    RelationNames extends string = string,
    Selection extends (keyof Fields & string) | undefined = undefined,
    Mode extends QueryMode = 'local',
  >(
    query: Query<Fields, WritableFields, RelationNames, Selection, Mode>,
  ): QuerySubscription<Fields, WritableFields, RelationNames, Selection, Mode> {
    return new QuerySubscription(query)
  }
  async remote<Fields extends ReadableFields = Attributes>(
    options: QueryOptions,
  ): Promise<{
    readonly data: Collection<ReadonlyModelInstance<Fields>>
    readonly completeness: 'complete' | 'partial'
  }> {
    const data = await new Query<Fields>(this.storage, options).remote().get()
    return { data, completeness: data.completeness ?? 'partial' }
  }
  async setSession(session: Session): Promise<void> {
    return this.sync.setSession(session)
  }
  async close(): Promise<void> {
    this.storage.memoryCache.close()
    return this.storage.owner.close()
  }
}
export async function createSynloquent<
  Bindings extends object = Record<string, ModelBinding>,
  Commands extends object = Record<
    string,
    (
      arguments_: Attributes,
      operationId: string,
    ) => Promise<import('./types.js').WireValue>
  >,
  Scopes extends object = Record<
    string,
    (
      arguments_: Attributes,
    ) => Query<Attributes, Attributes, string, undefined, 'remote'>
  >,
>(
  configuration: ClientConfiguration,
): Promise<SynloquentClient<Bindings, Commands, Scopes>> {
  assertManifest(configuration.schema)
  const storage = new Storage(configuration)
  await storage.initialize()
  return new SynloquentClient<Bindings, Commands, Scopes>(storage)
}

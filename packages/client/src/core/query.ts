import type { DatabaseRow, TransactionExecutor } from './database.js'
import { Collection } from './collection.js'
import { QueryCompiler } from './compiler.js'
import { SynloquentError, unsupported } from './errors.js'
import {
  makeModel,
  Model,
  makeNewModel,
  type ModelInstance,
  type ReadonlyModelInstance,
} from './model.js'
import { Relation } from './relations.js'
import { SyncEngine } from './sync.js'
import { exactGroupedAggregate } from './grouped-aggregate.js'
import type { Storage } from './storage.js'
import {
  canonicalJson,
  exactDecimalAggregate,
  exactIntegerAggregate,
  validateValue,
} from './values.js'
import type {
  ReadableFields,
  Attributes,
  ComparisonOperator,
  Predicate,
  QueryOptions,
  QueryResponse,
  WireValue,
} from './types.js'

export interface Page<Value> {
  readonly data: Collection<Value>
  readonly page: number
  readonly perPage: number
  readonly total?: number
  readonly hasMore: boolean
  readonly completeness: 'complete' | 'partial'
}
export type QueryMode = 'local' | 'remote'
export type QueryProjection<
  Fields extends ReadableFields,
  Selection extends (keyof Fields & string) | undefined,
> = [Selection] extends [never]
  ? Pick<Fields, never>
  : [Selection] extends [undefined]
    ? Fields
    : Pick<Fields, Extract<Selection, keyof Fields>>
export type QueryModel<
  Fields extends ReadableFields,
  WritableFields extends Attributes = Attributes,
  RelationNames extends string = string,
  Selection extends (keyof Fields & string) | undefined = undefined,
  Mode extends QueryMode = 'local',
> = Mode extends 'remote'
  ? ReadonlyModelInstance<
      Fields,
      WritableFields,
      RelationNames,
      QueryProjection<Fields, Selection>
    >
  : ModelInstance<
      Fields,
      WritableFields,
      RelationNames,
      QueryProjection<Fields, Selection>
    >

export class Query<
  Fields extends ReadableFields = Attributes,
  WritableFields extends Attributes = Attributes,
  RelationNames extends string = string,
  Selection extends (keyof Fields & string) | undefined = undefined,
  Mode extends QueryMode = 'local',
> {
  constructor(
    readonly storage: Storage,
    readonly options: QueryOptions,
    private readonly partialAllowed = false,
    private readonly executionMode: Mode = 'local' as Mode,
  ) {}
  get observationKey(): string {
    return canonicalJson({
      options: this.options,
      mode: this.executionMode,
      allowPartial: this.partialAllowed,
      schemaFingerprint: this.storage.manifest.fingerprint,
    })
  }
  protected next<
    NextSelection extends (keyof Fields & string) | undefined = Selection,
  >(
    options: Partial<QueryOptions>,
  ): Query<Fields, WritableFields, RelationNames, NextSelection, Mode> {
    return new Query<
      Fields,
      WritableFields,
      RelationNames,
      NextSelection,
      Mode
    >(
      this.storage,
      { ...this.options, ...options },
      this.partialAllowed,
      this.executionMode,
    )
  }
  remote(): Query<Fields, WritableFields, RelationNames, Selection, 'remote'> {
    return new Query(this.storage, this.options, this.partialAllowed, 'remote')
  }
  scope(
    name: string,
    arguments_: Attributes,
  ): Query<Fields, WritableFields, RelationNames, Selection, Mode> {
    const definition = this.storage.manifest.scopes?.[name]
    if (!definition || definition.model !== this.options.model)
      throw new SynloquentError(
        'forbidden_operation',
        `Scope ${name} is not registered for ${this.options.model}.`,
      )
    return this.next({
      scopes: [...(this.options.scopes ?? []), { name, arguments: arguments_ }],
    })
  }
  allowPartial(): Query<
    Fields,
    WritableFields,
    RelationNames,
    Selection,
    Mode
  > {
    return new Query(this.storage, this.options, true, this.executionMode)
  }
  private async requireComplete(): Promise<void> {
    if (this.executionMode === 'remote') return
    if (!this.partialAllowed && (await this.completeness()) !== 'complete')
      throw new SynloquentError(
        'incomplete_dataset',
        'This aggregate or existence result would represent only a partial dataset. Use allowPartial explicitly or complete the dataset first.',
      )
  }
  async aggregateResult(
    function_: 'count' | 'min' | 'max' | 'sum' | 'avg',
    field?: keyof Fields & string,
  ): Promise<{
    readonly value: WireValue | undefined
    readonly completeness: 'complete' | 'partial'
  }> {
    const query = this.allowPartial()
    if (this.executionMode === 'remote') {
      const response = await query.requestAggregate(function_, field)
      return {
        value: response.aggregate!.value,
        completeness: response.completeness,
      }
    }
    const value =
      function_ === 'count'
        ? await query.count()
        : field
          ? await query[function_](field)
          : undefined
    return { value, completeness: await this.completeness() }
  }
  toAST(): QueryOptions {
    return JSON.parse(JSON.stringify(this.options)) as QueryOptions
  }
  private append(
    predicate: Predicate,
    boolean: 'and' | 'or' = 'and',
  ): Query<Fields, WritableFields, RelationNames, Selection, Mode> {
    return this.next({
      where: this.options.where
        ? {
            kind: 'group',
            boolean,
            predicates: [this.options.where, predicate],
          }
        : predicate,
    })
  }
  where(
    field: keyof Fields & string,
    value: WireValue,
  ): Query<Fields, WritableFields, RelationNames, Selection, Mode>
  where(
    field: keyof Fields & string,
    operator: ComparisonOperator,
    value: WireValue,
  ): Query<Fields, WritableFields, RelationNames, Selection, Mode>
  where(
    field: keyof Fields & string,
    operatorOrValue: ComparisonOperator | WireValue,
    value?: WireValue,
  ): Query<Fields, WritableFields, RelationNames, Selection, Mode> {
    return this.append({
      kind: 'comparison',
      field,
      operator:
        value === undefined ? '=' : (operatorOrValue as ComparisonOperator),
      value: value === undefined ? (operatorOrValue as WireValue) : value,
    })
  }
  orWhere(
    field: keyof Fields & string,
    value: WireValue,
  ): Query<Fields, WritableFields, RelationNames, Selection, Mode>
  orWhere(
    field: keyof Fields & string,
    operator: ComparisonOperator,
    value: WireValue,
  ): Query<Fields, WritableFields, RelationNames, Selection, Mode>
  orWhere(
    field: keyof Fields & string,
    operatorOrValue: ComparisonOperator | WireValue,
    value?: WireValue,
  ): Query<Fields, WritableFields, RelationNames, Selection, Mode> {
    return this.append(
      {
        kind: 'comparison',
        field,
        operator:
          value === undefined ? '=' : (operatorOrValue as ComparisonOperator),
        value: value === undefined ? (operatorOrValue as WireValue) : value,
      },
      'or',
    )
  }
  whereGroup(
    callback: (
      query: Query<Fields, WritableFields, RelationNames, Selection, Mode>,
    ) => Query<Fields, WritableFields, RelationNames, Selection, Mode>,
    boolean: 'and' | 'or' = 'and',
  ): Query<Fields, WritableFields, RelationNames, Selection, Mode> {
    const group = callback(
      new Query<Fields, WritableFields, RelationNames, Selection, Mode>(
        this.storage,
        {
          model: this.options.model,
        },
        this.partialAllowed,
        this.executionMode,
      ),
    )
    return group.options.where
      ? this.append(group.options.where, boolean)
      : this
  }
  whereNot(
    callback: (
      query: Query<Fields, WritableFields, RelationNames, Selection, Mode>,
    ) => Query<Fields, WritableFields, RelationNames, Selection, Mode>,
  ): Query<Fields, WritableFields, RelationNames, Selection, Mode> {
    const group = callback(
      new Query<Fields, WritableFields, RelationNames, Selection, Mode>(
        this.storage,
        {
          model: this.options.model,
        },
        this.partialAllowed,
        this.executionMode,
      ),
    )
    return group.options.where
      ? this.append({ kind: 'not', predicate: group.options.where })
      : this
  }
  whereColumn(
    field: keyof Fields & string,
    operator: '=' | '!=' | '<' | '<=' | '>' | '>=',
    otherField: keyof Fields & string,
  ): Query<Fields, WritableFields, RelationNames, Selection, Mode> {
    return this.append({ kind: 'column', field, operator, otherField })
  }
  whereIn(
    field: keyof Fields & string,
    values: readonly WireValue[],
  ): Query<Fields, WritableFields, RelationNames, Selection, Mode> {
    return this.where(field, 'in', values)
  }
  whereNotIn(
    field: keyof Fields & string,
    values: readonly WireValue[],
  ): Query<Fields, WritableFields, RelationNames, Selection, Mode> {
    return this.where(field, 'notIn', values)
  }
  whereNull(
    field: keyof Fields & string,
  ): Query<Fields, WritableFields, RelationNames, Selection, Mode> {
    return this.append({ kind: 'comparison', field, operator: 'isNull' })
  }
  whereNotNull(
    field: keyof Fields & string,
  ): Query<Fields, WritableFields, RelationNames, Selection, Mode> {
    return this.append({ kind: 'comparison', field, operator: 'isNotNull' })
  }
  whereBetween(
    field: keyof Fields & string,
    values: readonly [WireValue, WireValue],
  ): Query<Fields, WritableFields, RelationNames, Selection, Mode> {
    return this.where(field, 'between', values)
  }
  whereNotBetween(
    field: keyof Fields & string,
    values: readonly [WireValue, WireValue],
  ): Query<Fields, WritableFields, RelationNames, Selection, Mode> {
    return this.where(field, 'notBetween', values)
  }
  whereJsonContains(
    field: keyof Fields & string,
    value: WireValue,
  ): Query<Fields, WritableFields, RelationNames, Selection, Mode> {
    return this.where(field, 'jsonContains', value)
  }
  whereJsonPath(
    field: keyof Fields & string,
    path: string,
    value: WireValue,
  ): Query<Fields, WritableFields, RelationNames, Selection, Mode> {
    return this.where(field, 'jsonPath', { path, value })
  }
  select<Keys extends readonly (keyof Fields & string)[]>(
    ...fields: Keys
  ): Query<Fields, WritableFields, RelationNames, Keys[number], Mode> {
    return this.next<Keys[number]>({ select: fields })
  }
  addSelect<Keys extends readonly (keyof Fields & string)[]>(
    ...fields: Keys
  ): Query<
    Fields,
    WritableFields,
    RelationNames,
    Exclude<Selection, undefined> | Keys[number],
    Mode
  > {
    return this.next<Exclude<Selection, undefined> | Keys[number]>({
      select: [...new Set([...(this.options.select ?? []), ...fields])],
    })
  }
  distinct(): Query<Fields, WritableFields, RelationNames, Selection, Mode> {
    return this.next({ distinct: true })
  }
  orderBy(
    field: keyof Fields & string,
    direction: 'asc' | 'desc' = 'asc',
  ): Query<Fields, WritableFields, RelationNames, Selection, Mode> {
    return this.next({
      orderBy: [...(this.options.orderBy ?? []), { field, direction }],
    })
  }
  orderByDesc(
    field: keyof Fields & string,
  ): Query<Fields, WritableFields, RelationNames, Selection, Mode> {
    return this.orderBy(field, 'desc')
  }
  reorder(
    field?: keyof Fields & string,
    direction: 'asc' | 'desc' = 'asc',
  ): Query<Fields, WritableFields, RelationNames, Selection, Mode> {
    return this.next({ orderBy: field ? [{ field, direction }] : [] })
  }
  latest(
    field: keyof Fields & string = (this.definition.timestamps?.createdAt ??
      this.definition.primaryKey) as keyof Fields & string,
  ): Query<Fields, WritableFields, RelationNames, Selection, Mode> {
    return this.orderByDesc(field)
  }
  oldest(
    field: keyof Fields & string = (this.definition.timestamps?.createdAt ??
      this.definition.primaryKey) as keyof Fields & string,
  ): Query<Fields, WritableFields, RelationNames, Selection, Mode> {
    return this.orderBy(field)
  }
  limit(
    limit: number,
  ): Query<Fields, WritableFields, RelationNames, Selection, Mode> {
    return this.next({ limit })
  }
  take(
    limit: number,
  ): Query<Fields, WritableFields, RelationNames, Selection, Mode> {
    return this.limit(limit)
  }
  offset(
    offset: number,
  ): Query<Fields, WritableFields, RelationNames, Selection, Mode> {
    return this.next({ offset })
  }
  skip(
    offset: number,
  ): Query<Fields, WritableFields, RelationNames, Selection, Mode> {
    return this.offset(offset)
  }
  groupBy(
    ...fields: (keyof Fields & string)[]
  ): Query<Fields, WritableFields, RelationNames, Selection, Mode> {
    return this.next({ groupBy: fields })
  }
  having(
    field: (keyof Fields & string) | '$aggregate',
    operator: ComparisonOperator,
    value: WireValue,
  ): Query<Fields, WritableFields, RelationNames, Selection, Mode> {
    return this.next({ having: { kind: 'comparison', field, operator, value } })
  }
  when(
    condition: unknown,
    callback: (
      query: Query<Fields, WritableFields, RelationNames, Selection, Mode>,
    ) => Query<Fields, WritableFields, RelationNames, Selection, Mode>,
    otherwise?: (
      query: Query<Fields, WritableFields, RelationNames, Selection, Mode>,
    ) => Query<Fields, WritableFields, RelationNames, Selection, Mode>,
  ): Query<Fields, WritableFields, RelationNames, Selection, Mode> {
    return condition ? callback(this) : otherwise ? otherwise(this) : this
  }
  unless(
    condition: unknown,
    callback: (
      query: Query<Fields, WritableFields, RelationNames, Selection, Mode>,
    ) => Query<Fields, WritableFields, RelationNames, Selection, Mode>,
    otherwise?: (
      query: Query<Fields, WritableFields, RelationNames, Selection, Mode>,
    ) => Query<Fields, WritableFields, RelationNames, Selection, Mode>,
  ): Query<Fields, WritableFields, RelationNames, Selection, Mode> {
    return this.when(!condition, callback, otherwise)
  }
  with(
    ...names: (RelationNames | `${RelationNames}.${string}`)[]
  ): Query<Fields, WritableFields, RelationNames, Selection, Mode> {
    const include: Record<string, QueryOptions> = { ...this.options.include }
    for (const path of names) {
      const [name, ...nested] = path.split('.')
      const relation = name ? this.definition.relations[name] : undefined
      if (!name || !relation)
        throw new SynloquentError(
          'unknown_relation',
          `Unknown relation ${path}.`,
        )
      include[name] = nested.length
        ? new Query(
            this.storage,
            include[name] ?? { model: relation.model },
          ).with(nested.join('.')).options
        : (include[name] ?? { model: relation.model })
    }
    return this.next({ include })
  }
  withConstrained(
    name: RelationNames,
    callback: (query: Query) => { readonly options: QueryOptions },
  ): Query<Fields, WritableFields, RelationNames, Selection, Mode> {
    const relation = this.definition.relations[name]
    if (!relation)
      throw new SynloquentError('unknown_relation', `Unknown relation ${name}.`)
    return this.next({
      include: {
        ...this.options.include,
        [name]: callback(new Query(this.storage, { model: relation.model }))
          .options,
      },
    })
  }
  private withAggregate(
    relation: RelationNames,
    function_: 'count' | 'exists' | 'sum' | 'min' | 'max' | 'avg',
    field?: string,
    alias?: string,
  ): Query<Fields, WritableFields, RelationNames, Selection, Mode> {
    if (!this.definition.relations[relation])
      throw new SynloquentError(
        'unknown_relation',
        `Unknown relation ${relation}.`,
      )
    return this.next({
      relationAggregates: [
        ...(this.options.relationAggregates ?? []),
        {
          relation,
          function: function_,
          ...(field ? { field } : {}),
          ...(alias ? { alias } : {}),
        },
      ],
    })
  }
  withCount(
    ...relations: RelationNames[]
  ): Query<Fields, WritableFields, RelationNames, Selection, Mode> {
    return relations.reduce<
      Query<Fields, WritableFields, RelationNames, Selection, Mode>
    >((query, relation) => query.withAggregate(relation, 'count'), this)
  }
  withExists(
    ...relations: RelationNames[]
  ): Query<Fields, WritableFields, RelationNames, Selection, Mode> {
    return relations.reduce<
      Query<Fields, WritableFields, RelationNames, Selection, Mode>
    >((query, relation) => query.withAggregate(relation, 'exists'), this)
  }
  withSum(
    relation: RelationNames,
    field: string,
  ): Query<Fields, WritableFields, RelationNames, Selection, Mode> {
    return this.withAggregate(relation, 'sum', field)
  }
  withMin(
    relation: RelationNames,
    field: string,
  ): Query<Fields, WritableFields, RelationNames, Selection, Mode> {
    return this.withAggregate(relation, 'min', field)
  }
  withMax(
    relation: RelationNames,
    field: string,
  ): Query<Fields, WritableFields, RelationNames, Selection, Mode> {
    return this.withAggregate(relation, 'max', field)
  }
  withAvg(
    relation: RelationNames,
    field: string,
  ): Query<Fields, WritableFields, RelationNames, Selection, Mode> {
    return this.withAggregate(relation, 'avg', field)
  }
  has(
    relation: string,
    operator: '=' | '!=' | '<' | '<=' | '>' | '>=' = '>=',
    count = 1,
  ): Query<Fields, WritableFields, RelationNames, Selection, Mode> {
    return this.append({ kind: 'relation', relation, operator, count })
  }
  doesntHave(
    relation: string,
  ): Query<Fields, WritableFields, RelationNames, Selection, Mode> {
    return this.has(relation, '=', 0)
  }
  orHas(
    relation: string,
    operator: '=' | '!=' | '<' | '<=' | '>' | '>=' = '>=',
    count = 1,
  ): Query<Fields, WritableFields, RelationNames, Selection, Mode> {
    return this.append({ kind: 'relation', relation, operator, count }, 'or')
  }
  orDoesntHave(
    relation: string,
  ): Query<Fields, WritableFields, RelationNames, Selection, Mode> {
    return this.orHas(relation, '=', 0)
  }
  whereHas(
    relation: string,
    callback: (query: Query) => { readonly options: QueryOptions },
    operator: '=' | '!=' | '<' | '<=' | '>' | '>=' = '>=',
    count = 1,
  ): Query<Fields, WritableFields, RelationNames, Selection, Mode> {
    const related = this.definition.relations[relation]
    if (!related)
      throw new SynloquentError(
        'unknown_relation',
        `Unknown relation ${relation}.`,
      )
    const where = callback(new Query(this.storage, { model: related.model }))
      .options.where
    return this.append({
      kind: 'relation',
      relation,
      operator,
      count,
      ...(where ? { predicate: where } : {}),
    })
  }
  whereDoesntHave(
    relation: string,
    callback: (query: Query) => { readonly options: QueryOptions },
  ): Query<Fields, WritableFields, RelationNames, Selection, Mode> {
    return this.whereHas(relation, callback, '=', 0)
  }
  orWhereHas(
    relation: string,
    callback: (query: Query) => { readonly options: QueryOptions },
  ): Query<Fields, WritableFields, RelationNames, Selection, Mode> {
    const predicate = new Query<
      Fields,
      WritableFields,
      RelationNames,
      Selection,
      Mode
    >(this.storage, { model: this.options.model }).whereHas(relation, callback)
      .options.where
    return predicate ? this.append(predicate, 'or') : this
  }
  orWhereDoesntHave(
    relation: string,
    callback: (query: Query) => { readonly options: QueryOptions },
  ): Query<Fields, WritableFields, RelationNames, Selection, Mode> {
    const predicate = new Query<
      Fields,
      WritableFields,
      RelationNames,
      Selection,
      Mode
    >(this.storage, { model: this.options.model }).whereDoesntHave(
      relation,
      callback,
    ).options.where
    return predicate ? this.append(predicate, 'or') : this
  }
  whereRelation(
    relation: string,
    field: string,
    operator: ComparisonOperator,
    value: WireValue,
  ): Query<Fields, WritableFields, RelationNames, Selection, Mode> {
    return this.whereHas(relation, (query) =>
      query.where(field, operator, value),
    )
  }
  whereMorphRelation(
    relation: RelationNames,
    models: readonly string[],
    field: string,
    operator: ComparisonOperator,
    value: WireValue,
  ): Query<Fields, WritableFields, RelationNames, Selection, Mode> {
    const definition = this.definition.relations[relation]
    if (
      definition?.type !== 'morphTo' ||
      !definition.morphMap ||
      !models.length ||
      models.length > 32 ||
      new Set(models).size !== models.length ||
      models.some(
        (model) => !Object.values(definition.morphMap!).includes(model),
      )
    )
      throw new SynloquentError(
        'unknown_relation',
        'Morph predicates require unique targets from an explicit declared morphTo map.',
      )
    return this.append({
      kind: 'relation',
      relation,
      morphModels: [...models],
      predicate: { kind: 'comparison', field, operator, value },
    })
  }
  whereBelongsTo(
    model: Pick<Model<ReadableFields>, 'modelName' | 'id' | 'attributes'>,
    relationName?: string,
  ): Query<Fields, WritableFields, RelationNames, Selection, Mode> {
    const found = relationName
      ? ([relationName, this.definition.relations[relationName]] as const)
      : Object.entries(this.definition.relations).find(
          ([, relation]) =>
            relation.type === 'belongsTo' && relation.model === model.modelName,
        )
    if (
      !found?.[1]?.foreignKey ||
      found[1].type !== 'belongsTo' ||
      found[1].model !== model.modelName
    )
      throw new SynloquentError(
        'unknown_relation',
        'No declared belongsTo relation matches.',
      )
    const target = this.storage.manifest.models[found[1].model]!
    const owner = found[1].ownerKey ?? target.primaryKey
    if (!target.fields[owner]?.readable)
      throw new SynloquentError(
        'forbidden_field',
        'Belongs-to owner key is not readable in the declared target model.',
      )
    if (model instanceof Model) {
      model.assertActive()
      if (model.storage.owner !== this.storage.owner)
        throw new SynloquentError(
          'validation_failed',
          'Belongs-to target belongs to another database owner.',
        )
    }
    const value =
      (model instanceof Model
        ? model.rawAttributes()[owner]
        : model.attributes[owner]) ??
      (owner === target.primaryKey ? model.id : undefined)
    if (value === undefined)
      throw new SynloquentError(
        'validation_failed',
        'Belongs-to target does not expose its declared owner key.',
      )
    return this.where(found[1].foreignKey as keyof Fields & string, value)
  }
  withTrashed(): Query<Fields, WritableFields, RelationNames, Selection, Mode> {
    return this.next({ trashed: 'include' })
  }
  onlyTrashed(): Query<Fields, WritableFields, RelationNames, Selection, Mode> {
    return this.next({ trashed: 'only' })
  }
  get definition() {
    const definition = this.storage.manifest.models[this.options.model]
    if (!definition)
      throw new SynloquentError(
        'unknown_model',
        `Unknown model ${this.options.model}.`,
      )
    return definition
  }
  async get(): Promise<
    Collection<
      QueryModel<Fields, WritableFields, RelationNames, Selection, Mode>
    >
  > {
    if (this.executionMode === 'remote') return this.remoteGet()
    return this.storage.read(async (executor) => {
      const compiled = new QueryCompiler(
        this.storage.manifest,
        this.storage.partition,
      ).compile(this.options)
      const result = await executor.execute(
        compiled.statement,
        compiled.parameters,
      )
      const models = await this.hydrateRows(result.rows, executor)
      return new Collection(models, await this.completeness(executor))
    })
  }
  private async hydrateRows(
    rows: readonly DatabaseRow[],
    executor: TransactionExecutor,
  ): Promise<
    QueryModel<Fields, WritableFields, RelationNames, Selection, Mode>[]
  > {
    const models = rows.map((row) => {
      const model = makeModel<Fields, WritableFields, RelationNames>(
        this.storage,
        this.storage.row(this.options.model, row),
      )
      for (const [field, value] of Object.entries(row))
        if (field.startsWith('_projection_'))
          model.setProjection(
            field.slice(12),
            value instanceof Uint8Array ? null : value,
          )
      return model
    })
    const include: Record<string, QueryOptions> = { ...this.options.include }
    for (const aggregate of this.options.relationAggregates ?? []) {
      const relation = this.definition.relations[aggregate.relation]
      if (!relation)
        throw new SynloquentError(
          'unknown_relation',
          `Unknown relation ${aggregate.relation}.`,
        )
      include[aggregate.relation] ??= { model: relation.model }
    }
    if (Object.keys(include).length)
      await Relation.hydrateMany(models, include, executor)
    for (const model of models)
      for (const aggregate of this.options.relationAggregates ?? []) {
        const relation = model.relation(aggregate.relation as RelationNames)
        const alias =
          aggregate.alias ??
          `${aggregate.relation}_${aggregate.function}${aggregate.field ? `_${aggregate.field}` : ''}`
        model.setAggregate(
          alias,
          aggregate.function === 'count'
            ? (relation.current?.length ?? 0)
            : aggregate.function === 'exists'
              ? Boolean(relation.current?.length)
              : aggregate.field
                ? ((await relation[aggregate.function](aggregate.field)) ??
                  null)
                : null,
        )
      }
    if (this.options.select)
      for (const model of models)
        model.project([...this.options.select, this.definition.primaryKey])
    return models as QueryModel<
      Fields,
      WritableFields,
      RelationNames,
      Selection,
      Mode
    >[]
  }
  private async remoteGet(): Promise<
    Collection<
      QueryModel<Fields, WritableFields, RelationNames, Selection, Mode>
    >
  > {
    const transport = this.storage.configuration.transport
    if (!transport)
      throw new SynloquentError(
        'unsupported_query',
        'No remote transport is configured.',
      )
    const request = {
      protocolVersion: 1 as const,
      requestId: this.storage.configuration.generateIdentity(),
      kind: 'query',
      schemaFingerprint: this.storage.manifest.fingerprint,
      session: { ...this.storage.session },
      payload: this.options,
    }
    const token =
      JSON.stringify(this.storage.session) +
      String(this.storage.owner.generation)
    const response = await transport.query(request)
    if (
      token !==
      JSON.stringify(this.storage.session) +
        String(this.storage.owner.generation)
    )
      throw new SynloquentError(
        'session_changed',
        'Remote query belongs to a replaced session or generation.',
      )
    if (
      !Array.isArray(response.records) ||
      !Array.isArray(response.related) ||
      !Array.isArray(response.relationSets) ||
      response.scope.schemaFingerprint !== this.storage.manifest.fingerprint
    )
      throw new SynloquentError(
        'schema_mismatch',
        'Malformed remote query response.',
      )
    const make = (record: import('./types.js').CanonicalRecord) =>
      makeModel<Fields, WritableFields, RelationNames>(
        this.storage,
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
      )
    const models = response.records.map((record) => {
      const model = make(record)
      const computed = response.computed?.[`${record.model}:${record.id}`]
      for (const [name, value] of Object.entries(computed?.aggregates ?? {}))
        model.setAggregate(name, value)
      for (const [name, value] of Object.entries(computed?.projections ?? {}))
        model.setProjection(name, value)
      return model
    })
    if (this.options.include)
      Relation.hydrateRemote(
        models,
        this.options.include,
        response.related,
        response.relationSets,
      )
    if (this.options.select)
      for (const model of models)
        model.project([...this.options.select, this.definition.primaryKey])
    return new Collection(
      models as QueryModel<
        Fields,
        WritableFields,
        RelationNames,
        Selection,
        Mode
      >[],
      response.completeness,
    )
  }
  all(): Promise<
    Collection<
      QueryModel<Fields, WritableFields, RelationNames, Selection, Mode>
    >
  > {
    return this.get()
  }
  async find(
    identity: string | number,
  ): Promise<QueryModel<
    Fields,
    WritableFields,
    RelationNames,
    Selection,
    Mode
  > | null> {
    if (this.executionMode === 'remote') {
      const stored = await this.storage.read((executor) =>
        this.storage.findStored(this.options.model, identity, executor),
      )
      if (stored && !stored.serverIdentity) return null
      const canonical = stored?.serverIdentity ?? identity
      if (
        this.definition.keyType === 'integer' &&
        !/^-?\d+$/.test(String(canonical))
      )
        throw new SynloquentError(
          'validation_failed',
          'Remote integer identity has no confirmed canonical alias.',
        )
      return this.where(
        this.definition.primaryKey as keyof Fields & string,
        canonical,
      ).first()
    }
    return this.storage.read(async (executor) => {
      const record = await this.storage.findStored(
        this.options.model,
        identity,
        executor,
      )
      if (!record) return null
      const compiled = new QueryCompiler(
        this.storage.manifest,
        this.storage.partition,
      ).compile(this.options, record.localIdentity)
      const result = await executor.execute(
        compiled.statement,
        compiled.parameters,
      )
      if (!result.rows[0]) return null
      return (await this.hydrateRows(result.rows, executor))[0] ?? null
    })
  }
  async findOrFail(
    identity: string | number,
  ): Promise<
    QueryModel<Fields, WritableFields, RelationNames, Selection, Mode>
  > {
    const model = await this.find(identity)
    if (!model)
      throw new SynloquentError(
        'not_found',
        `Model ${this.options.model} was not found.`,
      )
    return model
  }
  async first(): Promise<QueryModel<
    Fields,
    WritableFields,
    RelationNames,
    Selection,
    Mode
  > | null> {
    return (await this.limit(1).get()).first() ?? null
  }
  async firstOrFail(): Promise<
    QueryModel<Fields, WritableFields, RelationNames, Selection, Mode>
  > {
    const model = await this.first()
    if (!model)
      throw new SynloquentError(
        'not_found',
        `Model ${this.options.model} was not found.`,
      )
    return model
  }
  async value<Key extends keyof Fields & string>(
    field: Key,
  ): Promise<Fields[Key] | undefined> {
    return (
      (await this.select(field).first())?.attributes as
        Readonly<Fields> | undefined
    )?.[field]
  }
  async pluck<Key extends keyof Fields & string>(
    field: Key,
  ): Promise<Collection<Fields[Key]>> {
    return (await this.select(field).get()).map(
      (model) => (model.attributes as Readonly<Fields>)[field],
    )
  }
  async exists(): Promise<boolean> {
    await this.requireComplete()
    return Boolean(await this.first())
  }
  async doesntExist(): Promise<boolean> {
    await this.requireComplete()
    return !(await this.exists())
  }
  async count(): Promise<number> {
    await this.requireComplete()
    return this.executionMode === 'remote'
      ? Number(await this.remoteAggregate('count'))
      : (await this.get()).length
  }
  async min(field: keyof Fields & string): Promise<WireValue | undefined> {
    await this.requireComplete()
    return this.executionMode === 'remote'
      ? this.remoteAggregate('min', field)
      : this.whereNotNull(field).reorder(field).value(field)
  }
  async max(field: keyof Fields & string): Promise<WireValue | undefined> {
    await this.requireComplete()
    return this.executionMode === 'remote'
      ? this.remoteAggregate('max', field)
      : this.whereNotNull(field).reorder(field, 'desc').value(field)
  }
  async sum(field: keyof Fields & string): Promise<number | string> {
    await this.requireComplete()
    if (this.executionMode === 'remote') {
      const value = await this.remoteAggregate('sum', field)
      return this.definition.fields[field]?.type === 'integer' &&
        typeof value === 'string' &&
        !Number.isSafeInteger(Number(value))
        ? value
        : this.definition.fields[field]?.type === 'decimal'
          ? String(value)
          : Number(value)
    }
    const values = (await this.pluck(field)).items.map((value) => value ?? null)
    return this.definition.fields[field]?.type === 'integer'
      ? (exactIntegerAggregate(values) ?? 0)
      : this.definition.fields[field]?.type === 'decimal'
        ? (exactDecimalAggregate(
            values,
            this.definition.fields[field]?.precision ?? 18,
            false,
          ) ?? '0')
        : values.reduce<number>((total, value) => total + Number(value ?? 0), 0)
  }
  async avg(field: keyof Fields & string): Promise<number | string | null> {
    await this.requireComplete()
    if (this.executionMode === 'remote') {
      const value = await this.remoteAggregate('avg', field)
      return value === null
        ? null
        : this.definition.fields[field]?.type === 'integer' &&
            typeof value === 'string' &&
            !Number.isSafeInteger(Number(value))
          ? value
          : this.definition.fields[field]?.type === 'decimal'
            ? String(value)
            : Number(value)
    }
    const values = (await this.pluck(field)).items.filter(
      (value) => value !== null,
    )
    return this.definition.fields[field]?.type === 'integer'
      ? exactIntegerAggregate(values, true)
      : this.definition.fields[field]?.type === 'decimal'
        ? exactDecimalAggregate(
            values,
            this.definition.fields[field]?.precision ?? 18,
            true,
          )
        : values.length
          ? values.reduce<number>((total, value) => total + Number(value), 0) /
            values.length
          : null
  }
  async aggregateGroups(
    function_: 'count' | 'min' | 'max' | 'sum' | 'avg',
    field?: keyof Fields & string,
  ): Promise<{
    readonly groups: readonly {
      readonly keys: Attributes
      readonly value: WireValue
    }[]
    readonly completeness: 'complete' | 'partial'
  }> {
    if (!this.options.groupBy?.length)
      throw new SynloquentError(
        'unsupported_query',
        'Grouped aggregates require declared group fields.',
      )
    await this.requireComplete()
    if (this.executionMode === 'remote') {
      const response = await this.requestAggregate(function_, field)
      if (!response.aggregate?.groups)
        throw new SynloquentError(
          'schema_mismatch',
          'Remote grouped aggregate has no groups.',
        )
      return {
        groups: response.aggregate.groups,
        completeness: response.completeness,
      }
    }
    return this.storage.read(async (executor) => {
      return {
        groups: await exactGroupedAggregate(
          this.storage,
          this.options,
          function_,
          field,
          executor,
        ),
        completeness: await this.completeness(executor),
      }
    })
  }
  private async remoteAggregate(
    function_: 'count' | 'min' | 'max' | 'sum' | 'avg',
    field?: string,
  ): Promise<WireValue> {
    return (await this.requestAggregate(function_, field)).aggregate!.value
  }
  private async requestAggregate(
    function_: 'count' | 'min' | 'max' | 'sum' | 'avg',
    field?: string,
  ): Promise<QueryResponse> {
    const transport = this.storage.configuration.transport
    if (!transport)
      throw new SynloquentError(
        'unsupported_query',
        'No remote transport is configured.',
      )
    const request = {
      protocolVersion: 1 as const,
      requestId: this.storage.configuration.generateIdentity(),
      kind: 'query',
      schemaFingerprint: this.storage.manifest.fingerprint,
      session: { ...this.storage.session },
      payload: {
        ...this.options,
        aggregate: { function: function_, ...(field ? { field } : {}) },
      },
    }
    const token =
      JSON.stringify(this.storage.session) +
      String(this.storage.owner.generation)
    const response = await transport.query(request)
    if (
      token !==
      JSON.stringify(this.storage.session) +
        String(this.storage.owner.generation)
    )
      throw new SynloquentError(
        'session_changed',
        'Remote aggregate belongs to a previous session.',
      )
    if (
      !response.aggregate ||
      response.scope.schemaFingerprint !== this.storage.manifest.fingerprint
    )
      throw new SynloquentError(
        'schema_mismatch',
        'Remote aggregate response has no declared aggregate value.',
      )
    if (response.completeness !== 'complete' && !this.partialAllowed)
      throw new SynloquentError(
        'incomplete_dataset',
        'Remote aggregate describes a partial dataset.',
      )
    return response
  }
  async completeness(
    executor?: import('./database.js').TransactionExecutor,
  ): Promise<'complete' | 'partial'> {
    const scope = await this.storage.metadata('scope', executor)
    return scope &&
      (JSON.parse(scope) as { completeness?: string }).completeness ===
        'complete'
      ? 'complete'
      : 'partial'
  }
  async paginate(
    perPage = 15,
    page = 1,
  ): Promise<
    Page<QueryModel<Fields, WritableFields, RelationNames, Selection, Mode>>
  > {
    const total = await this.count()
    return {
      data: await this.offset((page - 1) * perPage)
        .limit(perPage)
        .get(),
      page,
      perPage,
      total,
      hasMore: total > page * perPage,
      completeness: await this.completeness(),
    }
  }
  async simplePaginate(
    perPage = 15,
    page = 1,
  ): Promise<
    Page<QueryModel<Fields, WritableFields, RelationNames, Selection, Mode>>
  > {
    const data = await this.offset((page - 1) * perPage)
      .limit(perPage + 1)
      .get()
    return {
      data: new Collection(data.items.slice(0, perPage)),
      page,
      perPage,
      hasMore: data.length > perPage,
      completeness: await this.completeness(),
    }
  }
  async cursorPaginate(
    perPage = 15,
    cursor?: string,
  ): Promise<{
    readonly data: Collection<
      QueryModel<Fields, WritableFields, RelationNames, Selection, Mode>
    >
    readonly nextCursor: string | null
    readonly completeness: 'complete' | 'partial'
  }> {
    if (!Number.isSafeInteger(perPage) || perPage < 1 || perPage > 1000)
      throw new SynloquentError(
        'validation_failed',
        'Cursor page size must be from one to one thousand.',
      )
    if (this.options.offset)
      throw new SynloquentError(
        'unsupported_query',
        'Cursor pagination does not combine with an offset.',
      )
    const ordering = [...(this.options.orderBy ?? [])]
    if (!ordering.some((order) => order.field === this.definition.primaryKey))
      ordering.push({ field: this.definition.primaryKey, direction: 'asc' })
    const {
      limit: ignoredLimit,
      offset: ignoredOffset,
      ...scopeOptions
    } = this.options
    void ignoredLimit
    void ignoredOffset
    const binding = canonicalJson({
      query: scopeOptions,
      schema: this.storage.manifest.fingerprint,
      partition: this.storage.partition,
      scope: await this.storage.metadata('scope'),
      snapshot: await this.storage.metadata('snapshotGeneration'),
    })
    let query = this.next({ orderBy: ordering })
    if (cursor) {
      let parsed: { binding?: unknown; values?: unknown }
      try {
        parsed = JSON.parse(cursor) as typeof parsed
      } catch {
        throw new SynloquentError(
          'cursor_expired',
          'Pagination cursor is malformed.',
        )
      }
      if (
        parsed.binding !== binding ||
        !Array.isArray(parsed.values) ||
        parsed.values.length !== ordering.length
      )
        throw new SynloquentError(
          'cursor_expired',
          'Pagination cursor belongs to another query, order, schema or authorization scope.',
        )
      const after: Predicate[] = []
      for (let index = 0; index < ordering.length; index++) {
        const order = ordering[index]!
        const value = parsed.values[index] as WireValue
        const field = this.definition.fields[order.field]
        if (!field)
          throw new SynloquentError(
            'unknown_field',
            `Unknown cursor order field ${order.field}.`,
          )
        if (value !== null) validateValue(order.field, field, value)
        const prefix: Predicate[] = ordering
          .slice(0, index)
          .map((previous, position) => ({
            kind: 'comparison',
            field: previous.field,
            operator: '=',
            value: (parsed.values as WireValue[])[position] ?? null,
          }))
        let comparison: Predicate =
          value === null
            ? order.direction === 'asc'
              ? {
                  kind: 'comparison',
                  field: order.field,
                  operator: 'isNotNull',
                }
              : { kind: 'group', boolean: 'or', predicates: [] }
            : {
                kind: 'comparison',
                field: order.field,
                operator: order.direction === 'asc' ? '>' : '<',
                value,
              }
        if (value !== null && order.direction === 'desc')
          comparison = {
            kind: 'group',
            boolean: 'or',
            predicates: [
              comparison,
              { kind: 'comparison', field: order.field, operator: 'isNull' },
            ],
          }
        after.push({
          kind: 'group',
          boolean: 'and',
          predicates: [...prefix, comparison],
        })
      }
      query = query.append({ kind: 'group', boolean: 'or', predicates: after })
    }
    const rows = await query.limit(perPage + 1).get()
    const data = new Collection(rows.items.slice(0, perPage), rows.completeness)
    const last = data.last()
    return {
      data,
      nextCursor:
        rows.length > perPage && last
          ? canonicalJson({
              binding,
              values: ordering.map(
                (order) =>
                  last.rawAttributes()[order.field] ??
                  (order.field === this.definition.primaryKey ? last.id : null),
              ),
            })
          : null,
      completeness: rows.completeness ?? 'partial',
    }
  }
  async chunk(
    size: number,
    callback: (
      models: Collection<
        QueryModel<Fields, WritableFields, RelationNames, Selection, Mode>
      >,
      page: number,
    ) => Promise<boolean | void>,
  ): Promise<void> {
    let page = 1
    for await (const rows of this.chunks(size)) {
      if ((await callback(rows, page++)) === false) return
    }
  }
  async chunkById(
    size: number,
    callback: (
      models: Collection<
        QueryModel<Fields, WritableFields, RelationNames, Selection, Mode>
      >,
      page: number,
    ) => Promise<boolean | void>,
  ): Promise<void> {
    let page = 1
    for await (const rows of this.keysetChunks(size)) {
      if ((await callback(rows, page++)) === false) return
    }
  }
  private async *chunks(
    size: number,
  ): AsyncGenerator<
    Collection<
      QueryModel<Fields, WritableFields, RelationNames, Selection, Mode>
    >
  > {
    if (!Number.isSafeInteger(size) || size < 1)
      throw new RangeError('Chunk size must be positive.')
    let offset = 0
    while (true) {
      const models = await this.offset(offset).limit(size).get()
      if (!models.length) return
      yield models
      if (models.length < size) return
      offset += size
    }
  }
  async *lazy(
    size = 100,
  ): AsyncGenerator<
    QueryModel<Fields, WritableFields, RelationNames, Selection, Mode>
  > {
    for await (const rows of this.chunks(size))
      for (const model of rows) yield model
  }
  async *lazyById(
    size = 100,
  ): AsyncGenerator<
    QueryModel<Fields, WritableFields, RelationNames, Selection, Mode>
  > {
    for await (const rows of this.keysetChunks(size))
      for (const model of rows) yield model
  }
  private async *keysetChunks(
    size: number,
  ): AsyncGenerator<
    Collection<
      QueryModel<Fields, WritableFields, RelationNames, Selection, Mode>
    >
  > {
    if (!Number.isSafeInteger(size) || size < 1)
      throw new RangeError('Chunk size must be positive.')
    const field = this.definition.primaryKey as keyof Fields & string
    let last: WireValue | undefined
    while (true) {
      const query = this.reorder(field)
      const rows = await (
        last === undefined ? query : query.where(field, '>', last)
      )
        .limit(size)
        .get()
      if (!rows.length) return
      yield rows
      last = rows.last()?.id
      if (rows.length < size) return
    }
  }
  cursor(): AsyncGenerator<
    QueryModel<Fields, WritableFields, RelationNames, Selection, Mode>
  > {
    return this.lazy()
  }
  async create(
    attributes: Partial<WritableFields>,
  ): Promise<ModelInstance<Fields, WritableFields, RelationNames>> {
    const model = await makeNewModel<Fields, WritableFields, RelationNames>(
      this.storage,
      this.options.model,
      attributes as Attributes,
    ).save()
    if (this.executionMode === 'remote') {
      await new SyncEngine(
        this.storage,
        this.storage.configuration.transport,
      ).confirmed(model.lastOperationId!)
      await model.refresh()
    }
    return model
  }
  async createConfirmed(
    attributes: Partial<WritableFields>,
    timeoutMilliseconds = 30000,
  ): Promise<ModelInstance<Fields, WritableFields, RelationNames>> {
    const model = await this.create(attributes)
    await model.saveConfirmed(timeoutMilliseconds)
    return model
  }
  private editableQuery(
    options: QueryOptions = this.options,
  ): Query<Fields, WritableFields, RelationNames, undefined, Mode> {
    const {
      select: ignoredSelect,
      include: ignoredInclude,
      relationAggregates: ignoredAggregates,
      ...fullOptions
    } = options
    void ignoredSelect
    void ignoredInclude
    void ignoredAggregates
    return new Query(
      this.storage,
      fullOptions,
      this.partialAllowed,
      this.executionMode,
    )
  }
  private sessionToken(): string {
    return (
      JSON.stringify(this.storage.session) +
      String(this.storage.owner.generation)
    )
  }
  private assertSession(token: string): void {
    if (token !== this.sessionToken())
      throw new SynloquentError(
        'session_changed',
        'Remote materialization belongs to a replaced session or database generation.',
      )
  }
  private async materializeRemote(
    models: readonly {
      canonicalRecord(): import('./types.js').CanonicalRecord | null
    }[],
    token: string,
  ): Promise<void> {
    await this.storage.write(async (executor, changed) => {
      this.assertSession(token)
      for (const model of models) {
        const canonical = model.canonicalRecord()
        if (!canonical)
          throw new SynloquentError(
            'schema_mismatch',
            'Editable remote result has no canonical identity and revision.',
          )
        await this.storage.ingest(canonical, executor, changed)
      }
      this.assertSession(token)
    })
  }
  async firstOrNew(
    attributes: Partial<Fields>,
    values: Partial<WritableFields> = {},
  ): Promise<ModelInstance<Fields, WritableFields, RelationNames>> {
    const token = this.sessionToken()
    let query = this.editableQuery()
    for (const [field, value] of Object.entries(attributes))
      query = query.where(field as keyof Fields & string, value as WireValue)
    const model = await query.first()
    if (!model)
      return makeNewModel<Fields, WritableFields, RelationNames>(
        this.storage,
        this.options.model,
        { ...attributes, ...values } as Attributes,
      )
    if (this.executionMode !== 'remote')
      return model as ModelInstance<Fields, WritableFields, RelationNames>
    await this.materializeRemote([model], token)
    this.assertSession(token)
    return new Query<Fields, WritableFields, RelationNames>(this.storage, {
      model: this.options.model,
      trashed: this.options.trashed ?? 'exclude',
    }).findOrFail(String(model.id))
  }
  async firstOrCreate(
    attributes: Partial<Fields>,
    values: Partial<WritableFields> = {},
  ): Promise<ModelInstance<Fields, WritableFields, RelationNames>> {
    const model = await this.firstOrNew(attributes, values)
    return model.exists
      ? model
      : this.executionMode === 'remote'
        ? model.saveConfirmed()
        : model.save()
  }
  async updateOrCreate(
    attributes: Partial<Fields>,
    values: Partial<WritableFields>,
  ): Promise<ModelInstance<Fields, WritableFields, RelationNames>> {
    const model = await this.firstOrNew(attributes)
    model.fill(values)
    return this.executionMode === 'remote'
      ? model.saveConfirmed()
      : model.save()
  }
  async insert(
    rows: readonly Partial<WritableFields>[],
  ): Promise<Collection<ModelInstance<Fields, WritableFields, RelationNames>>> {
    if (rows.length > 100)
      throw new SynloquentError(
        'validation_failed',
        'A bulk atomic insert is bounded to one hundred records.',
      )
    const atomicGroup = this.storage.configuration.generateIdentity()
    const models = await this.storage.transaction(async (storage) => {
      const created: ModelInstance<Fields, WritableFields, RelationNames>[] = []
      for (const row of rows)
        created.push(
          await makeNewModel<Fields, WritableFields, RelationNames>(
            storage,
            this.options.model,
            row as Attributes,
          ).save({ eventMode: 'bulk', atomicGroup }),
        )
      return new Collection(created)
    })
    await this.confirmRemote(models, true)
    return models
  }
  async upsert(
    rows: readonly Partial<WritableFields>[],
    uniqueBy: readonly (keyof Fields & string)[],
    update?: readonly (keyof Fields & string)[],
  ): Promise<Collection<ModelInstance<Fields, WritableFields, RelationNames>>> {
    if (
      !uniqueBy.length ||
      !(this.definition.unique ?? [[this.definition.primaryKey]]).some(
        (constraint) =>
          constraint.length === uniqueBy.length &&
          constraint.every((field) =>
            uniqueBy.includes(field as keyof Fields & string),
          ),
      )
    )
      throw new SynloquentError(
        'validation_failed',
        'upsert uniqueBy must match an explicitly exported unique constraint.',
      )
    if (rows.length > 100)
      throw new SynloquentError(
        'validation_failed',
        'A bulk atomic upsert is bounded to one hundred records.',
      )
    await this.requireComplete()
    if (this.executionMode === 'remote') {
      const token = this.sessionToken()
      const current = await this.editableQuery().remote().limit(101).get()
      if (current.length > 100)
        throw new SynloquentError(
          'validation_failed',
          'Remote upsert materialization exceeds one hundred records.',
        )
      await this.materializeRemote(current.items, token)
    }
    const atomicGroup = this.storage.configuration.generateIdentity()
    const models = await this.storage.transaction(async (storage) => {
      const query = new Query<Fields, WritableFields, RelationNames>(
        storage,
        this.options,
      )
      const saved: ModelInstance<Fields, WritableFields, RelationNames>[] = []
      for (const row of rows) {
        if (uniqueBy.some((field) => row[field] === undefined))
          throw new SynloquentError(
            'validation_failed',
            'Every upsert row must contain its unique constraint fields.',
          )
        const unique = Object.fromEntries(
          uniqueBy.map((field) => [field, row[field]]),
        ) as Partial<Fields>
        const values = update
          ? (Object.fromEntries(
              update
                .filter((field) => row[field] !== undefined)
                .map((field) => [field, row[field]]),
            ) as Partial<WritableFields>)
          : row
        const model = await query.firstOrNew(unique)
        model.fill(values)
        saved.push(await model.save({ eventMode: 'bulk', atomicGroup }))
      }
      return new Collection(saved)
    })
    await this.confirmRemote(models, true)
    return models
  }
  private async confirmRemote(
    models: Collection<ModelInstance<Fields, WritableFields, RelationNames>>,
    refresh = false,
  ): Promise<void> {
    if (this.executionMode !== 'remote') return
    const sync = new SyncEngine(
      this.storage,
      this.storage.configuration.transport,
    )
    await sync.flush()
    for (const model of models) {
      if (model.lastOperationId) await sync.confirmed(model.lastOperationId)
      if (refresh) await model.refresh()
    }
  }
  private async bulk(
    action: 'update' | 'delete' | 'restore' | 'forceDelete',
    values?: Partial<WritableFields>,
  ): Promise<number> {
    await this.requireComplete()
    const token = this.sessionToken()
    const remote =
      this.executionMode === 'remote'
        ? await this.editableQuery()
            .remote()
            .limit(Math.min(this.options.limit ?? 101, 101))
            .get()
        : undefined
    if (remote && remote.length > 100)
      throw new SynloquentError(
        'validation_failed',
        'Bulk mutation membership exceeds one hundred records. Select an explicit smaller batch.',
      )
    const atomicGroup = this.storage.configuration.generateIdentity()
    const models = await this.storage.transaction(async (storage) => {
      if (remote) {
        this.assertSession(token)
        for (const model of remote) {
          const canonical = model.canonicalRecord()
          if (canonical)
            await storage.write((executor, changed) =>
              storage.ingest(canonical, executor, changed),
            )
        }
        this.assertSession(token)
      }
      const selected = remote
        ? new Collection(
            await Promise.all(
              remote.items.map((model) =>
                new Query<Fields, WritableFields, RelationNames>(storage, {
                  model: this.options.model,
                  trashed: 'include',
                }).findOrFail(String(model.id)),
              ),
            ),
          )
        : await new Query<Fields, WritableFields, RelationNames>(
            storage,
            this.options,
          ).get()
      if (selected.length > 100)
        throw new SynloquentError(
          'validation_failed',
          'Bulk mutation membership exceeds one hundred records. Select an explicit smaller batch.',
        )
      for (const model of selected)
        if (action === 'update')
          await model.update(values ?? {}, { eventMode: 'bulk', atomicGroup })
        else await model[action]({ eventMode: 'bulk', atomicGroup })
      return selected
    })
    await this.confirmRemote(models)
    return models.length
  }
  update(values: Partial<WritableFields>): Promise<number> {
    return this.bulk('update', values)
  }
  delete(): Promise<number> {
    return this.bulk('delete')
  }
  restore(): Promise<number> {
    return this.bulk('restore')
  }
  forceDelete(): Promise<number> {
    return this.bulk('forceDelete')
  }
  join(
    model: string,
    alias: string,
    field: keyof Fields & string,
    otherField: string,
  ): Query<Fields, WritableFields, RelationNames, Selection, Mode> {
    return this.next({
      joins: [
        ...(this.options.joins ?? []),
        { type: 'inner', model, alias, on: [{ field, otherField }] },
      ],
    })
  }
  leftJoin(
    model: string,
    alias: string,
    field: keyof Fields & string,
    otherField: string,
  ): Query<Fields, WritableFields, RelationNames, Selection, Mode> {
    return this.next({
      joins: [
        ...(this.options.joins ?? []),
        { type: 'left', model, alias, on: [{ field, otherField }] },
      ],
    })
  }
  whereJoined(
    alias: string,
    field: string,
    operator: ComparisonOperator,
    value: WireValue,
  ): Query<Fields, WritableFields, RelationNames, Selection, Mode> {
    return this.next({
      joinedWhere: [
        ...(this.options.joinedWhere ?? []),
        { alias, predicate: { kind: 'comparison', field, operator, value } },
      ],
    })
  }
  union(
    query: Query<Fields, WritableFields, RelationNames, Selection, Mode>,
    all = false,
  ): Query<Fields, WritableFields, RelationNames, Selection, Mode> {
    return this.next({
      unions: [...(this.options.unions ?? []), { all, query: query.options }],
    })
  }
  unionAll(
    query: Query<Fields, WritableFields, RelationNames, Selection, Mode>,
  ): Query<Fields, WritableFields, RelationNames, Selection, Mode> {
    return this.union(query, true)
  }
  selectSub(
    query: { readonly options: QueryOptions },
    alias: string,
    correlate: readonly {
      readonly innerField: string
      readonly outerField: string
    }[] = [],
  ): Query<Fields, WritableFields, RelationNames, Selection, Mode> {
    return this.next({
      subqueries: [
        ...(this.options.subqueries ?? []),
        { kind: 'select', query: query.options, alias, correlate },
      ],
    })
  }
  whereExists(
    query: { readonly options: QueryOptions },
    correlate: readonly {
      readonly innerField: string
      readonly outerField: string
    }[] = [],
  ): Query<Fields, WritableFields, RelationNames, Selection, Mode> {
    return this.next({
      subqueries: [
        ...(this.options.subqueries ?? []),
        { kind: 'exists', query: query.options, correlate },
      ],
    })
  }
  whereNotExists(
    query: { readonly options: QueryOptions },
    correlate: readonly {
      readonly innerField: string
      readonly outerField: string
    }[] = [],
  ): Query<Fields, WritableFields, RelationNames, Selection, Mode> {
    return this.next({
      subqueries: [
        ...(this.options.subqueries ?? []),
        { kind: 'notExists', query: query.options, correlate },
      ],
    })
  }
  whereSub(
    field: keyof Fields & string,
    operator: '=' | '!=' | '<' | '<=' | '>' | '>=',
    query: { readonly options: QueryOptions },
    correlate: readonly {
      readonly innerField: string
      readonly outerField: string
    }[] = [],
  ): Query<Fields, WritableFields, RelationNames, Selection, Mode> {
    return this.next({
      subqueries: [
        ...(this.options.subqueries ?? []),
        { kind: 'where', query: query.options, field, operator, correlate },
      ],
    })
  }
  lockForUpdate(): never {
    return unsupported('lockForUpdate')
  }
  sharedLock(): never {
    return unsupported('sharedLock')
  }
  whereRaw(_expression: string, _bindings: readonly WireValue[] = []): never {
    void _bindings
    return unsupported('unregistered SQL predicate')
  }
  selectRaw(_expression: string, _bindings: readonly WireValue[] = []): never {
    void _bindings
    return unsupported('unregistered SQL expression')
  }
}
export class ModelBinding<
  Fields extends ReadableFields = Attributes,
  WritableFields extends Attributes = Attributes,
  RelationNames extends string = string,
> extends Query<Fields, WritableFields, RelationNames> {
  new(
    attributes: Partial<WritableFields> = {},
  ): ModelInstance<Fields, WritableFields, RelationNames> {
    return makeNewModel<Fields, WritableFields, RelationNames>(
      this.storage,
      this.options.model,
      attributes as Attributes,
    )
  }
}

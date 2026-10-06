import {
  DatabaseOwner,
  quoteIdentifier,
  type BindValue,
  type DatabaseRow,
  type TransactionExecutor,
} from './database.js'
import { resourceTable, pivotTable } from './compiler.js'
import { SynloquentError } from './errors.js'
import type { MemoryWorkBudget } from './memory-budget.js'
import { utf8Length } from './snapshot-content.js'
import {
  memoryCacheForOwner,
  type RecoverableMemoryCache,
} from './memory-cache.js'
import type {
  Attributes,
  WireValue,
  CanonicalRecord,
  ClientConfiguration,
  Manifest,
  ModelDefinition,
  FieldDefinition,
  MutationValues,
  Operation,
  RelationSet,
  Session,
  SyncState,
} from './types.js'
import {
  assertManifest,
  canonicalJson,
  decimalOrder,
  integerOrder,
  storageType,
  storageValue,
  validateAttributes,
  validateValue,
} from './values.js'

export interface StoredRecord {
  readonly model: string
  readonly localIdentity: string
  readonly serverIdentity: string | null
  readonly revision: string | null
  readonly canonical: Attributes
  readonly proposal: Attributes
  readonly attributes: Attributes
  readonly visible: boolean
  readonly deleted: boolean
  readonly state: SyncState
}
export interface OutboxEntry {
  readonly sequence: number
  readonly operation: Operation
  readonly attempted: Operation | null
  readonly attempts: number
  readonly status:
    'pending' | 'sending' | 'accepted' | 'conflicted' | 'rejected' | 'cancelled'
  readonly generation: number
  readonly error: Readonly<Record<string, unknown>> | null
}
interface SnapshotRecordSqlPlan {
  readonly definition: ModelDefinition
  readonly parametersPerRow: number
  orderedFields?: readonly [string, FieldDefinition][]
  columns?: readonly string[]
  statement?: { readonly rowCount: number; readonly sql: string }
}
interface SnapshotExceptionCache {
  readonly executorIdentity: object
  readonly partition: string
  readonly session: Session
  readonly sessionGeneration: number
  readonly manifest: Manifest
  readonly ownerGeneration: number
  readonly maximumBatchRows: number
  readonly maximumEntries: number
  readonly maximumBytes: number
  readonly entries: number
  readonly bytes: number
  readonly models: ReadonlyMap<string, ReadonlySet<string> | null>
}
const snapshotExceptionCacheLimits = Object.freeze({
  maximumEntries: 64,
  maximumBytes: 16384,
})
const conservativeSnapshotBudget: MemoryWorkBudget = Object.freeze({
  level: 'conservative',
  reason: 'startup',
  maximumBatchRows: 16,
  maximumBindingBytes: 16384,
  maximumHashBufferUnits: 16384,
  maximumCacheBytes: 524288,
  maximumCacheEntries: 64,
  maximumPrefetchConcurrency: 0,
  maximumSnapshotConcurrency: 1,
  maximumSnapshotResponseBytes: 65536,
})
export function generatedFieldColumn(
  field: string,
  definition: FieldDefinition,
  model: ModelDefinition,
): string {
  const path = `'$.${field}'`
  let expression = `CASE WHEN json_type(_proposal, ${path}) IS NOT NULL THEN json_extract(_proposal, ${path}) ELSE json_extract(_canonical, ${path}) END`
  if (field === model.primaryKey)
    expression = `COALESCE(${expression}, _server_identity, _local_identity)`
  return `${quoteIdentifier(field)} ${storageType(definition)} GENERATED ALWAYS AS (${expression}) VIRTUAL`
}
export function integerOrderColumn(field: string): string {
  const raw = `CAST(${quoteIdentifier(field)} AS TEXT)`
  const magnitude = `COALESCE(NULLIF(ltrim(ltrim(${raw}, '-'), '0'), ''), '0')`
  let complement = magnitude
  for (let digit = 0; digit < 10; digit++)
    complement = `replace(${complement}, '${digit}', '${String.fromCharCode(97 + digit)}')`
  for (let digit = 0; digit < 10; digit++)
    complement = `replace(${complement}, '${String.fromCharCode(97 + digit)}', '${9 - digit}')`
  const expression = `CASE WHEN ${raw} IS NULL THEN NULL WHEN ${raw} GLOB '*[^0-9-]*' THEN '2' || ${raw} WHEN substr(${raw}, 1, 1) = '-' AND ${magnitude} != '0' THEN '0' || printf('%03d', 999 - length(${magnitude})) || ${complement} || '.' ELSE '1' || printf('%03d', length(${magnitude})) || ${magnitude} || '.' END`
  return `${quoteIdentifier(`_order_${field}`)} TEXT GENERATED ALWAYS AS (${expression}) VIRTUAL`
}
export class Storage {
  readonly owner: DatabaseOwner
  readonly memoryCache: RecoverableMemoryCache
  manifest: Manifest
  session: Session
  private executor: TransactionExecutor | undefined
  private changed: Set<string> | undefined
  private partitionKey: string | undefined
  private transactionParent: Storage | undefined
  private transactionFinished = false
  private readonly snapshotDependencies = new WeakMap<
    TransactionExecutor,
    {
      readonly keys: Set<string>
      bytes: number
      recordSqlPlans?: Map<string, SnapshotRecordSqlPlan>
      exceptionCacheKey?: object
      exceptionVersion?: object
      trustedStatement?: {
        readonly executor: TransactionExecutor
        readonly statement: string
        readonly parameters: readonly BindValue[]
      }
    }
  >()
  private readonly snapshotExecutorIdentities = new WeakMap<
    TransactionExecutor,
    object
  >()
  readonly configuration: ClientConfiguration

  constructor(configuration: ClientConfiguration, owner?: DatabaseOwner) {
    this.configuration = configuration
    this.owner = owner ?? new DatabaseOwner(configuration.database)
    this.memoryCache = memoryCacheForOwner(
      this.owner,
      configuration.memoryBudget,
    )
    this.manifest = configuration.schema
    this.session = configuration.session
  }
  get partitionIdentity(): string {
    return canonicalJson([
      this.session.accountId,
      this.session.tenantId,
      this.session.deviceId,
      this.session.deviceEpoch,
    ])
  }
  get partition(): string {
    return this.partitionKey ?? this.partitionIdentity
  }
  modelStorage(): Storage {
    return this.transactionFinished && this.transactionParent
      ? this.transactionParent.modelStorage()
      : this
  }
  async selectPartition(executor: TransactionExecutor): Promise<void> {
    await executor.execute(
      'CREATE TABLE IF NOT EXISTS syn_partitions (identity TEXT NOT NULL UNIQUE, number INTEGER PRIMARY KEY AUTOINCREMENT)',
    )
    await executor.execute(
      'INSERT INTO syn_partitions(identity) VALUES (?) ON CONFLICT(identity) DO NOTHING',
      [this.partitionIdentity],
    )
    const result = await executor.execute(
      'SELECT CAST(number AS TEXT) AS number FROM syn_partitions WHERE identity = ?',
      [this.partitionIdentity],
    )
    this.partitionKey = String(result.rows[0]?.number)
  }
  async initialize(): Promise<void> {
    await this.owner.adapter.execute('PRAGMA foreign_keys = ON')
    await this.write(async (executor) => {
      const previousPartition = this.partition
      await this.selectPartition(executor)
      const existing = await executor.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'syn_%'",
      )
      await executor.execute('PRAGMA defer_foreign_keys = ON')
      for (const row of existing.rows) {
        const table = String(row.name)
        const columns = await executor.execute(
          `PRAGMA table_info(${quoteIdentifier(table)})`,
        )
        const partitionColumn = columns.rows.some(
          (column) => column.name === '_partition',
        )
          ? '_partition'
          : columns.rows.some((column) => column.name === 'partition')
            ? 'partition'
            : undefined
        if (partitionColumn)
          await executor.execute(
            `UPDATE ${quoteIdentifier(table)} SET ${quoteIdentifier(partitionColumn)} = ? WHERE ${quoteIdentifier(partitionColumn)} = ?`,
            [this.partition, previousPartition],
          )
      }
      await executor.execute(
        'CREATE TABLE IF NOT EXISTS syn_metadata (partition TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(partition, key))',
      )
      await executor.execute('DROP TABLE IF EXISTS syn_aliases')
      await executor.execute(
        'CREATE TABLE IF NOT EXISTS syn_outbox (sequence INTEGER PRIMARY KEY AUTOINCREMENT, partition TEXT NOT NULL, operation_id TEXT NOT NULL, operation TEXT NOT NULL, attempted TEXT, attempts INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, generation INTEGER NOT NULL, error TEXT, UNIQUE(partition, operation_id))',
      )
      await executor.execute(
        'CREATE INDEX IF NOT EXISTS syn_outbox_pending ON syn_outbox(partition, status, sequence)',
      )
      await executor.execute(
        'CREATE TABLE IF NOT EXISTS syn_commands (partition TEXT NOT NULL, operation_id TEXT NOT NULL, payload TEXT NOT NULL, result TEXT, status TEXT NOT NULL, PRIMARY KEY(partition, operation_id))',
      )
      await executor.execute(
        'CREATE TABLE IF NOT EXISTS syn_relation_sets (partition TEXT NOT NULL, model TEXT NOT NULL, relation TEXT NOT NULL, parent_identity TEXT NOT NULL, revision TEXT NOT NULL, completeness TEXT NOT NULL, canonical TEXT NOT NULL, PRIMARY KEY(partition, model, relation, parent_identity))',
      )
      await executor.execute(
        'CREATE TABLE IF NOT EXISTS syn_recovery (partition TEXT NOT NULL, model TEXT NOT NULL, local_identity TEXT NOT NULL, proposal TEXT NOT NULL, reason TEXT NOT NULL, PRIMARY KEY(partition, model, local_identity))',
      )
      const cached = await this.metadata('manifest', executor)
      if (cached) {
        const parsed = assertManifest(JSON.parse(cached) as Manifest)
        if (parsed.fingerprint !== this.manifest.fingerprint)
          this.manifest = parsed
      } else
        await this.setMetadata(
          'manifest',
          canonicalJson(this.manifest),
          executor,
        )
      await this.createSchema(executor, this.manifest)
      await executor.execute(
        "UPDATE syn_outbox SET status = 'pending' WHERE partition = ? AND status = 'sending'",
        [this.partition],
      )
      await this.setMetadata(
        'sessionGeneration',
        String(this.session.generation),
        executor,
      )
    })
  }
  async createSchema(
    executor: TransactionExecutor,
    manifest: Manifest,
  ): Promise<void> {
    const referenceFields = new Map<string, Set<string>>()
    const ownerFields = new Map<string, Set<string>>()
    for (const [name, definition] of Object.entries(manifest.models))
      for (const relation of Object.values(definition.relations)) {
        const target = manifest.models[relation.model]
        if (
          relation.type !== 'belongsTo' ||
          !relation.foreignKey ||
          !relation.onDelete ||
          !target ||
          !relation.ownerKey ||
          relation.ownerKey === target.primaryKey
        )
          continue
        const owner = ownerFields.get(relation.model) ?? new Set<string>()
        owner.add(relation.ownerKey)
        ownerFields.set(relation.model, owner)
        for (const [model, field] of [
          [name, relation.foreignKey],
          [relation.model, relation.ownerKey],
        ] as const) {
          const references = referenceFields.get(model) ?? new Set<string>()
          references.add(field)
          referenceFields.set(model, references)
        }
      }
    const legacyModels: string[] = []
    const existingModels = new Map<string, readonly DatabaseRow[]>()
    let rebuild = false
    for (const name of Object.keys(manifest.models)) {
      const existing = await executor.execute(
        `PRAGMA table_xinfo(${quoteIdentifier(resourceTable(name))})`,
      )
      existingModels.set(name, existing.rows)
      const field = Object.keys(manifest.models[name]!.fields)[0]
      const referenceLayout = referenceFields.get(name)?.size
        ? await executor.execute(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
            [resourceTable(name)],
          )
        : undefined
      if (
        existing.rows.some(
          (column) => column.name === field && column.hidden === 0,
        ) ||
        (existing.rows.length > 0 &&
          [...(referenceFields.get(name) ?? [])].some(
            (field) =>
              !existing.rows.some(
                (column) => column.name === `_reference_${field}`,
              ),
          )) ||
        (existing.rows.length > 0 &&
          referenceLayout !== undefined &&
          !String(referenceLayout.rows[0]?.sql).includes(
            'CASE WHEN _visible = 1 AND _deleted = 0',
          ))
      )
        rebuild = true
    }
    if (rebuild)
      for (const [name, columns] of existingModels) {
        if (!columns.length) continue
        await executor.execute(
          `ALTER TABLE ${quoteIdentifier(resourceTable(name))} RENAME TO ${quoteIdentifier(`syn_legacy_${name}`)}`,
        )
        legacyModels.push(name)
      }
    for (const [name, definition] of Object.entries(manifest.models)) {
      const columns = Object.entries(definition.fields).flatMap(
        ([field, fieldDefinition]) => [
          generatedFieldColumn(field, fieldDefinition, definition),
          ...(fieldDefinition.type === 'integer'
            ? [integerOrderColumn(field)]
            : fieldDefinition.type === 'decimal'
              ? [`${quoteIdentifier(`_order_${field}`)} TEXT`]
              : []),
        ],
      )
      for (const field of referenceFields.get(name) ?? []) {
        const type = definition.fields[field]!
        const value =
          type.type === 'integer' || type.type === 'decimal'
            ? `_order_${field}`
            : field
        columns.push(
          `${quoteIdentifier(`_reference_${field}`)} ${storageType(type)} GENERATED ALWAYS AS (CASE WHEN _visible = 1 AND _deleted = 0 THEN ${quoteIdentifier(value)} ELSE NULL END) VIRTUAL`,
        )
      }
      const foreignKeyColumns = new Set<string>()
      const foreignKeys = Object.values(definition.relations)
        .filter(
          (relation) =>
            relation.type === 'belongsTo' &&
            relation.foreignKey &&
            relation.onDelete,
        )
        .map((relation) => {
          const target = manifest.models[relation.model]
          if (!target || !relation.foreignKey)
            throw new SynloquentError(
              'schema_mismatch',
              'Foreign key target is absent.',
            )
          const custom =
            relation.ownerKey && relation.ownerKey !== target.primaryKey
          const foreignColumn = custom
            ? `_reference_${relation.foreignKey}`
            : relation.foreignKey
          foreignKeyColumns.add(foreignColumn)
          return `FOREIGN KEY(_partition, ${quoteIdentifier(foreignColumn)}) REFERENCES ${quoteIdentifier(resourceTable(relation.model))}(_partition, ${quoteIdentifier(custom ? `_reference_${relation.ownerKey}` : target.primaryKey)}) ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED`
        })
      const ownerUnique = [...(ownerFields.get(name) ?? [])].map(
        (field) =>
          `UNIQUE(_partition, ${quoteIdentifier(`_reference_${field}`)})`,
      )
      await executor.execute(
        `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(resourceTable(name))} (_partition TEXT NOT NULL, _local_identity TEXT NOT NULL, _server_identity TEXT, _revision TEXT, _canonical TEXT NOT NULL, _proposal TEXT NOT NULL, _visible INTEGER NOT NULL DEFAULT 1, _deleted INTEGER NOT NULL DEFAULT 0, _state TEXT NOT NULL, ${columns.join(', ')}, PRIMARY KEY(_partition, _local_identity), UNIQUE(_partition, ${quoteIdentifier(definition.primaryKey)})${[...foreignKeys, ...ownerUnique].length ? `, ${[...foreignKeys, ...ownerUnique].join(', ')}` : ''})`,
      )
      const ensureIndex = async (
        indexName: string,
        statement: string,
      ): Promise<void> => {
        const existing = await executor.execute(
          "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?",
          [indexName],
        )
        if (
          existing.rows.length &&
          existing.rows[0]?.sql !== statement.replace(' IF NOT EXISTS', '')
        )
          await executor.execute(`DROP INDEX ${quoteIdentifier(indexName)}`)
        await executor.execute(statement)
      }
      const snapshotExceptionIndexName = `syn_snapshot_exception_index_${name}`
      await ensureIndex(
        snapshotExceptionIndexName,
        `CREATE INDEX IF NOT EXISTS ${quoteIdentifier(snapshotExceptionIndexName)} ON ${quoteIdentifier(resourceTable(name))} (_partition, _server_identity) WHERE (_local_identity != 'c:' || _server_identity OR _proposal != '{}' OR _state != 'synced')`,
      )
      for (const foreignColumn of foreignKeyColumns) {
        const indexName = `syn_foreign_index_${name}_${foreignColumn}`
        // Every non-null FK tuple remains indexed, including hidden/deleted
        // children. SQLite never checks NULL child tuples against a parent.
        await ensureIndex(
          indexName,
          `CREATE INDEX IF NOT EXISTS ${quoteIdentifier(indexName)} ON ${quoteIdentifier(resourceTable(name))} (_partition, ${quoteIdentifier(foreignColumn)}) WHERE ${quoteIdentifier(foreignColumn)} IS NOT NULL`,
        )
      }
      const combinedUnique = new Set<number>()
      for (const [index, fields] of (definition.indexes ?? []).entries()) {
        const ordered = fields.map((field) =>
          definition.fields[field]?.type === 'integer' ||
          definition.fields[field]?.type === 'decimal'
            ? `_order_${field}`
            : field,
        )
        const requiresOrder = ordered.some(
          (field, position) => field !== fields[position],
        )
        const uniquePosition = (definition.unique ?? []).findIndex(
          (uniqueFields) =>
            !uniqueFields.includes(definition.primaryKey) &&
            canonicalJson(uniqueFields) === canonicalJson(fields),
        )
        const indexName = `${requiresOrder ? 'syn_ordered_index' : 'syn_index'}_${name}_${index}`
        if (uniquePosition >= 0) {
          combinedUnique.add(uniquePosition)
          await executor.execute(
            `DROP INDEX IF EXISTS ${quoteIdentifier(indexName)}`,
          )
        } else if (requiresOrder)
          await ensureIndex(
            indexName,
            `CREATE INDEX IF NOT EXISTS ${quoteIdentifier(indexName)} ON ${quoteIdentifier(resourceTable(name))} (_partition, _visible, ${ordered.map(quoteIdentifier).join(', ')})`,
          )
        else if (fields.length !== 1 || fields[0] !== definition.primaryKey)
          await ensureIndex(
            indexName,
            `CREATE INDEX IF NOT EXISTS ${quoteIdentifier(indexName)} ON ${quoteIdentifier(resourceTable(name))} (_partition, ${fields.map(quoteIdentifier).join(', ')})`,
          )
      }
      for (const [index, fields] of (definition.unique ?? []).entries())
        if (!fields.includes(definition.primaryKey)) {
          const indexName = `syn_unique_${name}_${index}`
          const ordered = fields.map((field) =>
            definition.fields[field]?.type === 'integer' ||
            definition.fields[field]?.type === 'decimal'
              ? `_order_${field}`
              : field,
          )
          const combined = combinedUnique.has(index)
          const requiresOrder = ordered.some(
            (field, position) => field !== fields[position],
          )
          const columns = [
            '_partition',
            ...(combined && requiresOrder ? ['_visible'] : []),
            ...ordered,
          ]
          // NULL liveness permits historical duplicate tuples. Active tuples
          // retain uniqueness and the complete declared lookup prefix.
          await ensureIndex(
            indexName,
            `CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(indexName)} ON ${quoteIdentifier(resourceTable(name))} (${columns.map(quoteIdentifier).join(', ')}${combined ? ', CASE WHEN _visible = 1 AND _deleted = 0 THEN 1 ELSE NULL END' : ''})${combined ? '' : ' WHERE _visible = 1 AND _deleted = 0'}`,
          )
        }
      for (const relation of Object.values(definition.relations)) {
        if (!relation.pivot) continue
        const pivot = relation.pivot
        const fields = {
          ...pivot.fields,
          [pivot.foreignKey]: pivot.fields[pivot.foreignKey] ?? {
            type: 'string' as const,
            nullable: false,
            readable: true,
            writable: true,
          },
          [pivot.relatedKey]: pivot.fields[pivot.relatedKey] ?? {
            type: 'string' as const,
            nullable: false,
            readable: true,
            writable: true,
          },
          ...(relation.morphType
            ? {
                [relation.morphType]: {
                  type: 'string' as const,
                  nullable: false,
                  readable: true,
                  writable: false,
                },
              }
            : {}),
        }
        const columns = Object.entries(fields)
          .map(
            ([field, definition]) =>
              `${quoteIdentifier(field)} ${storageType(definition)}`,
          )
          .join(', ')
        const keys = [
          ...new Set([
            pivot.foreignKey,
            pivot.relatedKey,
            ...(relation.morphType ? [relation.morphType] : []),
          ]),
        ]
        for (const table of [
          pivotTable(pivot.table),
          `syn_canonical_pivot_${pivot.table}`,
        ])
          await executor.execute(
            `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(table)} (_partition TEXT NOT NULL, ${columns}, PRIMARY KEY(_partition, ${keys.map(quoteIdentifier).join(', ')}))`,
          )
      }
    }
    if (legacyModels.length) {
      for (const name of legacyModels) {
        const columns = [
          '_partition',
          '_local_identity',
          '_server_identity',
          '_revision',
          '_canonical',
          '_proposal',
          '_visible',
          '_deleted',
          '_state',
          ...Object.entries(manifest.models[name]!.fields)
            .filter(([, field]) => field.type === 'decimal')
            .map(([field]) => `_order_${field}`),
        ]
        await executor.execute(
          `INSERT INTO ${quoteIdentifier(resourceTable(name))} (${columns.map(quoteIdentifier).join(',')}) SELECT ${columns.map(quoteIdentifier).join(',')} FROM ${quoteIdentifier(`syn_legacy_${name}`)}`,
        )
      }
      for (const name of legacyModels)
        await executor.execute(
          `DROP TABLE ${quoteIdentifier(`syn_legacy_${name}`)}`,
        )
      await this.createSchema(executor, manifest)
    }
  }
  read<Result>(
    callback: (executor: TransactionExecutor) => Promise<Result>,
  ): Promise<Result> {
    return this.executor ? callback(this.executor) : this.owner.read(callback)
  }
  write<Result>(
    callback: (
      executor: TransactionExecutor,
      changed: Set<string>,
    ) => Promise<Result>,
  ): Promise<Result> {
    return this.executor
      ? callback(this.executor, this.changed ?? new Set())
      : this.owner.write(callback)
  }
  async transaction<Result>(
    callback: (storage: Storage) => Promise<Result>,
  ): Promise<Result> {
    const run = async (
      executor: TransactionExecutor,
      changed: Set<string>,
    ): Promise<Result> => {
      const scoped = new Storage(this.configuration, this.owner)
      scoped.manifest = this.manifest
      scoped.session = this.session
      scoped.executor = executor
      scoped.changed = changed
      scoped.partitionKey = this.partitionKey
      scoped.transactionParent = this
      try {
        return await callback(scoped)
      } finally {
        scoped.transactionFinished = true
      }
    }
    if (this.executor) {
      const changed = this.changed ?? new Set<string>()
      const previous = new Set(changed)
      try {
        return await this.executor.transaction((executor) =>
          run(executor, changed),
        )
      } catch (error) {
        changed.clear()
        for (const table of previous) changed.add(table)
        throw error
      }
    }
    return this.owner.write(run)
  }
  async metadata(
    key: string,
    executor?: TransactionExecutor,
  ): Promise<string | null> {
    const read = async (
      handle: TransactionExecutor,
    ): Promise<string | null> => {
      const result = await handle.execute(
        'SELECT value FROM syn_metadata WHERE partition = ? AND key = ?',
        [this.partition, key],
      )
      return typeof result.rows[0]?.value === 'string'
        ? result.rows[0].value
        : null
    }
    return executor ? read(executor) : this.read(read)
  }
  async setMetadata(
    key: string,
    value: string,
    executor: TransactionExecutor,
  ): Promise<void> {
    await executor.execute(
      'INSERT INTO syn_metadata(partition,key,value) VALUES (?,?,?) ON CONFLICT(partition,key) DO UPDATE SET value=excluded.value',
      [this.partition, key, value],
    )
  }
  row(model: string, row: DatabaseRow): StoredRecord {
    const canonical = JSON.parse(String(row._canonical)) as Attributes
    const proposal = JSON.parse(String(row._proposal)) as Attributes
    return {
      model,
      localIdentity: String(row._local_identity),
      serverIdentity:
        row._server_identity === null ? null : String(row._server_identity),
      revision: row._revision === null ? null : String(row._revision),
      canonical,
      proposal,
      attributes: { ...canonical, ...proposal },
      visible: row._visible === 1,
      deleted: row._deleted === 1,
      state: String(row._state) as SyncState,
    }
  }
  async findStored(
    model: string,
    identity: string | number,
    executor: TransactionExecutor,
  ): Promise<StoredRecord | undefined> {
    const primaryKey = this.manifest.models[model]?.primaryKey
    if (!primaryKey)
      throw new SynloquentError('unknown_model', `Unknown model ${model}.`)
    const table = quoteIdentifier(resourceTable(model))
    const result = await executor.execute(
      `SELECT * FROM ${table} WHERE _partition = ? AND _local_identity = ? UNION ALL SELECT * FROM ${table} WHERE _partition = ? AND ${quoteIdentifier(primaryKey)} = ? AND _local_identity != ? LIMIT 1`,
      [
        this.partition,
        String(identity),
        this.partition,
        String(identity),
        String(identity),
      ],
    )
    return result.rows[0] ? this.row(model, result.rows[0]) : undefined
  }
  async findOwner(
    model: string,
    value: string | number,
    executor: TransactionExecutor,
    ownerKey?: string,
    includeHidden = false,
  ): Promise<StoredRecord | undefined> {
    const definition = this.manifest.models[model]
    if (!definition)
      throw new SynloquentError('unknown_model', `Unknown model ${model}.`)
    if (!ownerKey || ownerKey === definition.primaryKey)
      return this.findStored(model, value, executor)
    const field = definition.fields[ownerKey]
    if (!field)
      throw new SynloquentError(
        'unknown_field',
        `Unknown owner key ${model}.${ownerKey}.`,
      )
    const column =
      field.type === 'integer' || field.type === 'decimal'
        ? `_order_${ownerKey}`
        : ownerKey
    const bound =
      field.type === 'integer'
        ? integerOrder(value)
        : field.type === 'decimal'
          ? decimalOrder(value, field.precision ?? 18)
          : storageValue(value, field)
    const result = await executor.execute(
      `SELECT * FROM ${quoteIdentifier(resourceTable(model))} WHERE _partition = ? AND ${quoteIdentifier(column)} = ?${includeHidden ? '' : ' AND _visible = 1 AND _deleted = 0'} ORDER BY _visible DESC, _deleted ASC, _local_identity LIMIT 1`,
      [this.partition, bound],
    )
    return result.rows[0] ? this.row(model, result.rows[0]) : undefined
  }
  async persist(
    record: StoredRecord,
    executor: TransactionExecutor,
    changed = new Set<string>(),
    visited = new Set<string>(),
  ): Promise<void> {
    const definition = this.manifest.models[record.model]
    if (!definition)
      throw new SynloquentError(
        'unknown_model',
        `Unknown model ${record.model}.`,
      )
    const overlay = { ...record.canonical, ...record.proposal }
    overlay[definition.primaryKey] ??=
      record.serverIdentity ?? record.localIdentity
    // Accepted key changes must reach canonical dependencies beneath a retained delete overlay.
    if (
      record.visible &&
      Object.values(this.manifest.models).some((model) =>
        Object.values(model.relations).some(
          (relation) =>
            relation.type === 'belongsTo' &&
            relation.model === record.model &&
            relation.ownerKey &&
            relation.ownerKey !== definition.primaryKey &&
            relation.onUpdate === 'cascade',
        ),
      )
    ) {
      const previous = await this.findStored(
        record.model,
        record.localIdentity,
        executor,
      )
      if (previous?.visible)
        await this.updateDependencies(
          previous,
          { ...record, attributes: overlay },
          executor,
          changed,
          visited,
        )
    }
    const values: BindValue[] = [
      this.partition,
      record.localIdentity,
      record.serverIdentity,
      record.revision,
      canonicalJson(record.canonical),
      canonicalJson(record.proposal),
      record.visible ? 1 : 0,
      record.deleted ? 1 : 0,
      record.state,
    ]
    const columns = [
      '_partition',
      '_local_identity',
      '_server_identity',
      '_revision',
      '_canonical',
      '_proposal',
      '_visible',
      '_deleted',
      '_state',
    ]
    for (const [field, fieldDefinition] of Object.entries(definition.fields)) {
      if (fieldDefinition.type === 'decimal') {
        columns.push(`_order_${field}`)
        values.push(
          overlay[field] === null || overlay[field] === undefined
            ? null
            : decimalOrder(
                overlay[field] ?? null,
                fieldDefinition.precision ?? 18,
              ),
        )
      }
    }
    await executor.execute(
      `INSERT INTO ${quoteIdentifier(resourceTable(record.model))} (${columns.map(quoteIdentifier).join(', ')}) VALUES (${columns.map(() => '?').join(', ')}) ON CONFLICT(_partition, _local_identity) DO UPDATE SET ${columns
        .slice(2)
        .map(
          (column) =>
            `${quoteIdentifier(column)} = excluded.${quoteIdentifier(column)}`,
        )
        .join(', ')}`,
      values,
    )
  }
  private async updateDependencies(
    previous: StoredRecord,
    next: StoredRecord,
    executor: TransactionExecutor,
    changed: Set<string>,
    visited: Set<string>,
  ): Promise<void> {
    for (const [model, definition] of Object.entries(this.manifest.models))
      for (const relation of Object.values(definition.relations)) {
        if (
          relation.type !== 'belongsTo' ||
          relation.model !== previous.model ||
          !relation.foreignKey ||
          !relation.ownerKey ||
          relation.ownerKey ===
            this.manifest.models[previous.model]!.primaryKey ||
          relation.onUpdate !== 'cascade'
        )
          continue
        const field = definition.fields[relation.foreignKey]!
        const ordered = (value: WireValue | undefined): BindValue =>
          value === null || value === undefined
            ? null
            : field.type === 'integer'
              ? integerOrder(value)
              : field.type === 'decimal'
                ? decimalOrder(value, field.precision ?? 18)
                : storageValue(value, field)
        const canonicalChange =
          ordered(previous.canonical[relation.ownerKey]) !==
          ordered(next.canonical[relation.ownerKey])
        const oldValue = canonicalChange
          ? previous.canonical[relation.ownerKey]
          : previous.attributes[relation.ownerKey]
        const newValue = canonicalChange
          ? next.canonical[relation.ownerKey]
          : next.attributes[relation.ownerKey]
        if (
          oldValue === undefined ||
          oldValue === null ||
          newValue === undefined ||
          ordered(oldValue) === ordered(newValue)
        )
          continue
        if (
          !canonicalChange &&
          (typeof oldValue === 'string' || typeof oldValue === 'number')
        ) {
          const owner = await this.findOwner(
            previous.model,
            oldValue,
            executor,
            relation.ownerKey,
            true,
          )
          if (
            owner?.visible &&
            !owner.deleted &&
            owner.localIdentity !== previous.localIdentity
          )
            continue
        }
        const visit = canonicalJson([
          model,
          relation.foreignKey,
          previous.localIdentity,
          oldValue,
          newValue,
        ])
        if (visited.has(visit)) continue
        this.admitSnapshotDependency(executor, `update:${visit}`)
        visited.add(visit)
        const column =
          field.type === 'integer' || field.type === 'decimal'
            ? `_order_${relation.foreignKey}`
            : relation.foreignKey
        const rows = this.dependencyRows(
          model,
          executor,
          `_partition = ? AND _visible = 1 AND (${quoteIdentifier(column)} = ?${canonicalChange ? ` OR CAST(json_extract(_canonical, ?) AS TEXT) = ?` : ''})`,
          canonicalChange
            ? [
                this.partition,
                ordered(oldValue),
                `$.${relation.foreignKey}`,
                String(oldValue),
              ]
            : [this.partition, ordered(oldValue)],
        )
        for await (const row of rows) {
          const child = this.row(model, row)
          const canonicalMatches =
            ordered(child.canonical[relation.foreignKey]) === ordered(oldValue)
          const canonical =
            canonicalChange && canonicalMatches
              ? { ...child.canonical, [relation.foreignKey]: newValue }
              : child.canonical
          const proposal = canonicalChange
            ? await this.rebuildProposal(
                model,
                child.localIdentity,
                canonical,
                executor,
                child.proposal,
                this.snapshotDependencies.has(executor),
              )
            : { ...child.proposal, [relation.foreignKey]: newValue }
          let hasPending = false
          let conflicted = false
          let rejected = false
          let ownForeignProposal = false
          for await (const entry of this.pendingEntries(
            executor,
            { model, localIdentity: child.localIdentity },
            this.snapshotDependencies.has(executor),
          )) {
            if (
              !['pending', 'sending', 'conflicted', 'rejected'].includes(
                entry.status,
              )
            )
              continue
            hasPending = true
            conflicted ||= entry.status === 'conflicted'
            rejected ||= entry.status === 'rejected'
            ownForeignProposal ||= relation.foreignKey in entry.operation.values
          }
          if (!ownForeignProposal) {
            const effective = next.attributes[relation.ownerKey]
            if (
              canonicalChange &&
              effective !== undefined &&
              ordered(effective) !== ordered(newValue)
            )
              proposal[relation.foreignKey] = effective
            else if (
              ordered(proposal[relation.foreignKey]) ===
              ordered(canonical[relation.foreignKey])
            )
              delete proposal[relation.foreignKey]
          }
          await this.persist(
            {
              ...child,
              canonical,
              proposal,
              attributes: { ...canonical, ...proposal },
              state: conflicted
                ? 'conflicted'
                : rejected
                  ? 'rejected'
                  : hasPending || Object.keys(proposal).length
                    ? 'pending'
                    : 'synced',
            },
            executor,
            changed,
            visited,
          )
          changed.add(model)
        }
      }
  }
  async append(
    operation: Operation,
    executor: TransactionExecutor,
  ): Promise<void> {
    await executor.execute(
      "INSERT INTO syn_outbox(partition,operation_id,operation,status,generation) VALUES (?,?,?,'pending',?)",
      [
        this.partition,
        operation.operationId,
        canonicalJson(operation),
        this.session.generation,
      ],
    )
  }
  async pending(executor: TransactionExecutor): Promise<OutboxEntry[]> {
    const result = await executor.execute(
      'SELECT * FROM syn_outbox WHERE partition = ? ORDER BY sequence',
      [this.partition],
    )
    return result.rows.map((row) => ({
      sequence: Number(row.sequence),
      operation: JSON.parse(String(row.operation)) as Operation,
      attempted:
        row.attempted === null
          ? null
          : (JSON.parse(String(row.attempted)) as Operation),
      attempts: Number(row.attempts),
      status: String(row.status) as OutboxEntry['status'],
      generation: Number(row.generation),
      error:
        row.error === null
          ? null
          : (JSON.parse(String(row.error)) as Readonly<
              Record<string, unknown>
            >),
    }))
  }
  snapshotWorkBudget(): MemoryWorkBudget {
    try {
      const current = this.configuration.memoryBudget?.current()
      if (
        current &&
        Number.isSafeInteger(current.maximumBatchRows) &&
        current.maximumBatchRows >= 1 &&
        current.maximumBatchRows <= 64 &&
        Number.isSafeInteger(current.maximumBindingBytes) &&
        current.maximumBindingBytes >= 1 &&
        current.maximumBindingBytes <= 65536 &&
        Number.isSafeInteger(current.maximumHashBufferUnits) &&
        current.maximumHashBufferUnits >= 2 &&
        current.maximumHashBufferUnits <= 65536 &&
        Number.isSafeInteger(current.maximumSnapshotConcurrency) &&
        current.maximumSnapshotConcurrency >= 0 &&
        current.maximumSnapshotConcurrency <= 1 &&
        current.maximumSnapshotResponseBytes === 65536
      )
        return current
    } catch {
      /* Invalid policy adapters select fixed conservative work. */
    }
    return conservativeSnapshotBudget
  }
  snapshotExecutor(executor: TransactionExecutor): TransactionExecutor {
    this.clearSnapshotExceptions(executor)
    const dependencies = this.snapshotDependencies.get(executor) ?? {
      keys: new Set<string>(),
      bytes: 0,
    }
    const bounded: TransactionExecutor = {
      transaction: async (callback) => {
        this.clearSnapshotExceptions(bounded)
        try {
          return await executor.transaction((transaction) => {
            const scoped = this.snapshotExecutor(transaction)
            this.snapshotDependencies.set(
              scoped,
              this.snapshotDependencies.get(bounded)!,
            )
            return callback(scoped)
          })
        } finally {
          this.clearSnapshotExceptions(bounded)
        }
      },
      execute: async (statement, parameters = []) => {
        if (
          parameters.length > this.owner.adapter.capabilities.maximumParameters
        )
          throw new SynloquentError(
            'schema_mismatch',
            'A snapshot statement exceeds database parameter capacity.',
          )
        const bytes = parameters.reduce<number>(
          (total, value) =>
            total +
            (typeof value === 'string'
              ? utf8Length(value)
              : value instanceof Uint8Array
                ? value.byteLength
                : 8),
          0,
        )
        if (bytes > this.snapshotWorkBudget().maximumBindingBytes)
          throw new SynloquentError(
            'snapshot_admission_required',
            'One SQL binding group exceeds the current snapshot work budget.',
            { reason: 'binding-group-too-large' },
          )
        const trusted = this.snapshotDependencies.get(bounded)?.trustedStatement
        if (
          trusted?.executor !== bounded ||
          trusted.statement !== statement ||
          trusted.parameters !== parameters
        )
          this.clearSnapshotExceptions(bounded)
        return executor.execute(statement, parameters)
      },
    }
    this.snapshotDependencies.set(bounded, dependencies)
    this.snapshotExecutorIdentities.set(bounded, {})
    return bounded
  }
  private clearSnapshotExceptions(executor: TransactionExecutor): void {
    const dependencies = this.snapshotDependencies.get(executor)
    if (!dependencies?.exceptionCacheKey) return
    this.memoryCache.delete(dependencies.exceptionCacheKey)
    dependencies.exceptionVersion = {}
  }
  private async executeSnapshotCacheSafe(
    executor: TransactionExecutor,
    statement: string,
    parameters: readonly BindValue[],
  ) {
    const dependencies = this.snapshotDependencies.get(executor)
    if (!dependencies) return executor.execute(statement, parameters)
    const trusted = { executor, statement, parameters }
    dependencies.trustedStatement = trusted
    try {
      return await executor.execute(statement, parameters)
    } finally {
      if (dependencies.trustedStatement === trusted)
        delete dependencies.trustedStatement
    }
  }
  private snapshotExceptionLimits():
    | {
        maximumBatchRows: number
        maximumEntries: number
        maximumBytes: number
      }
    | undefined {
    try {
      const budget =
        this.configuration.memoryBudget?.current() ?? conservativeSnapshotBudget
      const valid = (value: number, maximum: number) =>
        Number.isSafeInteger(value) && value >= 0 && value <= maximum
      if (
        !valid(budget.maximumBatchRows, 64) ||
        !budget.maximumBatchRows ||
        !valid(budget.maximumBindingBytes, 65536) ||
        budget.maximumBindingBytes < 32 ||
        !Number.isSafeInteger(budget.maximumCacheEntries) ||
        budget.maximumCacheEntries < 1 ||
        !Number.isSafeInteger(budget.maximumCacheBytes) ||
        budget.maximumCacheBytes < 1 ||
        budget.maximumSnapshotConcurrency !== 1
      )
        return undefined
      return {
        maximumBatchRows: budget.maximumBatchRows,
        maximumEntries: Math.min(
          snapshotExceptionCacheLimits.maximumEntries,
          budget.maximumCacheEntries,
        ),
        maximumBytes: Math.min(
          snapshotExceptionCacheLimits.maximumBytes,
          budget.maximumCacheBytes,
          budget.maximumBindingBytes,
        ),
      }
    } catch {
      return undefined
    }
  }
  private async cachedSnapshotExceptions(
    model: string,
    executor: TransactionExecutor,
  ): Promise<ReadonlySet<string> | undefined> {
    const dependencies = this.snapshotDependencies.get(executor)
    if (!dependencies || this.owner.adapter.capabilities.maximumParameters < 4)
      return undefined
    const executorIdentity = this.snapshotExecutorIdentities.get(executor)
    if (!executorIdentity) return undefined
    const scope = {
      executorIdentity,
      partition: this.partition,
      session: this.session,
      sessionGeneration: this.session.generation,
      manifest: this.manifest,
      ownerGeneration: this.owner.generation,
    }
    const limits = this.snapshotExceptionLimits()
    if (!limits) {
      this.clearSnapshotExceptions(executor)
      return undefined
    }
    const key = (dependencies.exceptionCacheKey ??= {})
    let cached = this.memoryCache.get<SnapshotExceptionCache>(key)
    if (
      cached &&
      (cached.executorIdentity !== executorIdentity ||
        cached.partition !== this.partition ||
        cached.session !== this.session ||
        cached.sessionGeneration !== this.session.generation ||
        cached.manifest !== this.manifest ||
        cached.ownerGeneration !== this.owner.generation ||
        limits.maximumBatchRows < cached.maximumBatchRows ||
        limits.maximumEntries < cached.maximumEntries ||
        limits.maximumBytes < cached.maximumBytes)
    ) {
      this.clearSnapshotExceptions(executor)
      cached = undefined
    }
    const existing = cached?.models.get(model)
    if (existing !== undefined) return existing ?? undefined
    const retainedEntries = cached?.entries ?? 1
    const retainedBytes = cached?.bytes ?? 128
    const modelBytes = 128 + 2 * utf8Length(model)
    const maximumRows = Math.min(
      limits.maximumBatchRows,
      limits.maximumEntries - retainedEntries - 1,
      Math.floor((limits.maximumBytes - retainedBytes - modelBytes) / 128),
    )
    if (maximumRows < 0 || retainedBytes + modelBytes > limits.maximumBytes)
      return undefined
    const maximumIdentityBytes = Math.floor(
      (limits.maximumBytes - retainedBytes - modelBytes - maximumRows * 128) /
        6,
    )
    const version = (dependencies.exceptionVersion ??= {})
    const table = quoteIdentifier(resourceTable(model))
    let result
    try {
      result = await this.executeSnapshotCacheSafe(
        executor,
        `WITH candidates AS (
      SELECT rowid AS exception_row, length(CAST(_server_identity AS BLOB)) AS identity_bytes,
        typeof(_server_identity) AS identity_type FROM ${table}
      WHERE _partition = ? AND (_local_identity != 'c:' || _server_identity OR _proposal != '{}' OR _state != 'synced')
        AND _server_identity IS NOT NULL LIMIT ?
    ), bounds AS (
      SELECT COUNT(*) AS row_count, COALESCE(SUM(identity_bytes),0) AS identity_bytes,
        COALESCE(SUM(identity_type != 'text'),0) AS unsupported_count FROM candidates
    ) SELECT row_count, identity_bytes, unsupported_count,
      CASE WHEN row_count <= ? AND identity_bytes <= ? AND unsupported_count = 0
      THEN (SELECT json_group_array((SELECT target._server_identity FROM ${table} AS target
        WHERE target.rowid = candidates.exception_row)) FROM candidates) END AS identities
      FROM bounds`,
        [scope.partition, maximumRows + 1, maximumRows, maximumIdentityBytes],
      )
    } catch {
      this.clearSnapshotExceptions(executor)
      return undefined
    }
    const currentLimits = this.snapshotExceptionLimits()
    if (
      dependencies.exceptionVersion !== version ||
      !currentLimits ||
      currentLimits.maximumBatchRows < limits.maximumBatchRows ||
      currentLimits.maximumEntries < limits.maximumEntries ||
      currentLimits.maximumBytes < limits.maximumBytes ||
      scope.partition !== this.partition ||
      scope.session !== this.session ||
      scope.sessionGeneration !== this.session.generation ||
      scope.manifest !== this.manifest ||
      scope.ownerGeneration !== this.owner.generation
    ) {
      this.clearSnapshotExceptions(executor)
      return undefined
    }
    let identities: Set<string> | null = null
    let identityBytes = 0
    const row = result.rows[0]
    if (
      result.rows.length === 1 &&
      row &&
      typeof row.identities === 'string' &&
      utf8Length(row.identities) <= currentLimits.maximumBytes &&
      Number.isSafeInteger(Number(row.row_count)) &&
      Number(row.row_count) <= maximumRows &&
      Number(row.unsupported_count) === 0
    ) {
      let parsed: unknown
      try {
        parsed = JSON.parse(row.identities)
      } catch {
        parsed = undefined
      }
      if (
        Array.isArray(parsed) &&
        parsed.length === Number(row.row_count) &&
        parsed.every(
          (identity): identity is string => typeof identity === 'string',
        )
      ) {
        identities = new Set(parsed)
        identityBytes = parsed.reduce(
          (total, identity) => total + 128 + 6 * utf8Length(identity),
          0,
        )
      }
    }
    const models = new Map(cached?.models)
    models.set(model, identities)
    const entry: SnapshotExceptionCache = {
      ...scope,
      ...currentLimits,
      entries: retainedEntries + 1 + (identities?.size ?? 0),
      bytes: retainedBytes + modelBytes + identityBytes,
      models,
    }
    if (
      entry.entries > currentLimits.maximumEntries ||
      entry.bytes > currentLimits.maximumBytes ||
      !this.memoryCache.set(key, entry, entry.bytes) ||
      this.memoryCache.get(key) !== entry
    )
      return undefined
    return identities ?? undefined
  }
  private admitSnapshotDependency(
    executor: TransactionExecutor,
    key: string,
  ): void {
    const dependencies = this.snapshotDependencies.get(executor)
    if (!dependencies || dependencies.keys.has(key)) return
    const required = utf8Length(key) + 128
    if (
      dependencies.keys.size >= 256 ||
      dependencies.bytes + required >
        this.snapshotWorkBudget().maximumBindingBytes
    )
      throw new SynloquentError(
        'snapshot_admission_required',
        'The affected dependency or alias closure exceeds its bounded budget.',
        { reason: 'dependency-expansion-too-large' },
      )
    dependencies.keys.add(key)
    dependencies.bytes += required
  }
  private async *dependencyRows(
    model: string,
    executor: TransactionExecutor,
    condition: string,
    parameters: readonly BindValue[],
  ): AsyncGenerator<DatabaseRow> {
    const table = quoteIdentifier(resourceTable(model))
    if (!this.snapshotDependencies.has(executor)) {
      const result = await executor.execute(
        `SELECT * FROM ${table} WHERE ${condition}`,
        parameters,
      )
      yield* result.rows
      return
    }
    let after = ''
    while (true) {
      const budget = this.snapshotWorkBudget()
      const metadata = await executor.execute(
        `SELECT _local_identity,length(CAST(_canonical AS BLOB)) + length(CAST(_proposal AS BLOB)) + 512 AS bytes FROM ${table} WHERE (${condition}) AND _local_identity > ? ORDER BY _local_identity LIMIT ?`,
        [...parameters, after, budget.maximumBatchRows],
      )
      if (!metadata.rows.length) return
      for (const row of metadata.rows) {
        after = String(row._local_identity)
        if (Number(row.bytes) > this.snapshotWorkBudget().maximumBindingBytes)
          throw new SynloquentError(
            'snapshot_admission_required',
            'One affected dependency exceeds the current replay budget.',
            { reason: 'dependency-row-too-large' },
          )
        this.admitSnapshotDependency(executor, `row:${model}:${after}`)
        const result = await executor.execute(
          `SELECT * FROM ${table} WHERE (${condition}) AND _local_identity = ?`,
          [...parameters, after],
        )
        if (result.rows[0]) yield result.rows[0]
      }
    }
  }
  async assertBoundedSnapshotEffects(
    executor: TransactionExecutor,
    dataset: string,
  ): Promise<boolean> {
    const owners = [
      ...new Set(
        Object.values(this.manifest.models).flatMap((definition) =>
          Object.values(definition.relations).flatMap((relation) =>
            relation.ownerKey && relation.onUpdate === 'cascade'
              ? [relation.model]
              : [],
          ),
        ),
      ),
    ]
    const hardModels = Object.entries(this.manifest.models)
      .filter(([, definition]) => !definition.softDeletes)
      .map(([model]) => model)
    const risky = await executor.execute(
      `SELECT 1 AS present FROM syn_outbox WHERE partition = ? AND status IN ('pending','sending','conflicted','rejected') AND ((json_extract(operation, '$.action') = 'forceDelete'${hardModels.length ? ` OR (json_extract(operation, '$.action') = 'delete' AND json_extract(operation, '$.model') IN (${hardModels.map(() => '?').join(',')}))` : ''})${owners.length ? ` OR (json_extract(operation, '$.action') IN ('create','update') AND json_extract(operation, '$.model') IN (${owners.map(() => '?').join(',')}))` : ''}) LIMIT 1`,
      [this.partition, ...hardModels, ...owners],
    )
    // Replay bounds the affected closure as it is read, not unrelated catalog rows.
    void dataset
    return risky.rows.length > 0
  }
  async *pendingEntries(
    executor: TransactionExecutor,
    filter: {
      readonly model?: string
      readonly localIdentity?: string
      readonly action?: string
    } = {},
    bounded = false,
  ): AsyncGenerator<OutboxEntry> {
    let after = 0
    const conditions = ['partition = ?', 'sequence > ?']
    const filters: BindValue[] = []
    for (const [key, value] of Object.entries(filter)) {
      if (value === undefined) continue
      conditions.push(`json_extract(operation, '$.${key}') = ?`)
      filters.push(value)
    }
    while (true) {
      const budget = this.snapshotWorkBudget()
      const maximumRows = Math.min(
        bounded ? budget.maximumBatchRows : 64,
        this.owner.adapter.capabilities.maximumParameters - 1,
      )
      const metadata = await executor.execute(
        `SELECT sequence, length(CAST(operation AS BLOB)) + COALESCE(length(CAST(attempted AS BLOB)),0) + COALESCE(length(CAST(error AS BLOB)),0) AS bytes FROM syn_outbox WHERE ${conditions.join(' AND ')} ORDER BY sequence LIMIT ?`,
        [this.partition, after, ...filters, maximumRows],
      )
      if (!metadata.rows.length) return
      const sequences: BindValue[] = []
      let bytes = 0
      for (const row of metadata.rows) {
        const required = Number(row.bytes)
        if (bounded && required > budget.maximumBindingBytes)
          throw new SynloquentError(
            'snapshot_admission_required',
            'A pending operation exceeds the current bounded replay budget.',
            { reason: 'pending-operation-too-large' },
          )
        if (
          bounded &&
          sequences.length &&
          bytes + required > budget.maximumBindingBytes
        )
          break
        sequences.push(row.sequence!)
        bytes += required
      }
      const page = await executor.execute(
        `SELECT * FROM syn_outbox WHERE partition = ? AND sequence IN (${sequences.map(() => '?').join(',')}) ORDER BY sequence`,
        [this.partition, ...sequences],
      )
      for (const row of page.rows) {
        after = Number(row.sequence)
        yield {
          sequence: after,
          operation: JSON.parse(String(row.operation)) as Operation,
          attempted:
            row.attempted === null
              ? null
              : (JSON.parse(String(row.attempted)) as Operation),
          attempts: Number(row.attempts),
          status: String(row.status) as OutboxEntry['status'],
          generation: Number(row.generation),
          error:
            row.error === null
              ? null
              : (JSON.parse(String(row.error)) as Readonly<
                  Record<string, unknown>
                >),
        }
      }
    }
  }
  async beginSnapshotStaging(executor: TransactionExecutor): Promise<void> {
    await executor.execute(
      'CREATE TEMP TABLE syn_snapshot_membership (model TEXT NOT NULL, identity TEXT NOT NULL, PRIMARY KEY(model, identity)) WITHOUT ROWID',
    )
    for (const model of Object.keys(this.manifest.models))
      await executor.execute(
        `UPDATE ${quoteIdentifier(resourceTable(model))} SET _visible = 0 WHERE _partition = ? AND _visible = 1 AND (_proposal != '{}' OR _state != 'synced' OR _deleted != 0 OR _local_identity != 'c:' || _server_identity)`,
        [this.partition],
      )
  }
  async endSnapshotStaging(executor: TransactionExecutor): Promise<void> {
    for (const model of Object.keys(this.manifest.models)) {
      const table = quoteIdentifier(resourceTable(model))
      await executor.execute(
        `UPDATE ${table} SET _visible = 0 WHERE _partition = ? AND _visible = 1 AND NOT EXISTS (SELECT 1 FROM syn_snapshot_membership AS membership WHERE membership.model = ? AND membership.identity = ${table}._server_identity)`,
        [this.partition, model],
      )
    }
  }
  async rebuildProposal(
    model: string,
    localIdentity: string,
    canonical: Attributes,
    executor: TransactionExecutor,
    previousProposal: Attributes = {},
    bounded = false,
  ): Promise<Attributes> {
    const proposal: Attributes = {}
    for await (const entry of this.pendingEntries(
      executor,
      { model, localIdentity },
      bounded,
    )) {
      if (
        !['pending', 'sending', 'conflicted', 'rejected'].includes(entry.status)
      )
        continue
      if (
        entry.operation.action === 'create' ||
        entry.operation.action === 'update'
      )
        for (const [field, value] of Object.entries(entry.operation.values)) {
          if (
            value &&
            typeof value === 'object' &&
            '$ref' in value &&
            value.$ref &&
            typeof value.$ref === 'object' &&
            'model' in value.$ref &&
            'localIdentity' in value.$ref
          ) {
            const referenced = await this.findStored(
              String(value.$ref.model),
              String(value.$ref.localIdentity),
              executor,
            )
            proposal[field] =
              referenced?.serverIdentity ?? String(value.$ref.localIdentity)
          } else proposal[field] = value as import('./types.js').WireValue
        }
      if (
        entry.operation.action === 'increment' &&
        typeof entry.operation.values.field === 'string' &&
        typeof entry.operation.values.delta === 'number'
      ) {
        const field = entry.operation.values.field
        const base = proposal[field] ?? canonical[field] ?? 0
        if (this.manifest.models[model]?.fields[field]?.type === 'integer') {
          const result =
            BigInt(String(base)) + BigInt(entry.operation.values.delta)
          proposal[field] =
            result >= BigInt(Number.MIN_SAFE_INTEGER) &&
            result <= BigInt(Number.MAX_SAFE_INTEGER)
              ? Number(result)
              : result.toString()
        } else proposal[field] = Number(base) + entry.operation.values.delta
      }
      const softField = this.manifest.models[model]?.softDeletes
      if (softField && entry.operation.action === 'delete')
        proposal[softField] =
          previousProposal[softField] ?? this.configuration.now()
      if (softField && entry.operation.action === 'restore')
        proposal[softField] = null
    }
    return proposal
  }
  async ingest(
    canonical: CanonicalRecord,
    executor: TransactionExecutor,
    changed: Set<string>,
    acknowledgement?: string,
    bounded = false,
  ): Promise<StoredRecord> {
    const definition = this.manifest.models[canonical.model]
    if (!definition)
      throw new SynloquentError(
        'unknown_model',
        `Unknown canonical model ${canonical.model}.`,
      )
    let validated = validateAttributes(definition, canonical.attributes, false)
    const primaryValue = validated[definition.primaryKey]
    if (primaryValue === undefined)
      validateValue(
        definition.primaryKey,
        definition.fields[definition.primaryKey]!,
        canonical.id,
      )
    else if (String(primaryValue) !== canonical.id)
      throw new SynloquentError(
        'schema_mismatch',
        'Canonical primary attribute contradicts its wire identity.',
      )
    if (
      canonical.localIdentity !== undefined &&
      (!canonical.localIdentity ||
        canonical.localIdentity.length > 128 ||
        (acknowledgement && canonical.localIdentity !== acknowledgement))
    )
      throw new SynloquentError(
        'schema_mismatch',
        'Canonical local identity is invalid or contradicts its receipt.',
      )
    const authoritativeIdentity = acknowledgement ?? canonical.localIdentity
    const old = await this.findStored(
      canonical.model,
      authoritativeIdentity ?? canonical.id,
      executor,
    )
    if (old?.serverIdentity && old.serverIdentity !== canonical.id)
      throw new SynloquentError(
        'schema_mismatch',
        'Canonical identity reuses a stable alias already assigned to another server record.',
      )
    let revision = canonical.revision
    if (authoritativeIdentity) {
      const provisional = await this.findStored(
        canonical.model,
        canonical.id,
        executor,
      )
      if (
        provisional &&
        old &&
        provisional.localIdentity !== old.localIdentity
      ) {
        if (Object.keys(provisional.proposal).length)
          throw new SynloquentError(
            'conflict',
            'A provisional snapshot identity has its own pending edits and requires explicit alias reconciliation.',
          )
        validated = provisional.canonical
        revision = provisional.revision ?? canonical.revision
        await executor.execute(
          `DELETE FROM ${quoteIdentifier(resourceTable(canonical.model))} WHERE _partition = ? AND _local_identity = ?`,
          [this.partition, provisional.localIdentity],
        )
        await executor.execute(
          'UPDATE syn_relation_sets SET parent_identity = ? WHERE partition = ? AND model = ? AND parent_identity = ?',
          [
            old.localIdentity,
            this.partition,
            canonical.model,
            provisional.localIdentity,
          ],
        )
      }
    }
    const localIdentity =
      old?.localIdentity ?? authoritativeIdentity ?? `c:${canonical.id}`
    const proposal = old
      ? await this.rebuildProposal(
          canonical.model,
          localIdentity,
          validated,
          executor,
          old.proposal,
          bounded,
        )
      : {}
    let hasActive = false
    let conflicted = false
    let rejected = false
    let lifecycle: string | undefined
    if (old)
      for await (const entry of this.pendingEntries(
        executor,
        { model: canonical.model, localIdentity },
        bounded,
      )) {
        if (
          !['pending', 'sending', 'conflicted', 'rejected'].includes(
            entry.status,
          )
        )
          continue
        hasActive = true
        conflicted ||= entry.status === 'conflicted'
        rejected ||= entry.status === 'rejected'
        if (
          ['delete', 'restore', 'forceDelete'].includes(entry.operation.action)
        )
          lifecycle = entry.operation.action
      }
    let hardDeleted =
      lifecycle === 'forceDelete' ||
      (lifecycle === 'delete' && !definition.softDeletes)
    let pendingDependency = false
    for (const relation of Object.values(definition.relations))
      if (
        relation.type === 'belongsTo' &&
        relation.foreignKey &&
        (relation.onDelete === 'cascade' || relation.onDelete === 'nullify')
      ) {
        const value =
          relation.foreignKey in proposal
            ? proposal[relation.foreignKey]
            : validated[relation.foreignKey]
        if (typeof value !== 'string' && typeof value !== 'number') continue
        const parent = await this.findOwner(
          relation.model,
          value,
          executor,
          relation.ownerKey,
          true,
        )
        if (parent?.visible && parent.deleted) {
          pendingDependency = true
          if (relation.onDelete === 'cascade') hardDeleted = true
          else proposal[relation.foreignKey] = null
        }
      }
    const state: SyncState = conflicted
      ? 'conflicted'
      : rejected
        ? 'rejected'
        : hasActive || pendingDependency
          ? 'pending'
          : 'synced'
    const record: StoredRecord = {
      model: canonical.model,
      localIdentity,
      serverIdentity: canonical.id,
      revision,
      canonical: validated,
      proposal,
      visible: true,
      deleted: hardDeleted,
      state,
      attributes: { ...validated, ...proposal },
    }
    await this.persist(record, executor, changed)
    if (old?.serverIdentity === null && canonical.id !== localIdentity)
      await this.remapReferences(
        canonical.model,
        localIdentity,
        canonical.id,
        executor,
        changed,
      )
    changed.add(canonical.model)
    return record
  }
  async stageSnapshotRecords(
    records: readonly CanonicalRecord[],
    executor: TransactionExecutor,
    append = false,
    comparisons?: Map<string, boolean>,
  ): Promise<void> {
    const membership = 'syn_snapshot_membership'
    if (!append)
      await executor.execute(
        `CREATE TEMP TABLE ${quoteIdentifier(membership)} (model TEXT NOT NULL, identity TEXT NOT NULL, PRIMARY KEY(model, identity)) WITHOUT ROWID`,
      )
    try {
      // Pending/aliased rows need scalar replay. Ordinary unchanged canonical
      // rows keep their live indexes throughout this private transaction.
      if (!append)
        for (const model of Object.keys(this.manifest.models))
          await executor.execute(
            `UPDATE ${quoteIdentifier(resourceTable(model))} SET _visible = 0 WHERE _partition = ? AND _visible = 1 AND (_proposal != '{}' OR _state != 'synced' OR _deleted != 0 OR _local_identity != 'c:' || _server_identity)`,
            [this.partition],
          )
      const maximumRows = Math.min(
        append ? this.snapshotWorkBudget().maximumBatchRows : 64,
        Math.floor((this.owner.adapter.capabilities.maximumParameters - 2) / 2),
      )
      if (maximumRows < 1)
        throw new SynloquentError(
          'schema_mismatch',
          'Database parameter capacity is smaller than one snapshot staging row.',
        )
      const canonicalComparisons = comparisons ?? new Map<string, boolean>()
      let batch: CanonicalRecord[] = []
      const flush = async (): Promise<void> => {
        const first = batch[0]
        if (!first) return
        const definition = this.manifest.models[first.model]!
        const table = quoteIdentifier(resourceTable(first.model))
        const primary = quoteIdentifier(definition.primaryKey)
        let compareCanonical = canonicalComparisons.get(first.model)
        if (compareCanonical === undefined)
          for (const fieldName in definition.fields)
            if (
              Object.prototype.hasOwnProperty.call(
                definition.fields,
                fieldName,
              ) &&
              definition.fields[fieldName]!.type === 'json'
            ) {
              compareCanonical = true
              canonicalComparisons.set(first.model, true)
              break
            }
        const incoming: BindValue[] = []
        const attributesAwaitingComparison: Attributes[] = []
        for (const record of batch) {
          const attributes = validateAttributes(
            definition,
            record.attributes,
            false,
          )
          if (compareCanonical === undefined)
            attributesAwaitingComparison.push(attributes)
          else if (compareCanonical)
            incoming.push(record.id, canonicalJson(attributes))
        }
        if (compareCanonical === undefined) {
          // Validate the first scalar batch before the additional presence read.
          // JSON models retain their original validation/serialization order.
          compareCanonical =
            (
              await executor.execute(
                `SELECT 1 AS present FROM ${table} WHERE _partition = ? AND _visible = 1 LIMIT 1`,
                [this.partition],
              )
            ).rows.length > 0
          canonicalComparisons.set(first.model, compareCanonical)
          if (compareCanonical)
            for (let index = 0; index < batch.length; index++)
              incoming.push(
                batch[index]!.id,
                canonicalJson(attributesAwaitingComparison[index]),
              )
          attributesAwaitingComparison.length = 0
        }
        // The primary-key IN search bounds table work to this chunk. Canonical
        // strings are only bound for the chunk and never retained in temp rows.
        if (compareCanonical)
          await executor.execute(
            `WITH incoming(identity, canonical) AS (VALUES ${batch.map(() => '(?,?)').join(',')}) UPDATE ${table} SET _visible = 0 WHERE _partition = ? AND _local_identity IN (SELECT target._local_identity FROM incoming CROSS JOIN ${table} AS target WHERE target._partition = ? AND target.${primary} = incoming.identity AND target._visible = 1 AND target._canonical != incoming.canonical)`,
            [...incoming, this.partition, this.partition],
          )
        await executor.execute(
          `INSERT OR IGNORE INTO ${quoteIdentifier(membership)} (model, identity) VALUES ${batch.map(() => '(?,?)').join(',')}`,
          batch.flatMap((record) => [record.model, record.id]),
        )
        batch = []
      }
      for (const record of records) {
        if (!this.manifest.models[record.model])
          throw new SynloquentError(
            'unknown_model',
            `Unknown snapshot model ${record.model}.`,
          )
        if (
          batch.length &&
          (batch[0]?.model !== record.model || batch.length >= maximumRows)
        )
          await flush()
        batch.push(record)
      }
      await flush()
      if (!append)
        for (const model of Object.keys(this.manifest.models)) {
          const table = quoteIdentifier(resourceTable(model))
          await executor.execute(
            `UPDATE ${table} SET _visible = 0 WHERE _partition = ? AND _visible = 1 AND NOT EXISTS (SELECT 1 FROM ${quoteIdentifier(membership)} AS membership WHERE membership.model = ? AND membership.identity = ${table}._server_identity)`,
            [this.partition, model],
          )
        }
    } finally {
      if (!append)
        await executor.execute(`DROP TABLE ${quoteIdentifier(membership)}`)
    }
  }
  async ingestSnapshotRecords(
    records: readonly CanonicalRecord[],
    executor: TransactionExecutor,
    changed: Set<string>,
    bounded = false,
  ): Promise<void> {
    const exceptions = new Set<string>()
    for (const model of bounded
      ? [...new Set(records.map((record) => record.model))]
      : Object.keys(this.manifest.models)) {
      const identities = bounded
        ? records
            .filter((record) => record.model === model)
            .map((record) => record.id)
        : []
      const cached = bounded
        ? await this.cachedSnapshotExceptions(model, executor)
        : undefined
      if (cached) {
        for (const identity of identities)
          if (cached.has(identity)) exceptions.add(`${model}:${identity}`)
      } else {
        const result = await this.executeSnapshotCacheSafe(
          executor,
          `SELECT _server_identity FROM ${quoteIdentifier(resourceTable(model))} WHERE _partition = ? AND (_local_identity != 'c:' || _server_identity OR _proposal != '{}' OR _state != 'synced')${bounded ? ` AND _server_identity IN (${identities.map(() => '?').join(',')})` : ''}`,
          [this.partition, ...identities],
        )
        for (const row of result.rows)
          if (row._server_identity !== null)
            exceptions.add(`${model}:${String(row._server_identity)}`)
      }
    }
    const dependencies = bounded
      ? this.snapshotDependencies.get(executor)
      : undefined
    const recordSqlPlans = dependencies
      ? (dependencies.recordSqlPlans ??= new Map<
          string,
          SnapshotRecordSqlPlan
        >())
      : undefined
    const seen = new Set<string>()
    const maximumRowsByModel = new Map<string, number>()
    let batch: CanonicalRecord[] = []
    const flush = async (): Promise<void> => {
      const first = batch[0]
      if (!first) return
      const definition = this.manifest.models[first.model]!
      const plan = recordSqlPlans?.get(first.model)
      const orderedFields =
        plan?.orderedFields ??
        Object.entries(definition.fields).filter(
          ([, field]) => field.type === 'decimal',
        )
      const columns = plan?.columns ?? [
        '_partition',
        '_local_identity',
        '_server_identity',
        '_revision',
        '_canonical',
        '_proposal',
        '_visible',
        '_deleted',
        '_state',
        ...orderedFields.map(([field]) => `_order_${field}`),
      ]
      if (plan) {
        plan.orderedFields = orderedFields
        plan.columns = columns
      }
      const parameters: BindValue[] = []
      for (const canonical of batch) {
        const attributes = validateAttributes(
          definition,
          canonical.attributes,
          false,
        )
        parameters.push(
          this.partition,
          `c:${canonical.id}`,
          canonical.id,
          canonical.revision,
          canonicalJson(attributes),
          '{}',
          1,
          0,
          'synced',
        )
        for (const [field, fieldDefinition] of orderedFields) {
          const value =
            attributes[field] ??
            (field === definition.primaryKey ? canonical.id : null)
          parameters.push(
            value === null
              ? null
              : decimalOrder(value, fieldDefinition.precision ?? 18),
          )
        }
      }
      let statement =
        plan?.statement?.rowCount === batch.length
          ? plan.statement.sql
          : undefined
      if (statement === undefined) {
        const placeholder = `(${columns.map(() => '?').join(',')})`
        statement = `INSERT INTO ${quoteIdentifier(resourceTable(first.model))} (${columns.map(quoteIdentifier).join(',')}) VALUES ${batch.map(() => placeholder).join(',')} ON CONFLICT(_partition,_local_identity) DO UPDATE SET ${columns
          .slice(2)
          .map(
            (column) =>
              `${quoteIdentifier(column)}=excluded.${quoteIdentifier(column)}`,
          )
          .join(',')}`
        if (plan) plan.statement = { rowCount: batch.length, sql: statement }
      }
      await this.executeSnapshotCacheSafe(executor, statement, parameters)
      changed.add(first.model)
      batch = []
    }
    for (const canonical of records) {
      const definition = this.manifest.models[canonical.model]
      if (!definition)
        throw new SynloquentError(
          'unknown_model',
          `Unknown snapshot model ${canonical.model}.`,
        )
      if (canonical.attributes[definition.primaryKey] === undefined)
        validateValue(
          definition.primaryKey,
          definition.fields[definition.primaryKey]!,
          canonical.id,
        )
      const identity = `${canonical.model}:${canonical.id}`
      if (
        !canonical.id ||
        !canonical.revision ||
        seen.has(identity) ||
        (canonical.attributes[definition.primaryKey] !== undefined &&
          String(canonical.attributes[definition.primaryKey]) !== canonical.id)
      )
        throw new SynloquentError(
          'snapshot_invalid',
          'Snapshot contains an invalid or duplicate record identity.',
        )
      seen.add(identity)
      if (exceptions.has(identity) || canonical.localIdentity !== undefined) {
        await flush()
        this.clearSnapshotExceptions(executor)
        try {
          await this.ingest(canonical, executor, changed, undefined, bounded)
        } finally {
          this.clearSnapshotExceptions(executor)
        }
        continue
      }
      let maximumRows = maximumRowsByModel.get(canonical.model)
      if (maximumRows === undefined) {
        let plan = recordSqlPlans?.get(canonical.model)
        if (plan && plan.definition !== definition) {
          recordSqlPlans?.delete(canonical.model)
          plan = undefined
        }
        const parametersPerRow =
          plan?.parametersPerRow ??
          9 +
            Object.values(definition.fields).filter(
              (field) => field.type === 'decimal',
            ).length
        if (recordSqlPlans && !plan)
          recordSqlPlans.set(canonical.model, { definition, parametersPerRow })
        maximumRows = Math.min(
          bounded ? this.snapshotWorkBudget().maximumBatchRows : 64,
          Math.floor(
            this.owner.adapter.capabilities.maximumParameters /
              parametersPerRow,
          ),
        )
        maximumRowsByModel.set(canonical.model, maximumRows)
      }
      if (maximumRows < 1)
        throw new SynloquentError(
          'schema_mismatch',
          'Database parameter capacity is smaller than one exported record.',
        )
      if (
        batch.length &&
        (batch[0]?.model !== canonical.model || batch.length >= maximumRows)
      )
        await flush()
      batch.push(canonical)
    }
    await flush()
  }
  async clearCanonicalRelations(
    executor: TransactionExecutor,
    changed: Set<string>,
  ): Promise<void> {
    const tables = new Set(
      Object.values(this.manifest.models).flatMap((model) =>
        Object.values(model.relations).flatMap((relation) =>
          relation.pivot ? [relation.pivot.table] : [],
        ),
      ),
    )
    for (const table of tables) {
      await executor.execute(
        `DELETE FROM ${quoteIdentifier(`syn_canonical_pivot_${table}`)} WHERE _partition = ?`,
        [this.partition],
      )
      changed.add(`pivot:${table}`)
    }
    await executor.execute(
      'DELETE FROM syn_relation_sets WHERE partition = ?',
      [this.partition],
    )
  }
  private async remapReferences(
    model: string,
    localIdentity: string,
    serverIdentity: string,
    executor: TransactionExecutor,
    changed: Set<string>,
  ): Promise<void> {
    for (const [name, definition] of Object.entries(this.manifest.models)) {
      for (const relation of Object.values(definition.relations)) {
        if (
          relation.type !== 'belongsTo' ||
          relation.model !== model ||
          !relation.foreignKey ||
          (relation.ownerKey !== undefined &&
            relation.ownerKey !== this.manifest.models[model]?.primaryKey)
        )
          continue
        const rows = this.dependencyRows(
          name,
          executor,
          `_partition = ? AND (${quoteIdentifier(relation.foreignKey)} = ? OR json_extract(_proposal, ?) = ? OR json_extract(_canonical, ?) = ?)`,
          [
            this.partition,
            localIdentity,
            `$.${relation.foreignKey}`,
            localIdentity,
            `$.${relation.foreignKey}`,
            localIdentity,
          ],
        )
        let remapped = false
        for await (const row of rows) {
          remapped = true
          const record = this.row(name, row)
          const proposal = { ...record.proposal }
          const canonical = { ...record.canonical }
          if (proposal[relation.foreignKey] === localIdentity)
            proposal[relation.foreignKey] = serverIdentity
          if (canonical[relation.foreignKey] === localIdentity)
            canonical[relation.foreignKey] = serverIdentity
          await this.persist(
            { ...record, canonical, proposal },
            executor,
            changed,
          )
        }
        if (remapped) changed.add(name)
      }
      for (const relation of Object.values(definition.relations)) {
        if (!relation.pivot) continue
        const key =
          relation.model === model
            ? relation.pivot.relatedKey
            : name === model
              ? relation.pivot.foreignKey
              : undefined
        if (key) {
          await executor.execute(
            `UPDATE ${quoteIdentifier(pivotTable(relation.pivot.table))} SET ${quoteIdentifier(key)} = ? WHERE _partition = ? AND ${quoteIdentifier(key)} = ?`,
            [serverIdentity, this.partition, localIdentity],
          )
          changed.add(`pivot:${relation.pivot.table}`)
        }
      }
    }
  }
  async rebuildDeleteEffects(
    model: string,
    identity: string,
    executor: TransactionExecutor,
    changed: Set<string>,
  ): Promise<void> {
    const root = await this.findStored(model, identity, executor)
    if (!root) return
    const members = new Map<string, StoredRecord>()
    const queue = [root]
    for (let position = 0; position < queue.length; position++) {
      const parent = queue[position]!
      const key = `${parent.model}:${parent.localIdentity}`
      if (members.has(key)) continue
      members.set(key, parent)
      for (const [name, definition] of Object.entries(this.manifest.models))
        for (const relation of Object.values(definition.relations)) {
          if (
            relation.type !== 'belongsTo' ||
            relation.model !== parent.model ||
            !relation.foreignKey ||
            !['cascade', 'nullify'].includes(relation.onDelete ?? '')
          )
            continue
          const owner = this.manifest.models[parent.model]!
          const ownerKey = relation.ownerKey ?? owner.primaryKey
          const field = definition.fields[relation.foreignKey]!
          const values =
            ownerKey === owner.primaryKey
              ? [parent.localIdentity, parent.serverIdentity]
              : [parent.attributes[ownerKey], parent.canonical[ownerKey]]
          const distinct = [
            ...new Set(
              values.filter(
                (value): value is string | number =>
                  typeof value === 'string' || typeof value === 'number',
              ),
            ),
          ]
          if (!distinct.length) continue
          const ordered = (value: string | number): BindValue =>
            field.type === 'integer'
              ? integerOrder(value)
              : field.type === 'decimal'
                ? decimalOrder(value, field.precision ?? 18)
                : storageValue(value, field)
          const column =
            field.type === 'integer' || field.type === 'decimal'
              ? `_order_${relation.foreignKey}`
              : relation.foreignKey
          const placeholders = distinct.map(() => '?').join(',')
          const children = await executor.execute(
            `SELECT * FROM ${quoteIdentifier(resourceTable(name))} WHERE _partition = ? AND _visible = 1 AND (${quoteIdentifier(column)} IN (${placeholders}) OR CAST(json_extract(_canonical, ?) AS TEXT) IN (${placeholders}))`,
            [
              this.partition,
              ...distinct.map(ordered),
              `$.${relation.foreignKey}`,
              ...distinct.map(String),
            ],
          )
          for (const row of children.rows) queue.push(this.row(name, row))
        }
    }
    const entries = await this.pending(executor)
    const affected = new Set(
      [...members.values()].map((record) => record.model),
    )
    for (const [name, definition] of Object.entries(this.manifest.models))
      for (const relation of Object.values(definition.relations))
        if (
          relation.pivot &&
          (affected.has(name) || affected.has(relation.model))
        )
          changed.add(`pivot:${relation.pivot.table}`)
    for (const record of members.values()) {
      if (!record.visible) continue
      const active = entries.filter(
        (entry) =>
          entry.operation.model === record.model &&
          entry.operation.localIdentity === record.localIdentity &&
          ['pending', 'sending', 'conflicted', 'rejected'].includes(
            entry.status,
          ),
      )
      const proposal = await this.rebuildProposal(
        record.model,
        record.localIdentity,
        record.canonical,
        executor,
        record.proposal,
      )
      const lifecycle = active
        .filter((entry) =>
          ['delete', 'restore', 'forceDelete'].includes(entry.operation.action),
        )
        .at(-1)?.operation.action
      const softField = this.manifest.models[record.model]?.softDeletes
      await this.persist(
        {
          ...record,
          proposal,
          attributes: { ...record.canonical, ...proposal },
          deleted:
            lifecycle === 'forceDelete' ||
            (lifecycle === 'delete' && !softField),
          state: active.some((entry) => entry.status === 'conflicted')
            ? 'conflicted'
            : active.some((entry) => entry.status === 'rejected')
              ? 'rejected'
              : active.length
                ? 'pending'
                : 'synced',
        },
        executor,
        changed,
      )
      changed.add(record.model)
    }
    await this.applyPendingOwnerKeyUpdates(executor, changed)
    const applied = new Set<string>()
    for (const record of members.values()) {
      const current = await this.findStored(
        record.model,
        record.localIdentity,
        executor,
      )
      if (!current?.visible) continue
      if (current.deleted)
        await this.deleteDependencies(
          current.model,
          current.localIdentity,
          executor,
          changed,
          'local',
          applied,
        )
      for (const relation of Object.values(
        this.manifest.models[current.model]!.relations,
      )) {
        if (
          relation.type !== 'belongsTo' ||
          !relation.foreignKey ||
          !['cascade', 'nullify'].includes(relation.onDelete ?? '')
        )
          continue
        const value = current.attributes[relation.foreignKey]
        if (typeof value !== 'string' && typeof value !== 'number') continue
        const parent = await this.findOwner(
          relation.model,
          value,
          executor,
          relation.ownerKey,
          true,
        )
        if (parent?.visible && parent.deleted)
          await this.deleteDependencies(
            parent.model,
            parent.localIdentity,
            executor,
            changed,
            'local',
            applied,
          )
      }
    }
  }
  async applyPendingDeleteEffects(
    executor: TransactionExecutor,
    changed: Set<string>,
  ): Promise<void> {
    await this.applyPendingOwnerKeyUpdates(executor, changed)
    const visited = new Set<string>()
    const bounded = this.snapshotDependencies.has(executor)
    async function* operations(storage: Storage): AsyncGenerator<Operation> {
      if (!bounded) {
        const result = await executor.execute(
          "SELECT operation FROM syn_outbox WHERE partition = ? AND status IN ('pending','sending','conflicted','rejected') AND json_extract(operation, '$.action') IN ('delete','forceDelete') ORDER BY sequence",
          [storage.partition],
        )
        for (const row of result.rows)
          yield JSON.parse(String(row.operation)) as Operation
        return
      }
      for await (const entry of storage.pendingEntries(executor, {}, true))
        if (
          ['pending', 'sending', 'conflicted', 'rejected'].includes(
            entry.status,
          ) &&
          ['delete', 'forceDelete'].includes(entry.operation.action)
        )
          yield entry.operation
    }
    for await (const operation of operations(this)) {
      const definition = this.manifest.models[operation.model]
      if (
        !definition ||
        (operation.action === 'delete' && definition.softDeletes)
      )
        continue
      const parent = await this.findStored(
        operation.model,
        operation.localIdentity,
        executor,
      )
      if (!parent?.visible || !parent.deleted) continue
      await this.deleteDependencies(
        parent.model,
        parent.localIdentity,
        executor,
        changed,
        'local',
        visited,
        true,
      )
    }
  }
  private async applyPendingOwnerKeyUpdates(
    executor: TransactionExecutor,
    changed: Set<string>,
  ): Promise<void> {
    const models = new Set(
      Object.values(this.manifest.models).flatMap((definition) =>
        Object.values(definition.relations).flatMap((relation) =>
          relation.type === 'belongsTo' &&
          relation.ownerKey &&
          relation.ownerKey !==
            this.manifest.models[relation.model]?.primaryKey &&
          relation.onUpdate === 'cascade'
            ? [relation.model]
            : [],
        ),
      ),
    )
    if (!models.size) return
    const visited = new Set<string>()
    const bounded = this.snapshotDependencies.has(executor)
    async function* owners(
      storage: Storage,
    ): AsyncGenerator<{ model: string; localIdentity: string }> {
      if (!bounded) {
        const entries = await executor.execute(
          "SELECT DISTINCT json_extract(operation, '$.model') AS model, json_extract(operation, '$.localIdentity') AS local_identity FROM syn_outbox WHERE partition = ? AND status IN ('pending','sending','conflicted','rejected') AND json_extract(operation, '$.action') IN ('create','update')",
          [storage.partition],
        )
        for (const row of entries.rows)
          yield {
            model: String(row.model),
            localIdentity: String(row.local_identity),
          }
        return
      }
      for await (const entry of storage.pendingEntries(executor, {}, true))
        if (
          ['pending', 'sending', 'conflicted', 'rejected'].includes(
            entry.status,
          ) &&
          ['create', 'update'].includes(entry.operation.action)
        )
          yield {
            model: entry.operation.model,
            localIdentity: entry.operation.localIdentity,
          }
    }
    for await (const row of owners(this)) {
      const model = row.model
      if (!models.has(model)) continue
      const parent = await this.findStored(model, row.localIdentity, executor)
      if (!parent?.visible) continue
      await this.updateDependencies(
        { ...parent, attributes: parent.canonical },
        parent,
        executor,
        changed,
        visited,
      )
    }
  }
  async deleteDependencies(
    model: string,
    identity: string,
    executor: TransactionExecutor,
    changed: Set<string>,
    source: 'local' | 'server',
    visited = new Set<string>(),
    includeDeleted = false,
  ): Promise<void> {
    const key = `${model}:${identity}`
    if (visited.has(key)) return
    this.admitSnapshotDependency(executor, `delete:${key}`)
    visited.add(key)
    const parent = await this.findStored(model, identity, executor)
    if (!parent) return
    for (const [name, definition] of Object.entries(this.manifest.models))
      for (const relation of Object.values(definition.relations)) {
        if (
          relation.type !== 'belongsTo' ||
          relation.model !== model ||
          !relation.foreignKey ||
          !relation.onDelete
        )
          continue
        const target = this.manifest.models[model]!
        const ownerKey = relation.ownerKey ?? target.primaryKey
        const custom = ownerKey !== target.primaryKey
        const foreignDefinition = definition.fields[relation.foreignKey]!
        const foreignColumn =
          foreignDefinition.type === 'integer' ||
          foreignDefinition.type === 'decimal'
            ? `_order_${relation.foreignKey}`
            : relation.foreignKey
        const ownerValue = parent.attributes[ownerKey] ?? null
        if (custom && ownerValue === null) continue
        if (
          source === 'local' &&
          custom &&
          (typeof ownerValue === 'string' || typeof ownerValue === 'number')
        ) {
          const owner = await this.findOwner(
            model,
            ownerValue,
            executor,
            ownerKey,
            true,
          )
          if (owner?.localIdentity !== parent.localIdentity) continue
        }
        const boundValue = (value: WireValue): BindValue =>
          foreignDefinition.type === 'integer'
            ? integerOrder(value)
            : foreignDefinition.type === 'decimal'
              ? decimalOrder(value, foreignDefinition.precision ?? 18)
              : storageValue(value, foreignDefinition)
        const children = this.dependencyRows(
          name,
          executor,
          `_partition = ? AND _visible = 1${source === 'local' && (!includeDeleted || relation.onDelete === 'restrict') ? ' AND _deleted = 0' : ''} AND ${quoteIdentifier(foreignColumn)} ${custom ? '= ?' : 'IN (?,?)'}`,
          custom
            ? [this.partition, boundValue(ownerValue)]
            : [
                this.partition,
                boundValue(parent.localIdentity),
                boundValue(parent.serverIdentity ?? parent.localIdentity),
              ],
        )
        for await (const row of children) {
          if (relation.onDelete === 'restrict' && source === 'local')
            throw new SynloquentError(
              'forbidden_operation',
              `Deletion is restricted by ${name}.${relation.foreignKey}.`,
            )
          const child = this.row(name, row)
          if (relation.onDelete === 'cascade') {
            await this.deleteDependencies(
              name,
              child.localIdentity,
              executor,
              changed,
              source,
              visited,
              includeDeleted,
            )
            await this.persist(
              {
                ...child,
                visible: source === 'local' ? child.visible : false,
                deleted: true,
                state:
                  source === 'local' &&
                  !['conflicted', 'rejected'].includes(child.state)
                    ? 'pending'
                    : child.state,
              },
              executor,
            )
          } else if (relation.onDelete === 'nullify')
            await this.persist(
              {
                ...child,
                canonical:
                  source === 'server'
                    ? { ...child.canonical, [relation.foreignKey]: null }
                    : child.canonical,
                proposal:
                  source === 'local' || relation.foreignKey in child.proposal
                    ? { ...child.proposal, [relation.foreignKey]: null }
                    : child.proposal,
                state:
                  source === 'local' &&
                  !['conflicted', 'rejected'].includes(child.state)
                    ? 'pending'
                    : child.state,
              },
              executor,
            )
          changed.add(name)
        }
      }
    for (const [name, definition] of Object.entries(this.manifest.models))
      for (const relation of Object.values(definition.relations))
        if (relation.pivot) {
          const pivot = relation.pivot
          const field =
            name === model
              ? pivot.foreignKey
              : relation.model === model
                ? pivot.relatedKey
                : undefined
          if (field) {
            await executor.execute(
              `DELETE FROM ${quoteIdentifier(pivotTable(pivot.table))} WHERE _partition = ? AND ${quoteIdentifier(field)} IN (?,?)`,
              [
                this.partition,
                parent.localIdentity,
                parent.serverIdentity ?? parent.localIdentity,
              ],
            )
            changed.add(`pivot:${pivot.table}`)
          }
        }
  }
  async remove(
    model: string,
    identity: string,
    reason: 'delete' | 'remove',
    executor: TransactionExecutor,
    changed: Set<string>,
  ): Promise<void> {
    const record = await this.findStored(model, identity, executor)
    if (!record) return
    if (reason === 'delete')
      await this.deleteDependencies(
        model,
        identity,
        executor,
        changed,
        'server',
      )
    if (reason === 'remove' && Object.keys(record.proposal).length)
      await executor.execute(
        'INSERT OR REPLACE INTO syn_recovery(partition,model,local_identity,proposal,reason) VALUES (?,?,?,?,?)',
        [
          this.partition,
          model,
          record.localIdentity,
          canonicalJson(record.proposal),
          'access_revoked',
        ],
      )
    await this.persist(
      {
        ...record,
        visible: false,
        deleted: reason === 'delete',
        proposal: reason === 'remove' ? {} : record.proposal,
      },
      executor,
    )
    for (const definition of Object.values(this.manifest.models))
      for (const relation of Object.values(definition.relations)) {
        if (!relation.pivot) continue
        if (relation.model === model)
          await executor.execute(
            `DELETE FROM ${quoteIdentifier(pivotTable(relation.pivot.table))} WHERE _partition = ? AND ${quoteIdentifier(relation.pivot.relatedKey)} IN (?,?)`,
            [this.partition, identity, record.localIdentity],
          )
      }
    changed.add(model)
  }
  private morphName(
    model: string,
    relation: import('./types.js').RelationDefinition,
  ): string | undefined {
    if (!relation.morphType) return undefined
    const target = relation.type === 'morphedByMany' ? relation.model : model
    const name = Object.entries(relation.morphMap ?? {}).find(
      ([, candidate]) => candidate === target,
    )?.[0]
    if (!name)
      throw new SynloquentError(
        'schema_mismatch',
        `Missing declared morph alias for ${target}.`,
      )
    return name
  }
  async ingestSnapshotRelationSets(
    sets: readonly RelationSet[],
    executor: TransactionExecutor,
    changed: Set<string>,
    bounded = false,
  ): Promise<void> {
    const maximumParameters = this.owner.adapter.capabilities.maximumParameters
    const maximumRows = Math.max(
      1,
      Math.min(
        bounded ? this.snapshotWorkBudget().maximumBatchRows : 64,
        Math.floor(maximumParameters / 7),
      ),
    )
    let batch: RelationSet[] = []
    const flush = async (): Promise<void> => {
      const first = batch[0]
      if (!first) return
      const definition = this.manifest.models[first.model]!
      const relation = definition.relations[first.relation]!
      const pivot = relation.pivot!
      const columns = [
        '_local_identity',
        '_server_identity',
        '_revision',
        '_canonical',
        '_proposal',
        '_visible',
        '_deleted',
        '_state',
      ]
      if (batch.length + 2 > maximumParameters)
        throw new SynloquentError(
          'schema_mismatch',
          'Database parameter capacity is smaller than a relation parent lookup.',
        )
      const result = await executor.execute(
        `WITH requested(position,identity) AS (VALUES ${batch.map((_, position) => `(${position},?)`).join(',')}) SELECT requested.position AS _snapshot_position,0 AS _snapshot_priority,${columns.map((column) => `parent.${quoteIdentifier(column)}`).join(',')} FROM requested CROSS JOIN ${quoteIdentifier(resourceTable(first.model))} AS parent WHERE parent._partition = ? AND parent._local_identity = requested.identity UNION ALL SELECT requested.position AS _snapshot_position,1 AS _snapshot_priority,${columns.map((column) => `parent.${quoteIdentifier(column)}`).join(',')} FROM requested CROSS JOIN ${quoteIdentifier(resourceTable(first.model))} AS parent WHERE parent._partition = ? AND parent.${quoteIdentifier(definition.primaryKey)} = requested.identity AND parent._local_identity != requested.identity ORDER BY _snapshot_position,_snapshot_priority`,
        [
          ...batch.map((set) => String(set.parentId)),
          this.partition,
          this.partition,
        ],
      )
      const parents = new Map<number, StoredRecord>()
      for (const row of result.rows) {
        const position = Number(row._snapshot_position)
        if (!parents.has(position))
          parents.set(position, this.row(first.model, row))
      }
      type PreparedSet = {
        readonly set: RelationSet
        readonly parentIdentity: string
        readonly parentKey: string
      }
      const write = async (entries: readonly PreparedSet[]): Promise<void> => {
        if (!entries.length) return
        if (maximumParameters < 7)
          throw new SynloquentError(
            'schema_mismatch',
            'Database parameter capacity is smaller than one relation set.',
          )
        const morphName = this.morphName(first.model, relation)
        const table = quoteIdentifier(`syn_canonical_pivot_${pivot.table}`)
        await executor.execute(
          `DELETE FROM ${table} WHERE _partition = ? AND ${quoteIdentifier(pivot.foreignKey)} IN (${entries.map(() => '?').join(',')})${relation.morphType ? ` AND ${quoteIdentifier(relation.morphType)} = ?` : ''}`,
          [
            this.partition,
            ...entries.map((entry) => entry.parentKey),
            ...(morphName ? [morphName] : []),
          ],
        )
        let targetFields: string[] = []
        let targetRows: BindValue[][] = []
        const flushTargets = async (): Promise<void> => {
          if (!targetRows.length) return
          const placeholder = `(${targetFields.map(() => '?').join(',')})`
          await executor.execute(
            `INSERT OR REPLACE INTO ${table} (${targetFields.map(quoteIdentifier).join(',')}) VALUES ${targetRows.map(() => placeholder).join(',')}`,
            targetRows.flat(),
          )
          targetRows = []
        }
        for (const entry of entries)
          for (const target of entry.set.targets) {
            const projected: Record<string, BindValue> = {
              _partition: this.partition,
              [pivot.foreignKey]: entry.parentKey,
              [pivot.relatedKey]: target.id,
              ...(relation.morphType
                ? { [relation.morphType]: morphName ?? '' }
                : {}),
            }
            for (const [field, value] of Object.entries(target.attributes)) {
              const fieldDefinition = pivot.fields[field]
              if (!fieldDefinition || !fieldDefinition.readable)
                throw new SynloquentError(
                  'forbidden_field',
                  `Unexpected pivot projection ${field}.`,
                )
              validateValue(field, fieldDefinition, value)
            }
            for (const [field, fieldDefinition] of Object.entries(pivot.fields))
              projected[field] = storageValue(
                target.attributes[field] ?? fieldDefinition.default,
                fieldDefinition,
              )
            targetFields = Object.keys(projected)
            const maximumTargets = Math.min(
              bounded ? this.snapshotWorkBudget().maximumBatchRows : 64,
              Math.floor(maximumParameters / targetFields.length),
            )
            if (maximumTargets < 1)
              throw new SynloquentError(
                'schema_mismatch',
                'Database parameter capacity is smaller than one pivot target.',
              )
            if (targetRows.length >= maximumTargets) await flushTargets()
            targetRows.push(
              targetFields.map((field) => projected[field] ?? null),
            )
          }
        await flushTargets()
        await executor.execute(
          `INSERT INTO syn_relation_sets(partition,model,relation,parent_identity,revision,completeness,canonical) VALUES ${entries.map(() => '(?,?,?,?,?,?,?)').join(',')} ON CONFLICT(partition,model,relation,parent_identity) DO UPDATE SET revision=excluded.revision,completeness=excluded.completeness,canonical=excluded.canonical`,
          entries.flatMap((entry) => [
            this.partition,
            entry.set.model,
            entry.set.relation,
            entry.parentIdentity,
            entry.set.revision,
            entry.set.completeness,
            canonicalJson(entry.set.targets),
          ]),
        )
        changed.add(`pivot:${pivot.table}`)
      }
      let prepared: PreparedSet[] = []
      const parentKeys = new Set<string>()
      for (const [position, set] of batch.entries()) {
        const parent = parents.get(position)
        if (!parent?.visible) continue
        const parentKey = String(
          parent.attributes[relation.localKey ?? definition.primaryKey] ??
            parent.serverIdentity ??
            parent.localIdentity,
        )
        // A repeated effective key must replace the preceding set in input order.
        if (parentKeys.has(parentKey)) {
          await write(prepared)
          prepared = []
          parentKeys.clear()
        }
        prepared.push({ set, parentIdentity: parent.localIdentity, parentKey })
        parentKeys.add(parentKey)
      }
      await write(prepared)
      batch = []
    }
    for (const set of sets) {
      const definition = this.manifest.models[set.model]
      const relation = definition?.relations[set.relation]
      if (
        !definition ||
        !relation?.pivot ||
        !Array.isArray(set.targets) ||
        !['complete', 'partial'].includes(set.completeness)
      )
        throw new SynloquentError(
          'schema_mismatch',
          'Malformed or undeclared relation set.',
        )
      // A projected physical key can redirect a row into a later set's DELETE.
      // Keep the scalar sequence for these declarations instead of reordering it.
      if (
        Object.keys(relation.pivot.fields).some(
          (field) =>
            field === relation.pivot!.foreignKey ||
            field === relation.morphType ||
            field === '_partition',
        )
      ) {
        await flush()
        await this.ingestRelationSet(set, executor, changed)
        continue
      }
      if (
        batch.length &&
        (batch[0]?.model !== set.model ||
          batch[0]?.relation !== set.relation ||
          batch.length >= maximumRows)
      )
        await flush()
      batch.push(set)
    }
    await flush()
  }
  async ingestRelationSet(
    set: RelationSet,
    executor: TransactionExecutor,
    changed: Set<string>,
  ): Promise<void> {
    const definition = this.manifest.models[set.model]
    const relation = definition?.relations[set.relation]
    if (
      !definition ||
      !relation?.pivot ||
      !Array.isArray(set.targets) ||
      !['complete', 'partial'].includes(set.completeness)
    )
      throw new SynloquentError(
        'schema_mismatch',
        'Malformed or undeclared relation set.',
      )
    const parent = await this.findStored(set.model, set.parentId, executor)
    if (!parent?.visible) return
    const pivot = relation.pivot
    const morphName = this.morphName(set.model, relation)
    const parentKey = String(
      parent.attributes[relation.localKey ?? definition.primaryKey] ??
        parent.serverIdentity ??
        parent.localIdentity,
    )
    const table = `syn_canonical_pivot_${pivot.table}`
    await executor.execute(
      `DELETE FROM ${quoteIdentifier(table)} WHERE _partition = ? AND ${quoteIdentifier(pivot.foreignKey)} = ?${relation.morphType ? ` AND ${quoteIdentifier(relation.morphType)} = ?` : ''}`,
      [this.partition, parentKey, ...(morphName ? [morphName] : [])],
    )
    for (const target of set.targets as RelationSet['targets']) {
      const projected: Record<string, BindValue> = {
        _partition: this.partition,
        [pivot.foreignKey]: parentKey,
        [pivot.relatedKey]: target.id,
        ...(relation.morphType
          ? { [relation.morphType]: morphName ?? '' }
          : {}),
      }
      for (const [field, value] of Object.entries(target.attributes)) {
        const fieldDefinition = pivot.fields[field]
        if (!fieldDefinition || !fieldDefinition.readable)
          throw new SynloquentError(
            'forbidden_field',
            `Unexpected pivot projection ${field}.`,
          )
        validateValue(field, fieldDefinition, value)
      }
      for (const [field, fieldDefinition] of Object.entries(pivot.fields))
        projected[field] = storageValue(
          target.attributes[field] ?? fieldDefinition.default,
          fieldDefinition,
        )
      const fields = Object.keys(projected)
      await executor.execute(
        `INSERT OR REPLACE INTO ${quoteIdentifier(table)} (${fields.map(quoteIdentifier).join(',')}) VALUES (${fields.map(() => '?').join(',')})`,
        fields.map((field) => projected[field] ?? null),
      )
    }
    await executor.execute(
      'INSERT INTO syn_relation_sets(partition,model,relation,parent_identity,revision,completeness,canonical) VALUES (?,?,?,?,?,?,?) ON CONFLICT(partition,model,relation,parent_identity) DO UPDATE SET revision=excluded.revision,completeness=excluded.completeness,canonical=excluded.canonical',
      [
        this.partition,
        set.model,
        set.relation,
        parent.localIdentity,
        set.revision,
        set.completeness,
        canonicalJson(set.targets),
      ],
    )
    changed.add(`pivot:${pivot.table}`)
  }
  async rebuildRelationOverlays(
    executor: TransactionExecutor,
    changed: Set<string>,
    bounded = false,
  ): Promise<void> {
    const tables = [...changed]
      .filter((table) => table.startsWith('pivot:'))
      .map((table) => table.slice(6))
    const pending = bounded
      ? undefined
      : (await this.pending(executor)).filter(
          (entry) =>
            entry.operation.action === 'pivot' &&
            ['pending', 'sending', 'conflicted', 'rejected'].includes(
              entry.status,
            ),
        )
    for (const table of tables) {
      await executor.execute(
        `DELETE FROM ${quoteIdentifier(pivotTable(table))} WHERE _partition = ?`,
        [this.partition],
      )
      await executor.execute(
        `INSERT INTO ${quoteIdentifier(pivotTable(table))} SELECT * FROM ${quoteIdentifier(`syn_canonical_pivot_${table}`)} WHERE _partition = ?`,
        [this.partition],
      )
      for await (const entry of pending ??
        this.pendingEntries(executor, { action: 'pivot' }, true)) {
        if (
          !['pending', 'sending', 'conflicted', 'rejected'].includes(
            entry.status,
          )
        )
          continue
        const name = String(entry.operation.values.relation)
        const definition = this.manifest.models[entry.operation.model]
        const relation = definition?.relations[name]
        const pivot = relation?.pivot
        if (!definition || !relation || !pivot || pivot.table !== table)
          continue
        const parent = await this.findStored(
          entry.operation.model,
          entry.operation.localIdentity,
          executor,
        )
        if (!parent?.visible || parent.deleted) continue
        const morphName = this.morphName(entry.operation.model, relation)
        const parentKey = String(
          parent.attributes[relation.localKey ?? definition.primaryKey] ??
            parent.serverIdentity ??
            parent.localIdentity,
        )
        const values = entry.operation.values.targets
        if (!Array.isArray(values))
          throw new SynloquentError(
            'schema_mismatch',
            'Malformed pending pivot targets.',
          )
        const action = entry.operation.values.action
        const parentFilter = `_partition = ? AND ${quoteIdentifier(pivot.foreignKey)} = ?${relation.morphType ? ` AND ${quoteIdentifier(relation.morphType)} = ?` : ''}`
        const parentParameters = [
          this.partition,
          parentKey,
          ...(morphName ? [morphName] : []),
        ]
        if (action === 'sync')
          await executor.execute(
            `DELETE FROM ${quoteIdentifier(pivotTable(table))} WHERE ${parentFilter}`,
            parentParameters,
          )
        for (const value of values) {
          let targetIdentity = String(value)
          if (
            value &&
            typeof value === 'object' &&
            '$ref' in value &&
            value.$ref &&
            typeof value.$ref === 'object' &&
            'localIdentity' in value.$ref
          ) {
            const target = await this.findStored(
              relation.model,
              String(value.$ref.localIdentity),
              executor,
            )
            targetIdentity =
              target?.serverIdentity ?? String(value.$ref.localIdentity)
          }
          const existing = await executor.execute(
            `SELECT * FROM ${quoteIdentifier(pivotTable(table))} WHERE ${parentFilter} AND ${quoteIdentifier(pivot.relatedKey)} = ?`,
            [...parentParameters, targetIdentity],
          )
          if (
            action === 'detach' ||
            (action === 'toggle' && existing.rows.length)
          ) {
            await executor.execute(
              `DELETE FROM ${quoteIdentifier(pivotTable(table))} WHERE ${parentFilter} AND ${quoteIdentifier(pivot.relatedKey)} = ?`,
              [...parentParameters, targetIdentity],
            )
            continue
          }
          if (action === 'updateExistingPivot' && !existing.rows.length)
            continue
          const attributes = entry.operation.values.attributes as
            Attributes | undefined
          const projected: Record<string, BindValue> = {
            ...existing.rows[0],
            _partition: this.partition,
            [pivot.foreignKey]: parentKey,
            [pivot.relatedKey]: targetIdentity,
            ...(relation.morphType
              ? { [relation.morphType]: morphName ?? '' }
              : {}),
          }
          for (const [field, fieldDefinition] of Object.entries(pivot.fields))
            projected[field] =
              attributes && field in attributes
                ? storageValue(attributes[field], fieldDefinition)
                : (projected[field] ??
                  storageValue(fieldDefinition.default, fieldDefinition))
          const fields = Object.keys(projected)
          await executor.execute(
            `INSERT OR REPLACE INTO ${quoteIdentifier(pivotTable(table))} (${fields.map(quoteIdentifier).join(',')}) VALUES (${fields.map(() => '?').join(',')})`,
            fields.map((field) => projected[field] ?? null),
          )
        }
      }
    }
  }
  async mutationValues(
    model: string,
    attributes: Attributes,
    executor: TransactionExecutor,
  ): Promise<MutationValues> {
    const values: MutationValues = { ...attributes }
    const definition = this.manifest.models[model]
    if (!definition)
      throw new SynloquentError('unknown_model', `Unknown model ${model}.`)
    for (const relation of Object.values(definition.relations)) {
      if (relation.type !== 'belongsTo' || !relation.foreignKey) continue
      const value = values[relation.foreignKey]
      if (typeof value !== 'string' && typeof value !== 'number') continue
      const target = this.manifest.models[relation.model]!
      if (relation.ownerKey && relation.ownerKey !== target.primaryKey) {
        validateValue(
          relation.foreignKey,
          definition.fields[relation.foreignKey]!,
          value,
        )
        continue
      }
      const related = await this.findStored(relation.model, value, executor)
      if (related && (!related.visible || related.deleted))
        throw new SynloquentError(
          'forbidden_operation',
          'Foreign identity is outside active authorized membership.',
        )
      if (related && related.serverIdentity === null)
        values[relation.foreignKey] = {
          $ref: { model: relation.model, localIdentity: related.localIdentity },
        }
      else {
        const field = definition.fields[relation.foreignKey]
        if (field) validateValue(relation.foreignKey, field, value)
      }
    }
    return values
  }
  async mutationDependencies(
    model: string,
    attributes: Attributes,
    executor: TransactionExecutor,
  ): Promise<string[]> {
    const dependencies: string[] = []
    const relations = Object.values(
      this.manifest.models[model]?.relations ?? {},
    )
    if (
      !relations.some(
        (relation) =>
          relation.type === 'belongsTo' &&
          relation.foreignKey &&
          relation.ownerKey &&
          relation.ownerKey !==
            this.manifest.models[relation.model]?.primaryKey,
      )
    )
      return dependencies
    const pending = await this.pending(executor)
    for (const relation of relations) {
      if (
        relation.type !== 'belongsTo' ||
        !relation.foreignKey ||
        !relation.ownerKey ||
        relation.ownerKey === this.manifest.models[relation.model]?.primaryKey
      )
        continue
      const value = attributes[relation.foreignKey]
      if (typeof value !== 'string' && typeof value !== 'number') continue
      const parent = await this.findOwner(
        relation.model,
        value,
        executor,
        relation.ownerKey,
      )
      if (parent?.serverIdentity === null)
        dependencies.push(
          ...pending
            .filter(
              (entry) =>
                entry.operation.model === relation.model &&
                entry.operation.localIdentity === parent.localIdentity &&
                entry.operation.action === 'create' &&
                ['pending', 'sending', 'conflicted', 'rejected'].includes(
                  entry.status,
                ),
            )
            .map((entry) => entry.operation.operationId),
        )
    }
    return dependencies
  }
}

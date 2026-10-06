import { SynloquentError } from './errors.js'
import type { BindValue, TransactionExecutor } from './database.js'
import { snapshotPhase, utf8Length } from './snapshot-content.js'
import type { Storage } from './storage.js'
import type { MemoryWorkBudget } from './memory-budget.js'
import type {
  CanonicalRecord,
  DigestLifecycle,
  Envelope,
  RelationSet,
  SnapshotMetadata,
  SnapshotPartsDescriptor,
  SnapshotPartIdentity,
  SnapshotTransferPart,
  Transport,
} from './types.js'
import { canonicalJson } from './values.js'

const maximumPartBytes = 65536
const maximumBundleBytes = 1048576
const maximumBundleParts = 16

function invalid(message: string): never {
  throw new SynloquentError('snapshot_invalid', message)
}
function parseDocument(value: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch {
    return invalid('Snapshot JSON document is malformed.')
  }
}
function metadata(snapshot: SnapshotMetadata): SnapshotMetadata {
  return {
    schemaFingerprint: snapshot.schemaFingerprint,
    dataset: snapshot.dataset,
    generation: snapshot.generation,
    cursor: snapshot.cursor,
    hash: snapshot.hash,
    byteSize: snapshot.byteSize,
    scope: snapshot.scope,
  }
}
function identity(descriptor: SnapshotPartsDescriptor): string {
  return canonicalJson({
    ...metadata(descriptor),
    format: descriptor.format,
    partCount: descriptor.partCount,
    recordCount: descriptor.recordCount,
    relationSetCount: descriptor.relationSetCount,
    maximumPartBytes: descriptor.maximumPartBytes,
    maximumRowBytes: descriptor.maximumRowBytes,
    partRowLimit: descriptor.partRowLimit,
  })
}
function sessionIdentity(storage: Storage): string {
  return canonicalJson(storage.session)
}
function assertDescriptor(
  storage: Storage,
  descriptor: SnapshotPartsDescriptor,
  dataset: string,
): void {
  if (
    !descriptor ||
    descriptor.format !== 'canonical-parts-v1' ||
    !['ready', 'admission-required'].includes(descriptor.status) ||
    !descriptor.scope ||
    descriptor.schemaFingerprint !== storage.manifest.fingerprint ||
    descriptor.scope.schemaFingerprint !== storage.manifest.fingerprint ||
    descriptor.dataset !== dataset ||
    descriptor.scope.dataset !== dataset ||
    !descriptor.generation ||
    !descriptor.cursor ||
    !descriptor.scope.authorizationGeneration ||
    !descriptor.scope.projectionGeneration ||
    !['complete', 'partial'].includes(descriptor.scope.completeness ?? '') ||
    !/^[a-f0-9]{64}$/.test(descriptor.hash) ||
    !Number.isSafeInteger(descriptor.byteSize) ||
    descriptor.byteSize < 0 ||
    descriptor.byteSize > 256 * 1024 ** 2 ||
    !Number.isSafeInteger(descriptor.partCount) ||
    descriptor.partCount < 0 ||
    descriptor.partCount > 2000000 ||
    !Number.isSafeInteger(descriptor.recordCount) ||
    descriptor.recordCount < 0 ||
    descriptor.recordCount > 1000000 ||
    !Number.isSafeInteger(descriptor.relationSetCount) ||
    descriptor.relationSetCount < 0 ||
    descriptor.relationSetCount > 1000000 ||
    descriptor.maximumPartBytes !== maximumPartBytes ||
    descriptor.partRowLimit !== 256 ||
    !Number.isSafeInteger(descriptor.maximumRowBytes) ||
    descriptor.maximumRowBytes < 0 ||
    descriptor.maximumRowBytes > 256 * 1024 ** 2 ||
    utf8Length(canonicalJson(descriptor)) > 16384
  )
    invalid('Bounded snapshot descriptor identity or geometry is invalid.')
  if (descriptor.status !== 'ready')
    throw new SynloquentError(
      'snapshot_admission_required',
      'The server cannot admit this snapshot to the bounded representation.',
      { reason: descriptor.reason ?? 'unsupported-host-contract' },
    )
  if (descriptor.maximumRowBytes > maximumPartBytes)
    invalid('Ready snapshot row geometry exceeds the bounded representation.')
  const rowCount = descriptor.recordCount + descriptor.relationSetCount
  if (
    (rowCount === 0) !== (descriptor.partCount === 0) ||
    descriptor.partCount > rowCount
  )
    invalid('Snapshot part count does not match its row counts.')
  if (descriptor.partCount) {
    assertPartIdentity(descriptor.firstPart, 0)
  } else if (!descriptor.confirmationToken)
    invalid('An empty snapshot has no confirmation token.')
}
function assertPartIdentity(
  part: SnapshotPartIdentity | undefined,
  ordinal: number,
): asserts part is SnapshotPartIdentity {
  if (
    !part ||
    part.ordinal !== ordinal ||
    !Number.isSafeInteger(part.ordinal) ||
    part.ordinal < 0 ||
    part.ordinal >= 2000000 ||
    !/^[a-f0-9]{64}$/.test(part.hash) ||
    !Number.isSafeInteger(part.byteSize) ||
    part.byteSize < 1 ||
    part.byteSize > maximumPartBytes ||
    typeof part.downloadUrl !== 'string' ||
    !part.downloadUrl ||
    part.downloadUrl.length > 4096 ||
    typeof part.continuation !== 'string' ||
    !part.continuation ||
    part.continuation.length > 4096
  )
    invalid('Snapshot continuation identity is invalid.')
}
async function ensureTables(storage: Storage, dataset: string): Promise<void> {
  await storage.write(async (executor) => {
    const columns = await executor.execute(
      'PRAGMA table_info(syn_snapshot_parts)',
    )
    if (
      columns.rows.length &&
      (!columns.rows.some((row) => row.name === 'raw_prefix') ||
        !columns.rows.some((row) => row.name === 'raw_suffix'))
    ) {
      const retained = await executor.execute(
        'SELECT CASE WHEN length(CAST(next_request AS BLOB)) <= 16384 THEN next_request END AS next_request FROM syn_snapshot_acquisitions WHERE partition = ? AND dataset = ? AND session = ?',
        [storage.partition, dataset, sessionIdentity(storage)],
      )
      let continuation: SnapshotPartIdentity | undefined
      try {
        const content = retained.rows[0]?.next_request
        if (typeof content === 'string') {
          const part = parseDocument(content) as SnapshotPartIdentity
          assertPartIdentity(part, part.ordinal)
          continuation = part
        }
      } catch {
        /* Unsupported private data stays durable. */
      }
      throw new SynloquentError(
        'snapshot_admission_required',
        'The unpublished private acquisition layout requires explicit migration admission.',
        {
          reason: 'unsupported-private-layout',
          dataset,
          ...(continuation === undefined ? {} : { continuation }),
        },
      )
    }
    await executor.execute(
      'CREATE TABLE IF NOT EXISTS syn_snapshot_acquisitions (partition TEXT NOT NULL, dataset TEXT NOT NULL, identity TEXT NOT NULL, session TEXT NOT NULL, descriptor TEXT NOT NULL, next_request TEXT, next_ordinal INTEGER NOT NULL, record_count INTEGER NOT NULL, relation_set_count INTEGER NOT NULL, confirmation TEXT, PRIMARY KEY(partition,dataset))',
    )
    await executor.execute(
      'CREATE TABLE IF NOT EXISTS syn_snapshot_parts (partition TEXT NOT NULL, dataset TEXT NOT NULL, ordinal INTEGER NOT NULL, section TEXT NOT NULL, first_index INTEGER NOT NULL, row_count INTEGER NOT NULL, raw_prefix TEXT NOT NULL, raw_suffix TEXT NOT NULL, hash TEXT NOT NULL, byte_size INTEGER NOT NULL, PRIMARY KEY(partition,dataset,ordinal), FOREIGN KEY(partition,dataset) REFERENCES syn_snapshot_acquisitions(partition,dataset) ON DELETE CASCADE)',
    )
    await executor.execute(
      'CREATE TABLE IF NOT EXISTS syn_snapshot_rows (partition TEXT NOT NULL, dataset TEXT NOT NULL, section TEXT NOT NULL, row_index INTEGER NOT NULL, part_ordinal INTEGER NOT NULL, model TEXT NOT NULL, identity TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(partition,dataset,section,row_index), FOREIGN KEY(partition,dataset,part_ordinal) REFERENCES syn_snapshot_parts(partition,dataset,ordinal) ON DELETE CASCADE)',
    )
    await executor.execute(
      'CREATE INDEX IF NOT EXISTS syn_snapshot_rows_part ON syn_snapshot_rows(partition,dataset,part_ordinal,section,row_index)',
    )
    await executor.execute(
      "CREATE UNIQUE INDEX IF NOT EXISTS syn_snapshot_record_identity ON syn_snapshot_rows(partition,dataset,model,identity) WHERE section = 'records'",
    )
    await executor.execute(
      "CREATE INDEX IF NOT EXISTS syn_outbox_record_replay ON syn_outbox(partition,json_extract(operation,'$.model'),json_extract(operation,'$.localIdentity'),sequence)",
    )
  })
}
export async function loadSnapshotPartsDescriptor(
  storage: Storage,
  dataset: string,
): Promise<SnapshotPartsDescriptor | undefined> {
  await ensureTables(storage, dataset)
  return storage.read(async (executor) => {
    const result = await executor.execute(
      'SELECT CASE WHEN length(CAST(descriptor AS BLOB)) <= 16384 THEN descriptor END AS descriptor,session FROM syn_snapshot_acquisitions WHERE partition = ? AND dataset = ?',
      [storage.partition, dataset],
    )
    const row = result.rows[0]
    if (!row || row.session !== sessionIdentity(storage)) return undefined
    if (row.descriptor === null)
      invalid('Stored snapshot descriptor exceeds its bound.')
    const descriptor = parseDocument(
      String(row.descriptor),
    ) as SnapshotPartsDescriptor
    assertDescriptor(storage, descriptor, dataset)
    return descriptor
  })
}
interface Acquisition {
  readonly nextRequest: SnapshotPartIdentity | undefined
  readonly nextOrdinal: number
  readonly recordCount: number
  readonly relationSetCount: number
  readonly confirmation: string | undefined
}
async function acquisition(
  storage: Storage,
  executor: TransactionExecutor,
  descriptor: SnapshotPartsDescriptor,
): Promise<Acquisition> {
  const result = await executor.execute(
    'SELECT * FROM syn_snapshot_acquisitions WHERE partition = ? AND dataset = ?',
    [storage.partition, descriptor.dataset],
  )
  const row = result.rows[0]
  if (
    !row ||
    row.identity !== identity(descriptor) ||
    row.session !== sessionIdentity(storage)
  )
    throw new SynloquentError(
      'session_changed',
      'Snapshot acquisition was replaced.',
    )
  return {
    nextRequest:
      row.next_request === null
        ? undefined
        : (parseDocument(String(row.next_request)) as SnapshotPartIdentity),
    nextOrdinal: Number(row.next_ordinal),
    recordCount: Number(row.record_count),
    relationSetCount: Number(row.relation_set_count),
    confirmation:
      row.confirmation === null ? undefined : String(row.confirmation),
  }
}
function assertCurrent(
  lifecycle: DigestLifecycle,
  assertSession: () => void,
): void {
  assertSession()
  if (lifecycle.cancelled)
    throw new SynloquentError(
      'session_changed',
      'Snapshot acquisition was cancelled.',
    )
}
function snapshotAdmissionDetails(
  budget: MemoryWorkBudget,
): Readonly<Record<string, unknown>> {
  try {
    return {
      reason: 'memory-pressure',
      memoryBudget: {
        level: budget.level,
        reason: budget.reason,
        maximumBatchRows: budget.maximumBatchRows,
        maximumBindingBytes: budget.maximumBindingBytes,
        maximumHashBufferUnits: budget.maximumHashBufferUnits,
        maximumCacheBytes: budget.maximumCacheBytes,
        maximumCacheEntries: budget.maximumCacheEntries,
        maximumPrefetchConcurrency: budget.maximumPrefetchConcurrency,
        maximumSnapshotConcurrency: budget.maximumSnapshotConcurrency,
        maximumSnapshotResponseBytes: budget.maximumSnapshotResponseBytes,
      },
    }
  } catch {
    return { reason: 'memory-pressure', memoryBudgetContextUnavailable: true }
  }
}
async function admit(
  storage: Storage,
  lifecycle: DigestLifecycle,
  assertSession: () => void,
): Promise<void> {
  assertCurrent(lifecycle, assertSession)
  await storage.configuration.refreshMemoryBudget?.()
  assertCurrent(lifecycle, assertSession)
  const admissionBudget = storage.snapshotWorkBudget()
  if (!admissionBudget.maximumSnapshotConcurrency)
    throw new SynloquentError(
      'snapshot_admission_required',
      'Snapshot acquisition is deferred by current memory pressure.',
      snapshotAdmissionDetails(admissionBudget),
    )
}
function* rowDocuments(rawRows: string): Generator<string> {
  if (rawRows[0] !== '[' || rawRows.at(-1) !== ']')
    invalid('Canonical row span is not an array.')
  let start = 1
  let depth = 0
  let quoted = false
  let escaped = false
  for (let position = 1; position < rawRows.length - 1; position++) {
    const character = rawRows[position]
    if (quoted) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') quoted = false
    } else if (character === '"') quoted = true
    else if (character === '{' || character === '[') depth++
    else if (character === '}' || character === ']') depth--
    else if (character === ',' && depth === 0) {
      const content = rawRows.slice(start, position)
      const trimmed = content.trim()
      if (!trimmed || trimmed[0] !== '{' || trimmed.at(-1) !== '}')
        invalid('Canonical row span is malformed.')
      yield content
      start = position + 1
    }
    if (depth < 0) invalid('Canonical row nesting is invalid.')
  }
  if (quoted || depth !== 0) invalid('Canonical row span is incomplete.')
  if (start < rawRows.length - 1) {
    const content = rawRows.slice(start, -1)
    const trimmed = content.trim()
    if (trimmed[0] !== '{' || trimmed.at(-1) !== '}')
      invalid('Canonical row span contains a non-object row.')
    yield content
  }
}
function assertPartDocument(part: SnapshotTransferPart): {
  readonly rawPrefix: string
  readonly rawSuffix: string
} {
  if (
    part.format !== 'canonical-parts-v1' ||
    !Number.isSafeInteger(part.ordinal) ||
    part.ordinal < 0 ||
    !['records', 'relationSets'].includes(part.section) ||
    !Number.isSafeInteger(part.firstIndex) ||
    part.firstIndex < 0 ||
    !Number.isSafeInteger(part.rowCount) ||
    part.rowCount < 1 ||
    part.rowCount > 256 ||
    !Array.isArray(part.rows) ||
    part.rows.length !== part.rowCount ||
    typeof part.rawDocument !== 'string' ||
    typeof part.rawRows !== 'string' ||
    utf8Length(part.rawDocument) !== part.byteSize ||
    part.byteSize > maximumPartBytes ||
    !/^[a-f0-9]{64}$/.test(part.hash)
  )
    invalid('Snapshot part geometry is invalid.')
  let objectDepth = 0
  let arrayDepth = 0
  let quoted = false
  let escaped = false
  let quotedStart = 0
  let rootKey = false
  let start = -1
  const keys = new Set<string>()
  for (let position = 0; position < part.rawDocument.length; position++) {
    const character = part.rawDocument[position]
    if (quoted) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') {
        quoted = false
        let next = position + 1
        while (/[ \t\r\n]/.test(part.rawDocument[next] ?? '')) next++
        if (rootKey && part.rawDocument[next] === ':') {
          const key = parseDocument(
            part.rawDocument.slice(quotedStart, position + 1),
          ) as string
          if (keys.has(key)) invalid('Wire document repeats a root property.')
          keys.add(key)
          if (key === 'rows') {
            next++
            while (/[ \t\r\n]/.test(part.rawDocument[next] ?? '')) next++
            start = next
          }
        }
      }
    } else if (character === '"') {
      quoted = true
      quotedStart = position
      rootKey = objectDepth === 1 && arrayDepth === 0
    } else if (character === '{') objectDepth++
    else if (character === '}') objectDepth--
    else if (character === '[') arrayDepth++
    else if (character === ']') arrayDepth--
  }
  if (
    start < 0 ||
    part.rawRows[0] !== '[' ||
    part.rawRows.at(-1) !== ']' ||
    part.rawDocument.slice(start, start + part.rawRows.length) !== part.rawRows
  )
    invalid('Wire document does not contain its declared canonical row span.')
  const header = parseDocument(
    part.rawDocument.slice(0, start) +
      '[]' +
      part.rawDocument.slice(start + part.rawRows.length),
  ) as Record<string, unknown>
  if (
    keys.size !== 6 ||
    Object.keys(header).length !== 6 ||
    !Array.isArray(header.rows) ||
    header.rows.length ||
    header.format !== part.format ||
    header.ordinal !== part.ordinal ||
    header.section !== part.section ||
    header.firstIndex !== part.firstIndex ||
    header.rowCount !== part.rowCount
  )
    invalid('Wire document contradicts part metadata.')
  return {
    rawPrefix: part.rawDocument.slice(0, start),
    rawSuffix: part.rawDocument.slice(start + part.rawRows.length),
  }
}
async function durablePart(
  storage: Storage,
  executor: TransactionExecutor,
  descriptor: SnapshotPartsDescriptor,
  ordinal: number,
): Promise<SnapshotTransferPart> {
  const result = await executor.execute(
    'SELECT ordinal,section,first_index,row_count,hash,byte_size,CASE WHEN length(CAST(raw_prefix AS BLOB)) <= 65536 THEN raw_prefix END AS raw_prefix,CASE WHEN length(CAST(raw_suffix AS BLOB)) <= 65536 THEN raw_suffix END AS raw_suffix FROM syn_snapshot_parts WHERE partition = ? AND dataset = ? AND ordinal = ?',
    [storage.partition, descriptor.dataset, ordinal],
  )
  const stored = result.rows[0]
  if (!stored || stored.raw_prefix === null || stored.raw_suffix === null)
    invalid('Private snapshot part framing is missing or exceeds its bound.')
  const count = Number(stored.row_count)
  const prefix = String(stored.raw_prefix)
  const suffix = String(stored.raw_suffix)
  const bounds = await executor.execute(
    'SELECT COUNT(*) AS count,COALESCE(SUM(length(CAST(payload AS BLOB))),0) AS bytes FROM syn_snapshot_rows WHERE partition = ? AND dataset = ? AND part_ordinal = ?',
    [storage.partition, descriptor.dataset, ordinal],
  )
  if (
    !Number.isSafeInteger(count) ||
    count < 1 ||
    count > 256 ||
    Number(bounds.rows[0]?.count) !== count ||
    Number(bounds.rows[0]?.bytes) +
      count -
      1 +
      2 +
      utf8Length(prefix) +
      utf8Length(suffix) !==
      Number(stored.byte_size) ||
    Number(stored.byte_size) > maximumPartBytes
  )
    invalid('Durable snapshot row framing or size is invalid.')
  const payloads = await executor.execute(
    'SELECT row_index,section,model,identity,CASE WHEN length(CAST(payload AS BLOB)) <= 65536 THEN payload END AS payload FROM syn_snapshot_rows WHERE partition = ? AND dataset = ? AND part_ordinal = ? ORDER BY row_index LIMIT 257',
    [storage.partition, descriptor.dataset, ordinal],
  )
  const documents: string[] = []
  const rows: (CanonicalRecord | RelationSet)[] = []
  for (const [position, storedRow] of payloads.rows.entries()) {
    if (
      storedRow.payload === null ||
      storedRow.section !== stored.section ||
      Number(storedRow.row_index) !== Number(stored.first_index) + position
    )
      invalid('Durable snapshot row identity or order is invalid.')
    const document = String(storedRow.payload)
    const row = parseDocument(document) as CanonicalRecord | RelationSet
    if (!row || typeof row !== 'object' || Array.isArray(row))
      invalid('Durable snapshot payload is not an object row.')
    const rowIdentity =
      stored.section === 'records'
        ? (row as CanonicalRecord).id
        : `${(row as RelationSet).relation}:${(row as RelationSet).parentId}`
    if (storedRow.model !== row.model || storedRow.identity !== rowIdentity)
      invalid('Durable snapshot row contradicts its indexed identity.')
    documents.push(document)
    rows.push(row)
  }
  if (rows.length !== count)
    invalid('Durable snapshot part row count is invalid.')
  const rawRows = '[' + documents.join(',') + ']'
  const part: SnapshotTransferPart = {
    format: 'canonical-parts-v1',
    ordinal,
    section: stored.section as 'records' | 'relationSets',
    firstIndex: Number(stored.first_index),
    rowCount: count,
    rows: rows as SnapshotTransferPart['rows'],
    rawRows,
    rawDocument: prefix + rawRows + suffix,
    hash: String(stored.hash),
    byteSize: Number(stored.byte_size),
  }
  assertPartDocument(part)
  return part
}

async function storePart(
  storage: Storage,
  descriptor: SnapshotPartsDescriptor,
  part: SnapshotTransferPart,
  lifecycle: DigestLifecycle,
  assertSession: () => void,
): Promise<void> {
  const framing = assertPartDocument(part)
  if (
    (await storage.configuration.digest(part.rawDocument, lifecycle)) !==
    part.hash
  )
    invalid('Snapshot part wire hash mismatch.')
  assertCurrent(lifecycle, assertSession)
  await storage.write(async (executor) => {
    assertCurrent(lifecycle, assertSession)
    const state = await acquisition(storage, executor, descriptor)
    if (part.ordinal < state.nextOrdinal) {
      const existing = await durablePart(
        storage,
        executor,
        descriptor,
        part.ordinal,
      )
      if (
        existing.hash !== part.hash ||
        existing.byteSize !== part.byteSize ||
        existing.rawDocument !== part.rawDocument
      )
        invalid('Resumed immutable part differs from its durable copy.')
      return
    }
    if (
      part.ordinal !== state.nextOrdinal ||
      part.ordinal >= descriptor.partCount ||
      part.firstIndex !==
        (part.section === 'records'
          ? state.recordCount
          : state.relationSetCount) ||
      (part.section === 'records' && state.relationSetCount > 0) ||
      (part.section === 'relationSets' &&
        state.recordCount !== descriptor.recordCount) ||
      (part.section === 'records'
        ? state.recordCount + part.rowCount > descriptor.recordCount
        : state.relationSetCount + part.rowCount > descriptor.relationSetCount)
    )
      invalid('Snapshot part order or row count is invalid.')
    await executor.execute(
      'INSERT INTO syn_snapshot_parts VALUES (?,?,?,?,?,?,?,?,?,?)',
      [
        storage.partition,
        descriptor.dataset,
        part.ordinal,
        part.section,
        part.firstIndex,
        part.rowCount,
        framing.rawPrefix,
        framing.rawSuffix,
        part.hash,
        part.byteSize,
      ],
    )
    let index = 0
    let parameters: BindValue[] = []
    let bindingBytes = 0
    let batchRows = 0
    const flush = async (): Promise<void> => {
      if (!batchRows) return
      await storage
        .snapshotExecutor(executor)
        .execute(
          `INSERT INTO syn_snapshot_rows VALUES ${Array.from({ length: batchRows }, () => '(?,?,?,?,?,?,?,?)').join(',')}`,
          parameters,
        )
      parameters = []
      batchRows = 0
      bindingBytes = 0
    }
    for (const document of rowDocuments(part.rawRows)) {
      const row = part.rows[index]
      if (!row || canonicalJson(parseDocument(document)) !== canonicalJson(row))
        invalid('Decoded row contradicts its original canonical bytes.')
      const model = row.model
      const rowIdentity =
        part.section === 'records'
          ? (row as CanonicalRecord).id
          : `${(row as RelationSet).relation}:${(row as RelationSet).parentId}`
      if (
        typeof model !== 'string' ||
        !storage.manifest.models[model] ||
        typeof rowIdentity !== 'string' ||
        !rowIdentity
      )
        invalid('Snapshot row identity is invalid.')
      const values: BindValue[] = [
        storage.partition,
        descriptor.dataset,
        part.section,
        part.firstIndex + index,
        part.ordinal,
        model,
        rowIdentity,
        document,
      ]
      const bytes = values.reduce<number>(
        (total, value) =>
          total + (typeof value === 'string' ? utf8Length(value) : 8),
        0,
      )
      const budget = storage.snapshotWorkBudget()
      if (bytes > budget.maximumBindingBytes)
        throw new SynloquentError(
          'snapshot_admission_required',
          'A canonical row exceeds the current staging budget.',
          { reason: 'row-too-large' },
        )
      if (
        batchRows &&
        (batchRows >=
          Math.min(
            budget.maximumBatchRows,
            Math.floor(
              storage.owner.adapter.capabilities.maximumParameters / 8,
            ),
          ) ||
          bindingBytes + bytes > budget.maximumBindingBytes)
      )
        await flush()
      parameters.push(...values)
      bindingBytes += bytes
      batchRows++
      index++
    }
    await flush()
    if (index !== part.rowCount)
      invalid('Canonical row span count differs from its part metadata.')
    await executor.execute(
      'UPDATE syn_snapshot_acquisitions SET next_ordinal = ?,record_count = ?,relation_set_count = ? WHERE partition = ? AND dataset = ?',
      [
        state.nextOrdinal + 1,
        state.recordCount + (part.section === 'records' ? index : 0),
        state.relationSetCount + (part.section === 'relationSets' ? index : 0),
        storage.partition,
        descriptor.dataset,
      ],
    )
  })
}
async function* rowPages(
  storage: Storage,
  executor: TransactionExecutor,
  descriptor: SnapshotPartsDescriptor,
  section: 'records' | 'relationSets',
  partOrdinal?: number,
  consume = false,
): AsyncGenerator<readonly (CanonicalRecord | RelationSet)[]> {
  let after = -1
  while (true) {
    const budget = storage.snapshotWorkBudget()
    const filter = partOrdinal === undefined ? '' : ' AND part_ordinal = ?'
    const extra = partOrdinal === undefined ? [] : [partOrdinal]
    const maximumParameters =
      storage.owner.adapter.capabilities.maximumParameters
    const maximumRows = Math.min(
      Math.min(budget.maximumBatchRows, maximumParameters - 3),
      maximumParameters - 3,
    )
    const combinedRead = maximumParameters >= 6 + extra.length
    const bounds = await executor.execute(
      combinedRead
        ? `WITH page_scope AS (
            SELECT ? AS partition,? AS dataset,? AS section,? AS after_index${partOrdinal === undefined ? '' : ',? AS part_ordinal'},? AS maximum_rows,? AS maximum_bytes
          ), candidate_rows AS (
            SELECT row_index,length(CAST(payload AS BLOB)) AS bytes
            FROM syn_snapshot_rows
            WHERE partition = (SELECT partition FROM page_scope)
              AND dataset = (SELECT dataset FROM page_scope)
              AND section = (SELECT section FROM page_scope)
              AND row_index > (SELECT after_index FROM page_scope)
              ${partOrdinal === undefined ? '' : 'AND part_ordinal = (SELECT part_ordinal FROM page_scope)'}
            ORDER BY row_index LIMIT (SELECT maximum_rows FROM page_scope)
          ), candidate_bounds AS (
            SELECT row_index,bytes,
              (SELECT SUM(earlier.bytes + 512) FROM candidate_rows AS earlier WHERE earlier.row_index <= candidate_rows.row_index) AS cumulative_bytes
            FROM candidate_rows
          ), first_excess AS (
            SELECT bytes FROM candidate_bounds
            WHERE cumulative_bytes > (SELECT maximum_bytes FROM page_scope)
            ORDER BY row_index LIMIT 1
          )
          SELECT row_index,bytes,
            CASE WHEN cumulative_bytes <= (SELECT maximum_bytes FROM page_scope)
              AND NOT EXISTS (SELECT 1 FROM first_excess WHERE bytes + 512 > (SELECT maximum_bytes FROM page_scope))
            THEN (SELECT payload FROM syn_snapshot_rows
              WHERE partition = (SELECT partition FROM page_scope)
                AND dataset = (SELECT dataset FROM page_scope)
                AND section = (SELECT section FROM page_scope)
                AND row_index = candidate_bounds.row_index)
            END AS payload
          FROM candidate_bounds ORDER BY row_index`
        : `SELECT row_index,length(CAST(payload AS BLOB)) AS bytes FROM syn_snapshot_rows WHERE partition = ? AND dataset = ? AND section = ? AND row_index > ?${filter} ORDER BY row_index LIMIT ?`,
      [
        storage.partition,
        descriptor.dataset,
        section,
        after,
        ...extra,
        maximumRows,
        ...(combinedRead ? [budget.maximumBindingBytes] : []),
      ],
    )
    if (!bounds.rows.length) return
    const indexes: BindValue[] = []
    let bytes = 0
    for (const row of bounds.rows) {
      const required = Number(row.bytes) + 512
      if (required > budget.maximumBindingBytes)
        throw new SynloquentError(
          'snapshot_admission_required',
          'A staged row exceeds the current activation budget.',
          { reason: 'row-too-large' },
        )
      if (indexes.length && bytes + required > budget.maximumBindingBytes) break
      indexes.push(row.row_index!)
      bytes += required
    }
    const page = combinedRead
      ? {
          rows: bounds.rows
            .slice(0, indexes.length)
            .filter((row) => row.payload !== null),
        }
      : await executor.execute(
          `SELECT row_index,payload FROM syn_snapshot_rows WHERE partition = ? AND dataset = ? AND section = ? AND row_index IN (${indexes.map(() => '?').join(',')}) ORDER BY row_index`,
          [storage.partition, descriptor.dataset, section, ...indexes],
        )
    if (!page.rows.length) invalid('Private snapshot rows disappeared.')
    after = Number(page.rows.at(-1)?.row_index)
    yield page.rows.map(
      (row) =>
        parseDocument(String(row.payload)) as CanonicalRecord | RelationSet,
    )
    if (consume)
      await executor.execute(
        `DELETE FROM syn_snapshot_rows WHERE partition = ? AND dataset = ? AND section = ? AND row_index IN (${indexes.map(() => '?').join(',')})`,
        [storage.partition, descriptor.dataset, section, ...indexes],
      )
  }
}
async function verifyAcquisition(
  storage: Storage,
  descriptor: SnapshotPartsDescriptor,
  lifecycle: DigestLifecycle,
  assertSession: () => void,
): Promise<void> {
  const provider = storage.configuration.digestChunks
  if (!provider)
    throw new SynloquentError(
      'snapshot_admission_required',
      'Bounded snapshot installation requires streaming digestChunks.',
      { reason: 'streaming-digest-required' },
    )
  let byteSize = 0
  let consumed = false
  let recordCount = 0
  let relationSetCount = 0
  async function* chunks(): AsyncGenerator<string> {
    yield '{"records":['
    for (let ordinal = 0; ordinal < descriptor.partCount; ordinal++) {
      assertCurrent(lifecycle, assertSession)
      const part = await storage.read(async (executor) => {
        await acquisition(storage, executor, descriptor)
        return durablePart(storage, executor, descriptor, ordinal)
      })
      const section = part.section
      const rawDocument = part.rawDocument
      const rawRows = part.rawRows
      if (
        (await storage.configuration.digest(rawDocument, lifecycle)) !==
        part.hash
      )
        invalid('Durable snapshot wire hash mismatch.')
      if (
        part.firstIndex !==
          (section === 'records' ? recordCount : relationSetCount) ||
        (section === 'records' && relationSetCount)
      )
        invalid('Durable part ordering is invalid.')
      const count = part.rowCount
      if (section === 'relationSets' && !relationSetCount)
        yield '],"relationSets":['
      if ((section === 'records' ? recordCount : relationSetCount) > 0)
        yield ','
      yield rawRows.slice(1, -1)
      if (section === 'records') recordCount += count
      else relationSetCount += count
    }
    if (!relationSetCount) yield '],"relationSets":['
    yield ']}'
    consumed = true
  }
  async function* measured(): AsyncGenerator<string> {
    for await (const piece of chunks()) {
      let position = 0
      while (position < piece.length) {
        const maximumUnits = storage.snapshotWorkBudget().maximumHashBufferUnits
        let end = Math.min(piece.length, position + maximumUnits)
        const before = piece.charCodeAt(end - 1)
        const after = piece.charCodeAt(end)
        if (
          end < piece.length &&
          before >= 0xd800 &&
          before <= 0xdbff &&
          after >= 0xdc00 &&
          after <= 0xdfff
        )
          end--
        const value = piece.slice(position, end)
        byteSize += utf8Length(value)
        if (byteSize > descriptor.byteSize)
          invalid('Bounded catalog exceeds its declared byte size.')
        assertCurrent(lifecycle, assertSession)
        yield value
        position = end
      }
    }
  }
  snapshotPhase(storage.configuration, 'digest', 'begin')
  try {
    const hash = await provider(measured(), lifecycle)
    assertCurrent(lifecycle, assertSession)
    if (
      !consumed ||
      hash !== descriptor.hash ||
      byteSize !== descriptor.byteSize ||
      recordCount !== descriptor.recordCount ||
      relationSetCount !== descriptor.relationSetCount
    )
      invalid('Bounded catalog integrity mismatch.')
  } finally {
    snapshotPhase(storage.configuration, 'digest', 'end')
  }
}
export async function discardSnapshotParts(
  storage: Storage,
  descriptor: SnapshotPartsDescriptor,
): Promise<void> {
  await storage.write(async (executor) => {
    await executor.execute(
      'DELETE FROM syn_snapshot_acquisitions WHERE partition = ? AND dataset = ? AND identity = ? AND session = ?',
      [
        storage.partition,
        descriptor.dataset,
        identity(descriptor),
        sessionIdentity(storage),
      ],
    )
  })
}
export async function installSnapshotParts(
  storage: Storage,
  transport: Transport,
  descriptor: SnapshotPartsDescriptor,
  envelope: <Payload>(kind: string, payload: Payload) => Envelope<Payload>,
  assertSession: () => void,
): Promise<void> {
  snapshotPhase(storage.configuration, 'validation', 'begin')
  try {
    assertDescriptor(storage, descriptor, descriptor.dataset)
  } finally {
    snapshotPhase(storage.configuration, 'validation', 'end')
  }
  if (!storage.configuration.digestChunks)
    throw new SynloquentError(
      'snapshot_admission_required',
      'Bounded snapshot installation requires streaming digestChunks.',
      { reason: 'streaming-digest-required' },
    )
  if (storage.owner.adapter.capabilities.maximumParameters < 10)
    throw new SynloquentError(
      'schema_mismatch',
      'Database parameter capacity cannot store one immutable part.',
    )
  if (!transport.snapshotPartBatch || !transport.confirmSnapshotParts)
    invalid('Bounded snapshot transport is incomplete.')
  await ensureTables(storage, descriptor.dataset)
  const lifecycle = await storage.owner.verifyDigest(async (current) => {
    await admit(storage, current, assertSession)
    await storage.write(async (executor) => {
      assertCurrent(current, assertSession)
      const existing = await executor.execute(
        'SELECT identity,session FROM syn_snapshot_acquisitions WHERE partition = ? AND dataset = ?',
        [storage.partition, descriptor.dataset],
      )
      if (
        existing.rows[0]?.identity === identity(descriptor) &&
        existing.rows[0]?.session === sessionIdentity(storage)
      )
        return
      await executor.execute(
        'DELETE FROM syn_snapshot_acquisitions WHERE partition = ? AND dataset = ?',
        [storage.partition, descriptor.dataset],
      )
      await executor.execute(
        'INSERT INTO syn_snapshot_acquisitions VALUES (?,?,?,?,?,?,0,0,0,?)',
        [
          storage.partition,
          descriptor.dataset,
          identity(descriptor),
          sessionIdentity(storage),
          canonicalJson(descriptor),
          descriptor.firstPart ? canonicalJson(descriptor.firstPart) : null,
          descriptor.confirmationToken ?? null,
        ],
      )
    })
    while (true) {
      const state = await storage.read((executor) =>
        acquisition(storage, executor, descriptor),
      )
      if (!state.nextRequest) break
      await admit(storage, current, assertSession)
      const first = state.nextRequest
      const batch = await transport.snapshotPartBatch!(
        envelope('snapshot', { descriptor, part: first }),
        current,
      )
      assertCurrent(current, assertSession)
      let parts = 0
      let bytes = 0
      for await (const part of batch.parts) {
        await admit(storage, current, assertSession)
        if (
          part.ordinal !== first.ordinal + parts ||
          ++parts > maximumBundleParts ||
          (bytes += part.byteSize + 1) > maximumBundleBytes
        )
          invalid('Snapshot bundle geometry is invalid.')
        if (
          parts === 1 &&
          (part.hash !== first.hash || part.byteSize !== first.byteSize)
        )
          invalid('Bundle first part contradicts its continuation identity.')
        await storePart(storage, descriptor, part, current, assertSession)
      }
      if (!parts) invalid('Snapshot bundle is empty.')
      await storage.write(async (executor) => {
        assertCurrent(current, assertSession)
        const completed = await acquisition(storage, executor, descriptor)
        if (batch.nextPart)
          assertPartIdentity(batch.nextPart, completed.nextOrdinal)
        else if (
          completed.nextOrdinal !== descriptor.partCount ||
          !batch.confirmationToken
        )
          invalid('Snapshot bundle lacks its final confirmation.')
        if (batch.nextPart && batch.nextPart.ordinal <= first.ordinal)
          invalid('Snapshot continuation made no progress.')
        await executor.execute(
          'UPDATE syn_snapshot_acquisitions SET next_request = ?,confirmation = ? WHERE partition = ? AND dataset = ?',
          [
            batch.nextPart ? canonicalJson(batch.nextPart) : null,
            batch.confirmationToken ?? null,
            storage.partition,
            descriptor.dataset,
          ],
        )
      })
    }
    await verifyAcquisition(storage, descriptor, current, assertSession)
    const completed = await storage.read((executor) =>
      acquisition(storage, executor, descriptor),
    )
    if (!completed.confirmation)
      invalid('Snapshot final confirmation token is missing.')
    const confirmation = await transport.confirmSnapshotParts!(
      envelope('snapshot', {
        descriptor,
        confirmationToken: completed.confirmation,
      }),
      current,
    )
    assertCurrent(current, assertSession)
    if (
      confirmation.confirmed !== true ||
      canonicalJson(metadata(confirmation)) !==
        canonicalJson(metadata(descriptor))
    )
      invalid('Snapshot confirmation contradicts its checked metadata.')

    return current
  })
  assertCurrent(lifecycle, assertSession)
  await admit(storage, lifecycle, assertSession)
  let committing = false
  try {
    await storage.owner.replace(async (original, changed) => {
      assertCurrent(lifecycle, assertSession)
      const final = await acquisition(storage, original, descriptor)
      if (
        final.nextRequest ||
        final.nextOrdinal !== descriptor.partCount ||
        final.recordCount !== descriptor.recordCount ||
        final.relationSetCount !== descriptor.relationSetCount
      )
        invalid('Snapshot acquisition is incomplete.')
      const executor = storage.snapshotExecutor(original)
      const pendingEffects = await storage.assertBoundedSnapshotEffects(
        original,
        descriptor.dataset,
      )
      snapshotPhase(storage.configuration, 'staging', 'begin')
      await storage.beginSnapshotStaging(executor)
      const comparisons = new Map<string, boolean>()
      try {
        for await (const page of rowPages(
          storage,
          original,
          descriptor,
          'records',
        )) {
          assertCurrent(lifecycle, assertSession)
          await storage.stageSnapshotRecords(
            page as readonly CanonicalRecord[],
            executor,
            true,
            comparisons,
          )
        }
        comparisons.clear()
        await storage.endSnapshotStaging(executor)
        await storage.clearCanonicalRelations(executor, changed)
        snapshotPhase(storage.configuration, 'records', 'begin')
        try {
          for await (const page of rowPages(
            storage,
            original,
            descriptor,
            'records',
            undefined,
            true,
          )) {
            assertCurrent(lifecycle, assertSession)
            await storage.ingestSnapshotRecords(
              page as readonly CanonicalRecord[],
              executor,
              changed,
              true,
            )
          }
        } finally {
          snapshotPhase(storage.configuration, 'records', 'end')
        }
        snapshotPhase(storage.configuration, 'relationSets', 'begin')
        try {
          for await (const page of rowPages(
            storage,
            original,
            descriptor,
            'relationSets',
            undefined,
            true,
          )) {
            assertCurrent(lifecycle, assertSession)
            await storage.ingestSnapshotRelationSets(
              page as readonly RelationSet[],
              executor,
              changed,
              true,
            )
          }
        } finally {
          snapshotPhase(storage.configuration, 'relationSets', 'end')
        }
        for await (const entry of storage.pendingEntries(original, {}, true)) {
          if (
            !['pending', 'sending', 'conflicted', 'rejected'].includes(
              entry.status,
            )
          )
            continue
          const record = await storage.findStored(
            entry.operation.model,
            entry.operation.localIdentity,
            executor,
          )
          if (record?.serverIdentity === null)
            await storage.persist(
              { ...record, visible: true },
              executor,
              changed,
            )
          else if (
            record &&
            !record.visible &&
            Object.keys(record.proposal).length
          )
            await executor.execute(
              'INSERT OR REPLACE INTO syn_recovery(partition,model,local_identity,proposal,reason) VALUES (?,?,?,?,?)',
              [
                storage.partition,
                record.model,
                record.localIdentity,
                canonicalJson(record.proposal),
                'snapshot_scope_removed',
              ],
            )
        }
        if (pendingEffects)
          await storage.applyPendingDeleteEffects(executor, changed)
        await storage.rebuildRelationOverlays(executor, changed, true)
        assertCurrent(lifecycle, assertSession)
        const activationBudget = storage.snapshotWorkBudget()
        if (!activationBudget.maximumSnapshotConcurrency)
          throw new SynloquentError(
            'snapshot_admission_required',
            'Snapshot activation paused under memory pressure.',
            snapshotAdmissionDetails(activationBudget),
          )
        snapshotPhase(storage.configuration, 'integrity', 'begin')
        try {
          const integrity = await executor.execute('PRAGMA integrity_check')
          if (integrity.rows.some((row) => !Object.values(row).includes('ok')))
            invalid('SQLite integrity check failed.')
          if ((await executor.execute('PRAGMA foreign_key_check')).rows.length)
            invalid('SQLite foreign key validation failed.')
        } finally {
          snapshotPhase(storage.configuration, 'integrity', 'end')
        }
        await storage.setMetadata(
          `cursor:${descriptor.dataset}`,
          descriptor.cursor,
          executor,
        )
        await storage.setMetadata(
          'scope',
          canonicalJson(descriptor.scope),
          executor,
        )
        await storage.setMetadata(
          'snapshotGeneration',
          descriptor.generation,
          executor,
        )
        await executor.execute(
          'DELETE FROM syn_snapshot_acquisitions WHERE partition = ? AND dataset = ?',
          [storage.partition, descriptor.dataset],
        )
        if (
          !(
            await executor.execute(
              'SELECT 1 FROM syn_snapshot_acquisitions LIMIT 1',
            )
          ).rows.length
        ) {
          await executor.execute('DROP TABLE syn_snapshot_rows')
          await executor.execute('DROP TABLE syn_snapshot_parts')
          await executor.execute('DROP TABLE syn_snapshot_acquisitions')
          await executor.execute('DROP INDEX syn_outbox_record_replay')
        }
        changed.add('*')
        snapshotPhase(storage.configuration, 'staging', 'end')
        committing = true
        snapshotPhase(storage.configuration, 'commit', 'begin')
      } finally {
        await original.execute('DROP TABLE syn_snapshot_membership')
      }
    }, true)
    storage.memoryCache.clear()
  } finally {
    if (committing) snapshotPhase(storage.configuration, 'commit', 'end')
  }
}

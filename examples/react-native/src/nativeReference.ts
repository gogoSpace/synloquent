import type {
  Attributes,
  BindValue,
  CanonicalRecord,
  FieldDefinition,
  ModelDefinition,
  RelationSet,
  Snapshot,
  SnapshotPhase,
  WireValue,
} from '@synloquent/client'
import { makeModel } from '@synloquent/client'
import type { NativeFixture } from './nativeFixture'
import type { ExampleClient } from './nativeQualification'
import {
  canonicalJson,
  digest,
  digestChunks,
  encodeUtf8,
  nativeClock,
  yieldToApplication,
  setApplicationWorkPhase,
  observeNativeSqlPhase,
} from './platform'

function identifier(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
    throw new Error('Unsafe reference SQL identifier.')
  return `"${name}"`
}

function validateJson(value: WireValue, depth = 0): void {
  if (depth > 64) throw new Error('Reference JSON exceeds its depth bound.')
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new Error('Reference JSON requires finite numbers.')
    return
  }
  if (
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  )
    throw new Error('Reference JSON requires ordinary objects.')
  for (const child of Object.values(value)) validateJson(child, depth + 1)
}

function validateValue(
  field: string,
  definition: FieldDefinition,
  value: WireValue,
): void {
  if (value === null && definition.nullable) return
  const valid = (() => {
    switch (definition.type) {
      case 'boolean':
        return typeof value === 'boolean'
      case 'integer':
        return (
          (typeof value === 'number' && Number.isSafeInteger(value)) ||
          (typeof value === 'string' &&
            value.length <= 1000 &&
            value !== '-0' &&
            /^-?(?:0|[1-9]\d*)$/.test(value))
        )
      case 'float':
        return typeof value === 'number' && Number.isFinite(value)
      case 'decimal':
        return (
          typeof value === 'string' &&
          /^-?\d+(\.\d+)?$/.test(value) &&
          (definition.precision === undefined ||
            (value.split('.')[1]?.length ?? 0) <= definition.precision)
        )
      case 'string':
        return typeof value === 'string'
      case 'date':
        return (
          typeof value === 'string' &&
          /^\d{4}-\d{2}-\d{2}$/.test(value) &&
          new Date(value).toISOString().slice(0, 10) === value
        )
      case 'datetime':
        return (
          typeof value === 'string' &&
          /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d{1,6})?Z$/.test(
            value,
          ) &&
          Number.isFinite(Date.parse(value)) &&
          new Date(value).toISOString().slice(0, 10) === value.slice(0, 10)
        )
      case 'enum':
        return typeof value === 'string' && !!definition.enum?.includes(value)
      case 'json':
        validateJson(value)
        return true
    }
  })()
  if (!valid) throw new Error(`Invalid reference value for ${field}.`)
}

function validateAttributes(
  definition: ModelDefinition,
  attributes: Attributes,
): Attributes {
  const validated: Attributes = {}
  for (const [field, value] of Object.entries(attributes)) {
    const metadata = definition.fields[field]
    if (!metadata?.readable)
      throw new Error(`Undeclared or unreadable reference field ${field}.`)
    validateValue(field, metadata, value)
    validated[field] = value
  }
  return validated
}

function orderedDecimal(value: WireValue, scale: number): string {
  if (typeof value !== 'string' || !/^-?\d+(\.\d+)?$/.test(value))
    throw new Error('Invalid exact reference decimal.')
  const negative = value.startsWith('-')
  const [whole = '0', rawFraction = ''] = value.replace(/^-/, '').split('.')
  const integer = whole.replace(/^0+(?=\d)/, '')
  if (rawFraction.length > scale || integer.length > 999)
    throw new Error('Reference decimal exceeds declared bounds.')
  const fraction = rawFraction.padEnd(scale, '0')
  if (!negative || /^0+$/.test(integer + fraction))
    return `1${String(integer.length).padStart(3, '0')}${integer}.${fraction}`
  const complement = (digits: string) =>
    [...digits].map((digit) => String(9 - Number(digit))).join('')
  return `0${String(999 - integer.length).padStart(3, '0')}${complement(integer)}.${complement(fraction)}`
}

type ReferenceInput = Snapshot | NativeFixture

function boundedInput(
  input: ReferenceInput | Pick<Snapshot, 'records' | 'relationSets'>,
): input is NativeFixture {
  return 'metadata' in input
}

async function* recordPages(
  input: ReferenceInput,
  maximumRows = 64,
): AsyncGenerator<readonly CanonicalRecord[]> {
  if (boundedInput(input)) {
    for await (const page of input.records())
      for (let index = 0; index < page.length; index += maximumRows)
        yield page.slice(index, index + maximumRows)
  } else {
    for (let index = 0; index < input.records.length; index += maximumRows)
      yield input.records.slice(index, index + maximumRows)
  }
}

async function* relationSets(
  input: ReferenceInput,
): AsyncGenerator<RelationSet> {
  if (boundedInput(input)) {
    for await (const page of input.relationSets())
      for (const set of page) yield set
  } else {
    yield* input.relationSets
  }
}

export function snapshotContent(
  snapshot: Pick<Snapshot, 'records' | 'relationSets'> | NativeFixture,
): Promise<{ hash: string; byteSize: number }> {
  return boundedInput(snapshot)
    ? boundedSnapshotContent(snapshot)
    : legacySnapshotContent(snapshot)
}

async function legacySnapshotContent(
  snapshot: Pick<Snapshot, 'records' | 'relationSets'>,
): Promise<{ hash: string; byteSize: number }> {
  let byteSize = 0
  function* pieces(): Generator<string> {
    yield '{"records":['
    for (let index = 0; index < snapshot.records.length; index += 1)
      yield `${index ? ',' : ''}${canonicalJson(snapshot.records[index])}`
    yield '],"relationSets":['
    for (let index = 0; index < snapshot.relationSets.length; index += 1)
      yield `${index ? ',' : ''}${canonicalJson(snapshot.relationSets[index])}`
    yield ']}'
  }
  async function* chunks(): AsyncIterable<string> {
    let buffer = ''
    let bufferedBytes = 0
    for (const piece of pieces()) {
      if (!/[\u0080-\uffff]/.test(piece)) {
        let position = 0
        while (position < piece.length) {
          const length = Math.min(4096 - bufferedBytes, piece.length - position)
          buffer += piece.slice(position, position + length)
          bufferedBytes += length
          position += length
          if (bufferedBytes === 4096) {
            byteSize += bufferedBytes
            yield buffer
            buffer = ''
            bufferedBytes = 0
          }
        }
        continue
      }
      for (const character of piece) {
        const bytes = encodeUtf8(character).length
        if (bufferedBytes + bytes > 4096) {
          byteSize += bufferedBytes
          yield buffer
          buffer = ''
          bufferedBytes = 0
        }
        buffer += character
        bufferedBytes += bytes
      }
    }
    if (buffer) {
      byteSize += bufferedBytes
      yield buffer
    }
  }
  return { hash: await digestChunks(chunks()), byteSize }
}

async function boundedSnapshotContent(
  snapshot: NativeFixture,
): Promise<{ hash: string; byteSize: number }> {
  let byteSize = 0
  async function* pieces(): AsyncGenerator<string> {
    yield '{"records":['
    if (boundedInput(snapshot)) {
      let ordinal = 0
      let section: 'records' | 'relationSets' = 'records'
      const counts = { records: 0, relationSets: 0 }
      for await (const part of snapshot.parts()) {
        if (part.section === 'relationSets' && section === 'records') {
          yield '],"relationSets":['
          section = 'relationSets'
        }
        if (
          part.ordinal !== ordinal++ ||
          part.section !== section ||
          part.firstIndex !== counts[section] ||
          part.rowCount !== part.rows.length ||
          part.rowCount < 1 ||
          part.rowCount > 256 ||
          part.byteSize > 65536 ||
          encodeUtf8(part.rawDocument).byteLength !== part.byteSize ||
          (await digest(part.rawDocument)) !== part.hash ||
          part.rawRows !== canonicalJson(part.rows) ||
          part.rawDocument !==
            canonicalJson({
              firstIndex: part.firstIndex,
              format: part.format,
              ordinal: part.ordinal,
              rowCount: part.rowCount,
              rows: part.rows,
              section: part.section,
            })
        )
          throw new Error(
            'Invalid reference source part integrity or sequence.',
          )
        yield `${counts[section] ? ',' : ''}${part.rawRows.slice(1, -1)}`
        counts[section] += part.rowCount
      }
      if (
        counts.records !== snapshot.recordCount ||
        counts.relationSets !== snapshot.relationSetCount ||
        ordinal !== snapshot.partCount
      )
        throw new Error('Reference source counts differ.')
      if (section === 'records') yield '],"relationSets":['
      yield ']}'
      return
    }
  }
  async function* chunks(): AsyncIterable<string> {
    let buffer = ''
    let bufferedBytes = 0
    for await (const piece of pieces()) {
      if (!/[\u0080-\uffff]/.test(piece)) {
        let position = 0
        while (position < piece.length) {
          const length = Math.min(4096 - bufferedBytes, piece.length - position)
          buffer += piece.slice(position, position + length)
          bufferedBytes += length
          position += length
          if (bufferedBytes === 4096) {
            byteSize += bufferedBytes
            yield buffer
            buffer = ''
            bufferedBytes = 0
          }
        }
        continue
      }
      for (const character of piece) {
        const bytes = encodeUtf8(character).length
        if (bufferedBytes + bytes > 4096) {
          byteSize += bufferedBytes
          yield buffer
          buffer = ''
          bufferedBytes = 0
        }
        buffer += character
        bufferedBytes += bytes
      }
    }
    if (buffer) {
      byteSize += bufferedBytes
      yield buffer
    }
  }
  return { hash: await digestChunks(chunks()), byteSize }
}

export async function preparePendingCatalog(
  client: ExampleClient,
  input: ReferenceInput,
) {
  const snapshot = boundedInput(input) ? input.metadata : input
  const selected: CanonicalRecord[] = []
  for await (const page of recordPages(input))
    for (const record of page)
      if (
        record.model === 'Category' ||
        record.model === 'Tag' ||
        (record.model === 'Item' && Number(record.id) <= 100) ||
        (record.model === 'Image' && Number(record.attributes.item_id) <= 100)
      )
        selected.push(record)
  const sets: RelationSet[] = []
  for await (const set of relationSets(input)) sets.push(set)
  const records = selected
    .filter(
      (record) =>
        record.model === 'Category' ||
        record.model === 'Tag' ||
        (record.model === 'Item' && Number(record.id) <= 100) ||
        (record.model === 'Image' && Number(record.attributes.item_id) <= 100),
    )
    .map((record) =>
      record.model === 'Item' && record.id === '1'
        ? { ...record, localIdentity: 'native-stable-alias-item-1' }
        : record,
    )
  const initial = {
    ...snapshot,
    records,
    relationSets: sets,
    generation: 'native-pending-baseline',
  }
  await client.sync.installSnapshot({
    ...initial,
    ...(await snapshotContent(initial)),
  })
  const edited = await client.models.Item.findOrFail('2')
  edited.fill({ title: 'Pending reference edit' })
  await edited.save()
  const deleted = await client.models.Item.findOrFail('3')
  await deleted.delete()
  const deletionOperationId = deleted.lastOperationId
  if (!deletionOperationId)
    throw new Error(
      'Pending catalog deletion did not expose its operation identity.',
    )
  const created = await client.models.Item.create({
    title: 'Pending reference create',
    price: '9.99',
    quantity: 2,
  })
  const operations = await client.storage.read((executor) =>
    client.storage.pending(executor),
  )
  return {
    createdIdentity: created.localIdentity,
    deletionOperationId,
    operationIds: operations.map((entry) => entry.operation.operationId),
    outboxHash: await digest(
      canonicalJson(
        operations.map((entry) => ({
          operation: entry.operation,
          status: entry.status,
          error: entry.error ?? null,
        })),
      ),
    ),
    editedIdentity: edited.localIdentity,
    stableAlias: (await client.models.Item.findOrFail('1')).localIdentity,
  }
}

async function deletedParentPublicState(client: ExampleClient) {
  const stored = await client.storage.read((executor) =>
    client.storage.findStored('Item', '3', executor),
  )
  if (!stored?.deleted)
    throw new Error(
      'The public deletion witness requires retained deleted Item3.',
    )
  const deleted = makeModel(client.storage, stored)
  const direct = deleted.relation('tags')
  const tag = await client.models.Tag.findOrFail('4')
  const inverse = tag
    .relation('items')
    .constrain((query) => query.where('id', 3))
  const aggregate = await client.models.Tag.where('id', 4)
    .withConstrained('items', (query) => query.where('id', 3))
    .withCount('items')
    .withSum('items', 'quantity')
    .firstOrFail()
  await deleted.loadCount('tags')
  const state = {
    parentVisible: (await client.models.Item.find('3')) !== null,
    imageCount: await client.models.Image.where('item_id', 3).count(),
    tagIds: (await direct.get()).items.map((model) => String(model.id)),
    tagCount: await direct.count(),
    tagIdSum: await direct.sum('id'),
    parentTagCount: deleted.aggregates.tags_count,
    inverseItemIds: (await inverse.get()).items.map((model) =>
      String(model.id),
    ),
    inverseCount: await inverse.count(),
    inverseQuantitySum: await inverse.sum('quantity'),
    inverseWithCount: aggregate.aggregates.items_count,
    inverseWithSum: aggregate.aggregates.items_sum_quantity,
  }
  if (
    state.parentVisible ||
    state.imageCount !== 0 ||
    state.tagIds.length !== 0 ||
    state.tagCount !== 0 ||
    state.tagIdSum !== 0 ||
    state.parentTagCount !== 0 ||
    state.inverseItemIds.length !== 0 ||
    state.inverseCount !== 0 ||
    state.inverseQuantitySum !== 0 ||
    state.inverseWithCount !== 0 ||
    state.inverseWithSum !== 0
  )
    throw new Error(
      'Pending deletion leaked Item3 through public relations or aggregates.',
    )
  return state
}

async function retainedPendingState(client: ExampleClient) {
  const values = await client.storage.read(async (executor) => ({
    entries: await client.storage.pending(executor),
    metadata: (
      await executor.execute(
        'SELECT key,value FROM syn_metadata WHERE partition=? ORDER BY key',
        [client.storage.partition],
      )
    ).rows,
  }))
  return {
    fullOutboxHash: await digest(canonicalJson(values.entries)),
    operationStatuses: values.entries.map((entry) => ({
      operationId: entry.operation.operationId,
      status: entry.status,
    })),
    metadata: values.metadata,
  }
}

async function cancelDeletionPublicState(
  client: ExampleClient,
  deletionOperationId: string,
) {
  await client.sync.cancel(deletionOperationId)
  const restored = await client.models.Item.findOrFail('3')
  const images = await restored.relation('images').get()
  const tags = await restored.relation('tags').get()
  const tag = await client.models.Tag.findOrFail('4')
  const inverse = tag
    .relation('items')
    .constrain((query) => query.where('id', 3))
  const aggregate = await client.models.Tag.where('id', 4)
    .withConstrained('items', (query) => query.where('id', 3))
    .withCount('items')
    .withSum('items', 'quantity')
    .firstOrFail()
  const cancellation = await client.storage.read(async (executor) =>
    (await client.storage.pending(executor)).find(
      (entry) => entry.operation.operationId === deletionOperationId,
    ),
  )
  const state = {
    parentId: String(restored.id),
    imageIds: images.items.map((model) => String(model.id)).sort(),
    imageCount: images.length,
    imageParents: images.items.map((model) => String(model.attributes.item_id)),
    tagIds: tags.items.map((model) => String(model.id)).sort(),
    inverseItemIds: (await inverse.get()).items.map((model) =>
      String(model.id),
    ),
    inverseCount: await inverse.count(),
    inverseWithCount: aggregate.aggregates.items_count,
    inverseWithSum: aggregate.aggregates.items_sum_quantity,
    deletionStatus: cancellation?.status,
  }
  if (
    state.parentId !== '3' ||
    state.imageCount !== 6 ||
    canonicalJson(state.imageIds) !==
      canonicalJson(
        ['2', '17002', '34002', '51002', '68002', '85002'].sort(),
      ) ||
    state.imageParents.some((parent) => parent !== '3') ||
    canonicalJson(state.tagIds) !== canonicalJson(['4', '5', '6']) ||
    canonicalJson(state.inverseItemIds) !== canonicalJson(['3']) ||
    state.inverseCount !== 1 ||
    state.inverseWithCount !== 1 ||
    state.inverseWithSum !== restored.attributes.quantity ||
    state.deletionStatus !== 'cancelled'
  )
    throw new Error(
      'Cancelling the pending delete did not restore public Item3 relations.',
    )
  return state
}

export interface ReferencePhase {
  readonly phase: SnapshotPhase
  readonly elapsedMilliseconds: number
}

export async function snapshotMetadata(client: ExampleClient) {
  return client.storage.read(async (executor) => ({
    cursor: await client.storage.metadata('cursor:catalog', executor),
    scope: await client.storage.metadata('scope', executor),
    snapshotGeneration: await client.storage.metadata(
      'snapshotGeneration',
      executor,
    ),
  }))
}

/** Direct SQL bulk path with identical created DDL, owner, hash, pending state and integrity guarantees. */
export async function installReferenceSnapshot(
  client: ExampleClient,
  input: ReferenceInput,
): Promise<{
  readonly elapsedMilliseconds: number
  readonly phases: readonly ReferencePhase[]
  readonly rows: number
  readonly bulkStatements: number
  readonly sharedHelpers: readonly string[]
}> {
  const snapshot = boundedInput(input) ? input.metadata : input
  const recordCount = boundedInput(input)
    ? input.recordCount
    : input.records.length
  const relationSetCount = boundedInput(input)
    ? input.relationSetCount
    : input.relationSets.length
  const started = nativeClock.now()
  const phases: ReferencePhase[] = []
  let bulkStatements = 0
  const phase = async <Result>(
    name: SnapshotPhase,
    callback: () => Promise<Result>,
  ) => {
    setApplicationWorkPhase(name)
    const beginning = nativeClock.now()
    observeNativeSqlPhase(client, name, 'begin')
    try {
      return await callback()
    } finally {
      phases.push({
        phase: name,
        elapsedMilliseconds: nativeClock.now() - beginning,
      })
      observeNativeSqlPhase(client, name, 'end')
    }
  }
  await phase('validation', async () => {
    if (
      snapshot.schemaFingerprint !== client.storage.manifest.fingerprint ||
      snapshot.scope.schemaFingerprint !== snapshot.schemaFingerprint ||
      snapshot.dataset !== snapshot.scope.dataset ||
      !snapshot.cursor ||
      !snapshot.generation ||
      !snapshot.scope.authorizationGeneration ||
      !snapshot.scope.projectionGeneration ||
      !['complete', 'partial'].includes(snapshot.scope.completeness ?? '') ||
      recordCount > 1000000 ||
      relationSetCount > 1000000 ||
      !Number.isSafeInteger(snapshot.byteSize) ||
      snapshot.byteSize < 0 ||
      snapshot.byteSize > 268435456
    )
      throw new Error('Invalid reference snapshot envelope.')
  })
  await phase('digest', async () => {
    const content = await snapshotContent(input)
    if (
      content.hash !== snapshot.hash ||
      content.byteSize !== snapshot.byteSize
    )
      throw new Error(
        'Reference canonical content hash or byte count mismatches.',
      )
  })
  let commitStarted = 0
  await client.storage.owner.replace(async (executor, changed) => {
    const partition = client.storage.partition
    const manifest = client.storage.manifest
    const exceptions = new Set<string>()
    setApplicationWorkPhase('staging')
    const stagingStarted = nativeClock.now()
    observeNativeSqlPhase(client, 'staging', 'begin')
    if (boundedInput(input)) {
      await client.storage.beginSnapshotStaging(executor)
      try {
        const comparisons = new Map<string, boolean>()
        for await (const page of recordPages(input))
          await client.storage.stageSnapshotRecords(
            page,
            executor,
            true,
            comparisons,
          )
        await client.storage.endSnapshotStaging(executor)
      } finally {
        await executor.execute('DROP TABLE syn_snapshot_membership')
      }
    } else {
      await client.storage.stageSnapshotRecords(input.records, executor)
    }
    await client.storage.clearCanonicalRelations(executor, changed)
    await phase('records', async () => {
      if (!boundedInput(input))
        for (const model of Object.keys(manifest.models)) {
          const existing = await executor.execute(
            `SELECT _server_identity FROM ${identifier('syn_model_' + model)} WHERE _partition=? AND (_local_identity != 'c:' || _server_identity OR _proposal != '{}' OR _state != 'synced')`,
            [partition],
          )
          for (const record of existing.rows)
            if (record._server_identity !== null)
              exceptions.add(`${model}:${String(record._server_identity)}`)
        }
      const seen = new Set<string>()
      if (boundedInput(input))
        await executor.execute(
          'CREATE TEMP TABLE syn_reference_identities (model TEXT NOT NULL, identity TEXT NOT NULL, PRIMARY KEY(model,identity)) WITHOUT ROWID',
        )
      const maximumRowsByModel = new Map<string, number>()
      let batch: CanonicalRecord[] = []
      const flush = async () => {
        const first = batch[0]
        if (!first) return
        const definition = manifest.models[first.model]!
        const decimals = Object.entries(definition.fields).filter(
          ([, metadata]) => metadata.type === 'decimal',
        )
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
          ...decimals.map(([field]) => '_order_' + field),
        ]
        const parameters: BindValue[] = []
        for (const record of batch) {
          const attributes = validateAttributes(definition, record.attributes)
          parameters.push(
            partition,
            'c:' + record.id,
            record.id,
            record.revision,
            canonicalJson(attributes),
            '{}',
            1,
            0,
            'synced',
          )
          for (const [field, metadata] of decimals) {
            const value = attributes[field] ?? null
            parameters.push(
              value === null
                ? null
                : orderedDecimal(value, metadata.precision ?? 18),
            )
          }
        }
        const placeholders = '(' + columns.map(() => '?').join(',') + ')'
        await executor.execute(
          `INSERT INTO ${identifier('syn_model_' + first.model)} (${columns.map(identifier).join(',')}) VALUES ${batch.map(() => placeholders).join(',')} ON CONFLICT(_partition,_local_identity) DO UPDATE SET ${columns
            .slice(2)
            .map(
              (column) =>
                identifier(column) + '=excluded.' + identifier(column),
            )
            .join(',')}`,
          parameters,
        )
        bulkStatements += 1
        changed.add(first.model)
        batch = []
      }
      try {
        const pageSize = Math.min(
          64,
          Math.floor(
            client.storage.owner.adapter.capabilities.maximumParameters / 2,
          ),
        )
        if (pageSize < 1)
          throw new Error('Insufficient reference identity parameter capacity.')
        for await (const page of recordPages(input, pageSize)) {
          if (boundedInput(input)) {
            exceptions.clear()
            for (const record of page) {
              const definition = manifest.models[record.model]
              if (
                !definition ||
                !record.id ||
                !record.revision ||
                (record.attributes[definition.primaryKey] !== undefined &&
                  String(record.attributes[definition.primaryKey]) !==
                    record.id)
              )
                throw new Error('Invalid or duplicate reference identity.')
            }
            const registered = await executor.execute(
              'INSERT OR IGNORE INTO syn_reference_identities(model,identity) VALUES ' +
                page.map(() => '(?,?)').join(','),
              page.flatMap((record) => [record.model, record.id]),
            )
            if (registered.changes !== page.length)
              throw new Error('Invalid or duplicate reference identity.')
            for (const model of new Set(page.map((record) => record.model))) {
              const identities = page
                .filter((record) => record.model === model)
                .map((record) => record.id)
              const existing = await executor.execute(
                `SELECT _server_identity FROM ${identifier('syn_model_' + model)} WHERE _partition=? AND (_local_identity != 'c:' || _server_identity OR _proposal != '{}' OR _state != 'synced') AND _server_identity IN (${identities.map(() => '?').join(',')})`,
                [partition, ...identities],
              )
              for (const record of existing.rows)
                if (record._server_identity !== null)
                  exceptions.add(`${model}:${String(record._server_identity)}`)
            }
          }
          for (const record of page) {
            const definition = manifest.models[record.model]
            const identity = record.model + ':' + record.id
            if (
              !definition ||
              !record.id ||
              !record.revision ||
              seen.has(identity) ||
              (record.attributes[definition.primaryKey] !== undefined &&
                String(record.attributes[definition.primaryKey]) !== record.id)
            )
              throw new Error('Invalid or duplicate reference identity.')
            if (!boundedInput(input)) seen.add(identity)
            if (
              exceptions.has(identity) ||
              record.localIdentity !== undefined
            ) {
              await flush()
              await client.storage.ingest(record, executor, changed)
              continue
            }
            let maximumRows = maximumRowsByModel.get(record.model)
            if (maximumRows === undefined) {
              maximumRows = Math.min(
                64,
                Math.floor(
                  client.storage.owner.adapter.capabilities.maximumParameters /
                    (9 +
                      Object.values(definition.fields).filter(
                        (field) => field.type === 'decimal',
                      ).length),
                ),
              )
              maximumRowsByModel.set(record.model, maximumRows)
            }
            if (maximumRows < 1)
              throw new Error('Insufficient reference SQL parameter capacity.')
            if (
              batch.length &&
              (batch[0]?.model !== record.model || batch.length >= maximumRows)
            )
              await flush()
            batch.push(record)
          }
        }
        await flush()
      } finally {
        if (boundedInput(input))
          await executor.execute('DROP TABLE syn_reference_identities')
      }
    })
    await phase('relationSets', async () => {
      for await (const set of relationSets(input))
        await client.storage.ingestRelationSet(set, executor, changed)
      await client.storage.applyPendingDeleteEffects(executor, changed)
      await client.storage.rebuildRelationOverlays(executor, changed)
    })
    for (const entry of await client.storage.pending(executor))
      if (
        ['pending', 'sending', 'conflicted', 'rejected'].includes(entry.status)
      ) {
        const record = await client.storage.findStored(
          entry.operation.model,
          entry.operation.localIdentity,
          executor,
        )
        if (record?.serverIdentity === null)
          await client.storage.persist({ ...record, visible: true }, executor)
        else if (
          record &&
          !record.visible &&
          Object.keys(record.proposal).length
        )
          await executor.execute(
            'INSERT OR REPLACE INTO syn_recovery(partition,model,local_identity,proposal,reason) VALUES (?,?,?,?,?)',
            [
              partition,
              record.model,
              record.localIdentity,
              canonicalJson(record.proposal),
              'snapshot_scope_removed',
            ],
          )
      }
    await phase('integrity', async () => {
      const integrity = await executor.execute('PRAGMA integrity_check')
      if (
        integrity.rows.length !== 1 ||
        integrity.rows[0]?.integrity_check !== 'ok' ||
        (await executor.execute('PRAGMA foreign_key_check')).rows.length
      )
        throw new Error('Reference integrity validation failed.')
    })
    await client.storage.setMetadata(
      'cursor:' + snapshot.dataset,
      snapshot.cursor,
      executor,
    )
    await client.storage.setMetadata(
      'scope',
      canonicalJson(snapshot.scope),
      executor,
    )
    await client.storage.setMetadata(
      'snapshotGeneration',
      snapshot.generation,
      executor,
    )
    changed.add('*')
    phases.push({
      phase: 'staging',
      elapsedMilliseconds: nativeClock.now() - stagingStarted,
    })
    observeNativeSqlPhase(client, 'staging', 'end')
    setApplicationWorkPhase('commit')
    commitStarted = nativeClock.now()
    observeNativeSqlPhase(client, 'commit', 'begin')
  })
  phases.push({
    phase: 'commit',
    elapsedMilliseconds: nativeClock.now() - commitStarted,
  })
  observeNativeSqlPhase(client, 'commit', 'end')
  return {
    elapsedMilliseconds: nativeClock.now() - started,
    phases,
    rows: recordCount,
    bulkStatements,
    sharedHelpers: [
      'schema creation',
      'DatabaseOwner atomic replacement and committed subscriptions',
      'bounded identity membership and canonical-change staging',
      'stable aliases and pending proposal replay for exceptional records',
      'indexed pending delete cascade and nullify replay',
      'validated pivot projection and pending pivot replay',
      'metadata writes',
      'public native SHA256 provider',
    ],
  }
}

export async function verifyPendingCatalog(
  client: ExampleClient,
  expected: Awaited<ReturnType<typeof preparePendingCatalog>>,
) {
  const entries = await client.storage.read((executor) =>
    client.storage.pending(executor),
  )
  if (
    canonicalJson(entries.map((entry) => entry.operation.operationId)) !==
    canonicalJson(expected.operationIds)
  )
    throw new Error('Import changed pending operation identities.')
  const afterOutboxHash = await digest(
    canonicalJson(
      entries.map((entry) => ({
        operation: entry.operation,
        status: entry.status,
        error: entry.error ?? null,
      })),
    ),
  )
  if (afterOutboxHash !== expected.outboxHash)
    throw new Error('Import changed pending operation status or content.')
  const edited = await client.models.Item.findOrFail('2')
  const deleted = await client.models.Item.find('3')
  const created = await client.models.Item.findOrFail(expected.createdIdentity)
  const aliased = await client.models.Item.findOrFail('1')
  const deletedParentChildren = await client.models.Image.where(
    'item_id',
    3,
  ).count()
  if (
    edited.attributes.title !== 'Pending reference edit' ||
    edited.syncState !== 'pending' ||
    deleted !== null ||
    created.attributes.title !== 'Pending reference create' ||
    aliased.localIdentity !== expected.stableAlias ||
    deletedParentChildren !== 0
  )
    throw new Error(
      'Import lost pending lifecycle, proposal or stable alias state.',
    )
  const hiddenPublicState = await deletedParentPublicState(client)
  const beforeCancellation = await retainedPendingState(client)
  const readActualCatalog = () =>
    client.storage.read(async (executor) => {
      const records = []
      for (const model of Object.keys(client.storage.manifest.models).sort()) {
        const result = await executor.execute(
          `SELECT COUNT(*) AS stored, COALESCE(SUM(_visible),0) AS visible, COALESCE(SUM(CASE WHEN _visible=1 AND _deleted=0 THEN 1 ELSE 0 END),0) AS available, COALESCE(SUM(_deleted),0) AS deleted, COALESCE(SUM(length(_canonical)),0) AS canonicalBytes FROM ${identifier('syn_model_' + model)} WHERE _partition=?`,
          [client.storage.partition],
        )
        const row = result.rows[0]
        if (
          !row ||
          Object.values(row).some(
            (value) =>
              typeof value !== 'number' ||
              !Number.isSafeInteger(value) ||
              value < 0,
          )
        )
          throw new Error('Actual catalog count boundary is invalid.')
        records.push({ model, ...row })
      }
      const relationSets = await executor.execute(
        'SELECT COUNT(*) AS sets FROM syn_relation_sets WHERE partition=?',
        [client.storage.partition],
      )
      const pivotTables = [
        ...new Set(
          Object.values(client.storage.manifest.models).flatMap((definition) =>
            Object.values(definition.relations).flatMap((relation) =>
              relation.pivot ? [relation.pivot.table] : [],
            ),
          ),
        ),
      ].sort()
      const pivotFamilies = []
      for (const table of pivotTables) {
        const live = await executor.execute(
          `SELECT COUNT(*) AS records FROM ${identifier('syn_pivot_' + table)} WHERE _partition=?`,
          [client.storage.partition],
        )
        const canonical = await executor.execute(
          `SELECT COUNT(*) AS records FROM ${identifier('syn_canonical_pivot_' + table)} WHERE _partition=?`,
          [client.storage.partition],
        )
        pivotFamilies.push({
          table,
          live: Number(live.rows[0]?.records),
          canonical: Number(canonical.rows[0]?.records),
        })
      }
      const schema = await executor.execute(
        "SELECT type,name,sql FROM sqlite_master WHERE name LIKE 'syn_%' ORDER BY type,name",
      )
      const schemaHash = await digestChunks(
        (async function* () {
          yield canonicalJson(schema.rows)
        })(),
      )
      async function* content(): AsyncIterable<string> {
        for (const model of Object.keys(
          client.storage.manifest.models,
        ).sort()) {
          yield canonicalJson({ model }) + '\n'
          const decimalColumns = Object.entries(
            client.storage.manifest.models[model]!.fields,
          )
            .filter(([, definition]) => definition.type === 'decimal')
            .map(([field]) => ',' + identifier('_order_' + field))
            .join('')
          let previous = ''
          while (true) {
            const rows = (
              await executor.execute(
                `SELECT _local_identity,_server_identity,_revision,_canonical,_proposal,_visible,_deleted,_state${decimalColumns} FROM ${identifier('syn_model_' + model)} WHERE _partition=? AND _local_identity>? ORDER BY _local_identity LIMIT 256`,
                [client.storage.partition, previous],
              )
            ).rows
            if (!rows.length) break
            let buffer = ''
            for (const row of rows) {
              const encoded = canonicalJson(row) + '\n'
              if (buffer.length + encoded.length > 65536) {
                yield buffer
                buffer = ''
              }
              buffer += encoded
              previous = String(row._local_identity)
            }
            if (buffer) yield buffer
            await yieldToApplication()
          }
        }
        for (const table of [
          'syn_relation_sets',
          ...pivotTables.flatMap((table) => [
            'syn_pivot_' + table,
            'syn_canonical_pivot_' + table,
          ]),
        ]) {
          yield canonicalJson({ table }) + '\n'
          const column =
            table === 'syn_relation_sets' ? 'partition' : '_partition'
          const rows = (
            await executor.execute(
              `SELECT * FROM ${identifier(table)} WHERE ${identifier(column)}=?`,
              [client.storage.partition],
            )
          ).rows
          const content = rows
            .map((row) => {
              const projected = { ...row }
              delete projected[column]
              return canonicalJson(projected)
            })
            .sort()
          yield canonicalJson(content) + '\n'
        }
      }
      const storedContentHash = await digestChunks(content())
      return {
        records,
        relationSets: Number(relationSets.rows[0]?.sets),
        pivotFamilies,
        pivotRows: pivotFamilies.reduce((sum, family) => sum + family.live, 0),
        canonicalPivotRows: pivotFamilies.reduce(
          (sum, family) => sum + family.canonical,
          0,
        ),
        storedContentHash,
        schemaHash,
      }
    })
  const actualCatalog = await readActualCatalog()
  const rollbackSentinel = new Error(
    'Native public cancellation rollback sentinel.',
  )
  let restoredPublicState:
    Awaited<ReturnType<typeof cancelDeletionPublicState>> | undefined
  try {
    await client.transaction(async (scopedClient) => {
      restoredPublicState = await cancelDeletionPublicState(
        scopedClient,
        expected.deletionOperationId,
      )
      throw rollbackSentinel
    })
  } catch (failure) {
    if (failure !== rollbackSentinel) throw failure
  }
  if (!restoredPublicState)
    throw new Error(
      'The scoped transaction did not complete its public cancellation witness.',
    )
  const afterCancellation = await retainedPendingState(client)
  const afterRollbackPublicState = await deletedParentPublicState(client)
  const afterRollbackCatalog = await readActualCatalog()
  if (
    canonicalJson(beforeCancellation) !== canonicalJson(afterCancellation) ||
    canonicalJson(hiddenPublicState) !==
      canonicalJson(afterRollbackPublicState) ||
    canonicalJson(actualCatalog) !== canonicalJson(afterRollbackCatalog)
  )
    throw new Error(
      'Cancellation rollback changed pending outbox, metadata, public or catalog state.',
    )
  return {
    actualCatalog,
    pendingDeletePublicWitness: {
      hiddenPublicState,
      restoredPublicState,
      afterRollbackPublicState,
      beforeCancellation,
      afterCancellation,
      beforeCatalogHash: actualCatalog.storedContentHash,
      afterCatalogHash: afterRollbackCatalog.storedContentHash,
      rollbackSentinelObserved: true,
    },
    pendingPreservation: {
      beforeOperationIds: expected.operationIds,
      afterOperationIds: entries.map((entry) => entry.operation.operationId),
      beforeOutboxHash: expected.outboxHash,
      afterOutboxHash,
      stableAliasBefore: expected.stableAlias,
      stableAliasAfter: aliased.localIdentity,
      pendingCreateVisible:
        created.attributes.title === 'Pending reference create',
      pendingEditRetained:
        edited.attributes.title === 'Pending reference edit' &&
        edited.syncState === 'pending',
      pendingDeleteHidden: deleted === null,
      pendingCascadeChildrenHidden: deletedParentChildren === 0,
    },
  }
}

// Calibration-only validation aliases. The legacy installer above is unchanged.
export {
  identifier as calibrationIdentifier,
  validateValue as calibrationValidateValue,
  validateAttributes as calibrationValidateAttributes,
  orderedDecimal as calibrationOrderedDecimal,
}

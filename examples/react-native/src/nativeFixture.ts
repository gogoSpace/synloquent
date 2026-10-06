import type {
  CanonicalRecord,
  DigestLifecycle,
  Manifest,
  RelationSet,
  SnapshotMetadata,
  SnapshotPartIdentity,
  SnapshotPartsDescriptor,
  SnapshotTransferPart,
  Transport,
} from '@synloquent/client'
import { createDatabaseAdapter } from '@synloquent/client/sqlite'
import { deleteDatabase } from './nativeQualification'
import {
  canonicalJson,
  digest,
  digestChunks,
  createNativeSqlObserver,
  yieldToApplication,
} from './platform'

function countUtf8Bytes(content: string): number {
  if (!/[\u0080-\uffff]/.test(content)) return content.length
  let byteLength = 0
  for (let position = 0; position < content.length; position += 1) {
    const characterCode = content.charCodeAt(position)
    const followingCharacterCode = content.charCodeAt(position + 1)
    if (
      characterCode >= 0xd800 &&
      characterCode <= 0xdbff &&
      followingCharacterCode >= 0xdc00 &&
      followingCharacterCode <= 0xdfff
    ) {
      byteLength += 4
      position += 1
    } else {
      byteLength += characterCode <= 0x7f ? 1 : characterCode <= 0x7ff ? 2 : 3
    }
  }
  return byteLength
}
const maximumPartBytes = 65536
const maximumPartRows = 256
export const nativeFixtureSeed = 20261002
export const nativeFixtureItems = 17000
export const nativeFixtureImages = 100001

export async function* syntheticRecords(
  itemCount = nativeFixtureItems,
  imageCount = nativeFixtureImages,
): AsyncGenerator<CanonicalRecord> {
  for (let category = 1; category <= 50; category += 1)
    yield {
      model: 'Category',
      id: String(category),
      revision: '1',
      attributes: {
        id: category,
        title: `Category ${category}`,
        created_at: null,
        updated_at: null,
      },
    }
  for (let tag = 1; tag <= 64; tag += 1)
    yield {
      model: 'Tag',
      id: String(tag),
      revision: '1',
      attributes: {
        id: tag,
        title: `Tag ${tag}`,
        created_at: null,
        updated_at: null,
      },
    }
  for (let item = 1; item <= itemCount; item += 1) {
    yield {
      model: 'Item',
      id: String(item),
      revision: '1',
      attributes: {
        id: item,
        title: `Synthetic item ${String(item).padStart(5, '0')}`,
        category_id: (item % 50) + 1,
        active: item % 7 !== 0,
        price: `${item % 10000}.${String(item % 100).padStart(2, '0')}`,
        quantity: item % 20,
        metadata: null,
        created_at: null,
        updated_at: null,
      },
    }
    if (item % 500 === 0) await yieldToApplication()
  }
  for (let image = 1; image <= imageCount; image += 1) {
    yield {
      model: 'Image',
      id: String(image),
      revision: '1',
      attributes: {
        id: image,
        item_id: (image % itemCount) + 1,
        url: `image-${nativeFixtureSeed}-${image}.jpg`,
        created_at: null,
        updated_at: null,
      },
    }
    if (image % 500 === 0) await yieldToApplication()
  }
}

export async function* syntheticRelationSets(
  itemCount = nativeFixtureItems,
): AsyncGenerator<RelationSet> {
  for (let item = 1; item <= Math.min(100, itemCount); item += 1)
    yield {
      model: 'Item',
      parentId: String(item),
      relation: 'tags',
      revision: '1',
      completeness: 'complete',
      targets: [0, 1, 2].map((position) => ({
        id: String(((item + position) % 64) + 1),
        attributes: { position },
      })),
    }
}

function document(
  ordinal: number,
  section: 'records' | 'relationSets',
  firstIndex: number,
  rows: readonly string[],
): string {
  return `{"firstIndex":${firstIndex},"format":"canonical-parts-v1","ordinal":${ordinal},"rowCount":${rows.length},"rows":[${rows.join(',')}],"section":"${section}"}`
}

export interface NativeFixture {
  readonly metadata: SnapshotMetadata
  readonly recordCount: number
  readonly relationSetCount: number
  readonly partCount: number
  readonly maximumRowBytes: number
  readonly databaseBytes: number
  databasePath(): Promise<string>
  parts(): AsyncIterable<SnapshotTransferPart>
  records(): AsyncIterable<readonly CanonicalRecord[]>
  relationSets(): AsyncIterable<readonly RelationSet[]>
  transport(generation: () => string): Transport
  close(): Promise<void>
}

/** Immutable SQLite input is separate from both measured target databases. */
export async function createNativeFixture(
  name: string,
  schema: Manifest,
  sizes: { readonly items: number; readonly images: number } = {
    items: nativeFixtureItems,
    images: nativeFixtureImages,
  },
): Promise<NativeFixture> {
  if (
    !Number.isSafeInteger(sizes.items) ||
    sizes.items < 1 ||
    !Number.isSafeInteger(sizes.images) ||
    sizes.images < 0 ||
    sizes.items + sizes.images + 114 > 1000000
  )
    throw new Error('Invalid deterministic fixture size.')
  const sqlObserver = createNativeSqlObserver(name)
  const database = createDatabaseAdapter({
    name,
    observeNativeWork: sqlObserver.observeNativeWork,
  })
  let closed = false
  let closing: Promise<void> | undefined
  const close = (): Promise<void> => {
    if (closing) return closing
    closed = true
    closing = database.close().then(() => {
      deleteDatabase(name)
    })
    return closing
  }
  const assertOpen = () => {
    if (closed) throw new Error('Fixture input is closed.')
  }
  let ordinal = 0
  let maximumRowBytes = 0
  let catalogBytes = 0
  const counts = { records: 0, relationSets: 0 }
  try {
    await database.execute(
      'CREATE TABLE fixture_parts (ordinal INTEGER PRIMARY KEY, section TEXT NOT NULL, first_index INTEGER NOT NULL, row_count INTEGER NOT NULL, hash TEXT NOT NULL, byte_size INTEGER NOT NULL CHECK(byte_size <= 65536), raw_document TEXT NOT NULL)',
    )
    async function* build(): AsyncGenerator<string> {
      yield '{"records":['
      for (const section of ['records', 'relationSets'] as const) {
        if (section === 'relationSets') yield '],"relationSets":['
        let rows: string[] = []
        let rowsBytes = 0
        let firstIndex = 0
        const flush = async () => {
          if (!rows.length) return
          const content = document(ordinal, section, firstIndex, rows)
          const byteSize = countUtf8Bytes(content)
          if (byteSize > maximumPartBytes)
            throw new Error('Fixture part exceeds 64 KiB.')
          const hash = await digest(content)
          await database.execute(
            'INSERT INTO fixture_parts VALUES (?,?,?,?,?,?,?)',
            [
              ordinal,
              section,
              firstIndex,
              rows.length,
              hash,
              byteSize,
              content,
            ],
          )
          firstIndex += rows.length
          ordinal += 1
          rows = []
          rowsBytes = 0
        }
        const source =
          section === 'records'
            ? syntheticRecords(sizes.items, sizes.images)
            : syntheticRelationSets(sizes.items)
        for await (const row of source) {
          const content = canonicalJson(row)
          const byteSize = countUtf8Bytes(content)
          if (byteSize + 256 > maximumPartBytes)
            throw new Error('Fixture row exceeds bounded input.')
          if (
            rows.length &&
            (rows.length >= maximumPartRows ||
              rowsBytes + byteSize + 1 + 256 > maximumPartBytes)
          )
            await flush()
          maximumRowBytes = Math.max(maximumRowBytes, byteSize)
          rows.push(content)
          rowsBytes += byteSize + 1
          yield `${counts[section] ? ',' : ''}${content}`
          counts[section] += 1
        }
        await flush()
      }
      yield ']}'
    }
    async function* catalog(): AsyncGenerator<string> {
      for await (const piece of build()) {
        catalogBytes += countUtf8Bytes(piece)
        yield piece
      }
    }
    const hash = await digestChunks(catalog())
    const pageCount = Number(
      (await database.execute('PRAGMA page_count')).rows[0]!.page_count,
    )
    const pageSize = Number(
      (await database.execute('PRAGMA page_size')).rows[0]!.page_size,
    )
    await database.execute('PRAGMA query_only = ON')
    const metadata: SnapshotMetadata = {
      dataset: 'catalog',
      schemaFingerprint: schema.fingerprint,
      generation: 'native-synthetic-fixture',
      cursor: 'native-synthetic-cursor',
      hash,
      byteSize: catalogBytes,
      scope: {
        dataset: 'catalog',
        schemaFingerprint: schema.fingerprint,
        authorizationGeneration: 'synthetic-scope',
        projectionGeneration: 'synthetic-projection',
        completeness: 'complete',
      },
    }
    const identity = async (
      index: number,
      generation: string,
    ): Promise<SnapshotPartIdentity> => {
      assertOpen()
      const result = await database.execute(
        'SELECT hash,byte_size FROM fixture_parts WHERE ordinal=?',
        [index],
      )
      assertOpen()
      const row = result.rows[0]
      if (!row) throw new Error('Fixture input has a missing part.')
      return {
        ordinal: index,
        downloadUrl: `http://fixture.invalid/${encodeURIComponent(generation)}/${index}`,
        hash: String(row.hash),
        byteSize: Number(row.byte_size),
        continuation: `${generation}:${index}`,
      }
    }
    const readPart = async (index: number): Promise<SnapshotTransferPart> => {
      assertOpen()
      const result = await database.execute(
        'SELECT section,first_index,row_count,hash,byte_size,CASE WHEN length(CAST(raw_document AS BLOB))<=65536 THEN raw_document END AS bounded_document FROM fixture_parts WHERE ordinal=?',
        [index],
      )
      assertOpen()
      const row = result.rows[0]
      if (!row || typeof row.bounded_document !== 'string')
        throw new Error('Fixture input part is missing or oversized.')
      const rawDocument = row.bounded_document
      const beginning = rawDocument.indexOf(',"rows":') + ',"rows":'.length
      const ending = rawDocument.lastIndexOf(',"section":')
      if (beginning < ',"rows":'.length || ending < beginning)
        throw new Error('Fixture raw row span is invalid.')
      const rawRows = rawDocument.slice(beginning, ending)
      const rows = JSON.parse(rawRows) as CanonicalRecord[] | RelationSet[]
      if (
        !Array.isArray(rows) ||
        !['records', 'relationSets'].includes(String(row.section)) ||
        !Number.isSafeInteger(row.first_index) ||
        Number(row.first_index) < 0 ||
        rows.length !== Number(row.row_count) ||
        rows.length > maximumPartRows ||
        countUtf8Bytes(rawDocument) !== Number(row.byte_size)
      )
        throw new Error('Fixture input geometry differs from its metadata.')
      return {
        format: 'canonical-parts-v1',
        ordinal: index,
        section: row.section as 'records' | 'relationSets',
        firstIndex: Number(row.first_index),
        rowCount: rows.length,
        rows,
        rawDocument,
        rawRows,
        hash: String(row.hash),
        byteSize: Number(row.byte_size),
      }
    }
    async function* parts(): AsyncGenerator<SnapshotTransferPart> {
      for (let index = 0; index < ordinal; index += 1)
        yield await readPart(index)
    }
    async function* pages<Row>(
      section: 'records' | 'relationSets',
    ): AsyncGenerator<readonly Row[]> {
      let previous = -1
      while (true) {
        assertOpen()
        const selected = await database.execute(
          'SELECT ordinal FROM fixture_parts WHERE ordinal>? AND section=? ORDER BY ordinal LIMIT 1',
          [previous, section],
        )
        assertOpen()
        if (!selected.rows.length) return
        previous = Number(selected.rows[0]!.ordinal)
        const part = await readPart(previous)
        for (let index = 0; index < part.rows.length; index += 64)
          yield part.rows.slice(index, index + 64) as Row[]
      }
    }
    const unavailable = async (): Promise<never> => {
      throw new Error(
        'Synthetic input only implements the bounded snapshot transport.',
      )
    }
    return {
      metadata,
      recordCount: counts.records,
      relationSetCount: counts.relationSets,
      partCount: ordinal,
      maximumRowBytes,
      databaseBytes: pageCount * pageSize,
      async databasePath() {
        assertOpen()
        const result = await database.execute('PRAGMA database_list')
        assertOpen()
        const path = result.rows.find((row) => row.name === 'main')?.file
        if (typeof path !== 'string' || !path)
          throw new Error('Owned fixture has no actual main database path.')
        return path
      },
      parts,
      records: () => pages<CanonicalRecord>('records'),
      relationSets: () => pages<RelationSet>('relationSets'),
      close,
      transport(generation) {
        const active = (lifecycle?: DigestLifecycle) => {
          assertOpen()
          if (lifecycle?.cancelled)
            throw new Error('Fixture transfer was cancelled.')
        }
        const descriptor = async (): Promise<SnapshotPartsDescriptor> => {
          const currentGeneration = generation()
          const firstPart = await identity(0, currentGeneration)
          if (currentGeneration !== generation())
            throw new Error('Fixture generation changed during acquisition.')
          return {
            ...metadata,
            generation: currentGeneration,
            format: 'canonical-parts-v1',
            status: 'ready',
            recordCount: counts.records,
            relationSetCount: counts.relationSets,
            partCount: ordinal,
            maximumPartBytes,
            partRowLimit: maximumPartRows,
            maximumRowBytes,
            firstPart,
          }
        }
        return {
          manifest: async () => schema,
          query: unavailable,
          push: unavailable,
          pull: unavailable,
          snapshot: unavailable,
          command: unavailable,
          async snapshotParts(request, lifecycle) {
            active(lifecycle)
            if (request.payload.dataset !== metadata.dataset)
              throw new Error('Fixture dataset differs.')
            const result = await descriptor()
            active(lifecycle)
            return result
          },
          async snapshotPartBatch(request, lifecycle) {
            active(lifecycle)
            const current = await descriptor()
            if (
              canonicalJson(request.payload.descriptor) !==
              canonicalJson(current)
            )
              throw new Error('Fixture descriptor changed.')
            const first = request.payload.part.ordinal
            if (!Number.isSafeInteger(first) || first < 0 || first >= ordinal)
              throw new Error('Fixture continuation ordinal is invalid.')
            if (
              canonicalJson(request.payload.part) !==
              canonicalJson(await identity(first, current.generation))
            )
              throw new Error('Fixture continuation is invalid.')
            const ending = Math.min(first + 16, ordinal)
            const nextPart =
              ending < ordinal
                ? await identity(ending, current.generation)
                : undefined
            async function* batch(): AsyncGenerator<SnapshotTransferPart> {
              for (let index = first; index < ending; index += 1) {
                active(lifecycle)
                if (generation() !== current.generation)
                  throw new Error('Fixture generation changed during reading.')
                const part = await readPart(index)
                active(lifecycle)
                yield part
              }
            }
            return {
              parts: batch(),
              ...(nextPart
                ? { nextPart }
                : { confirmationToken: `${current.generation}:${hash}` }),
            }
          },
          async confirmSnapshotParts(request, lifecycle) {
            active(lifecycle)
            if (
              canonicalJson(request.payload.descriptor) !==
                canonicalJson(await descriptor()) ||
              request.payload.confirmationToken !== `${generation()}:${hash}`
            )
              throw new Error('Fixture confirmation is invalid.')
            active(lifecycle)
            return { ...metadata, generation: generation(), confirmed: true }
          },
        }
      },
    }
  } catch (failure) {
    try {
      await close()
    } catch (cleanupFailure) {
      throw new AggregateError(
        [failure, cleanupFailure],
        'Fixture preparation and cleanup failed.',
        { cause: cleanupFailure },
      )
    }
    throw failure
  }
}

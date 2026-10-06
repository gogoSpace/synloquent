import { open } from '@op-engineering/op-sqlite'
import type {
  DigestLifecycle,
  SnapshotMetadata,
  SnapshotPartsDescriptor,
  SnapshotPartIdentity,
  SnapshotTransferPart,
  Transport,
} from '@synloquent/client'
import type { NativeFixture } from './nativeFixture'
import { canonicalJson, digestChunks } from './platform'
import {
  CalibrationWireRootReader,
  decodeCalibrationWirePart,
} from './nativeCalibrationWire'

export const calibrationCaps = Object.freeze({
  rows: 16,
  bindingBytes: 16384,
  hashUnits: 16384,
  partBytes: 65536,
})

export function calibrationUtf8Length(content: string): number {
  let bytes = 0
  for (let position = 0; position < content.length; position++) {
    const code = content.charCodeAt(position)
    const following = content.charCodeAt(position + 1)
    if (
      code >= 0xd800 &&
      code <= 0xdbff &&
      following >= 0xdc00 &&
      following <= 0xdfff
    ) {
      bytes += 4
      position++
    } else bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : 3
  }
  return bytes
}

export function* calibrationHashPieces(content: string): Generator<string> {
  for (let position = 0; position < content.length;) {
    let ending = Math.min(content.length, position + calibrationCaps.hashUnits)
    const before = content.charCodeAt(ending - 1)
    const after = content.charCodeAt(ending)
    if (
      ending < content.length &&
      before >= 0xd800 &&
      before <= 0xdbff &&
      after >= 0xdc00 &&
      after <= 0xdfff
    )
      ending--
    yield content.slice(position, ending)
    position = ending
  }
}

/** Retain each complete original row span, including its surrounding trivia. */
export function* calibrationRowDocuments(rawRows: string): Generator<string> {
  const reader = new CalibrationWireRootReader(rawRows)
  reader.expect('[')
  let required = false
  while (true) {
    const beginning = reader.position
    reader.whitespace()
    if (rawRows[reader.position] === ']') {
      if (required)
        throw new Error('Calibration row span has a trailing comma.')
      reader.position++
      break
    }
    reader.valueSpan()
    reader.whitespace()
    yield rawRows.slice(beginning, reader.position)
    if (rawRows[reader.position] === ']') {
      reader.position++
      break
    }
    reader.expect(',')
    required = true
  }
  reader.whitespace()
  if (reader.position !== rawRows.length)
    throw new Error('Calibration row span has trailing data.')
}

export interface CalibrationSourceStatement {
  readonly parameters: number
  readonly bindingBytes: number
  readonly returnedRows: number
  readonly rejected: boolean
}

export interface CalibrationSourceIdentity {
  readonly databaseName: string
  readonly metadata: SnapshotMetadata
  readonly recordCount: number
  readonly relationSetCount: number
  readonly partCount: number
  readonly maximumRowBytes: number
  readonly partInventoryHash: string
}

export interface CalibrationSourceView {
  readonly identity: CalibrationSourceIdentity
  readPart(ordinal: number): Promise<SnapshotTransferPart>
  partOrdinals(section: 'records' | 'relationSets'): AsyncIterable<number>
  inventoryHash(lifecycle?: DigestLifecycle): Promise<string>
  transport(generation: () => string): Transport
}

function copiedIdentity(
  identity: CalibrationSourceIdentity,
): CalibrationSourceIdentity {
  if (
    !/^[A-Za-z0-9_-]+\.sqlite$/.test(identity.databaseName) ||
    !/^[a-f0-9]{64}$/.test(identity.partInventoryHash)
  )
    throw new Error('Calibration source name or inventory seal is invalid.')
  const result = JSON.parse(
    canonicalJson(identity),
  ) as CalibrationSourceIdentity
  Object.freeze(result.metadata.scope)
  Object.freeze(result.metadata)
  return Object.freeze(result)
}

/** A new read-only native connection owns a single pinned SQLite read view. */
export async function withCalibrationSourceView<Result>(
  suppliedIdentity: CalibrationSourceIdentity,
  callback: (view: CalibrationSourceView) => Promise<Result>,
  inventoryDigest: typeof digestChunks = digestChunks,
  observeStatement?: (event: CalibrationSourceStatement) => void,
): Promise<Result> {
  const identity = copiedIdentity(suppliedIdentity)
  const connection = open({
    name: identity.databaseName,
    readOnly: true,
    failOnCreate: true,
  })
  let available = true
  let transactionStarted = false
  let observationFailure: unknown
  let tail: Promise<unknown> = Promise.resolve()
  const execute = (
    statement: string,
    parameters: readonly (string | number)[] = [],
  ) => {
    if (!available)
      return Promise.reject(new Error('Calibration source view has closed.'))
    const pending = tail.then(async () => {
      if (!available) throw new Error('Calibration source view has closed.')
      let returnedRows = 0
      let rejected = true
      try {
        const result = await connection.execute(statement, [...parameters])
        returnedRows = result.rows.length
        rejected = false
        if (!available) throw new Error('Calibration source view has closed.')
        return result
      } finally {
        try {
          observeStatement?.({
            parameters: parameters.length,
            bindingBytes: parameters.reduce<number>(
              (bytes, value) =>
                bytes +
                (typeof value === 'string' ? calibrationUtf8Length(value) : 8),
              0,
            ),
            returnedRows,
            rejected,
          })
        } catch (failure) {
          observationFailure ??= failure
        }
      }
    })
    tail = pending.then(
      () => undefined,
      () => undefined,
    )
    return pending
  }
  let primaryFailure: unknown
  let failed = false
  let callbackResult: Result | undefined
  let cleanupFailures: unknown[]
  try {
    await execute('BEGIN DEFERRED')
    transactionStarted = true
    // The first read pins the view before any descriptor or activation work.
    const geometry = (
      await execute(
        'SELECT COUNT(*) AS count,MIN(ordinal) AS first,MAX(ordinal) AS last FROM fixture_parts',
      )
    ).rows[0]
    if (
      !geometry ||
      geometry.count !== identity.partCount ||
      (identity.partCount &&
        (geometry.first !== 0 || geometry.last !== identity.partCount - 1))
    )
      throw new Error('Calibration source part inventory is incomplete.')
    const readPart = async (ordinal: number): Promise<SnapshotTransferPart> => {
      if (
        !Number.isSafeInteger(ordinal) ||
        ordinal < 0 ||
        ordinal >= identity.partCount
      )
        throw new Error('Calibration source ordinal is invalid.')
      const row = (
        await execute(
          'SELECT ordinal,section,first_index,row_count,hash,byte_size,CASE WHEN length(CAST(raw_document AS BLOB))<=65536 THEN raw_document END AS raw_document FROM fixture_parts WHERE ordinal=?',
          [ordinal],
        )
      ).rows[0]
      if (
        !row ||
        typeof row.raw_document !== 'string' ||
        row.raw_document.length > 65536
      )
        throw new Error('Calibration source part is missing or oversized.')
      // Locate the original row span with the approved independent root reader.
      const reader = new CalibrationWireRootReader(row.raw_document)
      reader.expect('{')
      let rawRows: string | undefined
      while (true) {
        reader.whitespace()
        if (row.raw_document[reader.position] === '}') {
          reader.position++
          break
        }
        const keySpan = reader.stringSpan()
        const key = JSON.parse(row.raw_document.slice(...keySpan)) as unknown
        reader.expect(':')
        const valueSpan = reader.valueSpan()
        if (key === 'rows') {
          if (rawRows !== undefined)
            throw new Error('Calibration source repeats its row span.')
          rawRows = row.raw_document.slice(...valueSpan)
        }
        reader.whitespace()
        if (row.raw_document[reader.position] === '}') {
          reader.position++
          break
        }
        reader.expect(',')
      }
      reader.whitespace()
      if (reader.position !== row.raw_document.length || rawRows === undefined)
        throw new Error('Calibration source framing is incomplete.')
      const part: SnapshotTransferPart = {
        format: 'canonical-parts-v1',
        ordinal: Number(row.ordinal),
        section: row.section as 'records' | 'relationSets',
        firstIndex: Number(row.first_index),
        rowCount: Number(row.row_count),
        hash: String(row.hash),
        byteSize: Number(row.byte_size),
        rawDocument: row.raw_document,
        rawRows,
        rows: JSON.parse(rawRows) as SnapshotTransferPart['rows'],
      }
      decodeCalibrationWirePart(part)
      return part
    }
    const inventoryHash = async (
      lifecycle?: DigestLifecycle,
    ): Promise<string> => {
      async function* chunks() {
        for (let ordinal = 0; ordinal < identity.partCount; ordinal++) {
          if (lifecycle?.cancelled)
            throw new Error(
              'Calibration source inventory verification was cancelled.',
            )
          const row = (
            await execute(
              'SELECT ordinal,section,first_index,row_count,hash,byte_size FROM fixture_parts WHERE ordinal=?',
              [ordinal],
            )
          ).rows[0]
          if (!row)
            throw new Error('Calibration source lost an inventory entry.')
          yield* calibrationHashPieces(canonicalJson(row) + '\n')
        }
      }
      return inventoryDigest(chunks(), lifecycle)
    }
    const view: CalibrationSourceView = {
      identity,
      readPart,
      inventoryHash,
      async *partOrdinals(section) {
        let previous = -1
        while (true) {
          const selected = await execute(
            'SELECT ordinal FROM fixture_parts WHERE section=? AND ordinal>? ORDER BY ordinal LIMIT 16',
            [section, previous],
          )
          if (!selected.rows.length) return
          for (const row of selected.rows) {
            const ordinal = Number(row.ordinal)
            if (
              !Number.isSafeInteger(ordinal) ||
              ordinal <= previous ||
              ordinal >= identity.partCount
            )
              throw new Error('Calibration source section ordinal is invalid.')
            previous = ordinal
            yield ordinal
          }
        }
      },
      transport(generation) {
        const active = (lifecycle?: DigestLifecycle) => {
          if (!available || lifecycle?.cancelled)
            throw new Error(
              'Calibration local transfer is cancelled or closed.',
            )
        }
        const partIdentity = async (
          ordinal: number,
          currentGeneration: string,
        ): Promise<SnapshotPartIdentity> => {
          const row = (
            await execute(
              'SELECT hash,byte_size FROM fixture_parts WHERE ordinal=?',
              [ordinal],
            )
          ).rows[0]
          if (!row)
            throw new Error('Calibration source continuation has no part.')
          return {
            ordinal,
            downloadUrl: `http://fixture.invalid/${encodeURIComponent(currentGeneration)}/${ordinal}`,
            hash: String(row.hash),
            byteSize: Number(row.byte_size),
            continuation: `${currentGeneration}:${ordinal}`,
          }
        }
        const descriptor = async (): Promise<SnapshotPartsDescriptor> => {
          const currentGeneration = generation()
          const firstPart = identity.partCount
            ? await partIdentity(0, currentGeneration)
            : undefined
          if (currentGeneration !== generation())
            throw new Error('Calibration source generation changed.')
          return {
            ...identity.metadata,
            generation: currentGeneration,
            status: 'ready',
            format: 'canonical-parts-v1',
            recordCount: identity.recordCount,
            relationSetCount: identity.relationSetCount,
            partCount: identity.partCount,
            maximumPartBytes: 65536,
            maximumRowBytes: identity.maximumRowBytes,
            partRowLimit: 256,
            ...(firstPart
              ? { firstPart }
              : {
                  confirmationToken: `${currentGeneration}:${identity.metadata.hash}`,
                }),
          }
        }
        const unavailable = async (): Promise<never> => {
          throw new Error(
            'Calibration source implements only local snapshot parts.',
          )
        }
        return {
          manifest: unavailable,
          query: unavailable,
          push: unavailable,
          pull: unavailable,
          snapshot: unavailable,
          command: unavailable,
          async snapshotParts(request, lifecycle) {
            active(lifecycle)
            if (request.payload.dataset !== identity.metadata.dataset)
              throw new Error('Calibration source dataset differs.')
            const result = await descriptor()
            active(lifecycle)
            return result
          },
          async snapshotPartBatch(request, lifecycle) {
            active(lifecycle)
            const current = await descriptor()
            const first = request.payload.part.ordinal
            if (
              canonicalJson(request.payload.descriptor) !==
                canonicalJson(current) ||
              !Number.isSafeInteger(first) ||
              first < 0 ||
              first >= identity.partCount ||
              canonicalJson(request.payload.part) !==
                canonicalJson(await partIdentity(first, current.generation))
            )
              throw new Error('Calibration source continuation differs.')
            const ending = Math.min(first + 16, identity.partCount)
            const nextPart =
              ending < identity.partCount
                ? await partIdentity(ending, current.generation)
                : undefined
            async function* parts() {
              for (let ordinal = first; ordinal < ending; ordinal++) {
                active(lifecycle)
                if (generation() !== current.generation)
                  throw new Error(
                    'Calibration source changed generation during reading.',
                  )
                const part = await readPart(ordinal)
                active(lifecycle)
                yield part
              }
            }
            return {
              parts: parts(),
              ...(nextPart
                ? { nextPart }
                : {
                    confirmationToken: `${current.generation}:${identity.metadata.hash}`,
                  }),
            }
          },
          async confirmSnapshotParts(request, lifecycle) {
            active(lifecycle)
            if (
              canonicalJson(request.payload.descriptor) !==
                canonicalJson(await descriptor()) ||
              request.payload.confirmationToken !==
                `${generation()}:${identity.metadata.hash}`
            )
              throw new Error('Calibration local confirmation differs.')
            active(lifecycle)
            return {
              ...identity.metadata,
              generation: generation(),
              confirmed: true,
            }
          },
        }
      },
    }
    callbackResult = await callback(view)
    await execute('COMMIT')
    transactionStarted = false
    if (observationFailure) throw observationFailure
  } catch (failure) {
    primaryFailure = failure
    failed = true
  } finally {
    available = false
    await tail
    cleanupFailures = []
    if (transactionStarted) {
      try {
        await connection.execute('ROLLBACK')
      } catch (failure) {
        cleanupFailures.push(failure)
      }
    }
    try {
      connection.close()
    } catch (failure) {
      cleanupFailures.push(failure)
    }
  }
  if (cleanupFailures.length)
    throw new AggregateError(
      failed ? [primaryFailure, ...cleanupFailures] : cleanupFailures,
      'Calibration source cleanup failed.',
    )
  if (failed) throw primaryFailure
  return callbackResult as Result
}

/** Sealing is fixture preparation work, outside the later ingestion bracket. */
export async function sealCalibrationFixture(
  databaseName: string,
  fixture: NativeFixture,
): Promise<CalibrationSourceIdentity> {
  const identity: CalibrationSourceIdentity = {
    databaseName,
    metadata: fixture.metadata,
    recordCount: fixture.recordCount,
    relationSetCount: fixture.relationSetCount,
    partCount: fixture.partCount,
    maximumRowBytes: fixture.maximumRowBytes,
    partInventoryHash: '0'.repeat(64),
  }
  const partInventoryHash = await withCalibrationSourceView(identity, (view) =>
    view.inventoryHash(),
  )
  return copiedIdentity({ ...identity, partInventoryHash })
}

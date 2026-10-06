import { SynloquentError } from './errors.js'
import type {
  ClientConfiguration,
  DigestLifecycle,
  Snapshot,
  SnapshotPhase,
} from './types.js'
import { canonicalJson } from './values.js'

export function utf8Length(value: string): number {
  if (!/[\u0080-\uffff]/.test(value)) return value.length
  let length = 0
  for (let position = 0; position < value.length; position++) {
    const code = value.charCodeAt(position)
    if (
      code >= 0xd800 &&
      code <= 0xdbff &&
      position + 1 < value.length &&
      value.charCodeAt(position + 1) >= 0xdc00 &&
      value.charCodeAt(position + 1) <= 0xdfff
    ) {
      length += 4
      position++
    } else length += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : 3
  }
  return length
}

export function snapshotPhase(
  configuration: ClientConfiguration,
  phase: SnapshotPhase,
  state: 'begin' | 'end',
): void {
  try {
    configuration.observeSnapshotPhase?.({ phase, state })
  } catch {
    /* Diagnostics never change a database transaction outcome. */
  }
}

/** The digest covers only the canonical records and relation sets, in sorted key order. */
export async function verifySnapshotContent(
  snapshot: Snapshot,
  configuration: ClientConfiguration,
  lifecycle?: DigestLifecycle,
): Promise<void> {
  if (
    !Array.isArray(snapshot.records) ||
    !Array.isArray(snapshot.relationSets) ||
    snapshot.records.length > 1000000 ||
    snapshot.relationSets.length > 1000000 ||
    !Number.isSafeInteger(snapshot.byteSize) ||
    snapshot.byteSize < 0 ||
    snapshot.byteSize > 256 * 1024 * 1024
  )
    throw new SynloquentError(
      'snapshot_invalid',
      'Snapshot bounds are invalid.',
    )
  let byteSize = 0
  let consumed = false
  function* pieces(): Generator<string> {
    yield '{"records":['
    for (const [collectionIndex, collection] of [
      snapshot.records,
      snapshot.relationSets,
    ].entries()) {
      if (collectionIndex) yield '],"relationSets":['
      for (let index = 0; index < collection.length; index++) {
        if (index) yield ','
        const content = canonicalJson(collection[index])
        yield content
      }
    }
    yield ']}'
  }
  async function* measured(): AsyncGenerator<string> {
    let buffer = ''
    let bufferedBytes = 0
    let chunks = 0
    for (const piece of pieces()) {
      if (lifecycle?.cancelled)
        throw new SynloquentError(
          'session_changed',
          'Snapshot digest iteration was cancelled.',
        )
      if (!/[\u0080-\uffff]/.test(piece)) {
        let position = 0
        while (position < piece.length) {
          const length = Math.min(4096 - bufferedBytes, piece.length - position)
          buffer += piece.slice(position, position + length)
          bufferedBytes += length
          position += length
          if (bufferedBytes === 4096) {
            byteSize += bufferedBytes
            if (byteSize > snapshot.byteSize)
              throw new SynloquentError(
                'snapshot_invalid',
                'Snapshot content exceeds its declared byte size.',
              )
            yield buffer
            buffer = ''
            bufferedBytes = 0
            if (
              !configuration.digestChunks &&
              configuration.schedule &&
              ++chunks % 16 === 0
            )
              await new Promise<void>((resolve) =>
                configuration.schedule!(resolve, 0),
              )
          }
        }
        continue
      }
      let start = 0
      for (let position = 0; position < piece.length; position++) {
        const code = piece.charCodeAt(position)
        const paired =
          code >= 0xd800 &&
          code <= 0xdbff &&
          position + 1 < piece.length &&
          piece.charCodeAt(position + 1) >= 0xdc00 &&
          piece.charCodeAt(position + 1) <= 0xdfff
        const characterBytes = paired
          ? 4
          : code <= 0x7f
            ? 1
            : code <= 0x7ff
              ? 2
              : 3
        if (bufferedBytes + characterBytes > 4096) {
          buffer += piece.slice(start, position)
          byteSize += bufferedBytes
          if (byteSize > snapshot.byteSize)
            throw new SynloquentError(
              'snapshot_invalid',
              'Snapshot content exceeds its declared byte size.',
            )
          yield buffer
          buffer = ''
          bufferedBytes = 0
          start = position
        }
        bufferedBytes += characterBytes
        if (paired) position++
      }
      buffer += piece.slice(start)
    }
    if (buffer) {
      byteSize += bufferedBytes
      yield buffer
    }
    consumed = true
  }
  let hash: string
  snapshotPhase(configuration, 'digest', 'begin')
  try {
    if (configuration.digestChunks)
      hash = await configuration.digestChunks(measured(), lifecycle)
    else {
      if (snapshot.byteSize > 1024 * 1024)
        throw new SynloquentError(
          'snapshot_invalid',
          'Large snapshots require an injected streaming digestChunks implementation.',
        )
      const parts: string[] = []
      for await (const chunk of measured()) parts.push(chunk)
      hash = await configuration.digest(parts.join(''), lifecycle)
    }
  } finally {
    snapshotPhase(configuration, 'digest', 'end')
  }
  if (lifecycle?.cancelled)
    throw new SynloquentError(
      'session_changed',
      'Snapshot digest belongs to a cancelled lifecycle.',
    )
  if (!consumed || byteSize !== snapshot.byteSize || hash !== snapshot.hash)
    throw new SynloquentError(
      'snapshot_invalid',
      'Snapshot content length or hash mismatch.',
    )
}

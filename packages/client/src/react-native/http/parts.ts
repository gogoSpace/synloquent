import { SynloquentError } from '../../core/errors.js'
import { utf8Length } from '../../core/snapshot-content.js'
import type {
  DigestLifecycle,
  SnapshotPartBatch,
  SnapshotPartIdentity,
  SnapshotPartsDescriptor,
  SnapshotTransferPart,
} from '../../core/types.js'
import { decodeHttpJson } from './json.js'
import { isRecord, validateHttpPayload } from './validation.js'
import type { HttpWorkBudget } from './work-budget.js'
import type { HttpStage } from './types.js'

function invalid(): never {
  throw new SynloquentError(
    'snapshot_invalid',
    'Immutable snapshot part bounds or identity are invalid.',
  )
}
const boundedString = (value: unknown, maximum = 4096): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= maximum
const integer = (value: unknown, maximum: number): value is number =>
  typeof value === 'number' &&
  Number.isSafeInteger(value) &&
  value >= 0 &&
  value <= maximum

export function isSnapshotPartIdentity(
  value: unknown,
): value is SnapshotPartIdentity {
  return (
    isRecord(value) &&
    Object.keys(value).length === 5 &&
    integer(value.ordinal, 599999) &&
    boundedString(value.downloadUrl) &&
    boundedString(value.continuation) &&
    typeof value.hash === 'string' &&
    /^[a-f0-9]{64}$/.test(value.hash) &&
    integer(value.byteSize, 65536) &&
    value.byteSize > 0
  )
}

export function isSnapshotPartsDescriptor(
  value: unknown,
): value is SnapshotPartsDescriptor {
  if (!isRecord(value)) return false
  const allowed = new Set([
    'schemaFingerprint',
    'dataset',
    'generation',
    'cursor',
    'hash',
    'byteSize',
    'scope',
    'downloadUrl',
    'format',
    'status',
    'partCount',
    'recordCount',
    'relationSetCount',
    'maximumPartBytes',
    'maximumRowBytes',
    'partRowLimit',
    'firstPart',
    'confirmationToken',
    'reason',
  ])
  return (
    Object.keys(value).every((field) => allowed.has(field)) &&
    value.format === 'canonical-parts-v1' &&
    ['ready', 'admission-required'].includes(String(value.status)) &&
    ['schemaFingerprint', 'dataset', 'generation', 'cursor'].every((field) =>
      boundedString(value[field], 1024),
    ) &&
    typeof value.hash === 'string' &&
    /^[a-f0-9]{64}$/.test(value.hash) &&
    integer(value.byteSize, 536870912) &&
    integer(value.partCount, 600000) &&
    integer(value.recordCount, 500000) &&
    integer(value.relationSetCount, 100000) &&
    value.maximumPartBytes === 65536 &&
    value.partRowLimit === 256 &&
    integer(value.maximumRowBytes, 536870912) &&
    isRecord(value.scope) &&
    Object.keys(value.scope).every((field) =>
      [
        'dataset',
        'authorizationGeneration',
        'projectionGeneration',
        'schemaFingerprint',
        'completeness',
      ].includes(field),
    ) &&
    value.scope.dataset === value.dataset &&
    value.scope.schemaFingerprint === value.schemaFingerprint &&
    (value.scope.completeness === undefined ||
      ['complete', 'partial'].includes(String(value.scope.completeness))) &&
    [
      'dataset',
      'authorizationGeneration',
      'projectionGeneration',
      'schemaFingerprint',
    ].every((field) =>
      boundedString((value.scope as Record<string, unknown>)[field], 1024),
    ) &&
    (value.status === 'admission-required'
      ? ['unsupported-host-contract', 'row-exceeds-part-budget'].includes(
          String(value.reason),
        )
      : value.maximumRowBytes <= 65536 &&
        value.partCount <= value.recordCount + value.relationSetCount &&
        (value.partCount === 0
          ? value.recordCount === 0 &&
            value.relationSetCount === 0 &&
            boundedString(value.confirmationToken)
          : isSnapshotPartIdentity(value.firstPart) &&
            value.firstPart.ordinal === 0))
  )
}

async function rawRowsSpan(
  content: string,
  budget: HttpWorkBudget,
): Promise<string> {
  let objects = 0
  let arrays = 0
  let stringStart = -1
  let escaped = false
  let start = -1
  let startArrays = -1
  for (let position = 0; position < content.length; position++) {
    if (budget.shouldYield()) await budget.yield()
    const character = content[position]
    if (stringStart >= 0) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') {
        if (
          objects === 1 &&
          arrays === 0 &&
          JSON.parse(content.slice(stringStart, position + 1)) === 'rows'
        ) {
          let following = position + 1
          while (
            /\s/.test(content[following] ?? '') &&
            following < content.length
          )
            following++
          if (content[following] === ':') {
            following++
            while (
              /\s/.test(content[following] ?? '') &&
              following < content.length
            )
              following++
            if (content[following] !== '[' || start >= 0) invalid()
            start = following
            startArrays = arrays
          }
        }
        stringStart = -1
      }
      continue
    }
    if (character === '"') stringStart = position
    else if (character === '{') objects++
    else if (character === '}') objects--
    else if (character === '[') arrays++
    else if (character === ']') {
      arrays--
      if (start >= 0 && arrays === startArrays)
        return content.slice(start, position + 1)
    }
  }
  return invalid()
}

export function createSnapshotPartBatch(configuration: {
  content: string
  headers: Pick<Headers, 'get'>
  readonly descriptor: SnapshotPartsDescriptor
  readonly firstPart: SnapshotPartIdentity
  readonly budget: HttpWorkBudget
  readonly assertActive: () => void
  readonly digest: (
    content: string,
    lifecycle?: DigestLifecycle,
  ) => Promise<string>
  readonly lifecycle: DigestLifecycle
  readonly cancel: () => void
  readonly finish: () => void
  readonly now: () => number
  readonly phase: (value: HttpStage['phase']) => void
  readonly stage: (value: HttpStage) => void
}): { readonly batch: SnapshotPartBatch; release(): void } {
  let content = configuration.content
  configuration.content = ''
  const indexHeader = configuration.headers.get('X-Synloquent-Part-Index')
  if (
    !indexHeader ||
    utf8Length(indexHeader) > 16384 ||
    content.length > 1048576
  )
    invalid()
  const index: unknown = JSON.parse(indexHeader)
  if (
    !Array.isArray(index) ||
    index.length < 1 ||
    index.length > 16 ||
    !index.every(isSnapshotPartIdentity)
  )
    invalid()
  const identities = index as SnapshotPartIdentity[]
  if (
    JSON.stringify(identities[0]) !== JSON.stringify(configuration.firstPart)
  ) {
    // Property order is immaterial, all identity values are mandatory.
    if (
      Object.keys(configuration.firstPart).some(
        (field) =>
          identities[0]?.[field as keyof SnapshotPartIdentity] !==
          configuration.firstPart[field as keyof SnapshotPartIdentity],
      )
    )
      invalid()
  }
  if (
    identities.some(
      (identity, position) =>
        identity.ordinal !== configuration.firstPart.ordinal + position ||
        identity.ordinal >= configuration.descriptor.partCount,
    )
  )
    invalid()
  const nextHeader = configuration.headers.get('X-Synloquent-Next-Part')
  const confirmationToken =
    configuration.headers.get('X-Synloquent-Confirmation-Token') ?? undefined
  if (nextHeader && utf8Length(nextHeader) > 16384) invalid()
  const nextPart: unknown = nextHeader ? JSON.parse(nextHeader) : undefined
  const nextOrdinal = configuration.firstPart.ordinal + identities.length
  if (nextOrdinal < configuration.descriptor.partCount) {
    if (
      !isSnapshotPartIdentity(nextPart) ||
      nextPart.ordinal !== nextOrdinal ||
      confirmationToken !== undefined
    )
      invalid()
  } else if (nextPart !== undefined || !boundedString(confirmationToken))
    invalid()
  let released = false
  const release = () => {
    if (released) return
    released = true
    content = ''
    configuration.finish()
  }
  async function* parts(): AsyncGenerator<SnapshotTransferPart> {
    let position = 0
    let totalBytes = 0
    try {
      for (const identity of identities) {
        configuration.assertActive()
        if (released) invalid()
        const end = content.indexOf('\n', position)
        if (end < position || end - position > 65536) invalid()
        const document = content.slice(position, end)
        position = end + 1
        const byteSize = utf8Length(document)
        totalBytes += byteSize + 1
        if (byteSize !== identity.byteSize || totalBytes > 1048576) invalid()
        const hash = await configuration.digest(
          document,
          configuration.lifecycle,
        )
        configuration.assertActive()
        if (hash !== identity.hash) invalid()
        configuration.phase('jsonDecode')
        let stageStarted = configuration.now()
        configuration.budget.beginMeasurement()
        const value: unknown = await decodeHttpJson(
          document,
          configuration.budget,
        )
        configuration.stage({
          kind: 'snapshot',
          phase: 'jsonDecode',
          boundary: `immutable part ${identity.ordinal}`,
          elapsedMilliseconds: configuration.now() - stageStarted,
          maximumWorkSliceMilliseconds: configuration.budget.endMeasurement(),
        })
        configuration.phase('shapeValidation')
        stageStarted = configuration.now()
        configuration.budget.beginMeasurement()
        if (
          !isRecord(value) ||
          Object.keys(value).length !== 6 ||
          value.format !== 'canonical-parts-v1' ||
          value.ordinal !== identity.ordinal ||
          !['records', 'relationSets'].includes(String(value.section)) ||
          !integer(value.firstIndex, 500000) ||
          !integer(value.rowCount, 256) ||
          value.rowCount < 1 ||
          !Array.isArray(value.rows) ||
          value.rows.length !== value.rowCount
        )
          invalid()
        const valid = await validateHttpPayload(
          'snapshot',
          {
            ...configuration.descriptor,
            records: value.section === 'records' ? value.rows : [],
            relationSets: value.section === 'relationSets' ? value.rows : [],
          },
          configuration.budget,
        )
        if (!valid) invalid()
        configuration.stage({
          kind: 'snapshot',
          phase: 'shapeValidation',
          boundary: `immutable part ${identity.ordinal} payload`,
          elapsedMilliseconds: configuration.now() - stageStarted,
          maximumWorkSliceMilliseconds: configuration.budget.endMeasurement(),
        })
        configuration.phase('shapeValidation')
        stageStarted = configuration.now()
        configuration.budget.beginMeasurement()
        const rawRows = await rawRowsSpan(document, configuration.budget)
        configuration.assertActive()
        configuration.stage({
          kind: 'snapshot',
          phase: 'shapeValidation',
          boundary: `immutable part ${identity.ordinal} rawRows`,
          elapsedMilliseconds: configuration.now() - stageStarted,
          maximumWorkSliceMilliseconds: configuration.budget.endMeasurement(),
          responseCharacters: document.length,
        })
        yield {
          format: 'canonical-parts-v1',
          ordinal: identity.ordinal,
          section: value.section as 'records' | 'relationSets',
          firstIndex: value.firstIndex,
          rowCount: value.rowCount,
          rows: value.rows as SnapshotTransferPart['rows'],
          rawRows,
          rawDocument: document,
          hash,
          byteSize,
        }
      }
      if (position !== content.length) invalid()
    } finally {
      release()
    }
  }
  const iterator = parts()
  const ownedParts: AsyncIterableIterator<SnapshotTransferPart> = {
    next: () => iterator.next(),
    async return() {
      configuration.cancel()
      release()
      return iterator.return(undefined)
    },
    async throw(failure?: unknown) {
      configuration.cancel()
      release()
      return iterator.throw(failure)
    },
    [Symbol.asyncIterator]() {
      return this
    },
  }
  return {
    batch: {
      parts: ownedParts,
      ...(nextPart === undefined
        ? {}
        : { nextPart: nextPart as SnapshotPartIdentity }),
      ...(confirmationToken === undefined ? {} : { confirmationToken }),
    },
    release,
  }
}

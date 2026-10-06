import type { SnapshotTransferPart } from '@synloquent/client'

const maximumPartBytes = 65536
const rootFields = new Set([
  'firstIndex',
  'format',
  'ordinal',
  'rowCount',
  'rows',
  'section',
])

function malformed(message: string): never {
  throw new Error('Calibration reference wire document: ' + message)
}

function utf8Length(text: string): number {
  let bytes = 0
  for (let position = 0, length = text.length; position < length; position++) {
    const character = text.charCodeAt(position)
    const following = text.charCodeAt(position + 1)
    if (
      character >= 0xd800 &&
      character <= 0xdbff &&
      following >= 0xdc00 &&
      following <= 0xdfff
    ) {
      bytes += 4
      position++
    } else {
      bytes += character <= 0x7f ? 1 : character <= 0x7ff ? 2 : 3
    }
  }
  return bytes
}

/** Independent bounded root parser, without production acquisition machinery. */
class RootReader {
  position = 0

  constructor(readonly document: string) {}

  whitespace(): void {
    while (/[ \t\r\n]/.test(this.document[this.position] ?? '')) this.position++
  }

  expect(character: string): void {
    this.whitespace()
    if (this.document[this.position] !== character)
      malformed('Unexpected root framing.')
    this.position++
  }

  stringSpan(): readonly [number, number] {
    const beginning = this.position
    if (this.document[this.position++] !== '"')
      malformed('Root property is not a JSON string.')
    while (this.position < this.document.length) {
      const character = this.document[this.position++]
      if (character === '\\') this.position++
      else if (character === '"') return [beginning, this.position]
    }
    return malformed('A JSON string did not close.')
  }

  valueSpan(): readonly [number, number] {
    this.whitespace()
    const beginning = this.position
    const first = this.document[this.position]
    if (first === '"') return this.stringSpan()
    if (first === '{' || first === '[') {
      const closing: string[] = []
      while (this.position < this.document.length) {
        const character = this.document[this.position]
        if (character === '"') {
          this.stringSpan()
          continue
        }
        this.position++
        if (character === '{' || character === '[') {
          closing.push(character === '{' ? '}' : ']')
        } else if (character === '}' || character === ']') {
          if (closing.pop() !== character)
            malformed('Mismatched JSON container framing.')
          if (!closing.length) return [beginning, this.position]
        }
      }
      return malformed('A JSON container did not close.')
    }
    while (
      this.position < this.document.length &&
      !/[,}\s]/.test(this.document[this.position]!)
    )
      this.position++
    if (this.position === beginning) malformed('A root value is missing.')
    return [beginning, this.position]
  }
}

export interface CalibrationWirePart {
  readonly ordinal: number
  readonly section: 'records' | 'relationSets'
  readonly firstIndex: number
  readonly rowCount: number
  readonly rawDocument: string
  readonly rawRows: string
  readonly rawRowInterior: string
  readonly rows: readonly unknown[]
}

/** The caller must hash rawDocument and the complete raw catalog independently. */
export function decodeCalibrationWirePart(
  part: SnapshotTransferPart,
): CalibrationWirePart {
  if (
    part.format !== 'canonical-parts-v1' ||
    typeof part.rawDocument !== 'string' ||
    typeof part.rawRows !== 'string' ||
    part.rawDocument.length > maximumPartBytes ||
    !Number.isSafeInteger(part.byteSize) ||
    part.byteSize < 0 ||
    part.byteSize > maximumPartBytes ||
    utf8Length(part.rawDocument) !== part.byteSize ||
    !/^[a-f0-9]{64}$/.test(part.hash) ||
    !Number.isSafeInteger(part.ordinal) ||
    part.ordinal < 0 ||
    !Number.isSafeInteger(part.firstIndex) ||
    part.firstIndex < 0 ||
    !Number.isSafeInteger(part.rowCount) ||
    part.rowCount < 1 ||
    part.rowCount > 256 ||
    !Array.isArray(part.rows) ||
    part.rows.length !== part.rowCount ||
    !['records', 'relationSets'].includes(part.section)
  )
    malformed('Part geometry or the original byte count is invalid.')
  const reader = new RootReader(part.rawDocument)
  const fields = new Map<string, unknown>()
  let rowSpan: readonly [number, number] | undefined
  reader.expect('{')
  while (true) {
    reader.whitespace()
    const [beginning, ending] = reader.stringSpan()
    const key: unknown = JSON.parse(part.rawDocument.slice(beginning, ending))
    if (typeof key !== 'string' || !rootFields.has(key) || fields.has(key))
      malformed('An unknown or repeated decoded root property was supplied.')
    reader.expect(':')
    const span = reader.valueSpan()
    fields.set(key, JSON.parse(part.rawDocument.slice(span[0], span[1])))
    if (key === 'rows') rowSpan = span
    reader.whitespace()
    if (part.rawDocument[reader.position] === '}') {
      reader.position++
      break
    }
    reader.expect(',')
  }
  reader.whitespace()
  if (reader.position !== part.rawDocument.length || fields.size !== 6)
    malformed('The whole root document was not consumed exactly once.')
  const rows = fields.get('rows')
  if (
    fields.get('format') !== part.format ||
    fields.get('ordinal') !== part.ordinal ||
    fields.get('section') !== part.section ||
    fields.get('firstIndex') !== part.firstIndex ||
    fields.get('rowCount') !== part.rowCount ||
    !Array.isArray(rows) ||
    rows.length !== part.rowCount ||
    !rowSpan
  )
    malformed('Raw envelope and declared part identity disagree.')
  const rawRows = part.rawDocument.slice(rowSpan[0], rowSpan[1])
  if (rawRows !== part.rawRows || rawRows[0] !== '[' || rawRows.at(-1) !== ']')
    malformed('The raw row span differs from the declared original span.')
  return {
    ordinal: part.ordinal,
    section: part.section,
    firstIndex: part.firstIndex,
    rowCount: part.rowCount,
    rawDocument: part.rawDocument,
    rawRows,
    rawRowInterior: rawRows.slice(1, -1),
    rows,
  }
}

// Calibration-only public root-span reader for the local source adapter.
export { RootReader as CalibrationWireRootReader }

import { SynloquentError } from './errors.js'
import type {
  Attributes,
  FieldDefinition,
  Manifest,
  ModelDefinition,
  WireValue,
} from './types.js'
import type { BindValue } from './database.js'

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`
}

export function validateValue(
  field: string,
  definition: FieldDefinition,
  value: WireValue,
): WireValue {
  const fail = (): never => {
    throw new SynloquentError(
      'validation_failed',
      `Invalid ${definition.type} value for ${field}.`,
      { field, value },
    )
  }
  if (value === null) return definition.nullable ? null : fail()
  switch (definition.type) {
    case 'boolean':
      return typeof value === 'boolean' ? value : fail()
    case 'integer':
      return (typeof value === 'number' && Number.isSafeInteger(value)) ||
        (typeof value === 'string' &&
          value.length <= 1000 &&
          value !== '-0' &&
          /^-?(?:0|[1-9]\d*)$/.test(value))
        ? value
        : fail()
    case 'float':
      return typeof value === 'number' && Number.isFinite(value)
        ? value
        : fail()
    case 'decimal':
      return typeof value === 'string' &&
        /^-?\d+(\.\d+)?$/.test(value) &&
        (definition.precision === undefined ||
          (value.split('.')[1]?.length ?? 0) <= definition.precision)
        ? value
        : fail()
    case 'string':
      return typeof value === 'string' ? value : fail()
    case 'date':
      return typeof value === 'string' &&
        /^\d{4}-\d{2}-\d{2}$/.test(value) &&
        validDate(value)
        ? value
        : fail()
    case 'datetime':
      return typeof value === 'string' &&
        /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d{1,6})?Z$/.test(
          value,
        ) &&
        validDate(value.slice(0, 10)) &&
        Number.isFinite(Date.parse(value))
        ? value
        : fail()
    case 'enum':
      return typeof value === 'string' && definition.enum?.includes(value)
        ? value
        : fail()
    case 'json':
      assertWireValue(value)
      return value
  }
}
export function assertWireValue(
  value: unknown,
  depth = 0,
): asserts value is WireValue {
  if (depth > 64)
    throw new SynloquentError(
      'validation_failed',
      'JSON nesting exceeds 64 levels.',
    )
  if (value === null || typeof value === 'boolean' || typeof value === 'string')
    return
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new SynloquentError(
        'validation_failed',
        'JSON numbers must be finite.',
      )
    return
  }
  if (
    typeof value !== 'object' ||
    (!Array.isArray(value) &&
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  )
    throw new SynloquentError(
      'validation_failed',
      'JSON values must contain only ordinary objects, arrays and scalar wire values.',
    )
  for (const child of Object.values(value)) assertWireValue(child, depth + 1)
}
export function exactIntegerAggregate(
  values: readonly (WireValue | undefined)[],
  average = false,
): number | string | null {
  const included = values.filter(
    (value): value is string | number =>
      typeof value === 'string' || typeof value === 'number',
  )
  if (average && !included.length) return null
  const total = included.reduce((sum, value) => sum + BigInt(value), 0n)
  if (
    total >= BigInt(Number.MIN_SAFE_INTEGER) &&
    total <= BigInt(Number.MAX_SAFE_INTEGER)
  )
    return average ? Number(total) / included.length : Number(total)
  if (!average) return total.toString()
  const exact = exactDecimalAggregate(included.map(String), 18, true)!
  return exact.replace(/(\.[0-9]*[1-9])0+$/, '$1').replace(/\.0+$/, '')
}
function validDate(value: string): boolean {
  const date = new Date(`${value}T00:00:00Z`)
  return (
    Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === value
  )
}
export function validateAttributes(
  definition: ModelDefinition,
  attributes: Attributes,
  writable: boolean,
): Attributes {
  const validated: Attributes = {}
  for (const [field, value] of Object.entries(attributes)) {
    const fieldDefinition = definition.fields[field]
    if (!fieldDefinition)
      throw new SynloquentError('unknown_field', `Unknown field ${field}.`, {
        field,
      })
    if (writable ? !fieldDefinition.writable : !fieldDefinition.readable)
      throw new SynloquentError(
        'forbidden_field',
        `Field ${field} is not ${writable ? 'writable' : 'readable'}.`,
        { field },
      )
    validated[field] =
      writable &&
      typeof value === 'string' &&
      Object.values(definition.relations).some(
        (relation) =>
          relation.type === 'belongsTo' && relation.foreignKey === field,
      )
        ? value
        : validateValue(field, fieldDefinition, value)
  }
  return validated
}
export function storageValue(
  value: WireValue | undefined,
  definition: FieldDefinition,
): BindValue {
  if (value === undefined || value === null) return null
  if (definition.type === 'boolean') return value ? 1 : 0
  if (definition.type === 'json') return canonicalJson(value)
  if (definition.type === 'integer') return String(value)
  return value as string | number
}
export function storageType(definition: FieldDefinition): string {
  if (definition.type === 'boolean') return 'INTEGER'
  if (definition.type === 'float') return 'REAL'
  return 'TEXT'
}
export const engineCapabilities: readonly string[] = Object.freeze([
  'query.v1',
  'mutation.v1',
  'sync.v1',
  'snapshot.v1',
  'snapshot.parts.v1',
  'relationSets.v1',
  'json.scalar-array-contains.v1',
  'json.scalar-path.v1',
  'json.object-contains.remote.v1',
])
export function assertManifest(input: Manifest): Manifest {
  if (
    !input ||
    input.protocolVersion !== 1 ||
    !Number.isSafeInteger(input.schemaVersion) ||
    !input.fingerprint ||
    !Array.isArray(input.capabilities) ||
    !input.models ||
    typeof input.models !== 'object'
  )
    throw new SynloquentError('schema_mismatch', 'Malformed manifest.')
  for (const capability of input.capabilities)
    if (!engineCapabilities.includes(capability))
      throw new SynloquentError(
        'upgrade_required',
        `Manifest requires unknown engine capability ${capability}.`,
        { capability },
      )
  for (const [name, definition] of Object.entries(input.models)) {
    if (
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ||
      !definition.fields[definition.primaryKey] ||
      !definition.resource ||
      !Array.isArray(definition.operations)
    )
      throw new SynloquentError(
        'schema_mismatch',
        `Malformed model definition ${name}.`,
      )
    for (const [field, fieldDefinition] of Object.entries(definition.fields)) {
      if (
        !/^[A-Za-z][A-Za-z0-9_]*$/.test(field) ||
        ![
          'string',
          'integer',
          'float',
          'decimal',
          'boolean',
          'date',
          'datetime',
          'json',
          'enum',
        ].includes(fieldDefinition.type) ||
        typeof fieldDefinition.nullable !== 'boolean' ||
        typeof fieldDefinition.readable !== 'boolean' ||
        typeof fieldDefinition.writable !== 'boolean' ||
        (fieldDefinition.precision !== undefined &&
          (!Number.isSafeInteger(fieldDefinition.precision) ||
            fieldDefinition.precision < 0 ||
            fieldDefinition.precision > 18))
      )
        throw new SynloquentError(
          'schema_mismatch',
          `Malformed field ${name}.${field}.`,
        )
      if (
        fieldDefinition.type === 'enum' &&
        (!fieldDefinition.enum?.length ||
          new Set(fieldDefinition.enum).size !== fieldDefinition.enum.length)
      )
        throw new SynloquentError(
          'schema_mismatch',
          `Enum ${name}.${field} needs unique declared values.`,
        )
      if (fieldDefinition.default !== undefined)
        validateValue(field, fieldDefinition, fieldDefinition.default)
    }
    for (const fields of [
      ...(definition.indexes ?? []),
      ...(definition.unique ?? []),
    ])
      if (!fields.length || fields.some((field) => !definition.fields[field]))
        throw new SynloquentError(
          'schema_mismatch',
          `Index or unique constraint on ${name} references a field absent from its explicit export.`,
          { fields },
        )
    for (const [relationName, relation] of Object.entries(
      definition.relations,
    )) {
      const target = input.models[relation.model]
      if (!target && relation.type !== 'morphTo')
        throw new SynloquentError(
          'schema_mismatch',
          `Unknown relation target ${name}.${relationName}.`,
        )
      const requireField = (
        model: ModelDefinition | undefined,
        field: string | undefined,
      ): void => {
        if (field !== undefined && !model?.fields[field])
          throw new SynloquentError(
            'schema_mismatch',
            `Relation ${name}.${relationName} references an unexported field ${field}.`,
          )
      }
      requireField(definition, relation.localKey)
      requireField(target, relation.ownerKey)
      requireField(target, relation.aggregateField)
      if (relation.oneOfMany) {
        if (
          !relation.oneOfMany.length ||
          relation.oneOfMany.length > 16 ||
          relation.oneOfMany.some(
            (entry) => !['min', 'max'].includes(entry.aggregate),
          )
        )
          throw new SynloquentError(
            'schema_mismatch',
            `Malformed one-of-many sequence ${name}.${relationName}.`,
          )
        for (const entry of relation.oneOfMany)
          requireField(target, entry.field)
      }
      if (relation.type === 'belongsTo' || relation.type === 'morphTo') {
        requireField(definition, relation.foreignKey)
        requireField(definition, relation.morphType)
      } else if (relation.through) {
        const through = input.models[relation.through]
        if (!through)
          throw new SynloquentError(
            'schema_mismatch',
            `Unknown through model ${relation.through}.`,
          )
        requireField(through, relation.foreignKey)
        requireField(through, relation.secondLocalKey)
        requireField(target, relation.secondKey)
      } else if (!relation.pivot) {
        requireField(target, relation.foreignKey)
        requireField(target, relation.morphType)
      }
      for (const mapped of Object.values(relation.morphMap ?? {}))
        if (!input.models[mapped])
          throw new SynloquentError(
            'schema_mismatch',
            `Unknown mapped morph model ${mapped}.`,
          )
      if (
        relation.pivot &&
        (!relation.pivot.table ||
          relation.pivot.foreignKey === relation.pivot.relatedKey)
      )
        throw new SynloquentError(
          'schema_mismatch',
          `Malformed pivot ${name}.${relationName}.`,
        )
    }
    if (definition.timestamps)
      for (const field of Object.values(definition.timestamps))
        if (definition.fields[field]?.type !== 'datetime')
          throw new SynloquentError(
            'schema_mismatch',
            `Timestamp ${name}.${field} is not an exported datetime.`,
          )
    if (
      definition.softDeletes &&
      definition.fields[definition.softDeletes]?.type !== 'datetime'
    )
      throw new SynloquentError(
        'schema_mismatch',
        `Soft delete ${name}.${definition.softDeletes} is not an exported datetime.`,
      )
  }
  return input
}

/** Lexically sortable fixed-scale decimal representation, without floating point conversion. */
export function decimalOrder(value: WireValue, scale = 18): string {
  if (typeof value !== 'string' || !/^-?\d+(\.\d+)?$/.test(value))
    throw new SynloquentError(
      'validation_failed',
      'Expected an exact decimal string.',
    )
  const negative = value.startsWith('-')
  const [rawInteger = '0', rawFraction = ''] = value
    .replace(/^-/, '')
    .split('.')
  const integer = rawInteger.replace(/^0+(?=\d)/, '')
  if (rawFraction.length > scale || integer.length > 999)
    throw new SynloquentError(
      'validation_failed',
      'Decimal exceeds declared storage scale or 999 digit magnitude.',
    )
  const fraction = rawFraction.padEnd(scale, '0')
  const zero = /^0+$/.test(integer + fraction)
  if (!negative || zero)
    return `1${String(integer.length).padStart(3, '0')}${integer}.${fraction}`
  const complement = (digits: string): string =>
    [...digits].map((digit) => String(9 - Number(digit))).join('')
  return `0${String(999 - integer.length).padStart(3, '0')}${complement(integer)}.${complement(fraction)}`
}

export function exactDecimalAggregate(
  values: readonly WireValue[],
  scale: number,
  average: boolean,
): string | null {
  const included = values.filter((value) => value !== null)
  if (!included.length && average) return null
  const coefficient = (value: WireValue): bigint => {
    if (typeof value !== 'string')
      throw new SynloquentError(
        'validation_failed',
        'Decimal aggregation requires exact decimal strings.',
      )
    const [integer = '0', fraction = ''] = value.replace(/^-/, '').split('.')
    const magnitude = BigInt(integer + fraction.padEnd(scale, '0'))
    return value.startsWith('-') ? -magnitude : magnitude
  }
  let total = included.reduce((sum, value) => sum + coefficient(value), 0n)
  if (average) {
    const divisor = BigInt(included.length)
    const remainder = total % divisor
    total /= divisor
    if ((remainder < 0n ? -remainder : remainder) * 2n >= divisor)
      total += remainder < 0n ? -1n : 1n
  }
  const negative = total < 0n
  const digits = (negative ? -total : total).toString().padStart(scale + 1, '0')
  return `${negative ? '-' : ''}${scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits}`
}

export function integerOrder(value: WireValue): string {
  return typeof value === 'number' ||
    (typeof value === 'string' && /^-?\d+$/.test(value))
    ? decimalOrder(String(value), 0)
    : `2${String(value)}`
}

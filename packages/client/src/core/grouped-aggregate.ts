import { QueryCompiler } from './compiler.js'
import { SynloquentError } from './errors.js'
import type { TransactionExecutor } from './database.js'
import type { Storage } from './storage.js'
import type { Attributes, Predicate, QueryOptions, WireValue } from './types.js'
import {
  canonicalJson,
  decimalOrder,
  exactDecimalAggregate,
  exactIntegerAggregate,
  integerOrder,
  validateValue,
} from './values.js'

type Truth = boolean | null
interface Group {
  readonly keys: Attributes
  readonly values: WireValue[]
  count: number
}
function isWireObject(value: WireValue | undefined): value is Attributes {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Group using SQLite's authorized row selection, then reduce canonical values without SQLite float coercion. */
export async function exactGroupedAggregate(
  storage: Storage,
  options: QueryOptions,
  function_: 'count' | 'min' | 'max' | 'sum' | 'avg',
  field: string | undefined,
  executor: TransactionExecutor,
): Promise<
  readonly { readonly keys: Attributes; readonly value: WireValue }[]
> {
  const definition = storage.manifest.models[options.model]!
  const groupFields = options.groupBy ?? []
  const source = field ? definition.fields[field] : undefined
  if (function_ !== 'count' && (!field || !source?.readable))
    throw new SynloquentError(
      'unknown_field',
      'Grouped aggregation requires an exported readable field.',
    )
  if (
    (function_ === 'sum' || function_ === 'avg') &&
    source &&
    !['integer', 'decimal', 'float'].includes(source.type)
  )
    throw new SynloquentError(
      'unsupported_query',
      'Numeric aggregation requires a declared integer, decimal or float field.',
    )
  const selection = { ...options }
  delete selection.groupBy
  delete selection.having
  delete selection.aggregate
  delete selection.select
  delete selection.distinct
  delete selection.orderBy
  delete selection.offset
  delete selection.limit
  const compiler = new QueryCompiler(storage.manifest, storage.partition)
  const aggregateQuery = {
    ...options,
    aggregate: { function: function_, ...(field ? { field } : {}) },
  }
  compiler.compile(aggregateQuery)
  const compiled = compiler.compile(selection)
  const rows = await executor.execute(compiled.statement, compiled.parameters)
  const groups = new Map<string, Group>()
  for (const row of rows.rows) {
    const record = storage.row(options.model, row)
    const keys = Object.fromEntries(
      groupFields.map((name) => [name, record.attributes[name] ?? null]),
    )
    const identity = canonicalJson(keys)
    let group = groups.get(identity)
    if (!group) {
      group = { keys, values: [], count: 0 }
      groups.set(identity, group)
    }
    group.count++
    if (field) group.values.push(record.attributes[field] ?? null)
  }
  const compare = (
    selector: string,
    left: WireValue,
    right: WireValue,
  ): number => {
    if (left === right) return 0
    if (left === null) return -1
    if (right === null) return 1
    const exported = definition.fields[selector]
    const key = (value: WireValue): string | number => {
      if (
        selector === '$aggregate' &&
        (typeof value === 'string' || typeof value === 'number')
      )
        return decimalOrder(String(value), 18)
      if (exported?.type === 'integer') return integerOrder(value)
      if (exported?.type === 'decimal')
        return decimalOrder(value, exported.precision ?? 18)
      if (typeof value === 'number') return value
      if (typeof value === 'boolean') return Number(value)
      return typeof value === 'string' ? value : canonicalJson(value)
    }
    const first = key(left)
    const second = key(right)
    return first < second ? -1 : first > second ? 1 : 0
  }
  let predicateNodes = 0
  const evaluate = (
    predicate: Predicate,
    keys: Attributes,
    aggregate: WireValue,
    depth = 0,
  ): Truth => {
    if (++predicateNodes > 256 || depth > 16)
      throw new SynloquentError(
        'unsupported_query',
        'Having predicate complexity exceeds the portable bound.',
      )
    if (predicate.kind === 'group') {
      if (!predicate.predicates.length) return predicate.boolean === 'and'
      const values = predicate.predicates.map((child) =>
        evaluate(child, keys, aggregate, depth + 1),
      )
      return predicate.boolean === 'and'
        ? values.includes(false)
          ? false
          : values.includes(null)
            ? null
            : true
        : values.includes(true)
          ? true
          : values.includes(null)
            ? null
            : false
    }
    if (predicate.kind === 'not') {
      const value = evaluate(predicate.predicate, keys, aggregate, depth + 1)
      return value === null ? null : !value
    }
    if (predicate.kind === 'relation')
      throw new SynloquentError(
        'unsupported_query',
        'Having predicates must address grouped fields or the aggregate selector.',
      )
    const read = (name: string): WireValue => {
      if (name === '$aggregate') return aggregate
      if (!groupFields.includes(name))
        throw new SynloquentError(
          'unknown_field',
          `Having field ${name} is not a declared group key.`,
        )
      return keys[name] ?? null
    }
    const value = read(predicate.field)
    const other =
      predicate.kind === 'column' ? read(predicate.otherField) : predicate.value
    if (predicate.operator === 'jsonContains') {
      if (other !== null && typeof other === 'object')
        throw new SynloquentError(
          'unsupported_query',
          'Local JSON containment supports scalar array membership only.',
        )
      return Array.isArray(value) && value.some((member) => member === other)
    }
    if (predicate.operator === 'jsonPath') {
      if (
        !isWireObject(other) ||
        typeof other.path !== 'string' ||
        !/^\$(\.[A-Za-z_][A-Za-z0-9_]*|\[\d+\])+$/.test(other.path) ||
        !('value' in other) ||
        (other.value !== null && typeof other.value === 'object')
      )
        throw new SynloquentError(
          'unsupported_query',
          'JSON path requires a declared bounded scalar path and scalar value.',
        )
      let selected: WireValue | undefined = value
      for (const segment of other.path
        .slice(1)
        .match(/\.[A-Za-z_][A-Za-z0-9_]*|\[\d+\]/g) ?? []) {
        if (segment.startsWith('['))
          selected = Array.isArray(selected)
            ? selected[Number(segment.slice(1, -1))]
            : undefined
        else
          selected = isWireObject(selected)
            ? selected[segment.slice(1)]
            : undefined
      }
      return selected !== undefined && selected === other.value
    }
    if (predicate.operator === 'isNull') return value === null
    if (predicate.operator === 'isNotNull') return value !== null
    if (other === null)
      return predicate.operator === '!=' ? value !== null : value === null
    if (value === null) return null
    if (other === undefined)
      throw new SynloquentError(
        'validation_failed',
        'Having comparison needs a wire value.',
      )
    const validate = (input: WireValue): void => {
      if (predicate.field === '$aggregate') {
        if (
          (typeof input !== 'string' && typeof input !== 'number') ||
          !/^-?\d+(\.\d+)?$/.test(String(input))
        )
          throw new SynloquentError(
            'validation_failed',
            'Aggregate comparison requires an exact numeric value.',
          )
      } else
        validateValue(
          predicate.field,
          definition.fields[predicate.field]!,
          input,
        )
    }
    if (['in', 'notIn', 'between', 'notBetween'].includes(predicate.operator)) {
      if (!Array.isArray(other))
        throw new SynloquentError(
          'validation_failed',
          'Having membership or range comparison requires an array.',
        )
      for (const input of other) if (input !== null) validate(input)
      if (predicate.operator === 'in' || predicate.operator === 'notIn') {
        const found = other.some(
          (input) =>
            input !== null && compare(predicate.field, value, input) === 0,
        )
        const result = found ? true : other.includes(null) ? null : false
        return predicate.operator === 'in' || result === null ? result : !result
      }
      if (other.length !== 2)
        throw new SynloquentError(
          'validation_failed',
          'Having range requires two values.',
        )
      if (other[0] === null || other[1] === null) return null
      const found =
        compare(predicate.field, value, other[0]!) >= 0 &&
        compare(predicate.field, value, other[1]!) <= 0
      return predicate.operator === 'between' ? found : !found
    }
    if (predicate.operator === 'like') {
      if (typeof value !== 'string' || typeof other !== 'string')
        throw new SynloquentError(
          'validation_failed',
          'Having LIKE requires string operands.',
        )
      let pattern = '^'
      const escape = (character: string): string =>
        character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      for (let position = 0; position < other.length; position++) {
        const character = other[position]!
        if (character === '\\') {
          const escaped = other[++position]
          if (escaped === undefined)
            throw new SynloquentError(
              'validation_failed',
              'LIKE cannot end with an incomplete escape.',
            )
          pattern += escape(escaped)
        } else
          pattern +=
            character === '%'
              ? '[\\s\\S]*'
              : character === '_'
                ? '[\\s\\S]'
                : escape(character)
      }
      return new RegExp(pattern + '$', 'u').test(value)
    }
    validate(other)
    const ordering = compare(predicate.field, value, other)
    return predicate.operator === '='
      ? ordering === 0
      : predicate.operator === '!='
        ? ordering !== 0
        : predicate.operator === '<'
          ? ordering < 0
          : predicate.operator === '<='
            ? ordering <= 0
            : predicate.operator === '>'
              ? ordering > 0
              : predicate.operator === '>='
                ? ordering >= 0
                : false
  }
  const reduce = (group: Group): WireValue => {
    if (function_ === 'count')
      return field
        ? group.values.filter((value) => value !== null).length
        : group.count
    const values = group.values.filter((value) => value !== null)
    if (!values.length) return null
    if (function_ === 'sum' || function_ === 'avg') {
      if (source?.type === 'integer')
        return exactIntegerAggregate(values, function_ === 'avg')
      if (source?.type === 'decimal')
        return exactDecimalAggregate(
          values,
          source.precision ?? 18,
          function_ === 'avg',
        )
      if (!values.length) return function_ === 'avg' ? null : 0
      const total = values.reduce<number>(
        (sum, value) => sum + Number(value),
        0,
      )
      if (!Number.isFinite(total))
        throw new SynloquentError(
          'validation_failed',
          'Grouped floating point aggregate exceeds finite wire range.',
        )
      return function_ === 'avg' ? total / values.length : total
    }
    if (!values.length) return null
    return values.reduce((result, value) =>
      compare(field!, value, result) < 0 === (function_ === 'min')
        ? value
        : result,
    )
  }
  let result = [...groups.values()].map((group) => ({
    keys: group.keys,
    value: reduce(group),
  }))
  if (options.having)
    result = result.filter((group) => {
      predicateNodes = 0
      return evaluate(options.having!, group.keys, group.value) === true
    })
  const ordering = [...(options.orderBy ?? [])]
  for (const groupField of groupFields)
    if (!ordering.some((order) => order.field === groupField))
      ordering.push({ field: groupField, direction: 'asc' })
  for (const order of ordering)
    if (!groupFields.includes(order.field))
      throw new SynloquentError(
        'unknown_field',
        `Grouped ordering field ${order.field} is not a declared group key.`,
      )
  result.sort((left, right) => {
    for (const order of ordering) {
      const compared = compare(
        order.field,
        left.keys[order.field] ?? null,
        right.keys[order.field] ?? null,
      )
      if (compared) return order.direction === 'desc' ? -compared : compared
    }
    return 0
  })
  return result.slice(
    options.offset ?? 0,
    options.limit === undefined
      ? undefined
      : (options.offset ?? 0) + options.limit,
  )
}

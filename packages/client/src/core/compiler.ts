import { quoteIdentifier, type BindValue } from './database.js'
import { SynloquentError, unsupported } from './errors.js'
import type {
  Manifest,
  ModelDefinition,
  Predicate,
  QueryOptions,
  RelationDefinition,
  WireValue,
} from './types.js'
import {
  decimalOrder,
  integerOrder,
  storageValue,
  validateValue,
} from './values.js'

export interface CompiledQuery {
  readonly statement: string
  readonly parameters: readonly BindValue[]
  readonly dependencies: ReadonlySet<string>
}
export function resourceTable(model: string): string {
  return `syn_model_${model}`
}
export function pivotTable(table: string): string {
  return `syn_pivot_${table}`
}
export class QueryCompiler {
  private parameters: BindValue[] = []
  private dependencies = new Set<string>()
  private aliasCounter = 0
  private targetIdentity: string | undefined
  private queryDepth = 0
  constructor(
    private readonly manifest: Manifest,
    private readonly partition: string,
  ) {}

  compile(options: QueryOptions, localIdentity?: string): CompiledQuery {
    this.parameters = []
    this.dependencies = new Set<string>()
    this.targetIdentity = localIdentity
    this.aliasCounter = 0
    this.queryDepth = 0
    if (options.scopes?.length) return unsupported('registered scope')
    const statement = this.select(options, 'resource')
    return {
      statement,
      parameters: this.parameters,
      dependencies: this.dependencies,
    }
  }

  compileRelation(
    model: string,
    relationName: string,
    identities: readonly string[],
    options: QueryOptions,
  ): CompiledQuery {
    this.parameters = []
    this.dependencies = new Set<string>()
    const definition = this.definition(model)
    const relation = definition.relations[relationName]
    if (!relation)
      throw new SynloquentError(
        'unknown_relation',
        `Unknown relation ${relationName}.`,
      )
    const join = this.relationJoin(model, relation, 'parent', 'related')
    const conditions = [
      `parent._partition = ${this.bind(this.partition)}`,
      `parent._visible = 1`,
      `parent._deleted = 0`,
      `parent._local_identity IN (${identities.map((identity) => this.bind(identity)).join(',')})`,
      join.condition,
    ]
    if (options.where)
      conditions.push(
        this.predicate(relation.model, options.where, 'related', 0),
      )
    const related = this.definition(relation.model)
    const winner = this.oneOfManyWinner(model, relation, 'parent', 'related')
    if (winner) conditions.push(winner)
    if (related.softDeletes && options.trashed !== 'include')
      conditions.push(
        `${this.field(relation.model, related.softDeletes, 'related')} IS ${options.trashed === 'only' ? 'NOT ' : ''}NULL`,
      )
    const ordering = [...(options.orderBy ?? [])]
    if (!ordering.length && relation.oneOfMany?.length)
      for (const aggregate of relation.oneOfMany)
        ordering.push({
          field: aggregate.field,
          direction: aggregate.aggregate === 'min' ? 'asc' : 'desc',
        })
    if (relation.aggregateField && !ordering.length)
      ordering.push({
        field: relation.aggregateField,
        direction:
          relation.aggregate === 'min' || relation.type === 'oldestOfMany'
            ? 'asc'
            : 'desc',
      })
    ordering.push({
      field: related.primaryKey,
      direction:
        relation.aggregate === 'max' || relation.type === 'latestOfMany'
          ? 'desc'
          : 'asc',
    })
    const statement = `SELECT parent._local_identity AS _parent_identity, related.* FROM ${quoteIdentifier(resourceTable(model))} AS parent CROSS JOIN ${join.from} WHERE ${conditions.join(' AND ')} ORDER BY ${ordering.map((order) => `${this.field(relation.model, order.field, 'related', true)} ${order.direction.toUpperCase()}`).join(', ')}`
    return {
      statement,
      parameters: this.parameters,
      dependencies: this.dependencies,
    }
  }
  private definition(model: string): ModelDefinition {
    const definition = this.manifest.models[model]
    if (!definition)
      throw new SynloquentError('unknown_model', `Unknown model ${model}.`)
    this.dependencies.add(model)
    return definition
  }
  private bind(value: BindValue): string {
    if (this.parameters.length >= 30000)
      throw new SynloquentError(
        'unsupported_query',
        'Query parameter count exceeds the portable bound.',
      )
    this.parameters.push(value)
    return `?${this.parameters.length}`
  }
  private field(
    model: string,
    field: string,
    alias: string,
    ordered = false,
  ): string {
    if (field === '$aggregate' && alias === 'aggregate')
      return 'aggregate_value'
    const definition = this.definition(model).fields[field]
    if (!definition)
      throw new SynloquentError(
        'unknown_field',
        `Unknown field ${model}.${field}.`,
      )
    if (!definition.readable)
      throw new SynloquentError(
        'forbidden_field',
        `Field ${model}.${field} is not readable.`,
      )
    return `${quoteIdentifier(alias)}.${quoteIdentifier(ordered && (definition.type === 'decimal' || definition.type === 'integer') ? `_order_${field}` : field)}`
  }
  private comparisonValue(
    model: string,
    field: string,
    value: WireValue | undefined,
    ordered: boolean,
  ): BindValue {
    if (field === '$aggregate') {
      if (
        (typeof value !== 'number' || !Number.isFinite(value)) &&
        (typeof value !== 'string' || !/^-?\d+(\.\d+)?$/.test(value))
      )
        throw new SynloquentError(
          'unsupported_query',
          'Aggregate comparison needs a finite number or an exact numeric string.',
        )
      return value
    }
    const definition = this.definition(model).fields[field]
    if (!definition)
      throw new SynloquentError(
        'unknown_field',
        `Unknown field ${model}.${field}.`,
      )
    if (value === undefined)
      throw new SynloquentError(
        'unsupported_query',
        `Missing comparison value for ${field}.`,
      )
    if (value === null) return null
    if (!(
      field === this.definition(model).primaryKey && typeof value === 'string'
    ))
      validateValue(field, definition, value)
    return ordered && definition.type === 'decimal'
      ? decimalOrder(value, definition.precision ?? 18)
      : ordered && definition.type === 'integer'
        ? integerOrder(value)
        : storageValue(value, definition)
  }
  private select(
    options: QueryOptions,
    alias: string,
    extraConditions: readonly string[] = [],
    scalar = false,
  ): string {
    if (++this.queryDepth > 16)
      throw new SynloquentError(
        'unsupported_query',
        'Subquery depth exceeds 16.',
      )
    if (options.unions?.length) {
      if (options.unions.length > 16)
        throw new SynloquentError(
          'unsupported_query',
          'Union branch count exceeds 16.',
        )
      const { unions, limit, offset, ...base } = options
      let statement = `SELECT * FROM (${this.select(base, alias, extraConditions, scalar)})`
      for (const union of unions) {
        if (
          union.query.model !== options.model ||
          JSON.stringify(union.query.select ?? null) !==
            JSON.stringify(options.select ?? null)
        )
          throw new SynloquentError(
            'unsupported_query',
            'Union branches require the same resource and projection.',
          )
        statement += ` UNION${union.all ? ' ALL' : ''} SELECT * FROM (${this.select(union.query, `union_${this.aliasCounter++}`, [], scalar)})`
      }
      const definition = this.definition(options.model)
      const ordering = [...(options.orderBy ?? [])]
      if (!ordering.some((order) => order.field === definition.primaryKey))
        ordering.push({ field: definition.primaryKey, direction: 'asc' })
      statement += ` ORDER BY ${ordering.map((order) => `${quoteIdentifier(definition.fields[order.field]?.type === 'integer' || definition.fields[order.field]?.type === 'decimal' ? `_order_${order.field}` : order.field)} ${order.direction.toUpperCase()}`).join(', ')}, _local_identity ASC`
      if (limit !== undefined) statement += ` LIMIT ${this.bind(limit)}`
      else if (offset !== undefined) statement += ' LIMIT -1'
      if (offset !== undefined) statement += ` OFFSET ${this.bind(offset)}`
      this.queryDepth -= 1
      return statement
    }
    const definition = this.definition(options.model)
    if (
      options.aggregate &&
      !['count', 'sum', 'min', 'max', 'avg'].includes(
        options.aggregate.function,
      )
    )
      throw new SynloquentError(
        'unsupported_query',
        'Aggregate function is outside the portable allowlist.',
      )
    if (
      options.limit !== undefined &&
      (!Number.isSafeInteger(options.limit) ||
        options.limit < 0 ||
        options.limit > 100000)
    )
      throw new SynloquentError('unsupported_query', 'Invalid query limit.')
    if (
      options.offset !== undefined &&
      (!Number.isSafeInteger(options.offset) || options.offset < 0)
    )
      throw new SynloquentError('unsupported_query', 'Invalid query offset.')
    const fields =
      options.select ??
      Object.keys(definition.fields).filter(
        (field) => definition.fields[field]?.readable,
      )
    fields.forEach((field) => this.field(options.model, field, alias))
    let selected = options.aggregate
      ? `${options.aggregate.function.toUpperCase()}(${options.aggregate.field ? this.field(options.model, options.aggregate.field, alias) : '*'}) AS aggregate_value${options.groupBy?.length ? `, ${options.groupBy.map((field) => `${this.field(options.model, field, alias)} AS ${quoteIdentifier(field)}`).join(', ')}` : ''}`
      : scalar
        ? fields
            .map((field) => this.field(options.model, field, alias))
            .join(', ')
        : `${quoteIdentifier(alias)}.*`
    const predicates = [
      `${quoteIdentifier(alias)}._partition = ${this.bind(this.partition)}`,
      `${quoteIdentifier(alias)}._visible = 1`,
      `${quoteIdentifier(alias)}._deleted = 0`,
    ]
    predicates.push(...extraConditions)
    if (this.targetIdentity && alias === 'resource')
      predicates.push(
        `${quoteIdentifier(alias)}._local_identity = ${this.bind(this.targetIdentity)}`,
      )
    if (definition.softDeletes && options.trashed !== 'include')
      predicates.push(
        `${this.field(options.model, definition.softDeletes, alias)} IS ${options.trashed === 'only' ? 'NOT ' : ''}NULL`,
      )
    let from = `${quoteIdentifier(resourceTable(options.model))} AS ${quoteIdentifier(alias)}`
    const joins = new Map<string, string>()
    if ((options.joins?.length ?? 0) > 16)
      throw new SynloquentError('unsupported_query', 'Join count exceeds 16.')
    for (const join of options.joins ?? []) {
      if (
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(join.alias) ||
        joins.has(join.alias) ||
        join.alias === alias ||
        !join.on.length ||
        join.on.length > 16
      )
        throw new SynloquentError(
          'unsupported_query',
          'Invalid declared join alias or conditions.',
        )
      this.definition(join.model)
      joins.set(join.alias, join.model)
      const conditions = join.on.map(
        (condition) =>
          `${this.field(options.model, condition.field, alias)} = ${this.field(join.model, condition.otherField, join.alias)}`,
      )
      conditions.push(
        `${quoteIdentifier(join.alias)}._partition = ${quoteIdentifier(alias)}._partition`,
        `${quoteIdentifier(join.alias)}._visible = 1`,
        `${quoteIdentifier(join.alias)}._deleted = 0`,
      )
      const joinedSoftDeletes = this.definition(join.model).softDeletes
      if (joinedSoftDeletes)
        conditions.push(
          `${this.field(join.model, joinedSoftDeletes, join.alias)} IS NULL`,
        )
      from += ` ${join.type === 'left' ? 'LEFT' : 'INNER'} JOIN ${quoteIdentifier(resourceTable(join.model))} AS ${quoteIdentifier(join.alias)} ON ${conditions.join(' AND ')}`
    }
    for (const joined of options.joinedWhere ?? []) {
      const model = joins.get(joined.alias)
      if (!model)
        throw new SynloquentError(
          'unsupported_query',
          'Predicate references an undeclared join alias.',
        )
      predicates.push(this.predicate(model, joined.predicate, joined.alias, 0))
    }
    if ((options.subqueries?.length ?? 0) > 16)
      throw new SynloquentError(
        'unsupported_query',
        'Subquery count exceeds 16.',
      )
    for (const subquery of options.subqueries ?? []) {
      const innerAlias = `subquery_${this.aliasCounter++}`
      const correlation = (subquery.correlate ?? []).map(
        (condition) =>
          `${this.field(subquery.query.model, condition.innerField, innerAlias)} = ${this.field(options.model, condition.outerField, alias)}`,
      )
      if (subquery.kind === 'select' || subquery.kind === 'where') {
        if (
          (!subquery.query.aggregate && subquery.query.select?.length !== 1) ||
          (subquery.query.limit ?? 1) > 1
        )
          throw new SynloquentError(
            'unsupported_query',
            'A scalar subquery needs one selected field or aggregate and at most one row.',
          )
      }
      const inner = this.select(
        {
          ...subquery.query,
          ...(subquery.kind === 'select' || subquery.kind === 'where'
            ? { limit: 1 }
            : {}),
        },
        innerAlias,
        correlation,
        subquery.kind === 'select' || subquery.kind === 'where',
      )
      if (subquery.kind === 'select') {
        if (!subquery.alias)
          throw new SynloquentError(
            'unsupported_query',
            'A selected subquery requires an alias.',
          )
        selected += `, (${inner}) AS ${quoteIdentifier(`_projection_${subquery.alias}`)}`
      } else if (subquery.kind === 'exists' || subquery.kind === 'notExists')
        predicates.push(
          `${subquery.kind === 'notExists' ? 'NOT ' : ''}EXISTS (${inner})`,
        )
      else {
        if (!subquery.field)
          throw new SynloquentError(
            'unsupported_query',
            'A where subquery requires an outer field.',
          )
        predicates.push(
          `${this.field(options.model, subquery.field, alias)} ${this.operator(subquery.operator ?? '=')} (${inner})`,
        )
      }
    }
    if (options.where)
      predicates.push(this.predicate(options.model, options.where, alias, 0))
    let statement = `SELECT ${selected} FROM ${from} WHERE ${predicates.join(' AND ')}`
    if (options.distinct && !options.aggregate)
      statement = `SELECT ${quoteIdentifier(alias)}.* FROM (SELECT ${selected}, ROW_NUMBER() OVER(PARTITION BY ${fields.map((field) => this.field(options.model, field, alias)).join(', ')} ORDER BY ${this.field(options.model, definition.primaryKey, alias, true)} ASC, ${quoteIdentifier(alias)}._local_identity) AS _distinct_row FROM ${from} WHERE ${predicates.join(' AND ')}) AS ${quoteIdentifier(alias)} WHERE ${quoteIdentifier(alias)}._distinct_row = 1`
    if (options.groupBy?.length)
      statement += ` GROUP BY ${options.groupBy.map((field) => this.field(options.model, field, alias)).join(', ')}`
    if (options.having)
      statement += ` HAVING ${this.predicate(options.model, options.having, 'aggregate', 0)}`
    if (!options.aggregate) {
      const ordering = [...(options.orderBy ?? [])]
      if (!ordering.some((order) => order.field === definition.primaryKey))
        ordering.push({ field: definition.primaryKey, direction: 'asc' })
      statement += ` ORDER BY ${ordering.map((order) => `${this.field(options.model, order.field, alias, true)} ${order.direction === 'desc' ? 'DESC' : 'ASC'}`).join(', ')}, ${quoteIdentifier(alias)}._local_identity ASC`
    }
    if (options.limit !== undefined)
      statement += ` LIMIT ${this.bind(options.limit)}`
    else if (options.offset !== undefined) statement += ' LIMIT -1'
    if (options.offset !== undefined)
      statement += ` OFFSET ${this.bind(options.offset)}`
    this.queryDepth -= 1
    return statement
  }
  private predicate(
    model: string,
    predicate: Predicate,
    alias: string,
    depth: number,
  ): string {
    if (depth > 16)
      throw new SynloquentError(
        'unsupported_query',
        'Predicate depth exceeds 16.',
      )
    if (predicate.kind === 'group') {
      if (predicate.predicates.length > 100)
        throw new SynloquentError(
          'unsupported_query',
          'Predicate group exceeds 100 terms.',
        )
      if (!predicate.predicates.length)
        return predicate.boolean === 'and' ? '1' : '0'
      return `(${predicate.predicates.map((child) => this.predicate(model, child, alias, depth + 1)).join(predicate.boolean === 'and' ? ' AND ' : ' OR ')})`
    }
    if (predicate.kind === 'not')
      return `(NOT ${this.predicate(model, predicate.predicate, alias, depth + 1)})`
    if (predicate.kind === 'column')
      return `${this.field(model, predicate.field, alias, true)} ${this.operator(predicate.operator)} ${this.field(model, predicate.otherField, alias, true)}`
    if (predicate.kind === 'relation')
      return this.relationPredicate(model, predicate, alias, depth + 1)
    const ordered = [
      '<',
      '<=',
      '>',
      '>=',
      'between',
      'notBetween',
      '=',
      '!=',
      'in',
      'notIn',
    ].includes(predicate.operator)
    const field = this.field(model, predicate.field, alias, ordered)
    if (predicate.operator === 'isNull' || predicate.operator === 'isNotNull')
      return `${field} IS ${predicate.operator === 'isNotNull' ? 'NOT ' : ''}NULL`
    if (
      predicate.value === null &&
      predicate.operator !== 'jsonContains' &&
      predicate.operator !== 'jsonPath'
    )
      return `${field} IS ${predicate.operator === '!=' ? 'NOT ' : ''}NULL`
    if (predicate.operator === 'like') {
      const value = this.comparisonValue(
        model,
        predicate.field,
        predicate.value,
        false,
      )
      if (typeof value !== 'string')
        throw new SynloquentError(
          'unsupported_query',
          'Portable LIKE requires a string pattern.',
        )
      let pattern = ''
      const literal = (character: string): string =>
        character === '*'
          ? '[*]'
          : character === '?'
            ? '[?]'
            : character === '['
              ? '[[]'
              : character
      for (let position = 0; position < value.length; position++) {
        const character = value[position]!
        if (character === '\\') {
          const escaped = value[++position]
          if (escaped === undefined)
            throw new SynloquentError(
              'validation_failed',
              'LIKE pattern ends with an incomplete escape.',
            )
          pattern += literal(escaped)
        } else
          pattern +=
            character === '%'
              ? '*'
              : character === '_'
                ? '?'
                : literal(character)
      }
      return `${field} GLOB ${this.bind(pattern)}`
    }
    if (predicate.operator === 'in' || predicate.operator === 'notIn') {
      if (!Array.isArray(predicate.value) || predicate.value.length > 1000)
        throw new SynloquentError(
          'unsupported_query',
          'IN requires a bounded array.',
        )
      if (!predicate.value.length)
        return predicate.operator === 'in' ? '0' : '1'
      return `${field} ${predicate.operator === 'notIn' ? 'NOT ' : ''}IN (${predicate.value.map((value) => this.bind(this.comparisonValue(model, predicate.field, value, ordered))).join(', ')})`
    }
    if (
      predicate.operator === 'between' ||
      predicate.operator === 'notBetween'
    ) {
      if (!Array.isArray(predicate.value) || predicate.value.length !== 2)
        throw new SynloquentError(
          'unsupported_query',
          'BETWEEN requires exactly two values.',
        )
      return `${field} ${predicate.operator === 'notBetween' ? 'NOT ' : ''}BETWEEN ${this.bind(this.comparisonValue(model, predicate.field, predicate.value[0], ordered))} AND ${this.bind(this.comparisonValue(model, predicate.field, predicate.value[1], ordered))}`
    }
    if (
      predicate.operator === 'jsonContains' ||
      predicate.operator === 'jsonPath'
    ) {
      if (this.definition(model).fields[predicate.field]?.type !== 'json')
        throw new SynloquentError(
          'unsupported_query',
          'JSON predicates require a declared JSON field.',
        )
      const primitive = (
        value: WireValue | undefined,
      ): { value: BindValue; type: string | undefined } => {
        if (value === undefined || (value && typeof value === 'object'))
          throw new SynloquentError(
            'unsupported_query',
            'Portable JSON predicates accept scalar values only.',
          )
        return {
          value:
            value === null
              ? null
              : typeof value === 'boolean'
                ? Number(value)
                : value,
          type:
            value === null
              ? 'null'
              : typeof value === 'boolean'
                ? value
                  ? 'true'
                  : 'false'
                : typeof value === 'string'
                  ? 'text'
                  : undefined,
        }
      }
      if (predicate.operator === 'jsonContains') {
        const value = primitive(predicate.value)
        const type = value.type
          ? ` AND json_member.type = ${this.bind(value.type)}`
          : " AND json_member.type IN ('integer','real')"
        return `(json_type(${field}) = 'array' AND EXISTS (SELECT 1 FROM json_each(${field}) AS json_member WHERE json_member.value IS ${this.bind(value.value)}${type}))`
      }
      if (
        !predicate.value ||
        typeof predicate.value !== 'object' ||
        !('path' in predicate.value) ||
        typeof predicate.value.path !== 'string' ||
        !/^\$(\.[A-Za-z_][A-Za-z0-9_]*|\[\d+\])+$/.test(predicate.value.path)
      )
        throw new SynloquentError(
          'unsupported_query',
          'JSON path requires a declared bounded scalar path.',
        )
      const value = primitive(
        'value' in predicate.value ? predicate.value.value : undefined,
      )
      const type = value.type
        ? ` AND json_type(${field}, ${this.bind(predicate.value.path)}) = ${this.bind(value.type)}`
        : ''
      return `(json_extract(${field}, ${this.bind(predicate.value.path)}) IS ${this.bind(value.value)}${type})`
    }
    return `${field} ${this.operator(predicate.operator)} ${this.bind(this.comparisonValue(model, predicate.field, predicate.value, ordered))}`
  }
  private operator(operator: string): string {
    const operators: Readonly<Record<string, string>> = {
      '=': '=',
      '!=': '!=',
      '<': '<',
      '<=': '<=',
      '>': '>',
      '>=': '>=',
      like: 'LIKE',
    }
    const compiled = operators[operator]
    if (!compiled)
      throw new SynloquentError(
        'unsupported_query',
        `Unknown operator ${operator}.`,
      )
    return compiled
  }
  relationJoin(
    model: string,
    relation: RelationDefinition,
    parentAlias: string,
    relatedAlias: string,
  ): { from: string; condition: string } {
    const parent = this.definition(model)
    const related = this.definition(relation.model)
    const parentField = (field: string, ordered = true): string =>
      this.field(model, field, parentAlias, ordered)
    const relatedField = (field: string, ordered = true): string =>
      this.field(relation.model, field, relatedAlias, ordered)
    let target = `${quoteIdentifier(resourceTable(relation.model))} AS ${quoteIdentifier(relatedAlias)}`
    const partition = `${quoteIdentifier(relatedAlias)}._partition = ${quoteIdentifier(parentAlias)}._partition AND ${quoteIdentifier(relatedAlias)}._visible = 1 AND ${quoteIdentifier(relatedAlias)}._deleted = 0`
    const foreignKey = relation.foreignKey ?? `${model.toLowerCase()}_id`
    if (relation.type === 'belongsTo')
      return {
        from: target,
        condition: `${relatedField(relation.ownerKey ?? related.primaryKey)} = ${parentField(foreignKey)} AND ${partition}`,
      }
    if (
      [
        'hasOne',
        'hasMany',
        'ofMany',
        'latestOfMany',
        'oldestOfMany',
        'morphOne',
        'morphMany',
      ].includes(relation.type)
    ) {
      const equalities = [
        foreignKey,
        ...(relation.morphType ? [relation.morphType] : []),
      ]
      const unique = (related.unique ?? []).findIndex(
        (fields) =>
          !fields.includes(related.primaryKey) &&
          fields.length > 0 &&
          equalities.includes(fields[0]!),
      )
      if (unique >= 0)
        target += ` INDEXED BY ${quoteIdentifier(`syn_unique_${relation.model}_${unique}`)}`
      else {
        const index = (related.indexes ?? []).findIndex(
          (fields) => fields.length > 0 && equalities.includes(fields[0]!),
        )
        if (index >= 0) {
          const fields = related.indexes![index]!
          const ordered = fields.some((field) =>
            ['integer', 'decimal'].includes(related.fields[field]!.type),
          )
          if (ordered || !fields.includes(related.primaryKey))
            target += ` INDEXED BY ${quoteIdentifier(`${ordered ? 'syn_ordered_index' : 'syn_index'}_${relation.model}_${index}`)}`
        }
      }
      let condition = `${relatedField(foreignKey)} = ${parentField(relation.localKey ?? parent.primaryKey)} AND ${partition}`
      if (relation.type.startsWith('morph')) {
        if (!relation.morphType || !relation.morphMap)
          throw new SynloquentError(
            'schema_mismatch',
            'Morph relation requires explicit type and map.',
          )
        const morphName = Object.entries(relation.morphMap).find(
          ([, targetModel]) => targetModel === model,
        )?.[0]
        if (!morphName)
          throw new SynloquentError(
            'schema_mismatch',
            `Missing morph map for ${model}.`,
          )
        condition += ` AND ${relatedField(relation.morphType)} = ${this.bind(morphName)}`
      }
      return { from: target, condition }
    }
    if (
      relation.type === 'belongsToMany' ||
      relation.type === 'morphToMany' ||
      relation.type === 'morphedByMany'
    ) {
      if (!relation.pivot)
        throw new SynloquentError(
          'schema_mismatch',
          'Many-to-many relation requires pivot metadata.',
        )
      const pivotAlias = `pivot_${this.aliasCounter++}`
      this.dependencies.add(`pivot:${relation.pivot.table}`)
      let condition = `${quoteIdentifier(pivotAlias)}.${quoteIdentifier(relation.pivot.foreignKey)} = ${parentField(relation.localKey ?? parent.primaryKey, false)} AND ${quoteIdentifier(pivotAlias)}._partition = ${quoteIdentifier(parentAlias)}._partition AND ${partition}`
      if (relation.morphType) {
        const morphName = Object.entries(relation.morphMap ?? {}).find(
          ([, targetModel]) =>
            targetModel ===
            (relation.type === 'morphedByMany' ? relation.model : model),
        )?.[0]
        if (!morphName)
          throw new SynloquentError(
            'schema_mismatch',
            'Missing pivot morph map.',
          )
        condition += ` AND ${quoteIdentifier(pivotAlias)}.${quoteIdentifier(relation.morphType)} = ${this.bind(morphName)}`
      }
      return {
        from: `${quoteIdentifier(pivotTable(relation.pivot.table))} AS ${quoteIdentifier(pivotAlias)} CROSS JOIN ${target} ON ${quoteIdentifier(pivotAlias)}.${quoteIdentifier(relation.pivot.relatedKey)} = ${relatedField(relation.ownerKey ?? related.primaryKey, false)}`,
        condition,
      }
    }
    if (
      relation.type === 'hasOneThrough' ||
      relation.type === 'hasManyThrough'
    ) {
      if (!relation.through || !relation.secondKey)
        throw new SynloquentError(
          'schema_mismatch',
          'Through relation requires through model and second key.',
        )
      const through = this.definition(relation.through)
      const throughAlias = `through_${this.aliasCounter++}`
      return {
        from: `${target} JOIN ${quoteIdentifier(resourceTable(relation.through))} AS ${quoteIdentifier(throughAlias)} ON ${relatedField(relation.secondKey)} = ${this.field(relation.through, relation.secondLocalKey ?? through.primaryKey, throughAlias, true)}`,
        condition: `${this.field(relation.through, foreignKey, throughAlias, true)} = ${parentField(relation.localKey ?? parent.primaryKey)} AND ${quoteIdentifier(throughAlias)}._partition = ${quoteIdentifier(parentAlias)}._partition AND ${quoteIdentifier(throughAlias)}._visible = 1 AND ${quoteIdentifier(throughAlias)}._deleted = 0 AND ${partition}`,
      }
    }
    return unsupported(relation.type)
  }
  private relationPredicate(
    model: string,
    predicate: Extract<Predicate, { kind: 'relation' }>,
    alias: string,
    depth: number,
  ): string {
    const relation = this.definition(model).relations[predicate.relation]
    if (!relation)
      throw new SynloquentError(
        'unknown_relation',
        `Unknown relation ${model}.${predicate.relation}.`,
      )
    if (relation.type === 'morphTo') {
      if (!relation.morphMap || !relation.foreignKey || !relation.morphType)
        throw new SynloquentError(
          'schema_mismatch',
          'Morph predicate requires an explicit map and identity fields.',
        )
      const models = predicate.morphModels ?? [
        ...new Set(Object.values(relation.morphMap)),
      ]
      if (
        !models.length ||
        models.length > 32 ||
        new Set(models).size !== models.length ||
        models.some(
          (target) => !Object.values(relation.morphMap!).includes(target),
        )
      )
        throw new SynloquentError(
          'unknown_relation',
          'Morph predicate target is outside the exported morph map.',
        )
      const counts = models.map((targetModel) => {
        const target = this.definition(targetModel)
        const targetAlias = `morph_${this.aliasCounter++}`
        const names = Object.entries(relation.morphMap!)
          .filter(([, target]) => target === targetModel)
          .map(([name]) => name)
        const conditions = [
          `${quoteIdentifier(targetAlias)}._partition = ${quoteIdentifier(alias)}._partition`,
          `${quoteIdentifier(targetAlias)}._visible = 1`,
          `${quoteIdentifier(targetAlias)}._deleted = 0`,
          `${this.field(targetModel, relation.ownerKey ?? target.primaryKey, targetAlias, true)} = ${this.field(model, relation.foreignKey!, alias, true)}`,
          `${this.field(model, relation.morphType!, alias)} IN (${names.map((name) => this.bind(name)).join(', ')})`,
        ]
        if (target.softDeletes)
          conditions.push(
            `${this.field(targetModel, target.softDeletes, targetAlias)} IS NULL`,
          )
        if (predicate.predicate)
          conditions.push(
            this.predicate(
              targetModel,
              predicate.predicate,
              targetAlias,
              depth + 1,
            ),
          )
        return `(SELECT COUNT(*) FROM ${quoteIdentifier(resourceTable(targetModel))} AS ${quoteIdentifier(targetAlias)} WHERE ${conditions.join(' AND ')})`
      })
      return `(${counts.join(' + ')}) ${this.operator(predicate.operator ?? '>=')} ${this.bind(predicate.count ?? 1)}`
    }
    if (predicate.morphModels)
      throw new SynloquentError(
        'unsupported_query',
        'Morph target selection is supported only for a declared morphTo relation.',
      )
    const relatedAlias = `related_${this.aliasCounter++}`
    const join = this.relationJoin(model, relation, alias, relatedAlias)
    const conditions = [join.condition]
    const target = this.definition(relation.model)
    if (target.softDeletes)
      conditions.push(
        `${this.field(relation.model, target.softDeletes, relatedAlias)} IS NULL`,
      )
    const winner = this.oneOfManyWinner(model, relation, alias, relatedAlias)
    if (winner) conditions.push(winner)
    if (predicate.predicate)
      conditions.push(
        this.predicate(
          relation.model,
          predicate.predicate,
          relatedAlias,
          depth,
        ),
      )
    const condition = conditions.join(' AND ')
    return `(SELECT COUNT(*) FROM ${join.from} WHERE ${condition}) ${this.operator(predicate.operator ?? '>=')} ${this.bind(predicate.count ?? 1)}`
  }
  private oneOfManyWinner(
    model: string,
    relation: RelationDefinition,
    parentAlias: string,
    relatedAlias: string,
  ): string | null {
    if (
      !relation.oneOfMany?.length &&
      !relation.aggregateField &&
      !['ofMany', 'latestOfMany', 'oldestOfMany'].includes(relation.type)
    )
      return null
    const related = this.definition(relation.model)
    const sequence = relation.oneOfMany ?? [
      {
        field: relation.aggregateField ?? related.primaryKey,
        aggregate:
          relation.aggregate ??
          (relation.type === 'oldestOfMany' ? 'min' : 'max'),
      },
    ]
    const ordering = [...sequence]
    if (!ordering.some((entry) => entry.field === related.primaryKey))
      ordering.push({ field: related.primaryKey, aggregate: 'max' })
    const candidate = `winner_${this.aliasCounter++}`
    const join = this.relationJoin(model, relation, parentAlias, candidate)
    const conditions = [
      join.condition,
      ...sequence
        .filter((entry) => related.fields[entry.field]?.nullable)
        .map(
          (entry) =>
            `${this.field(relation.model, entry.field, candidate)} IS NOT NULL`,
        ),
    ]
    if (related.softDeletes)
      conditions.push(
        `${this.field(relation.model, related.softDeletes, candidate)} IS NULL`,
      )
    const order = ordering
      .map(
        (entry) =>
          `${this.field(relation.model, entry.field, candidate, true)} ${entry.aggregate === 'min' ? 'ASC' : 'DESC'}`,
      )
      .join(', ')
    return `${quoteIdentifier(relatedAlias)}._local_identity = (SELECT ${quoteIdentifier(candidate)}._local_identity FROM ${join.from} WHERE ${conditions.join(' AND ')} ORDER BY ${order} LIMIT 1)`
  }
}

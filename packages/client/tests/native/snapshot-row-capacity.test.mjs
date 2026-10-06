import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setImmediate } from 'node:timers'
import test from 'node:test'
import { createContext, Script } from 'node:vm'
import typescript from 'typescript'

const { process } = globalThis
const storagePath = resolve('packages/client/src/core/storage.ts')
const referencePath = resolve('examples/react-native/src/nativeReference.ts')
const baselineStorage = process.env.SYNLOQUENT_ROW_CAPACITY_STORAGE_BASELINE
const baselineReference = process.env.SYNLOQUENT_ROW_CAPACITY_REFERENCE_BASELINE
assert.equal(Boolean(baselineStorage), Boolean(baselineReference))
const sourceHashes = {}
const activeConnections = new Set()
const observations = []
let openedConnections = 0
let closedConnections = 0

function sourceRuntime(historical = false) {
  const fieldObjects = new WeakSet()
  const metadata = { enumerations: 0, fieldVisits: 0 }
  const events = []
  const instrumentedObject = new Proxy(Object, {
    get(target, name) {
      if (name === 'values')
        return (value) => {
          const values = Object.values(value)
          if (fieldObjects.has(value)) {
            metadata.enumerations += 1
            metadata.fieldVisits += values.length
          }
          return values
        }
      return Reflect.get(target, name)
    },
  })
  const context = createContext({ Object: instrumentedObject })
  const modules = new Map()
  let clock = 0
  function load(path) {
    if (modules.has(path)) return modules.get(path)
    const actualPath = historical
      ? path === storagePath
        ? resolve(baselineStorage)
        : path === referencePath
          ? resolve(baselineReference)
          : path
      : path
    const source = readFileSync(actualPath, 'utf8')
    sourceHashes[actualPath] = createHash('sha256').update(source).digest('hex')
    const exports = {}
    modules.set(path, exports)
    const compiled = typescript.transpileModule(source, {
      compilerOptions: {
        module: typescript.ModuleKind.CommonJS,
        target: typescript.ScriptTarget.ES2022,
      },
    }).outputText
    const require = (name) => {
      if (name === './platform')
        return {
          canonicalJson: load(resolve('packages/client/src/core/values.ts'))
            .canonicalJson,
          digest: async (content) =>
            createHash('sha256').update(content).digest('hex'),
          digestChunks: async (chunks) => {
            const hash = createHash('sha256')
            for await (const chunk of chunks) hash.update(chunk)
            return hash.digest('hex')
          },
          encodeUtf8: (content) => new TextEncoder().encode(content),
          nativeClock: { now: () => ++clock },
          yieldToApplication: async () => {
            events.push({ yield: true })
            await new Promise((resolveYield) => setImmediate(resolveYield))
          },
          setApplicationWorkPhase: (phase) => events.push({ phase }),
          observeNativeSqlPhase: () => {},
        }
      if (name === '@synloquent/client')
        return {
          makeModel() {
            throw new Error('Records-only reference must not create a model.')
          },
        }
      assert.ok(name.startsWith('.'), 'Unexpected runtime dependency ' + name)
      return load(resolve(dirname(path), name.replace(/\.js$/, '.ts')))
    }
    new Script('(function(require,exports){' + compiled + '\n})', {
      filename: actualPath,
    }).runInContext(context)(require, exports)
    return exports
  }
  return {
    Storage: load(storagePath).Storage,
    helpers: load(referencePath),
    canonicalJson: load(resolve('packages/client/src/core/values.ts'))
      .canonicalJson,
    metadata,
    events,
    register(schema) {
      for (const model of Object.values(schema.models))
        fieldObjects.add(model.fields)
    },
  }
}

function schema(decimalFields = 1) {
  const readable = { nullable: false, readable: true, writable: true }
  const model = (resource, fields) => ({
    resource,
    table: resource,
    primaryKey: 'id',
    keyType: 'integer',
    incrementing: true,
    fields: {
      id: { ...readable, type: 'integer', writable: false },
      name: { ...readable, type: 'string' },
      ...fields,
    },
    relations: {},
    operations: ['create', 'update', 'delete'],
  })
  return {
    protocolVersion: 1,
    releaseVersion: '0.1.0',
    schemaVersion: 1,
    fingerprint: 'capacity-' + decimalFields,
    capabilities: [],
    models: {
      Item: model(
        'items',
        Object.fromEntries(
          Array.from({ length: decimalFields }, (_, index) => [
            'price' + index,
            { ...readable, type: 'decimal', precision: 2, nullable: true },
          ]),
        ),
      ),
      Tag: model('tags', {}),
    },
  }
}

function record(identity, model = 'Item', decimalFields = 1) {
  return {
    model,
    id: String(identity),
    revision: 'revision-' + identity,
    attributes: {
      id: String(identity),
      name: model + '-' + identity,
      ...(model === 'Item'
        ? Object.fromEntries(
            Array.from({ length: decimalFields }, (_, index) => [
              'price' + index,
              index % 2 ? null : '-12345678901234567890.25',
            ]),
          )
        : {}),
    },
  }
}

async function fixture(historical, definition, suppliedRuntime) {
  const runtime = suppliedRuntime ?? sourceRuntime(historical)
  const manifest = schema(definition.decimalFields ?? 1)
  runtime.register(manifest)
  const database = new DatabaseSync(':memory:')
  activeConnections.add(database)
  openedConnections += 1
  let maximumParameters = 32766
  const execute = async (statement, parameters = []) => {
    runtime.events.push({ statement, parameters: [...parameters] })
    await new Promise((resolveStatement) => setImmediate(resolveStatement))
    assert.ok(parameters.length <= maximumParameters, 'Parameter cap exceeded')
    const prepared = database.prepare(statement)
    if (prepared.columns().length)
      return { rows: prepared.all(...parameters), changes: 0 }
    const result = prepared.run(...parameters)
    return {
      rows: [],
      changes: Number(result.changes),
      insertId: String(result.lastInsertRowid),
    }
  }
  const executor = {
    execute,
    async transaction(callback) {
      await execute('SAVEPOINT capacity_nested')
      try {
        const result = await callback(executor)
        await execute('RELEASE SAVEPOINT capacity_nested')
        return result
      } catch (failure) {
        await execute('ROLLBACK TO SAVEPOINT capacity_nested')
        await execute('RELEASE SAVEPOINT capacity_nested')
        throw failure
      }
    },
  }
  const adapter = {
    capabilities: {
      asynchronous: true,
      transactions: true,
      savepoints: true,
      json: true,
      get maximumParameters() {
        return maximumParameters
      },
    },
    execute,
    async transaction(callback) {
      await execute('BEGIN IMMEDIATE')
      try {
        const result = await callback(executor)
        await execute('COMMIT')
        return result
      } catch (failure) {
        await execute('ROLLBACK')
        throw failure
      }
    },
    async close() {
      database.close()
      activeConnections.delete(database)
      closedConnections += 1
    },
  }
  const storage = new runtime.Storage({
    schema: manifest,
    database: adapter,
    session: {
      accountId: 'capacity-account',
      tenantId: 'capacity-tenant',
      deviceId: 'capacity-device',
      deviceEpoch: 'capacity-epoch',
      generation: 1,
    },
    generateIdentity: () => 'capacity-identity',
    now: () => '2026-10-03T00:00:00.000Z',
    digest: async (content) =>
      createHash('sha256').update(content).digest('hex'),
  })
  try {
    await storage.initialize()
  } catch (failure) {
    await storage.owner.close()
    throw failure
  }
  const notifications = []
  storage.owner.subscribe((changed, generation) => {
    notifications.push({ changed: [...changed], generation })
  })
  const witness = () => {
    const tables = database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      )
      .all()
    return runtime.canonicalJson(
      Object.fromEntries(
        tables.map(({ name }) => [
          name,
          database.prepare('SELECT * FROM "' + name + '" ORDER BY rowid').all(),
        ]),
      ),
    )
  }
  return {
    runtime,
    storage,
    manifest,
    witness,
    notifications,
    setMaximumParameters(value) {
      maximumParameters = value
    },
  }
}

async function install(context, kind, records) {
  if (kind === 'sdk')
    return context.storage.owner.replace((executor, changed) =>
      context.storage.ingestSnapshotRecords(records, executor, changed),
    )
  const snapshot = {
    records,
    relationSets: [],
    ...(await context.runtime.helpers.snapshotContent({
      records,
      relationSets: [],
    })),
    schemaFingerprint: context.manifest.fingerprint,
    dataset: 'capacity',
    cursor: 'capacity-cursor',
    generation: 'capacity-generation',
    scope: {
      dataset: 'capacity',
      schemaFingerprint: context.manifest.fingerprint,
      authorizationGeneration: 'capacity-auth',
      projectionGeneration: 'capacity-projection',
      completeness: 'complete',
    },
  }
  return context.runtime.helpers.installReferenceSnapshot(
    { storage: context.storage },
    snapshot,
  )
}

async function runScenario(historical, kind, definition, suppliedRuntime) {
  const context = await fixture(historical, definition, suppliedRuntime)
  try {
    if (definition.pendingException) {
      await install(context, kind, [record(1)])
      await context.storage.owner.write(async (executor) => {
        await executor.execute(
          'UPDATE syn_model_Item SET _proposal=?, _state=? WHERE _server_identity=?',
          ['{"name":"pending-name"}', 'pending', '1'],
        )
      })
    }
    if (definition.priorInvocation) await install(context, kind, [record(900)])
    context.setMaximumParameters(definition.maximumParameters ?? 32766)
    context.runtime.events.length = 0
    context.runtime.metadata.enumerations = 0
    context.runtime.metadata.fieldVisits = 0
    context.notifications.length = 0
    const before = context.witness()
    const generationBefore = context.storage.owner.generation
    let error = null
    let output
    try {
      output = await install(context, kind, definition.records)
    } catch (failure) {
      error = {
        name: failure.name,
        code: failure.code ?? null,
        message: failure.message,
        details: failure.details ?? null,
      }
    }
    const after = context.witness()
    if (error) {
      assert.equal(after, before, 'Failed transaction must retain every table')
      assert.equal(context.storage.owner.generation, generationBefore)
      assert.deepEqual(context.notifications, [])
    }
    const result = {
      error,
      output: output ?? null,
      before,
      after,
      notifications: context.notifications,
      events: context.runtime.events,
    }
    return {
      result: JSON.parse(JSON.stringify(result)),
      metadata: { ...context.runtime.metadata },
      sqlFingerprint: createHash('sha256')
        .update(JSON.stringify(context.runtime.events))
        .digest('hex'),
    }
  } finally {
    await context.storage.owner.close()
  }
}

const scenarios = [
  {
    name: '130 ordinary rows retain the 64-row boundary',
    records: Array.from({ length: 130 }, (_, index) => record(index + 1)),
    enumerations: 1,
    historicalEnumerations: 130,
    bulkParameters: [640, 640, 20],
  },
  {
    name: 'A B A model switches reuse separate capacities with a tiny cap',
    records: [
      record(1),
      record(2, 'Tag'),
      record(3, 'Tag'),
      record(4),
      record(5),
    ],
    maximumParameters: 20,
    enumerations: 2,
    historicalEnumerations: 5,
    bulkParameters: [10, 18, 20],
  },
  {
    name: 'two decimal columns retain exact ordered decimal and null binds',
    decimalFields: 2,
    records: [record(1, 'Item', 2), record(2, 'Item', 2), record(3, 'Item', 2)],
    maximumParameters: 22,
    enumerations: 1,
    historicalEnumerations: 3,
    bulkParameters: [22, 11],
  },
  {
    name: 'zero decimal model retains its own nine-parameter row',
    records: [record(1, 'Tag'), record(2, 'Tag'), record(3, 'Tag')],
    maximumParameters: 18,
    enumerations: 1,
    historicalEnumerations: 3,
    bulkParameters: [18, 9],
  },
  {
    name: 'pending exception flushes and retains its proposal',
    pendingException: true,
    records: [record(2), record(1), record(3)],
    enumerations: 1,
    historicalEnumerations: 2,
  },
  {
    name: 'explicit local identity keeps scalar routing between ordinary rows',
    records: [
      record(1),
      { ...record(2), localIdentity: 'server-alias' },
      record(3),
    ],
    enumerations: 1,
    historicalEnumerations: 2,
  },
  {
    name: 'scalar-only rows never calculate an unused ordinary capacity',
    records: [{ ...record(1, 'Tag'), localIdentity: 'scalar-tag' }],
    maximumParameters: 9,
    enumerations: 0,
    historicalEnumerations: 0,
  },
  {
    name: 'first ordinary capacity failure follows a successful scalar row',
    records: [{ ...record(1, 'Tag'), localIdentity: 'scalar-tag' }, record(2)],
    maximumParameters: 9,
    error: /parameter capacity/,
    mustExecuteBulkBeforeFailure: true,
  },
  {
    name: 'one-row capacity still fails at the first ordinary record',
    records: [record(1)],
    maximumParameters: 8,
    error: /parameter capacity/,
  },
  {
    name: 'duplicate identity retains rollback and the exact error point',
    records: [record(1), record(2), record(3), record(1)],
    maximumParameters: 20,
    mustExecuteBulkBeforeFailure: true,
    error: /duplicate/,
  },
  {
    name: 'raw primary key mismatch is checked before capacity',
    records: [
      { ...record(1), attributes: { ...record(1).attributes, id: '2' } },
    ],
    maximumParameters: 8,
    error: /identity/,
  },
  {
    name: 'invalid raw integer primary key is never omitted',
    records: [
      { ...record(1), id: '-0', attributes: { id: '-0', name: 'invalid' } },
    ],
    error: /integer/,
  },
  {
    name: 'invalid decimal input keeps validation and rollback',
    records: [
      record(1),
      {
        ...record(2),
        attributes: { ...record(2).attributes, price0: '1.234' },
      },
    ],
    error: /decimal/,
  },
  {
    name: 'capacity failure of model B precedes flushing invalid model A',
    records: [
      { ...record(1, 'Tag'), attributes: { id: '1', name: 4 } },
      record(2, 'Item', 2),
    ],
    decimalFields: 2,
    maximumParameters: 9,
    error: /parameter capacity/,
    referenceError: /Invalid string/,
  },
  {
    name: 'a separate invocation rechecks the changed adapter capacity',
    priorInvocation: true,
    records: [record(1)],
    maximumParameters: 9,
    error: /parameter capacity/,
  },
  {
    name: 'unknown model retains its failure and rollback',
    records: [record(1), record(2, 'Unknown')],
    error: /model|identity/,
  },
  {
    name: 'an empty invocation does not construct any model capacity',
    records: [],
    enumerations: 0,
    historicalEnumerations: 0,
    bulkParameters: [],
  },
]

for (const kind of ['sdk', 'reference'])
  for (const definition of scenarios)
    await test(kind + ' ' + definition.name, async (context) => {
      const actual = await runScenario(false, kind, definition)
      const expectedError =
        kind === 'reference'
          ? (definition.referenceError ?? definition.error)
          : definition.error
      if (expectedError)
        assert.match(actual.result.error?.message ?? '', expectedError)
      else assert.equal(actual.result.error, null)
      if (definition.enumerations !== undefined)
        assert.equal(actual.metadata.enumerations, definition.enumerations)
      if (definition.bulkParameters)
        assert.deepEqual(
          actual.result.events
            .filter((event) =>
              /^INSERT INTO "syn_model_.*ON CONFLICT/.test(
                event.statement ?? '',
              ),
            )
            .map((event) => event.parameters.length),
          definition.bulkParameters,
        )
      if (definition.mustExecuteBulkBeforeFailure)
        assert.ok(
          actual.result.events.some((event) =>
            /^INSERT INTO "syn_model_.*ON CONFLICT/.test(event.statement ?? ''),
          ),
        )
      if (baselineStorage) {
        const historical = await runScenario(true, kind, definition)
        assert.deepEqual(actual.result, historical.result)
        assert.equal(actual.sqlFingerprint, historical.sqlFingerprint)
        if (definition.historicalEnumerations !== undefined)
          assert.equal(
            historical.metadata.enumerations,
            definition.historicalEnumerations,
          )
        assert.ok(
          actual.metadata.enumerations <= historical.metadata.enumerations,
        )
        observations.push({
          kind,
          scenario: definition.name,
          actual: actual.metadata,
          historical: historical.metadata,
          sqlFingerprint: actual.sqlFingerprint,
          fullDifferentialEqual: true,
        })
      }
      context.diagnostic(JSON.stringify({ metadata: actual.metadata }))
    })

for (const kind of ['sdk', 'reference'])
  await test(
    kind +
      ' separate schemas reuse the same module without a global model cache',
    async () => {
      const first = {
        records: [record(1), record(2), record(3)],
        maximumParameters: 20,
      }
      const second = {
        decimalFields: 2,
        records: [
          record(1, 'Item', 2),
          record(2, 'Item', 2),
          record(3, 'Item', 2),
        ],
        maximumParameters: 20,
      }
      const runtime = sourceRuntime()
      const firstResult = await runScenario(false, kind, first, runtime)
      const secondResult = await runScenario(false, kind, second, runtime)
      assert.equal(firstResult.result.error, null)
      assert.equal(secondResult.result.error, null)
      assert.equal(firstResult.metadata.enumerations, 1)
      assert.equal(secondResult.metadata.enumerations, 1)
      assert.equal(secondResult.metadata.fieldVisits, 4)
      assert.deepEqual(
        secondResult.result.events
          .filter((event) =>
            /^INSERT INTO "syn_model_.*ON CONFLICT/.test(event.statement ?? ''),
          )
          .map((event) => event.parameters.length),
        [11, 11, 11],
      )
      if (baselineStorage) {
        const historicalRuntime = sourceRuntime(true)
        const historicalFirst = await runScenario(
          true,
          kind,
          first,
          historicalRuntime,
        )
        const historicalSecond = await runScenario(
          true,
          kind,
          second,
          historicalRuntime,
        )
        assert.deepEqual(firstResult.result, historicalFirst.result)
        assert.deepEqual(secondResult.result, historicalSecond.result)
      }
    },
  )

await test('sdk absent primary attribute still validates the raw wire identity before capacity', async () => {
  const definition = {
    records: [{ ...record(1), id: '-0', attributes: { name: 'invalid' } }],
    maximumParameters: 8,
  }
  const actual = await runScenario(false, 'sdk', definition)
  assert.match(actual.result.error?.message ?? '', /integer/)
  assert.equal(actual.metadata.enumerations, 0)
  if (baselineStorage)
    assert.deepEqual(
      actual.result,
      (await runScenario(true, 'sdk', definition)).result,
    )
})

await test('all task-owned SQLite connections close and actual sources retain provenance', () => {
  assert.equal(activeConnections.size, 0)
  assert.equal(closedConnections, openedConnections)
  assert.equal(sourceHashes[storagePath]?.length, 64)
  assert.equal(sourceHashes[referencePath]?.length, 64)
  if (baselineStorage) {
    const reduced = observations.filter(
      (observation) =>
        observation.actual.enumerations < observation.historical.enumerations,
    )
    assert.ok(reduced.length >= 8, 'Original source must expose repeated work')
  }
})

await test('reports bounded source counts without a native memory claim', (context) => {
  context.diagnostic(
    JSON.stringify({
      sourceHashes,
      observations,
      openedConnections,
      closedConnections,
      nativeCompatibilityClaim: false,
      nativePeakImprovementClaim: false,
      allocationModel:
        'Each counted Object.values(fields).filter(decimal) evaluation creates two explicit array containers. Invocation-local model maps replace repeated evaluations, preserving all flush metadata work.',
    }),
  )
})

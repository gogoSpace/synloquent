import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { DatabaseSync } from 'node:sqlite'
import { setImmediate } from 'node:timers'
import test from 'node:test'
import { createContext, Script } from 'node:vm'
import typescript from 'typescript'

const { process } = globalThis
const adapterPath = resolve('packages/client/src/sqlite/index.ts')
const errorPath = resolve('packages/client/src/core/errors.ts')
const driverDirectory = resolve(
  'examples/react-native/node_modules/@op-engineering/op-sqlite',
)
const sourceHashes = {}
const activeConnections = new Set()

function loadSource(path, dependencies, context) {
  const source = readFileSync(path, 'utf8')
  sourceHashes[path] = createHash('sha256').update(source).digest('hex')
  const compiled = typescript.transpileModule(source, {
    compilerOptions: {
      module: typescript.ModuleKind.CommonJS,
      target: typescript.ScriptTarget.ES2022,
    },
  }).outputText
  const exports = {}
  new Script(
    '(function(require,exports){' +
      compiled +
      (path === errorPath
        ? ''
        : '\nexports.normalizeResult = normalizeResult') +
      '\n})',
    { filename: path },
  ).runInContext(context)((name) => {
    assert.ok(name in dependencies, 'Unexpected runtime dependency ' + name)
    return dependencies[name]
  }, exports)
  return exports
}

function loadAdapter(open, path = adapterPath, allocations) {
  const instrumentedObject = allocations
    ? new Proxy(Object, {
        get(target, name) {
          if (name === 'entries')
            return (value) => {
              const entries = Object.entries(value)
              allocations.entriesArrays += 1
              allocations.entryPairs += entries.length
              return entries
            }
          if (name === 'getOwnPropertyDescriptor')
            return (...argumentsList) => {
              allocations.descriptorObjects += 1
              return Object.getOwnPropertyDescriptor(...argumentsList)
            }
          return Reflect.get(target, name)
        },
      })
    : Object
  const context = createContext({
    Object: instrumentedObject,
    ArrayBuffer,
    Uint8Array,
    performance,
  })
  const errors = loadSource(errorPath, {}, context)
  return loadSource(
    path,
    {
      '@op-engineering/op-sqlite': { open },
      '../core/errors.js': errors,
    },
    context,
  )
}

const { normalizeResult } = loadAdapter(() => {
  throw new Error('Normalization-only control must not open a connection.')
})

function ownedConnection(overrides = {}) {
  const database = new DatabaseSync(':memory:')
  activeConnections.add(database)
  const statements = []
  const rawResults = []
  let closeCalls = 0
  const connection = {
    execute(statement, parameters = []) {
      statements.push({ statement, parameters: [...parameters] })
      return new Promise((resolveResult, rejectResult) => {
        setImmediate(() => {
          try {
            const controlled = overrides.execute?.(statement, parameters)
            if (controlled !== undefined) {
              Promise.resolve(controlled).then(resolveResult, rejectResult)
              return
            }
            const query = database.prepare(statement)
            if (query.columns().length) {
              const result = {
                rows: query.all(...parameters),
                rowsAffected: 0,
              }
              rawResults.push(result)
              resolveResult(result)
            } else {
              const result = query.run(...parameters)
              resolveResult({
                rows: [],
                rowsAffected: Number(result.changes),
                insertId: Number(result.lastInsertRowid),
              })
            }
          } catch (failure) {
            rejectResult(failure)
          }
        })
      })
    },
    close() {
      closeCalls += 1
      database.close()
      activeConnections.delete(database)
    },
  }
  return {
    connection,
    statements,
    rawResults,
    closeCalls: () => closeCalls,
  }
}

await test('uses pinned fresh native data rows as the private ownership premise', (context) => {
  const packagePath = resolve(driverDirectory, 'package.json')
  assert.equal(JSON.parse(readFileSync(packagePath)).version, '18.2.5')
  for (const relative of [
    'cpp/OPDatabase.cpp',
    'cpp/OPUtils.cpp',
    'cpp/OPBridge.cpp',
    'src/functions.ts',
    'src/types.ts',
  ]) {
    const path = resolve(driverDirectory, relative)
    sourceHashes[path] = createHash('sha256')
      .update(readFileSync(path))
      .digest('hex')
  }
  const nativeSource = readFileSync(
    resolve(driverDirectory, 'cpp/OPUtils.cpp'),
    'utf8',
  )
  assert.ok(nativeSource.includes('auto rows = jsi::Array(rt, row_count)'))
  assert.ok(nativeSource.includes('auto row = jsi::Object(rt)'))
  assert.ok(
    nativeSource.includes(
      'memcpy(buf.data(rt), jsBuffer.data.get(), jsBuffer.size)',
    ),
  )
  context.diagnostic(
    JSON.stringify({
      sourceHashes,
      nativeCompatibilityClaim: false,
      memoryPeakClosureClaim: false,
      ownership:
        'Pinned execute creates fresh ordinary JS data rows. There are no borrowed statement views or later native result mutations. Arbitrary accessor-bearing fake driver rows are outside this producer contract.',
    }),
  )
})

await test('retains the exact scalar array and row objects without mutation', () => {
  const rows = Object.freeze([
    Object.freeze({ id: 1, title: 'native scalar', nullable: null }),
    Object.freeze({ id: 2, title: 'second native scalar', nullable: null }),
  ])
  const normalized = normalizeResult({ rows, rowsAffected: 0 })
  assert.equal(normalized.rows, rows)
  assert.equal(normalized.rows[0], rows[0])
  assert.equal(normalized.rows[1], rows[1])
  assert.equal(normalized.changes, 0)
  assert.equal(Object.hasOwn(normalized, 'insertId'), false)
  const empty = []
  assert.equal(normalizeResult({ rows: empty, rowsAffected: 0 }).rows, empty)
})

await test('preserves exact numbers, integer strings, null and changes or insertId zero', () => {
  const row = {
    zero: 0,
    negativeZero: -0,
    maximumSafeInteger: Number.MAX_SAFE_INTEGER,
    exactIntegerString: '9223372036854775807',
    exactDecimal: '12345678901234567890.0010',
    decimal: 1.25,
    nullValue: null,
    embeddedNull: 'before\u0000after',
    unicode: 'Žluťoučký 🐈',
  }
  const normalized = normalizeResult({
    rows: [row],
    rowsAffected: 0,
    insertId: 0,
  })
  assert.equal(normalized.rows[0], row)
  assert.ok(Object.is(normalized.rows[0].negativeZero, -0))
  assert.deepEqual(normalized.rows[0], row)
  assert.equal(normalized.insertId, 0)
  assert.equal(normalized.changes, 0)
  assert.equal(
    normalizeResult({
      rows: [],
      rowsAffected: 4,
      insertId: '9223372036854775807',
    }).insertId,
    '9223372036854775807',
  )
  assert.equal(normalizeResult({ rows: [], rowsAffected: 4 }).changes, 4)
})

await test('checks own scalar columns even when names shadow builtins', () => {
  const row = Object.create(null)
  row.hasOwnProperty = 0
  row.constructor = 'own column'
  row.toString = null
  row.__proto__ = 'own scalar column'
  const normalized = normalizeResult({ rows: [row], rowsAffected: 0 })
  assert.equal(normalized.rows[0], row)
  assert.equal(Object.getPrototypeOf(normalized.rows[0]), null)
  assert.equal(normalized.rows[0].hasOwnProperty, 0)
  assert.equal(normalized.rows[0].constructor, 'own column')
  assert.equal(normalized.rows[0].__proto__, 'own scalar column')
  const ordinary = { hasOwnProperty: 0, constructor: 'ordinary own column' }
  assert.equal(
    normalizeResult({ rows: [ordinary], rowsAffected: 0 }).rows[0],
    ordinary,
  )
})

await test('keeps copied fallback for mixed booleans and all binary offsets', () => {
  const buffer = new Uint8Array([11, 22, 33, 44, 55, 66]).buffer
  const view = new Uint8Array(buffer, 1, 3)
  const dataView = new DataView(buffer, 2, 2)
  const wordView = new Uint16Array(buffer, 2, 2)
  const rows = [
    { scalar: 'also copied when another row needs conversion', nullable: null },
    { trueValue: true, falseValue: false, buffer, view, dataView, wordView },
  ]
  const normalized = normalizeResult({ rows, rowsAffected: 3, insertId: 12 })
  assert.notEqual(normalized.rows, rows)
  assert.notEqual(normalized.rows[0], rows[0])
  assert.notEqual(normalized.rows[1], rows[1])
  assert.equal(normalized.rows[1].trueValue, 1)
  assert.equal(normalized.rows[1].falseValue, 0)
  for (const field of ['buffer', 'view', 'dataView', 'wordView']) {
    const value = normalized.rows[1][field]
    assert.ok(value instanceof Uint8Array)
    assert.equal(value.buffer, buffer)
    assert.equal(
      value.byteOffset,
      field === 'buffer' ? 0 : rows[1][field].byteOffset,
    )
    assert.equal(
      value.byteLength,
      field === 'buffer' ? 6 : rows[1][field].byteLength,
    )
  }
  assert.deepEqual(Array.from(normalized.rows[1].view), [22, 33, 44])
  assert.deepEqual(Array.from(normalized.rows[1].dataView), [33, 44])
  assert.equal(rows[1].trueValue, true)
  assert.equal(rows[1].falseValue, false)
  assert.equal(rows[1].view, view)
  assert.equal(normalized.changes, 3)
  assert.equal(normalized.insertId, 12)
})

await test('keeps nonordinary rows on the prior copying and own-column fallback', () => {
  const prototype = { inherited: 'must not enter normalized columns' }
  const row = Object.assign(Object.create(prototype), {
    id: 3,
    title: 'nonordinary row',
    enabled: false,
  })
  const rows = [row]
  const normalized = normalizeResult({ rows, rowsAffected: 0 })
  assert.notEqual(normalized.rows, rows)
  assert.notEqual(normalized.rows[0], row)
  assert.deepEqual(
    { ...normalized.rows[0] },
    {
      id: 3,
      title: 'nonordinary row',
      enabled: 0,
    },
  )
  assert.equal(Object.hasOwn(normalized.rows[0], 'inherited'), false)
  assert.equal(row.enabled, false)
})

await test('removes actual-source scalar row and entry copies in a bounded allocation model', (context) => {
  const rows = Array.from({ length: 256 }, (_, identity) => ({
    identity,
    title: 'row ' + identity,
    quantity: identity % 20,
    nullable: null,
    exact: '9223372036854775807',
  }))
  function measure(path) {
    const allocations = {
      entriesArrays: 0,
      entryPairs: 0,
      descriptorObjects: 0,
    }
    const module = loadAdapter(() => {}, path, allocations)
    const normalized = module.normalizeResult({ rows, rowsAffected: 0 })
    return {
      ...allocations,
      resultArraysCopied: Number(normalized.rows !== rows),
      rowObjectsCopied: normalized.rows.reduce(
        (total, row, index) => total + Number(row !== rows[index]),
        0,
      ),
      normalized,
    }
  }
  const actual = measure(adapterPath)
  assert.equal(actual.resultArraysCopied, 0)
  assert.equal(actual.rowObjectsCopied, 0)
  assert.equal(actual.entriesArrays, 0)
  assert.equal(actual.entryPairs, 0)
  assert.equal(actual.descriptorObjects, 0)
  const baselinePath = process.env.SYNLOQUENT_SQLITE_BASELINE_SOURCE
  let baseline
  if (baselinePath) {
    baseline = measure(resolve(baselinePath))
    assert.equal(baseline.resultArraysCopied, 1)
    assert.equal(baseline.rowObjectsCopied, rows.length)
    assert.equal(baseline.entriesArrays, rows.length)
    assert.equal(baseline.entryPairs, rows.length * 5)
    assert.deepEqual(
      {
        ...actual.normalized,
        rows: Array.from(actual.normalized.rows, (row) => ({ ...row })),
      },
      {
        ...baseline.normalized,
        rows: Array.from(baseline.normalized.rows, (row) => ({ ...row })),
      },
    )
  }
  const { normalized: actualResult, ...actualCounts } = actual
  const { normalized: baselineResult, ...baselineCounts } = baseline ?? {}
  assert.equal(actualResult.rows.length, rows.length)
  context.diagnostic(
    JSON.stringify({
      rows: rows.length,
      fieldsPerRow: 5,
      actualCounts,
      baselineCounts,
      explicitSourceObjectsAvoided: baseline ? 1793 : null,
      excludesEngineInternalEnumerationAndVmAllocations: true,
      nativeMemoryPeakClaim: false,
    }),
  )
  if (baselineResult) assert.equal(baselineResult.rows.length, rows.length)
})

await test('adapter scalar rows outlive later statements, transactions and connection close', async () => {
  const owned = ownedConnection()
  const module = loadAdapter(() => owned.connection)
  const adapter = module.createDatabaseAdapter({
    name: 'lifetime-control.sqlite',
  })
  try {
    await adapter.execute(
      'CREATE TABLE controls(identity INTEGER PRIMARY KEY,title TEXT)',
    )
    await adapter.execute('INSERT INTO controls(identity,title) VALUES (?,?)', [
      1,
      'first',
    ])
    const first = await adapter.execute(
      'SELECT identity,title FROM controls ORDER BY identity',
    )
    const firstNative = owned.rawResults.at(-1)
    assert.equal(first.rows, firstNative.rows)
    await adapter.transaction(async (transaction) => {
      await transaction.execute(
        'UPDATE controls SET title=? WHERE identity=?',
        ['second', 1],
      )
      const later = await transaction.execute(
        'SELECT identity,title FROM controls ORDER BY identity',
      )
      assert.notEqual(later.rows, first.rows)
      assert.notEqual(later.rows[0], first.rows[0])
      assert.equal(later.rows[0].title, 'second')
    })
    assert.equal(first.rows[0].title, 'first')
    await adapter.close()
    assert.equal(first.rows[0].title, 'first')
    assert.equal(owned.closeCalls(), 1)
    await assert.rejects(adapter.execute('SELECT 1'), {
      code: 'closed_database',
    })
  } finally {
    await adapter.close()
  }
})

await test('actual adapter nested rollback, query errors and settled observer stay intact', async () => {
  const owned = ownedConnection()
  const observations = []
  const module = loadAdapter(() => owned.connection)
  const adapter = module.createDatabaseAdapter({
    name: 'transaction-control.sqlite',
    observeNativeWork(event) {
      observations.push(event)
      throw new Error('isolated diagnostic observer')
    },
  })
  let staleExecutor
  try {
    await adapter.execute(
      'CREATE TABLE controls(identity INTEGER PRIMARY KEY,title TEXT)',
    )
    await adapter.transaction(async (transaction) => {
      staleExecutor = transaction
      await transaction.execute('INSERT INTO controls VALUES (?,?)', [
        1,
        'outer',
      ])
      const failure = new Error('nested rollback control')
      await assert.rejects(
        transaction.transaction(async (nested) => {
          await nested.execute('INSERT INTO controls VALUES (?,?)', [
            2,
            'inner',
          ])
          throw failure
        }),
        (caught) => caught === failure,
      )
      assert.equal(
        (await transaction.execute('SELECT count(*) AS count FROM controls'))
          .rows[0].count,
        1,
      )
    })
    assert.equal(
      (await adapter.execute('SELECT title FROM controls')).rows[0].title,
      'outer',
    )
    await assert.rejects(staleExecutor.execute('SELECT 1'), {
      code: 'closed_database',
    })
    await assert.rejects(adapter.execute('SELECT missing_column FROM controls'))
    assert.equal(
      (await adapter.execute('SELECT count(*) AS count FROM controls')).rows[0]
        .count,
      1,
    )
    assert.ok(
      observations.some(
        (event) =>
          event.statement === 'SELECT missing_column FROM controls' &&
          event.phase === 'settled',
      ),
    )
    assert.ok(
      owned.statements.some((entry) =>
        entry.statement.startsWith('ROLLBACK TO SAVEPOINT '),
      ),
    )
    assert.ok(owned.statements.some((entry) => entry.statement === 'COMMIT'))
  } finally {
    await adapter.close()
  }
  assert.equal(owned.closeCalls(), 1)
})

await test('close drains accepted asynchronous work and rejects newly queued work', async () => {
  let completeStatement
  let startedStatement
  const started = new Promise((resolveStarted) => {
    startedStatement = resolveStarted
  })
  const raw = { rows: [{ value: 'retained result' }], rowsAffected: 0 }
  const owned = ownedConnection({
    execute(statement) {
      if (statement === 'SELECT delayed_control') {
        startedStatement()
        return new Promise((resolveResult) => {
          completeStatement = () => resolveResult(raw)
        })
      }
    },
  })
  const adapter = loadAdapter(() => owned.connection).createDatabaseAdapter({
    name: 'drain-control.sqlite',
  })
  const pending = adapter.execute('SELECT delayed_control')
  await started
  const closing = adapter.close()
  await assert.rejects(adapter.execute('SELECT 1'), { code: 'closed_database' })
  assert.equal(owned.closeCalls(), 0)
  completeStatement()
  const result = await pending
  await closing
  assert.equal(result.rows, raw.rows)
  assert.equal(result.rows[0].value, 'retained result')
  assert.equal(owned.closeCalls(), 1)
  const measurements = adapter.nativeMeasurements()
  assert.ok(Number.isFinite(measurements.synchronousOpenMilliseconds))
  assert.ok(Number.isFinite(measurements.synchronousCloseMilliseconds))
  assert.ok(Number.isFinite(measurements.maximumStatementDispatchMilliseconds))
})

await test('native execution error identity and rollback failure poisoning stay intact', async () => {
  const nativeFailure = new Error('owned execute failure')
  const rollbackFailure = new Error('owned rollback failure')
  const owned = ownedConnection({
    execute(statement) {
      if (statement === 'SELECT failed_control') throw nativeFailure
      if (statement === 'ROLLBACK') throw rollbackFailure
    },
  })
  const adapter = loadAdapter(() => owned.connection).createDatabaseAdapter({
    name: 'poison-control.sqlite',
  })
  try {
    await assert.rejects(
      adapter.execute('SELECT failed_control'),
      (failure) => failure === nativeFailure,
    )
    const transactionFailure = new Error('owned transaction failure')
    await assert.rejects(
      adapter.transaction(async () => {
        throw transactionFailure
      }),
      (failure) => {
        assert.equal(failure.name, 'AggregateError')
        assert.equal(failure.errors[0], transactionFailure)
        assert.equal(failure.errors[1], rollbackFailure)
        return true
      },
    )
    await assert.rejects(adapter.execute('SELECT 1'), {
      code: 'closed_database',
    })
  } finally {
    await adapter.close()
  }
  assert.equal(owned.closeCalls(), 1)
})

await test('all task-owned database connections have closed', () => {
  assert.equal(activeConnections.size, 0)
})

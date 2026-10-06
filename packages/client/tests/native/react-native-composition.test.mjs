import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { Script, createContext } from 'node:vm'
import { DatabaseSync } from 'node:sqlite'
import { Buffer } from 'node:buffer'
import { performance } from 'node:perf_hooks'
import {
  setImmediate,
  clearImmediate,
  setTimeout,
  clearTimeout,
} from 'node:timers'
import console from 'node:console'
import typescript from 'typescript'

const { AbortController } = globalThis
const publicExports = await import(
  pathToFileURL(
    resolve(
      'examples/react-native/node_modules/@synloquent/client/dist/index.js',
    ),
  ).href
)
const sources = {}
const observations = []
const applicationTasks = new Set()
const nativeTasks = new Set()
const timers = new Set()
const connections = new Set()
const contexts = new Map()
const controllers = []
const abortListeners = new Map()
const runtimes = []
const transports = []
let fetchHandler
let nextContext = 0
let openedConnections = 0
let closedConnections = 0
let providerClosures = 0
let failConnectionClose = false
let failDatabaseInitialization = false
let nextApplicationAction
let deliveredCallbacks = 0
function applicationSchedule(callback) {
  const task = setImmediate(() => {
    applicationTasks.delete(task)
    deliveredCallbacks += 1
    nextApplicationAction?.()
    callback(false)
  })
  applicationTasks.add(task)
  return task
}
function nativeWork(callback) {
  return new Promise((resolveWork, reject) => {
    const task = setImmediate(() => {
      nativeTasks.delete(task)
      try {
        resolveWork(callback())
      } catch (failure) {
        reject(failure)
      }
    })
    nativeTasks.add(task)
  })
}
const nativeDatabase = {
  open() {
    const database = new DatabaseSync(':memory:')
    connections.add(database)
    openedConnections += 1
    return {
      execute: (statement, parameters = []) =>
        nativeWork(() => {
          if (
            failDatabaseInitialization &&
            statement === 'PRAGMA foreign_keys = ON'
          )
            throw new Error('owned native database initialization failure')
          const query = database.prepare(statement)
          if (query.columns().length)
            return { rows: query.all(...parameters), rowsAffected: 0 }
          const result = query.run(...parameters)
          return {
            rows: [],
            rowsAffected: Number(result.changes),
            insertId: Number(result.lastInsertRowid),
          }
        }),
      close() {
        database.close()
        connections.delete(database)
        closedConnections += 1
        if (failConnectionClose)
          throw new Error('owned connection close diagnostic failure')
      },
    }
  },
}
const nativeCrypto = {
  start: () =>
    nativeWork(() => {
      const identity = String(++nextContext)
      contexts.set(identity, { hash: createHash('sha256'), bytes: 0 })
      return identity
    }),
  append: (identity, content) =>
    nativeWork(() => {
      const context = contexts.get(identity)
      assert(context)
      context.hash.update(content)
      context.bytes += Buffer.byteLength(content)
    }),
  finish: (identity) =>
    nativeWork(() => {
      const context = contexts.get(identity)
      assert(context)
      contexts.delete(identity)
      return {
        digest: context.hash.digest('hex'),
        bytes: context.bytes,
        cpuMilliseconds: 0,
        wallMilliseconds: 0,
      }
    }),
  cancel: (identity) =>
    nativeWork(() => {
      contexts.delete(identity)
    }),
  threadCpuMilliseconds: () => 0,
}
class TrackedController extends AbortController {
  constructor() {
    super()
    controllers.push(this)
    const listeners = new Set()
    abortListeners.set(this.signal, listeners)
    const add = this.signal.addEventListener.bind(this.signal)
    const remove = this.signal.removeEventListener.bind(this.signal)
    this.signal.addEventListener = (type, listener, ...options) => {
      if (type === 'abort') listeners.add(listener)
      return add(type, listener, ...options)
    }
    this.signal.removeEventListener = (type, listener, ...options) => {
      if (type === 'abort') listeners.delete(listener)
      return remove(type, listener, ...options)
    }
  }
}
const context = createContext({
  performance,
  AbortController: TrackedController,
  setTimeout(callback, delay) {
    const timer = setTimeout(() => {
      timers.delete(timer)
      callback()
    }, delay)
    timers.add(timer)
    return timer
  },
  clearTimeout(timer) {
    clearTimeout(timer)
    timers.delete(timer)
  },
  fetch: (...argumentsList) => fetchHandler(...argumentsList),
  nativeRuntimeScheduler: {
    unstable_scheduleCallback: applicationSchedule,
    unstable_cancelCallback: clearImmediate,
  },
})
const scheduler = {
  unstable_NormalPriority: 3,
  unstable_scheduleCallback: (priority, callback) => {
    assert.equal(priority, 3)
    return applicationSchedule(callback)
  },
  unstable_cancelCallback: (task) => {
    clearImmediate(task)
    applicationTasks.delete(task)
  },
}
const loaded = new Map()
function load(path) {
  const filename = resolve(path)
  if (loaded.has(filename)) return loaded.get(filename)
  const source = readFileSync(filename, 'utf8')
  sources[filename] = createHash('sha256').update(source).digest('hex')
  const exports = {}
  loaded.set(filename, exports)
  const require = (name) => {
    if (name === 'scheduler') return scheduler
    if (name === '@op-engineering/op-sqlite') return nativeDatabase
    if (name === 'react-native')
      return { TurboModuleRegistry: { getEnforcing: () => nativeCrypto } }
    const dependency = resolve(dirname(filename), name.replace(/\.js$/, '.ts'))
    if (dependency === resolve('packages/client/src/core/client.ts'))
      return { createSynloquent: publicExports.createSynloquent }
    if (dependency === resolve('packages/client/src/core/errors.ts'))
      return { SynloquentError: publicExports.SynloquentError }
    const result = load(dependency)
    if (dependency === resolve('packages/client/src/native-crypto/index.ts'))
      return {
        ...result,
        createNativeCryptoProvider: (configuration) => {
          const provider = result.createNativeCryptoProvider(configuration)
          const close = provider.close
          provider.close = () => {
            providerClosures += 1
            return close()
          }
          return provider
        },
      }
    return result
  }
  const compiled = typescript.transpileModule(source, {
    compilerOptions: {
      module: typescript.ModuleKind.CommonJS,
      target: typescript.ScriptTarget.ES2022,
    },
  }).outputText
  new Script('(function(require,exports){' + compiled + '\n})', {
    filename,
  }).runInContext(context)(require, exports)
  return exports
}
const composition = load('packages/client/src/react-native/index.ts')
const { backendSchema } = load('examples/react-native/backend.generated.ts')
const session = {
  accountId: 'caller-account',
  tenantId: 'caller-tenant',
  deviceId: 'caller-device',
  deviceEpoch: 'caller-epoch',
  generation: 0,
}
let nextIdentity = 0
function configuration(overrides = {}) {
  return {
    schema: backendSchema,
    session,
    database: { name: 'composition-control.sqlite' },
    generateIdentity: () => String(++nextIdentity),
    http: {
      endpoint: 'https://caller.invalid/protocol',
      authenticate: (identity) => ({
        session: identity.session,
        headers: {
          Authorization: 'Caller arbitrary scheme',
          'X-Application-Auth': 'provided',
        },
      }),
    },
    ...overrides,
  }
}
function request(kind = 'snapshot', identity = session) {
  return {
    protocolVersion: 1,
    requestId: 'caller-request',
    kind,
    schemaFingerprint: backendSchema.fingerprint,
    session: identity,
    payload: kind === 'snapshot' ? { dataset: 'catalog' } : {},
  }
}
function snapshot(records = []) {
  return {
    schemaFingerprint: backendSchema.fingerprint,
    dataset: 'catalog',
    generation: 'snapshot',
    cursor: 'cursor',
    hash: '0'.repeat(64),
    byteSize: 0,
    records,
    relationSets: [],
    scope: {
      dataset: 'catalog',
      authorizationGeneration: 'authorization',
      projectionGeneration: 'projection',
      schemaFingerprint: backendSchema.fingerprint,
      completeness: 'complete',
    },
  }
}
function respond(sent, payload = snapshot(), status = 200, headers = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => headers[name] ?? null },
    text: async () => JSON.stringify({ ...sent, payload }),
  }
}
function makeTransport(overrides = {}) {
  const result = composition.createReactNativeHttpTransport({
    ...configuration().http,
    session,
    ...overrides,
  })
  transports.push(result)
  return result
}
async function turn() {
  await new Promise((resolveTurn) => setImmediate(resolveTurn))
}
async function rejectsBounded(pending, predicate) {
  let timer
  try {
    await assert.rejects(
      Promise.race([
        pending,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Cancellation did not finish within500ms')),
            500,
          )
        }),
      ]),
      predicate,
    )
  } finally {
    clearTimeout(timer)
  }
}
try {
  fetchHandler = async (address, options) => {
    assert.equal(address, 'https://caller.invalid/protocol')
    assert.equal(options.headers.Authorization, 'Caller arbitrary scheme')
    assert.equal(options.headers['X-Application-Auth'], 'provided')
    assert.equal(options.headers['X-Synloquent-Device'], session.deviceId)
    const sent = JSON.parse(options.body)
    assert.deepEqual(sent.session, session)
    return respond(sent)
  }
  const valid = makeTransport()
  assert.equal((await valid.transport.snapshot(request())).records.length, 0)
  observations.push('caller-auth-session-tenant-request-and-protocol-headers')
  let fetchCalls = 0
  fetchHandler = async () => {
    fetchCalls += 1
    throw new Error('Unexpected fetch')
  }
  for (const field of Object.keys(session)) {
    const invalid = makeTransport({
      authenticate: (identity) => ({
        session: {
          ...identity.session,
          [field]: field === 'generation' ? 1 : 'foreign',
        },
        headers: { Authorization: 'wrong' },
      }),
    })
    await assert.rejects(
      invalid.transport.snapshot(request()),
      (failure) => failure.code === 'session_changed',
    )
  }
  for (const headers of [
    { Authorization: 'bad\r\nheader' },
    { 'Content-Type': 'wrong' },
    { 'X-Synloquent-Device': 'wrong' },
  ]) {
    const invalid = makeTransport({
      authenticate: (identity) => ({ session: identity.session, headers }),
    })
    await assert.rejects(
      invalid.transport.snapshot(request()),
      (failure) => failure.code === 'unauthenticated',
    )
  }
  await assert.rejects(
    valid.transport.query(request()),
    (failure) => failure.code === 'schema_mismatch',
  )
  assert.equal(fetchCalls, 0)
  observations.push(
    'auth-every-session-field-reserved-header-and-method-identity-rejection',
  )

  const waiting = makeTransport({ authenticate: () => new Promise(() => {}) })
  const pending = waiting.transport.snapshot(request())
  await turn()
  await waiting.close()
  await rejectsBounded(
    pending,
    (failure) =>
      failure.code === 'closed_database' && failure.name === 'AbortError',
  )
  assert.equal(timers.size, 0)
  observations.push(
    'stuck-auth-cancellation-closes-without-provider-completion',
  )
  const expired = makeTransport({
    timeoutMilliseconds: 5,
    authenticate: () => new Promise(() => {}),
  })
  await rejectsBounded(
    expired.transport.snapshot(request()),
    (failure) => failure.name === 'AbortError',
  )
  observations.push('whole-deadline-includes-authentication')

  for (const boundary of ['fetch', 'text']) {
    const target = makeTransport()
    let resolveLate
    fetchHandler = async (_address, options) => {
      const sent = JSON.parse(options.body)
      if (boundary === 'fetch')
        return new Promise((resolveFetch) => {
          resolveLate = () => resolveFetch(respond(sent))
        })
      return {
        ...respond(sent),
        text: () =>
          new Promise((resolveText) => {
            resolveLate = () =>
              resolveText(JSON.stringify({ ...sent, payload: snapshot() }))
          }),
      }
    }
    const reading = target.transport.snapshot(request())
    void reading.catch(() => undefined)
    await turn()
    target.setSession({ ...session, accountId: 'another' })
    await rejectsBounded(
      reading,
      (failure) => failure.code === 'session_changed',
    )
    resolveLate()
    await turn()
    assert.equal(timers.size, 0)
    observations.push('cancel-' + boundary + '-and-reject-late-response')
  }

  const records = Array.from({ length: 20000 }, (_, index) => ({
    model: 'Item',
    id: String(index),
    revision: '1',
    attributes: { id: index, title: 'Record' },
  }))
  for (const targetPhase of ['jsonDecode', 'shapeValidation']) {
    const target = makeTransport({
      observePhase(phase) {
        if (phase === targetPhase)
          nextApplicationAction = () => target.cancelPending()
      },
    })
    fetchHandler = async (_address, options) =>
      respond(JSON.parse(options.body), snapshot(records))
    await rejectsBounded(
      target.transport.snapshot(request()),
      (failure) => failure.name === 'AbortError',
    )
    nextApplicationAction = undefined
    assert.equal(applicationTasks.size, 0)
    observations.push(
      'cancel-' + targetPhase + '-at-native-application-boundary',
    )
  }
  fetchHandler = async () => ({
    status: 200,
    ok: false,
    headers: { get: () => null },
    text: async () => '',
  })
  await assert.rejects(
    valid.transport.snapshot(request()),
    /Invalid native HTTP status/,
  )
  fetchHandler = async () => ({
    status: 429,
    ok: false,
    headers: { get: (name) => (name === 'Retry-After' ? '2' : null) },
    text: async () =>
      JSON.stringify({ error: { code: 'rate_limited', message: 'Retry' } }),
  })
  await assert.rejects(
    valid.transport.snapshot(request()),
    (failure) =>
      failure.status === 429 && failure.retryAfterMilliseconds === 2000,
  )
  observations.push('status-consistency-and429-retry-validation')

  const runtime = await composition.createReactNativeClient(configuration())
  runtimes.push(runtime)
  assert.equal(runtime.client.setSession, runtime.setSession)
  assert.equal(runtime.client.sync.setSession, runtime.setSession)
  assert.equal(runtime.client.close, runtime.close)
  const created = await runtime.client.models.Item.create({
    title: 'Ordinary offline',
    price: '1.00',
    quantity: 2,
  })
  const localIdentity = created.localIdentity
  created.fill({ quantity: 3 })
  await created.save()
  assert.equal(
    (await runtime.client.models.Item.findOrFail(localIdentity)).attributes
      .quantity,
    3,
  )
  await runtime.client.transaction(async (scoped) => {
    await assert.rejects(
      scoped.setSession(session),
      (failure) => failure.code === 'nested_transaction',
    )
    await assert.rejects(
      scoped.sync.setSession(session),
      (failure) => failure.code === 'nested_transaction',
    )
    await assert.rejects(
      scoped.close(),
      (failure) => failure.code === 'nested_transaction',
    )
    await scoped.transaction(async (nested) => {
      await assert.rejects(
        nested.close(),
        (failure) => failure.code === 'nested_transaction',
      )
    })
  })
  const changes = [
    runtime.client.setSession({ ...session, accountId: 'second' }),
    runtime.client.sync.setSession({
      ...session,
      accountId: 'third',
      tenantId: 'third',
    }),
  ]
  await Promise.all(changes)
  assert.equal(runtime.client.storage.session.accountId, 'third')
  assert.equal(runtime.client.storage.session.generation, 2)
  assert.equal(await runtime.client.models.Item.find(localIdentity), null)
  fetchHandler = async (_address, options) => {
    const sent = JSON.parse(options.body)
    assert.equal(sent.session.accountId, 'third')
    assert.equal(sent.session.generation, 2)
    return respond(sent, backendSchema)
  }
  await runtime.client.storage.configuration.transport.manifest(
    runtime.client.sync.envelope('manifest', {}),
  )
  await runtime.setSession(session)
  assert.equal(
    (await runtime.client.models.Item.findOrFail(localIdentity)).attributes
      .quantity,
    3,
  )
  const hash = await runtime.client.storage.configuration.digest('Unicode 🧭')
  assert.equal(hash, createHash('sha256').update('Unicode 🧭').digest('hex'))
  const closing = runtime.close()
  assert.equal(closing, runtime.close())
  assert.equal(closing, runtime.client.close())
  await closing
  await assert.rejects(
    runtime.setSession(session),
    (failure) => failure.code === 'closed_database',
  )
  observations.push(
    'actual-sdk-sqlite-offline-crud-serial-session-isolation-native-provider-and-idempotent-close',
  )
  observations.push(
    'raw-client-lifecycle-routes-and-nested-scope-bypass-rejection',
  )

  let cancelledAuthentication = 0
  const activeRuntime = await composition.createReactNativeClient(
    configuration({
      http: {
        ...configuration().http,
        authenticate(_identity, lifecycle) {
          lifecycle.subscribe(() => {
            cancelledAuthentication += 1
          })
          return new Promise(() => {})
        },
      },
    }),
  )
  runtimes.push(activeRuntime)
  const waitingRequest =
    activeRuntime.client.storage.configuration.transport.manifest(
      activeRuntime.client.sync.envelope('manifest', {}),
    )
  void waitingRequest.catch(() => undefined)
  await turn()
  await activeRuntime.client.sync.setSession({
    ...session,
    accountId: 'raw-transition',
  })
  await rejectsBounded(
    waitingRequest,
    (failure) => failure.code === 'session_changed',
  )
  assert.equal(cancelledAuthentication, 1)
  let iteratorReturns = 0
  const pendingDigest = activeRuntime.client.storage.configuration.digestChunks(
    {
      [Symbol.asyncIterator]() {
        return {
          next: () => new Promise(() => {}),
          return: () => {
            iteratorReturns += 1
            return Promise.resolve({ done: true })
          },
        }
      },
    },
  )
  void pendingDigest.catch(() => undefined)
  await turn()
  assert(contexts.size > 0)
  const pendingRequest =
    activeRuntime.client.storage.configuration.transport.manifest(
      activeRuntime.client.sync.envelope('manifest', {}),
    )
  void pendingRequest.catch(() => undefined)
  await turn()
  const transition = activeRuntime.setSession({
    ...session,
    accountId: 'last-transition',
  })
  const closeDuringTransition = activeRuntime.client.close()
  await Promise.all([transition, closeDuringTransition])
  await rejectsBounded(
    pendingRequest,
    (failure) => failure.name === 'AbortError',
  )
  await rejectsBounded(
    pendingDigest,
    (failure) => failure.name === 'NativeDigestCancelledError',
  )
  assert.equal(iteratorReturns, 1)
  assert.equal(contexts.size, 0)
  observations.push(
    'factory-raw-session-aborts-pending-auth-and-close-cancels-stuck-native-digest',
  )
  observations.push(
    'close-serializes-after-accepted-session-transition-without-reopening-transport',
  )

  for (const kind of ['http', 'schema']) {
    const openedBefore = openedConnections
    const closedBefore = closedConnections
    const providersBefore = providerClosures
    await assert.rejects(
      composition.createReactNativeClient(
        configuration(
          kind === 'http'
            ? { http: { ...configuration().http, endpoint: 'invalid' } }
            : { schema: { ...backendSchema, protocolVersion: 2 } },
        ),
      ),
    )
    assert.equal(openedConnections, openedBefore + 1)
    assert.equal(closedConnections, closedBefore + 1)
    assert.equal(providerClosures, providersBefore + 1)
    observations.push(
      'initialization-' + kind + '-failure-closes-every-created-resource',
    )
  }
  const openedBeforeFailure = openedConnections
  const closedBeforeFailure = closedConnections
  const providersBeforeFailure = providerClosures
  failDatabaseInitialization = true
  try {
    await assert.rejects(
      composition.createReactNativeClient(configuration()),
      (failure) =>
        failure.name === 'AggregateError' &&
        failure.cause.message ===
          'owned native database initialization failure',
    )
  } finally {
    failDatabaseInitialization = false
  }
  assert.equal(openedConnections, openedBeforeFailure + 1)
  assert.equal(closedConnections, closedBeforeFailure + 1)
  assert.equal(providerClosures, providersBeforeFailure + 1)
  observations.push(
    'native-initialization-rejection-closes-connection-and-provider-with-primary-cause',
  )
  failConnectionClose = true
  try {
    await assert.rejects(
      composition.createReactNativeClient(
        configuration({
          http: { ...configuration().http, endpoint: 'invalid' },
        }),
      ),
      (failure) =>
        failure.name === 'AggregateError' &&
        failure.cause.message ===
          'An absolute HTTP protocol endpoint is required.' &&
        failure.errors.length === 2,
    )
  } finally {
    failConnectionClose = false
  }
  observations.push(
    'cleanup-error-keeps-initialization-primary-failure-and-closes-resource',
  )
  const binding = context.nativeRuntimeScheduler
  context.nativeRuntimeScheduler = undefined
  try {
    await assert.rejects(
      composition.createReactNativeClient(configuration()),
      /native RuntimeScheduler binding/,
    )
  } finally {
    context.nativeRuntimeScheduler = binding
  }
  observations.push('missing-native-scheduler-fails-closed')
  for (const transport of transports) await transport.close()
  assert.equal(timers.size, 0)
  assert.equal(applicationTasks.size, 0)
  assert.equal(nativeTasks.size, 0)
  assert.equal(connections.size, 0)
  assert.equal(contexts.size, 0)
  for (const listeners of abortListeners.values())
    assert.equal(listeners.size, 0)
  console.log(
    JSON.stringify({
      observations,
      sourceHashes: sources,
      deliveredCallbacks,
      openedConnections,
      closedConnections,
      providerClosures,
      nativePerformanceClaim: false,
      cleanup: {
        timers: timers.size,
        applicationTasks: applicationTasks.size,
        nativeTasks: nativeTasks.size,
        connections: connections.size,
        nativeHashContexts: contexts.size,
      },
    }),
  )
} finally {
  nextApplicationAction = undefined
  await Promise.allSettled([
    ...runtimes.map((runtime) => runtime.close()),
    ...transports.map((transport) => transport.close()),
  ])
  for (const task of applicationTasks) clearImmediate(task)
  for (const timer of timers) clearTimeout(timer)
  for (const connection of connections) connection.close()
}

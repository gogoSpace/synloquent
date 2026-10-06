import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, dirname } from 'node:path'
import { Script, createContext } from 'node:vm'
import { performance } from 'node:perf_hooks'
import {
  setImmediate,
  clearImmediate,
  setTimeout,
  clearTimeout,
} from 'node:timers'
import console from 'node:console'
import typescript from 'typescript'

const { AbortController, AbortSignal } = globalThis

const sources = new Map()
const observations = []
const activeTasks = new Set()
const activeHostTasks = new Set()
const activeTimers = new Set()
const workMeasurements = []
let scheduledCallbacks = 0
let deliveredCallbacks = 0
let maximumNumberConversionCharacters = 0
let cancellationDuringYield
let phase = ''
let fetchResponse
const controllers = []
const abortListeners = new Map()
let maximumSliceCharacters = 0
let maximumNativeParseCharacters = 0
let maximumClock = performance.now()
let fakeClock

const controlledNumber = (value) => {
  if (typeof value === 'string') {
    maximumNumberConversionCharacters = Math.max(
      maximumNumberConversionCharacters,
      value.length,
    )
    assert(
      value.length <= 2048,
      'A large number must not finalize in an unbounded native conversion',
    )
  }
  return Number(value)
}
controlledNumber.isFinite = Number.isFinite
controlledNumber.isInteger = Number.isInteger
controlledNumber.isSafeInteger = Number.isSafeInteger

const applicationClock = () => {
  if (fakeClock !== undefined) return fakeClock
  const now = performance.now()
  assert(now >= maximumClock, 'The monotonic clock must progress finitely')
  maximumClock = now
  return now
}

class CapturedAbortController extends AbortController {
  constructor() {
    super()
    controllers.push(this)
    const signal = this.signal
    const listeners = new Set()
    abortListeners.set(signal, listeners)
    const add = signal.addEventListener.bind(signal)
    const remove = signal.removeEventListener.bind(signal)
    signal.addEventListener = (type, listener, ...options) => {
      if (type === 'abort') listeners.add(listener)
      return add(type, listener, ...options)
    }
    signal.removeEventListener = (type, listener, ...options) => {
      if (type === 'abort') listeners.delete(listener)
      return remove(type, listener, ...options)
    }
  }
}

const platform = {
  nativeClock: { now: applicationClock, memory: {} },
  setApplicationWorkPhase(value) {
    phase = value
  },
  observeNativeContinuation() {},
  schedule(callback, delay) {
    assert(delay === 0 || delay === 1)
    scheduledCallbacks += 1
    const deliver = () => {
      activeTasks.delete(task)
      activeHostTasks.delete(task)
      deliveredCallbacks += 1
      callback()
    }
    const task = delay > 0 ? setTimeout(deliver, delay) : setImmediate(deliver)
    activeTasks.add(task)
    if (delay > 0) activeHostTasks.add(task)
    if (cancellationDuringYield) cancellationDuringYield()
    return () => {
      if (delay > 0) clearTimeout(task)
      else clearImmediate(task)
      activeTasks.delete(task)
      activeHostTasks.delete(task)
    }
  },
}

const context = createContext({
  Number: controlledNumber,
  AbortController: CapturedAbortController,
  setTimeout(callback, delay) {
    const timer = setTimeout(() => {
      activeTimers.delete(timer)
      callback()
    }, delay)
    activeTimers.add(timer)
    return timer
  },
  clearTimeout(timer) {
    clearTimeout(timer)
    activeTimers.delete(timer)
  },
  fetch: async (address, options) => fetchResponse(address, options),
  recordSliceCharacters(value) {
    maximumSliceCharacters = Math.max(maximumSliceCharacters, value)
    assert(
      value <= 2048,
      'A token must not finalize by slicing the whole token',
    )
  },
  recordNativeParseCharacters(value) {
    maximumNativeParseCharacters = Math.max(maximumNativeParseCharacters, value)
    assert(value <= 2048, 'The native JSON parser input must remain bounded')
  },
})
new Script(`
  const originalSlice = String.prototype.slice
  String.prototype.slice = function(beginning, ending) {
    const length = Math.min(this.length, ending ?? this.length) - beginning
    recordSliceCharacters(Math.max(0, length))
    return originalSlice.call(this, beginning, ending)
  }
  Array.prototype.join = function() { throw new Error('Whole-token join is forbidden in production decode and validation') }
  const originalParse = JSON.parse
  JSON.parse = function(content) {
    recordNativeParseCharacters(content.length)
    return originalParse(content)
  }
  this.objectPrototype = Object.prototype
  this.arrayPrototype = Array.prototype
`).runInContext(context)

const loaded = new Map()
function load(path) {
  const absolutePath = resolve(path)
  if (loaded.has(absolutePath)) return loaded.get(absolutePath)
  const source = readFileSync(absolutePath, 'utf8')
  sources.set(absolutePath, createHash('sha256').update(source).digest('hex'))
  const module = { exports: {} }
  loaded.set(absolutePath, module.exports)
  const require = (name) => {
    if (name === './platform') return platform
    if (name === '@synloquent/client/react-native')
      return load('packages/client/src/react-native/http/transport.ts')
    if (name === 'scheduler')
      return {
        unstable_NormalPriority: 3,
        unstable_scheduleCallback: (_priority, callback) =>
          platform.schedule(callback, 0),
        unstable_cancelCallback: (task) => task(),
      }
    if (name.startsWith('.'))
      return load(
        resolve(dirname(absolutePath), name.replace(/\.js$/, '') + '.ts'),
      )
    throw new Error('Unexpected runtime dependency: ' + name)
  }
  const compiled = typescript.transpileModule(source, {
    compilerOptions: {
      module: typescript.ModuleKind.CommonJS,
      target: typescript.ScriptTarget.ES2022,
    },
  }).outputText
  new Script('(function(require, exports, module) {' + compiled + '\n})', {
    filename: absolutePath,
  }).runInContext(context)(require, module.exports, module)
  return module.exports
}
const { HttpWorkBudget } = load(
  'packages/client/src/react-native/http/work-budget.ts',
)
const { decodeHttpJson } = load('packages/client/src/react-native/http/json.ts')
const { validateHttpPayload } = load(
  'packages/client/src/react-native/http/validation.ts',
)
const transportModule = load('examples/react-native/src/httpTransport.ts')

function budget(
  controller = new AbortController(),
  deadline = applicationClock() + 30000,
) {
  return new HttpWorkBudget({
    now: applicationClock,
    deadline,
    cancellation: controller.signal,
    abort: () => controller.abort(),
    schedule: (callback, delay) => platform.schedule(callback, delay),
  })
}

function equivalent(actual, expected) {
  const pending = [[actual, expected]]
  while (pending.length) {
    const [left, right] = pending.pop()
    if (right === null || typeof right !== 'object') {
      assert(
        Object.is(left, right),
        'Differential primitive mismatch: ' + String(right),
      )
      continue
    }
    assert.equal(Array.isArray(left), Array.isArray(right))
    assert.equal(
      Object.getPrototypeOf(left),
      Array.isArray(right) ? context.arrayPrototype : context.objectPrototype,
    )
    const actualKeys = Object.keys(left)
    const expectedKeys = Object.keys(right)
    assert.deepEqual(actualKeys, expectedKeys)
    for (const key of expectedKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(left, key)
      assert(
        descriptor &&
          descriptor.enumerable &&
          descriptor.writable &&
          descriptor.configurable,
      )
      pending.push([left[key], right[key]])
    }
  }
}

async function differential(content, label) {
  let expected
  try {
    expected = JSON.parse(content)
  } catch {
    await assert.rejects(
      decodeHttpJson(content, budget()),
      (failure) => failure.name === 'SyntaxError',
      label,
    )
    return
  }
  const work = budget()
  work.beginMeasurement()
  const actual = await decodeHttpJson(content, work)
  const maximumWorkSliceMilliseconds = work.endMeasurement()
  assert(
    Number.isFinite(maximumWorkSliceMilliseconds) &&
      maximumWorkSliceMilliseconds >= 0,
  )
  equivalent(actual, expected)
  if (content.length > 100000)
    workMeasurements.push({
      label,
      responseCharacters: content.length,
      maximumWorkSliceMilliseconds,
    })
}

const session = {
  accountId: '1',
  tenantId: '1',
  deviceId: 'control',
  deviceEpoch: 'epoch',
  generation: 0,
}
const scope = {
  dataset: 'catalog',
  authorizationGeneration: '1',
  projectionGeneration: '1',
  schemaFingerprint: 'fixture',
}
function request(kind, payload = {}) {
  return {
    protocolVersion: 1,
    requestId: 'owned-request',
    kind,
    schemaFingerprint: 'fixture',
    session,
    payload,
  }
}
function snapshot(records = [], relationSets = []) {
  return {
    schemaFingerprint: 'fixture',
    dataset: 'catalog',
    generation: '1',
    cursor: '1',
    hash: 'fixture',
    byteSize: 1,
    records,
    relationSets,
    scope,
  }
}
function record(
  index = 0,
  attributes = { id: index, title: 'Bounded synthetic HTTP record' },
) {
  return { model: 'Item', id: String(index), revision: '1', attributes }
}
function relation(targets = []) {
  return {
    model: 'Item',
    relation: 'tags',
    parentId: '1',
    revision: '1',
    completeness: 'complete',
    targets,
  }
}
function responseEnvelope(sent, payload) {
  return { ...sent, payload }
}
function serve(body, status = 200, headers = {}) {
  const content = typeof body === 'string' ? body : JSON.stringify(body)
  fetchResponse = async (address, options) => {
    assert.equal(address, 'http://owned-control.invalid/synloquent/v1/protocol')
    assert.equal(options.method, 'POST')
    assert.equal(options.headers.Authorization, 'Bearer synthetic-actor-1')
    assert.equal(options.headers['X-Synloquent-Device'], session.deviceId)
    assert(options.signal instanceof AbortSignal)
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name) => headers[name] ?? null },
      text: async () => content,
    }
  }
}

try {
  const valid = [
    'null',
    'true',
    'false',
    '-0',
    '0',
    '1e309',
    '-1e309',
    '5e-324',
    '-1e-999',
    '1.7976931348623157e308',
    '9007199254740993',
    '1e+3',
    '1E-3',
    '\r\n\t [1,2,3] ',
    JSON.stringify('"\\/\b\f\n\r\t'),
    '"\\u0000\\uD800\\uDC00\\uDFFF"',
    '"č雪😀\u2028\u2029"',
    '"\ud800\udc00\udfff"',
    '{"same":1,"same":2,"__proto__":{"polluted":true},"constructor":0}',
    '{"__proto__":1,"__proto__":2,"2":"b","1":"a","0":"z"}',
    '{"toString":"own","valueOf":null,"nested":[{},[]]}',
  ]
  for (const content of valid) await differential(content, 'fixed-valid')
  assert.equal({}.polluted, undefined)
  observations.push(
    'grammar-primitives-unicode-surrogates-own-keys-duplicate-keys',
  )

  const invalid = [
    '',
    ' ',
    '[',
    '{',
    '"',
    '"\\',
    '"\\u123',
    '"\\x00"',
    '"a\nb"',
    '"\u0000"',
    '01',
    '-01',
    '+1',
    '.1',
    '1.',
    '1e',
    '1e+',
    '--1',
    'NaN',
    'Infinity',
    'undefined',
    '[1,]',
    '{"a":1,}',
    '{a:1}',
    '{"a" 1}',
    '{"a":}',
    '[,1]',
    '[1 2]',
    'truefalse',
    'null 0',
    '[]x',
    '\u00a0null',
    '\ufeffnull',
    '{"a":1]',
  ]
  for (const content of invalid) await differential(content, 'fixed-invalid')
  const truncated =
    '{"key":[true,false,null,-1.25e+20,"escapes\\uD83D\\uDE00",{"a":1}]}'
  for (let position = 0; position <= truncated.length; position += 1)
    await differential(truncated.slice(0, position), 'every-prefix-truncation')
  observations.push('invalid-grammar-and-every-prefix-truncation')

  let randomState = 72131
  const random = () => {
    randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0
    return randomState / 4294967296
  }
  function randomValue(depth = 0) {
    const kind = Math.floor(random() * (depth < 6 ? 7 : 5))
    if (kind === 0) return null
    if (kind === 1) return random() > 0.5
    if (kind === 2)
      return (random() - 0.5) * 10 ** (Math.floor(random() * 610) - 305)
    if (kind === 3)
      return '\\"\n雪😀' + String.fromCharCode(Math.floor(random() * 65536))
    if (kind === 4) return Math.floor(random() * 100000)
    if (kind === 5)
      return Array.from({ length: Math.floor(random() * 8) }, () =>
        randomValue(depth + 1),
      )
    const result = {}
    for (let index = 0; index < 5; index += 1)
      Object.defineProperty(
        result,
        ['__proto__', 'constructor', '2', 'a', '雪'][index],
        { value: randomValue(depth + 1), enumerable: true },
      )
    return result
  }
  for (let index = 0; index < 300; index += 1)
    await differential(JSON.stringify(randomValue()), 'seeded-differential')
  await differential(
    '['.repeat(5000) + '0' + ']'.repeat(5000),
    'iterative-deep-container',
  )
  observations.push('seeded-json-parse-differential-and-iterative-depth')

  const longCharacters = 4 * 1024 * 1024
  await differential(
    '"' + 'a'.repeat(longCharacters) + '雪\\uD800"',
    'large-single-string-finalization',
  )
  await differential(
    '"' + '\\uD83D\\uDE00\\n'.repeat(100000) + '"',
    'large-escaped-string',
  )
  await differential(
    '{"' + 'k'.repeat(longCharacters) + '":1}',
    'large-single-object-key',
  )
  await differential(
    '12345' + '0'.repeat(longCharacters) + 'e-' + longCharacters,
    'large-finite-number',
  )
  await differential(
    '0.' + '0'.repeat(longCharacters) + '5e' + longCharacters,
    'large-leading-zero-coefficient',
  )
  await differential(
    '0e' + '9'.repeat(longCharacters),
    'large-single-exponent-zero',
  )
  await differential(
    '1e-' + '9'.repeat(longCharacters),
    'large-single-exponent-underflow',
  )
  await differential(
    '-0.' + '0'.repeat(longCharacters) + 'e99999',
    'large-negative-zero',
  )
  const halfway = '1.00000000000000011102230246251565404236316680908203125'
  await differential(
    halfway + '0'.repeat(longCharacters),
    'large-exact-rounding-midpoint',
  )
  await differential(
    halfway + '0'.repeat(longCharacters) + '1',
    'large-sticky-rounding-midpoint',
  )
  await differential(
    '-' + halfway + '0'.repeat(longCharacters) + '1',
    'large-negative-sticky-midpoint',
  )
  const subnormalHalfway = '0.' + (5n ** 1075n).toString().padStart(1075, '0')
  await differential(
    subnormalHalfway + '0'.repeat(longCharacters),
    'large-exact-subnormal-midpoint',
  )
  await differential(
    subnormalHalfway + '0'.repeat(longCharacters) + '1',
    'large-sticky-subnormal-midpoint',
  )
  for (const exponent of [-1075, -1022, -53, -1, 0, 107, 970]) {
    for (const coefficient of [1n, (1n << 53n) + 1n, (1n << 54n) - 1n]) {
      const decimal =
        exponent >= 0
          ? (coefficient << BigInt(exponent)).toString() + '.'
          : (() => {
              const digits = (coefficient * 5n ** BigInt(-exponent))
                .toString()
                .padStart(-exponent + 1, '0')
              const point = digits.length + exponent
              return digits.slice(0, point) + '.' + digits.slice(point)
            })()
      for (const suffix of ['0'.repeat(4096), '0'.repeat(4096) + '1']) {
        await differential(decimal + suffix, 'binary64-exact-dyadic-boundary')
        await differential(
          '-' + decimal + suffix,
          'negative-binary64-dyadic-boundary',
        )
      }
    }
  }
  await differential(
    '[' + '0,'.repeat(100000) + '0] trailing',
    'large-malformed-tail',
  )
  await differential(
    '"' + 'a'.repeat(longCharacters) + '\\uZZZZ"',
    'large-malformed-string-tail',
  )
  await differential(
    '1' + '0'.repeat(longCharacters) + 'e+',
    'large-malformed-number-tail',
  )
  assert(deliveredCallbacks > 100)
  assert(maximumNumberConversionCharacters <= 2048)
  assert(maximumSliceCharacters <= 2048)
  observations.push(
    'large-token-bounded-finalization-and-sticky-binary64-rounding',
  )

  const cancellationController = new AbortController()
  let returned = false
  cancellationDuringYield = () => cancellationController.abort()
  await assert.rejects(
    decodeHttpJson(
      '"' + 'a'.repeat(longCharacters) + '"',
      budget(cancellationController),
    ).then(() => {
      returned = true
    }),
    (failure) => failure.name === 'AbortError',
  )
  cancellationDuringYield = undefined
  assert.equal(returned, false)
  assert.equal(activeTasks.size, 0)
  const expiredController = new AbortController()
  fakeClock = 100
  await assert.rejects(
    decodeHttpJson('null', budget(expiredController, 99)),
    (failure) => failure.name === 'AbortError',
  )
  assert(expiredController.signal.aborted)
  fakeClock = undefined
  observations.push(
    'parser-cancellation-no-partial-return-and-monotonic-deadline',
  )

  const largePayload = snapshot(
    Array.from({ length: 117115 }, (_, index) => record(index)),
    Array.from({ length: 51128 }, () => relation()),
  )
  const sharedWork = budget()
  sharedWork.beginMeasurement()
  const decoded = await decodeHttpJson(JSON.stringify(largePayload), sharedWork)
  const decodeMaximum = sharedWork.endMeasurement()
  const callbacksBeforeValidation = deliveredCallbacks
  sharedWork.beginMeasurement()
  assert.equal(await validateHttpPayload('snapshot', decoded, sharedWork), true)
  const validationMaximum = sharedWork.endMeasurement()
  assert(
    deliveredCallbacks > callbacksBeforeValidation,
    'The large validator must return to the application',
  )
  assert.equal(decoded.records.length, 117115)
  observations.push('shared-decode-validation-budget-117115-records-51128-sets')

  const validPayloads = {
    manifest: {
      protocolVersion: 1,
      fingerprint: 'f',
      schemaVersion: 1,
      releaseVersion: '1',
      capabilities: ['relations'],
      models: {},
    },
    query: {
      records: [record()],
      related: [record(1)],
      relationSets: [relation([{ id: '1', attributes: { name: 'tag' } }])],
      completeness: 'partial',
      scope,
    },
    push: {
      receipts: [
        {
          operationId: 'operation',
          localIdentity: 'local',
          status: 'accepted',
          canonical: record(),
          relationSets: [],
        },
      ],
    },
    pull: {
      cursor: '1',
      highWater: '1',
      scanComplete: true,
      scope,
      batches: [
        {
          cursor: '1',
          relationSets: [],
          changes: [
            { kind: 'upsert', model: 'Item', id: '1', record: record() },
          ],
        },
      ],
    },
    snapshot: snapshot([record()], [relation()]),
    command: {
      operationId: 'operation',
      status: 'accepted',
      replayed: false,
      result: { quantity: '9007199254740993' },
    },
  }
  for (const [kind, payload] of Object.entries(validPayloads)) {
    const sent = request(
      kind,
      kind === 'command'
        ? {
            name: 'increment',
            operationId: 'operation',
            arguments: { item_id: '1' },
          }
        : {},
    )
    serve(responseEnvelope(sent, payload))
    const transport = transportModule.createExampleTransport({
      address: 'http://owned-control.invalid',
    })
    const result = await transport[kind](sent)
    equivalent(result, kind === 'command' ? payload.result : payload)
    assert.equal(activeTimers.size, 0)
  }
  observations.push('actual-transport-all-six-kinds-and-exact-command-result')

  const sent = request('snapshot', { dataset: 'catalog' })
  for (const [label, mutate, expectedCode] of [
    [
      'protocol',
      (value) => {
        value.protocolVersion = 2
      },
      'schema_mismatch',
    ],
    [
      'request-id',
      (value) => {
        value.requestId = 'foreign'
      },
      'schema_mismatch',
    ],
    [
      'kind',
      (value) => {
        value.kind = 'query'
      },
      'schema_mismatch',
    ],
    [
      'session-shape',
      (value) => {
        value.session = null
      },
      'schema_mismatch',
    ],
    [
      'schema',
      (value) => {
        value.schemaFingerprint = 'foreign'
      },
      'schema_mismatch',
    ],
    ...Object.keys(session).map((key) => [
      'session-' + key,
      (value) => {
        value.session[key] = 'foreign'
      },
      'session_changed',
    ]),
    [
      'last-record-shape',
      (value) => {
        value.payload.records.at(-1).revision = 1
      },
      'schema_mismatch',
    ],
    [
      'last-relation-shape',
      (value) => {
        value.payload.relationSets.at(-1).targets = null
      },
      'schema_mismatch',
    ],
  ]) {
    const envelope = JSON.parse(
      JSON.stringify(
        responseEnvelope(sent, snapshot([record(), record(1)], [relation()])),
      ),
    )
    mutate(envelope)
    serve(envelope)
    await assert.rejects(
      transportModule
        .createExampleTransport({ address: 'http://owned-control.invalid' })
        .snapshot(sent),
      (failure) => failure.code === expectedCode,
      label,
    )
    assert.equal(activeTimers.size, 0, label)
  }
  observations.push('actual-transport-identity-session-schema-shape-negatives')

  const invalidWire = [
    NaN,
    Infinity,
    undefined,
    () => {},
    new Array(100001).fill(0),
    Object.fromEntries(
      Array.from({ length: 1001 }, (_, index) => [String(index), 0]),
    ),
  ]
  let nested = null
  for (let depth = 0; depth < 33; depth += 1) nested = { child: nested }
  invalidWire.push(nested)
  for (const value of invalidWire)
    assert.equal(
      await validateHttpPayload(
        'snapshot',
        snapshot([record(0, { value })]),
        budget(),
      ),
      false,
    )
  const targetLimit = relation(
    new Array(100001).fill({ id: '1', attributes: {} }),
  )
  assert.equal(
    await validateHttpPayload(
      'snapshot',
      snapshot([], [targetLimit]),
      budget(),
    ),
    false,
  )
  assert.equal(
    await validateHttpPayload(
      'snapshot',
      snapshot([], new Array(1000001).fill(relation())),
      budget(),
    ),
    false,
  )
  assert.equal(
    await validateHttpPayload(
      'command',
      { ...validPayloads.command, extra: 1 },
      budget(),
      'operation',
    ),
    false,
  )
  observations.push('original-wire-depth-width-finite-and-relation-limits')

  const cancellationPayload = snapshot(
    Array.from({ length: 100000 }, (_, index) => record(index)),
  )
  const validationController = new AbortController()
  cancellationDuringYield = () => validationController.abort()
  await assert.rejects(
    validateHttpPayload(
      'snapshot',
      cancellationPayload,
      budget(validationController),
    ),
    (failure) => failure.name === 'AbortError',
  )
  cancellationDuringYield = undefined
  assert.equal(activeTasks.size, 0)
  observations.push('shape-cancellation-cleans-pending-application-task')

  serve(responseEnvelope(sent, largePayload))
  let applicationTaskDelivered = false
  const applicationTask = setImmediate(() => {
    applicationTaskDelivered = true
  })
  const completeStarted = performance.now()
  transportModule.resetNativeHttpStages()
  const actualSnapshot = await transportModule
    .createExampleTransport({ address: 'http://owned-control.invalid' })
    .snapshot(sent)
  clearImmediate(applicationTask)
  assert(
    applicationTaskDelivered,
    'Original uninterrupted transport baseline must fail this repaired application-delivery oracle',
  )
  assert.equal(actualSnapshot.records.length, 117115)
  const completeElapsedMilliseconds = performance.now() - completeStarted
  const stages = transportModule.nativeHttpStages()
  for (const measured of stages.filter((entry) =>
    ['jsonDecode', 'shapeValidation'].includes(entry.phase),
  )) {
    assert(
      Number.isFinite(measured.elapsedMilliseconds) &&
        measured.elapsedMilliseconds > 0,
    )
    assert(
      Number.isFinite(measured.maximumWorkSliceMilliseconds) &&
        measured.maximumWorkSliceMilliseconds > 0,
    )
    assert(
      measured.maximumWorkSliceMilliseconds <= measured.elapsedMilliseconds + 5,
    )
  }
  assert.equal(activeTimers.size, 0)
  observations.push(
    'actual-transport-application-progress-and-whole-elapsed-preserved',
  )

  const clockController = new AbortController()
  fakeClock = 0
  const timedWork = budget(clockController, 10)
  cancellationDuringYield = () => {
    fakeClock = 11
  }
  await assert.rejects(
    decodeHttpJson('"' + 'a'.repeat(longCharacters) + '"', timedWork),
    (failure) => failure.name === 'AbortError',
  )
  cancellationDuringYield = undefined
  fakeClock = undefined
  assert(clockController.signal.aborted)
  assert.equal(activeTasks.size, 0)
  observations.push('deadline-check-after-real-application-boundary')

  serve(responseEnvelope(sent, largePayload))
  cancellationDuringYield = () => controllers.at(-1).abort()
  await assert.rejects(
    transportModule
      .createExampleTransport({ address: 'http://owned-control.invalid' })
      .snapshot(sent),
    (failure) => failure.name === 'AbortError',
  )
  cancellationDuringYield = undefined
  assert.equal(activeTimers.size, 0)
  assert.equal(activeTasks.size, 0)
  serve('{')
  await assert.rejects(
    transportModule
      .createExampleTransport({ address: 'http://owned-control.invalid' })
      .snapshot(sent),
    (failure) => failure.name === 'SyntaxError',
  )
  assert.equal(activeTimers.size, 0)
  serve(
    { error: { code: 'unauthenticated', message: 'Synthetic failure' } },
    401,
    { 'Retry-After': '2' },
  )
  await assert.rejects(
    transportModule
      .createExampleTransport({ address: 'http://owned-control.invalid' })
      .snapshot(sent),
    (failure) =>
      failure.code === 'unauthenticated' &&
      failure.status === 401 &&
      failure.retryAfterMilliseconds === 2000,
  )
  assert.equal(activeTimers.size, 0)
  observations.push(
    'transport-abort-malformed-http-error-finally-timer-cleanup',
  )

  serve(responseEnvelope(sent, largePayload))
  await assert.rejects(
    transportModule
      .createExampleTransport({
        address: 'http://owned-control.invalid',
        timeoutMilliseconds: 5,
      })
      .snapshot(sent),
    (failure) => failure.name === 'AbortError',
  )
  assert.equal(activeTimers.size, 0)
  assert.equal(activeTasks.size, 0)
  serve('x'.repeat(64 * 1024 * 1024 + 1))
  await assert.rejects(
    transportModule
      .createExampleTransport({ address: 'http://owned-control.invalid' })
      .snapshot(sent),
    (failure) =>
      failure.code === 'schema_mismatch' && /size limit/.test(failure.message),
  )
  assert.equal(activeTimers.size, 0)
  for (const listeners of abortListeners.values())
    assert.equal(listeners.size, 0)
  observations.push('real-timeout-capacity-and-abort-listener-cleanup')

  const failedSchedulerController = new AbortController()
  const failedSchedulerWork = new HttpWorkBudget({
    now: applicationClock,
    deadline: applicationClock() + 30000,
    cancellation: failedSchedulerController.signal,
    abort: () => failedSchedulerController.abort(),
    schedule: () => {
      throw new Error('Unavailable native scheduler')
    },
  })
  await assert.rejects(
    decodeHttpJson('"' + 'a'.repeat(longCharacters) + '"', failedSchedulerWork),
    /Unavailable native scheduler/,
  )
  observations.push('scheduler-failure-cannot-return-partial-json')

  assert.equal(activeTasks.size, 0)
  console.log(
    JSON.stringify({
      observations,
      scheduledCallbacks,
      deliveredCallbacks,
      maximumNumberConversionCharacters,
      maximumNativeParseCharacters,
      maximumSliceCharacters,
      decodeMaximum,
      validationMaximum,
      workMeasurements,
      completeElapsedMilliseconds,
      stages: stages.map((value) => ({
        phase: value.phase,
        elapsedMilliseconds: value.elapsedMilliseconds,
        maximumWorkSliceMilliseconds: value.maximumWorkSliceMilliseconds,
      })),
      lastPhase: phase,
      sourceHashes: Object.fromEntries(sources),
      nativePerformanceClaim: false,
    }),
  )
} finally {
  for (const task of activeTasks)
    if (activeHostTasks.has(task)) clearTimeout(task)
    else clearImmediate(task)
  for (const timer of activeTimers) clearTimeout(timer)
}

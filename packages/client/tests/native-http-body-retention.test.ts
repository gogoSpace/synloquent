import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Script, createContext } from 'node:vm'
import { test } from 'node:test'
import typescript from 'typescript'
import type {
  DigestLifecycle,
  Envelope,
  Session,
  Transport,
} from '../src/core/types.js'

interface PublicResponse {
  readonly status: number
  readonly ok: boolean
  readonly bodyUsed: boolean
  readonly headers: { get(name: string): string | null }
  text(): Promise<string>
}
interface PublicResponseConstructor {
  new (
    content: string,
    options?: { status?: number; headers?: Record<string, string> },
  ): PublicResponse
  error(): PublicResponse
}
interface HttpStage {
  kind: string
  phase: string
  elapsedMilliseconds: number
  responseCharacters?: number
  serverTiming?: string | null
  serverProfile?: string | null
  maximumWorkSliceMilliseconds?: number
}
interface HttpConfiguration {
  endpoint: string
  session: Session
  authenticate(
    identity: { session: Session },
    lifecycle: DigestLifecycle,
  ):
    | { session: Session; headers: Record<string, string> }
    | Promise<{ session: Session; headers: Record<string, string> }>
  timeoutMilliseconds?: number
  nowMilliseconds?: () => number
  schedule?: (callback: () => void, delayMilliseconds: number) => () => void
  observePhase?: (phase: string) => void
  observeStage?: (stage: HttpStage) => void
  observeNativeContinuation?: (event: { statement: string }) => void
}
interface HttpOwner {
  transport: Transport
  cancelPending(): void
  suspend(): void
  setSession(session: Session): void
  close(): Promise<void>
}

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const sourceDirectory = resolve(repository, 'packages/client/src/react-native')
const session: Session = {
  accountId: 'owned-account',
  tenantId: 'owned-tenant',
  deviceId: 'owned-device',
  deviceEpoch: 'owned-epoch',
  generation: 1,
}
function request(): Envelope<{ dataset: string }> {
  return {
    protocolVersion: 1,
    requestId: 'owned-request',
    kind: 'snapshot',
    schemaFingerprint: 'owned-schema',
    session: { ...session },
    payload: { dataset: 'catalog' },
  }
}
function payload(records = 0) {
  return {
    schemaFingerprint: 'owned-schema',
    dataset: 'catalog',
    generation: '1',
    cursor: '1',
    hash: 'owned-hash',
    byteSize: 0,
    records: Array.from({ length: records }, (_, index) => ({
      model: 'Item',
      id: String(index),
      revision: '1',
      attributes: { title: `Record ${index} ${'x'.repeat(32)}` },
    })),
    relationSets: [],
    scope: {
      dataset: 'catalog',
      authorizationGeneration: '1',
      projectionGeneration: '1',
      schemaFingerprint: 'owned-schema',
      completeness: 'complete',
    },
  }
}
function deferred<Value>() {
  let resolveValue!: (value: Value | PromiseLike<Value>) => void
  let rejectValue!: (failure: unknown) => void
  const promise = new Promise<Value>((resolveResult, rejectResult) => {
    resolveValue = resolveResult
    rejectValue = rejectResult
  })
  return { promise, resolve: resolveValue, reject: rejectValue }
}
function nextTurn() {
  return new Promise<void>((resolveTurn) => setImmediate(resolveTurn))
}
function hasCode(failure: unknown, code: string): boolean {
  return (
    typeof failure === 'object' &&
    failure !== null &&
    'code' in failure &&
    failure.code === code
  )
}
function observedPromises() {
  interface Observation {
    settled: boolean
    subscriptions: number
  }
  const observations: Observation[] = []
  const promises = new WeakMap<object, Observation>()
  class ObservedPromise<Value> extends Promise<Value> {
    constructor(
      executor: (
        resolveValue: (value: Value | PromiseLike<Value>) => void,
        rejectValue: (failure?: unknown) => void,
      ) => void,
    ) {
      const observation = { settled: false, subscriptions: 0 }
      super((resolveValue, rejectValue) =>
        executor(
          (value) => {
            observation.settled = true
            resolveValue(value)
          },
          (failure) => {
            observation.settled = true
            rejectValue(failure)
          },
        ),
      )
      observations.push(observation)
      promises.set(this, observation)
    }
    override then<Fulfilled = Value, Rejected = never>(
      onfulfilled?:
        ((value: Value) => Fulfilled | PromiseLike<Fulfilled>) | null,
      onrejected?:
        ((failure: unknown) => Rejected | PromiseLike<Rejected>) | null,
    ): Promise<Fulfilled | Rejected> {
      const observation = promises.get(this)
      assert.ok(observation)
      if (!observation.settled) observation.subscriptions += 1
      return super.then(onfulfilled, onrejected)
    }
  }
  return {
    constructor: ObservedPromise,
    maximumPendingSubscriptions: () =>
      Math.max(0, ...observations.map((value) => value.subscriptions)),
  }
}

function actualTransport(promiseConstructor: PromiseConstructor = Promise) {
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const applicationTasks = new Set<ReturnType<typeof setImmediate>>()
  const controllers: Set<unknown>[] = []
  const stages: HttpStage[] = []
  const events: string[] = []
  let time = 0
  let fetchCalls = 0
  let textCalls = 0
  let onApplication: (() => void) | undefined
  let fetchResponse: (
    sent: Envelope<{ dataset: string }>,
  ) => PublicResponse | Promise<PublicResponse>
  class ObservedController extends AbortController {
    constructor() {
      super()
      const listeners = new Set<unknown>()
      controllers.push(listeners)
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
  const schedule = (callback: () => void, delayMilliseconds: number) => {
    if (delayMilliseconds > 0) {
      const task = setTimeout(() => {
        timers.delete(task)
        onApplication?.()
        callback()
      }, delayMilliseconds)
      timers.add(task)
      return () => {
        clearTimeout(task)
        timers.delete(task)
      }
    }
    const task = setImmediate(() => {
      applicationTasks.delete(task)
      onApplication?.()
      callback()
    })
    applicationTasks.add(task)
    return () => {
      clearImmediate(task)
      applicationTasks.delete(task)
    }
  }
  const context = createContext({
    AbortController: ObservedController,
    Promise: promiseConstructor,
    performance: { now: () => time },
    setTimeout(callback: () => void, delay: number) {
      const timer = setTimeout(() => {
        timers.delete(timer)
        callback()
      }, delay)
      timers.add(timer)
      return timer
    },
    clearTimeout(timer: ReturnType<typeof setTimeout>) {
      clearTimeout(timer)
      timers.delete(timer)
    },
    fetch(
      _address: string,
      options: {
        method: string
        body: string
        signal: AbortSignal
        headers: Record<string, string>
      },
    ) {
      fetchCalls += 1
      assert.equal(options.method, 'POST')
      assert.equal(options.headers['Content-Type'], 'application/json')
      assert.equal(options.headers['X-Synloquent-Device'], session.deviceId)
      assert.equal(options.signal.aborted, false)
      return fetchResponse(JSON.parse(options.body))
    },
  })
  // Public Node Response/Headers exercise the transport boundary. Native
  // Response ownership and compatibility require separate native evidence.
  const Response: PublicResponseConstructor = globalThis.Response
  const loaded = new Map<string, object>()
  function load(filename: string): object {
    const existing = loaded.get(filename)
    if (existing) return existing
    const actualFilename =
      process.env.SYNLOQUENT_NATIVE_HTTP_TRANSPORT_BASELINE &&
      filename === resolve(sourceDirectory, 'http/transport.ts')
        ? resolve(process.env.SYNLOQUENT_NATIVE_HTTP_TRANSPORT_BASELINE)
        : filename
    const compiled = typescript.transpileModule(
      readFileSync(actualFilename, 'utf8'),
      {
        compilerOptions: {
          target: typescript.ScriptTarget.ES2022,
          module: typescript.ModuleKind.CommonJS,
        },
      },
    ).outputText
    const exported = {}
    loaded.set(filename, exported)
    new Script(`(function(require,exports){${compiled}\n})`, {
      filename: actualFilename,
    }).runInContext(context)((specifier: string) => {
      if (specifier === 'scheduler')
        return {
          unstable_NormalPriority: 3,
          unstable_scheduleCallback: (
            _priority: number,
            callback: () => void,
          ) => schedule(callback, 0),
          unstable_cancelCallback: (cancel: () => void) => cancel(),
        }
      assert.ok(specifier.startsWith('.'))
      return load(resolve(dirname(filename), specifier.replace(/\.js$/, '.ts')))
    }, exported)
    return exported
  }
  const exported = load(resolve(sourceDirectory, 'http/transport.ts')) as {
    createReactNativeHttpTransport: (
      configuration: HttpConfiguration,
    ) => HttpOwner
  }
  const createResponse = (
    content: string,
    status = 200,
    headers: Record<string, string> = {},
  ) => {
    const response = new Response(content, { status, headers })
    const readText = response.text.bind(response)
    response.text = () => {
      textCalls += 1
      events.push('text')
      return readText()
    }
    const readHeader = response.headers.get.bind(response.headers)
    response.headers.get = (name) => {
      events.push(`header:${name}`)
      return readHeader(name)
    }
    return response
  }
  fetchResponse = (sent) =>
    createResponse(JSON.stringify({ ...sent, payload: payload() }))
  const createOwner = (configuration: Partial<HttpConfiguration> = {}) =>
    exported.createReactNativeHttpTransport({
      endpoint: 'https://owned.invalid/synloquent',
      session,
      authenticate: (identity) => ({
        session: identity.session,
        headers: { Authorization: 'Bearer owned' },
      }),
      timeoutMilliseconds: 60000,
      nowMilliseconds: () => time,
      schedule,
      observePhase: (phase) => events.push(`phase:${phase}`),
      observeStage: (stage) => {
        stages.push(stage)
        events.push(`stage:${stage.phase}`)
      },
      observeNativeContinuation: (event) =>
        events.push(`continuation:${event.statement}`),
      ...configuration,
    })
  return {
    createOwner,
    createResponse,
    Response,
    events,
    stages,
    setFetch: (fetch: typeof fetchResponse) => {
      fetchResponse = fetch
    },
    setTime: (value: number) => {
      time = value
    },
    onApplication: (callback: () => void) => {
      onApplication = callback
    },
    fetchCalls: () => fetchCalls,
    textCalls: () => textCalls,
    assertClean() {
      assert.equal(timers.size, 0)
      assert.equal(applicationTasks.size, 0)
      assert.ok(controllers.every((listeners) => listeners.size === 0))
    },
  }
}

test('C55 HTTP completed auth fetch and text waits cannot share retained pending Promise reactions', async () => {
  const observation = observedPromises()
  const actual = actualTransport(observation.constructor)
  const owner = actual.createOwner()
  try {
    for (let count = 0; count < 3; count++) {
      assert.deepEqual(
        JSON.parse(JSON.stringify(await owner.transport.snapshot(request()))),
        payload(),
      )
      // Public Promise hooks count subscriptions on unresolved operands without
      // retaining those Promises, their values, or requesting garbage collection.
      // Resolve adoption is not an exact clock. Never-resolved cancellation
      // operands are counted exactly across the three completed waits.
      assert.ok(
        observation.maximumPendingSubscriptions() <= 2,
        `Completed waits retained ${observation.maximumPendingSubscriptions()} reactions on one pending Promise`,
      )
    }
  } finally {
    await owner.close()
    actual.assertClean()
  }
})

test('C55 public Response metadata and body consumption preserve stage and header observation order', async () => {
  const actual = actualTransport()
  const sent = request()
  const response = actual.createResponse(
    JSON.stringify({ ...sent, payload: payload() }),
    200,
    {
      'Server-Timing': 'snapshot;dur=10',
      'X-Synloquent-Profile': 'owned-profile',
    },
  )
  actual.setFetch(() => response)
  const owner = actual.createOwner()
  try {
    assert.deepEqual(
      JSON.parse(JSON.stringify(await owner.transport.snapshot(sent))),
      payload(),
    )
    assert.equal(response.bodyUsed, true)
    assert.equal(actual.textCalls(), 1)
    assert.deepEqual(actual.events, [
      'phase:responseAvailable',
      'phase:responseText',
      'continuation:native HTTP response completion',
      'header:Server-Timing',
      'header:X-Synloquent-Profile',
      'stage:responseAvailable',
      'text',
      'continuation:native HTTP response text completion',
      'stage:responseText',
      'phase:jsonDecode',
      'stage:jsonDecode',
      'phase:shapeValidation',
      'stage:shapeValidation',
    ])
    assert.equal(actual.stages[0]?.serverTiming, 'snapshot;dur=10')
    assert.equal(actual.stages[0]?.serverProfile, 'owned-profile')
    assert.ok(actual.stages.every((stage) => stage.elapsedMilliseconds === 0))
    await assert.rejects(response.text(), /already.*read/i)
  } finally {
    await owner.close()
    actual.assertClean()
  }
})

for (const retryAfter of ['2', '0.5', 'invalid']) {
  test(`C55 public HTTP429 Retry-After ${retryAfter} is read only after complete decode`, async () => {
    const actual = actualTransport()
    actual.setFetch(() =>
      actual.createResponse(
        JSON.stringify({
          error: { code: 'rate_limited', message: 'Retry later' },
        }),
        429,
        { 'Retry-After': retryAfter },
      ),
    )
    const owner = actual.createOwner()
    try {
      await assert.rejects(owner.transport.snapshot(request()), (failure) => {
        assert.ok(hasCode(failure, 'rate_limited'))
        assert.ok(
          typeof failure === 'object' &&
            failure !== null &&
            'status' in failure &&
            'retryAfterMilliseconds' in failure &&
            'message' in failure,
        )
        assert.equal(failure.status, 429)
        assert.equal(failure.message, 'Retry later')
        assert.equal(
          failure.retryAfterMilliseconds,
          retryAfter === 'invalid' ? undefined : Number(retryAfter) * 1000,
        )
        return true
      })
      assert.ok(
        actual.events.indexOf('header:Retry-After') >
          actual.events.indexOf('stage:jsonDecode'),
      )
      assert.equal(
        actual.events.filter((event) => event === 'header:Retry-After').length,
        1,
      )
      assert.equal(actual.events.includes('phase:shapeValidation'), false)
    } finally {
      await owner.close()
      actual.assertClean()
    }
  })
}

test('C55 delayed Retry-After public Header failure retains original error identity after decode', async () => {
  const actual = actualTransport()
  const failure = new Error('owned Retry-After getter failure')
  const response = actual.createResponse('{}', 429)
  const read = response.headers.get.bind(response.headers)
  response.headers.get = (name) => {
    if (name === 'Retry-After') {
      assert.ok(actual.events.includes('stage:jsonDecode'))
      throw failure
    }
    return read(name)
  }
  actual.setFetch(() => response)
  const owner = actual.createOwner()
  try {
    await assert.rejects(
      owner.transport.snapshot(request()),
      (value) => value === failure,
    )
  } finally {
    await owner.close()
    actual.assertClean()
  }
})

test('C55 malformed HTTP error body still fails decode before reading Retry-After', async () => {
  const actual = actualTransport()
  actual.setFetch(() =>
    actual.createResponse('{invalid', 429, { 'Retry-After': '2' }),
  )
  const owner = actual.createOwner()
  try {
    await assert.rejects(owner.transport.snapshot(request()))
    assert.equal(actual.events.includes('header:Retry-After'), false)
  } finally {
    await owner.close()
    actual.assertClean()
  }
})

test('C55 public response status error fails before consuming its body', async () => {
  const actual = actualTransport()
  actual.setFetch(() => actual.Response.error())
  const owner = actual.createOwner()
  try {
    await assert.rejects(
      owner.transport.snapshot(request()),
      /Invalid native HTTP status/,
    )
    assert.equal(actual.textCalls(), 0)
  } finally {
    await owner.close()
    actual.assertClean()
  }
})

test('C55 public response above64MiB retains size error status before decode', async () => {
  const actual = actualTransport()
  actual.setFetch(() =>
    actual.createResponse('x'.repeat(64 * 1024 * 1024 + 1), 413),
  )
  const owner = actual.createOwner()
  try {
    await assert.rejects(owner.transport.snapshot(request()), (failure) => {
      assert.ok(hasCode(failure, 'schema_mismatch'))
      assert.ok(
        typeof failure === 'object' && failure !== null && 'status' in failure,
      )
      assert.equal(failure.status, 413)
      return true
    })
    assert.equal(actual.events.includes('phase:jsonDecode'), false)
  } finally {
    await owner.close()
    actual.assertClean()
  }
})

for (const boundary of ['authenticate', 'fetch', 'text'] as const) {
  for (const disposition of ['resolve', 'reject'] as const) {
    test(
      `C55 cancel pending ${boundary} preserves auth notification and handles late ${disposition}`,
      { timeout: 5000 },
      async () => {
        const actual = actualTransport()
        const entered = deferred<void>()
        const pending = deferred<unknown>()
        let notifications = 0
        const response = actual.createResponse(
          JSON.stringify({ ...request(), payload: payload() }),
        )
        const owner = actual.createOwner({
          authenticate(identity, lifecycle) {
            lifecycle.subscribe(() => {
              notifications += 1
            })
            if (boundary === 'authenticate') {
              entered.resolve()
              return pending.promise.then(() => ({
                session: identity.session,
                headers: {},
              }))
            }
            return { session: identity.session, headers: {} }
          },
        })
        if (boundary === 'fetch')
          actual.setFetch(() => {
            entered.resolve()
            return pending.promise.then(() => response)
          })
        if (boundary === 'text') {
          response.text = () => {
            entered.resolve()
            return pending.promise.then(() =>
              JSON.stringify({ ...request(), payload: payload() }),
            )
          }
          actual.setFetch(() => response)
        }
        const rejected = assert.rejects(
          owner.transport.snapshot(request()),
          (failure) => hasCode(failure, 'session_changed'),
        )
        try {
          await entered.promise
          owner.cancelPending()
          owner.cancelPending()
          await rejected
          if (disposition === 'resolve') pending.resolve(undefined)
          else pending.reject(new Error('late owned operand failure'))
          await nextTurn()
          assert.equal(notifications, 1)
        } finally {
          await owner.close()
          actual.assertClean()
        }
      },
    )
  }
}

for (const order of [
  'fulfill-first',
  'reject-first',
  'cancel-first',
] as const) {
  test(
    `C55 pending fetch queued ${order} still respects active-after and cancellation precedence`,
    { timeout: 5000 },
    async () => {
      const actual = actualTransport()
      const entered = deferred<void>()
      const pending = deferred<PublicResponse>()
      actual.setFetch(() => {
        entered.resolve()
        return pending.promise
      })
      const owner = actual.createOwner()
      const rejected = assert.rejects(
        owner.transport.snapshot(request()),
        (failure) => hasCode(failure, 'session_changed'),
      )
      try {
        await entered.promise
        if (order === 'fulfill-first')
          pending.resolve(
            actual.createResponse(
              JSON.stringify({ ...request(), payload: payload() }),
            ),
          )
        if (order === 'reject-first')
          pending.reject(new Error('first queued fetch failure'))
        owner.cancelPending()
        if (order === 'cancel-first')
          pending.resolve(actual.createResponse('{}'))
        await rejected
        assert.equal(actual.textCalls(), 0)
      } finally {
        await owner.close()
        actual.assertClean()
      }
    },
  )
}

for (const phase of ['jsonDecode', 'shapeValidation']) {
  test(
    `C55 actual response ${phase} cancellation cannot publish partial body and detaches host work`,
    { timeout: 5000 },
    async () => {
      const actual = actualTransport()
      actual.setFetch((sent) =>
        actual.createResponse(
          JSON.stringify({ ...sent, payload: payload(4000) }),
        ),
      )
      const owner: HttpOwner = actual.createOwner({
        observePhase(current) {
          actual.events.push(`phase:${current}`)
          if (current === phase)
            actual.onApplication(() => owner.cancelPending())
        },
      })
      try {
        await assert.rejects(owner.transport.snapshot(request()), (failure) =>
          hasCode(failure, 'session_changed'),
        )
        assert.equal(
          actual.stages.some((stage) => stage.phase === phase),
          false,
        )
      } finally {
        await owner.close()
        actual.assertClean()
      }
    },
  )
}

test(
  'C55 HTTP deadline still includes pending authentication and close drains exactly once',
  { timeout: 5000 },
  async () => {
    const actual = actualTransport()
    const owner = actual.createOwner({
      timeoutMilliseconds: 5,
      authenticate: () => new Promise(() => undefined),
    })
    try {
      await assert.rejects(owner.transport.snapshot(request()), (failure) =>
        hasCode(failure, 'transport_failed'),
      )
      assert.equal(actual.fetchCalls(), 0)
      const closing = owner.close()
      assert.equal(owner.close(), closing)
      await closing
    } finally {
      await owner.close()
      actual.assertClean()
    }
  },
)

for (const mutation of ['request', 'session', 'suspend', 'close'] as const) {
  test(
    `C55 ${mutation} change while response text is pending prevents stale publication`,
    { timeout: 5000 },
    async () => {
      const actual = actualTransport()
      const entered = deferred<void>()
      const pending = deferred<string>()
      const response = actual.createResponse('{}')
      response.text = () => {
        entered.resolve()
        return pending.promise
      }
      actual.setFetch(() => response)
      const owner = actual.createOwner()
      const sent = request()
      const rejected = assert.rejects(
        owner.transport.snapshot(sent),
        (failure) =>
          hasCode(
            failure,
            mutation === 'close' ? 'closed_database' : 'session_changed',
          ),
      )
      try {
        await entered.promise
        if (mutation === 'request')
          Object.assign(sent, { requestId: 'altered-request' })
        if (mutation === 'session')
          owner.setSession({ ...session, generation: 2 })
        if (mutation === 'suspend') owner.suspend()
        const closing = mutation === 'close' ? owner.close() : undefined
        pending.resolve(JSON.stringify({ ...request(), payload: payload() }))
        await rejected
        if (closing) await closing
        assert.equal(actual.events.includes('phase:jsonDecode'), false)
      } finally {
        await owner.close()
        actual.assertClean()
      }
    },
  )
}

test(
  'C55 closing concurrent HTTP requests cancels both auth subscriptions and returns the same close Promise',
  { timeout: 5000 },
  async () => {
    const actual = actualTransport()
    let subscriptions = 0
    const owner = actual.createOwner({
      authenticate(_identity, lifecycle) {
        lifecycle.subscribe(() => {
          subscriptions += 1
        })
        return new Promise(() => undefined)
      },
    })
    const rejected = [0, 1].map(() =>
      assert.rejects(owner.transport.snapshot(request()), (failure) =>
        hasCode(failure, 'closed_database'),
      ),
    )
    const closing = owner.close()
    assert.equal(owner.close(), closing)
    await closing
    await Promise.all(rejected)
    assert.equal(subscriptions, 2)
    assert.equal(actual.fetchCalls(), 0)
    actual.assertClean()
  },
)

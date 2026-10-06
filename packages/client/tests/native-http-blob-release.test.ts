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

interface PublicBody {
  readonly status: number
  readonly ok: boolean
  readonly headers: Headers
  readonly bodyUsed: boolean
  text(): Promise<string>
}
interface HttpOwner {
  transport: Transport
  cancelPending(): void
  suspend(): void
  setSession(session: Session): void
  close(): Promise<void>
}
interface Configuration {
  endpoint: string
  session: Session
  authenticate(
    identity: { session: Session },
    lifecycle: DigestLifecycle,
  ):
    | { session: Session; headers: Record<string, string> }
    | Promise<{ session: Session; headers: Record<string, string> }>
  timeoutMilliseconds: number
  nowMilliseconds(): number
  schedule(callback: () => void, delay: number): () => void
  observePhase(phase: string): void
  observeStage(stage: { phase: string }): void
}
interface FixtureOptions {
  pending?: 'fetch' | 'blob' | 'text'
  textThrows?: boolean
  textRejects?: boolean
  status?: number
  raw?: string
  fallback?: boolean
  foreignResponse?: boolean
  instanceBlobOverride?: boolean
  instanceTextOverride?: boolean
  subclassTextOverride?: boolean
  headerThrows?: boolean
  closeThrows?: boolean
  boundedHeaderFailure?: boolean
}
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const sourceDirectory = resolve(repository, 'packages/client/src/react-native')
const compiledSources = new Map<string, string>()
const session: Session = {
  accountId: 'blob-account',
  tenantId: 'blob-tenant',
  deviceId: 'blob-device',
  deviceEpoch: 'blob-epoch',
  generation: 1,
}
function request(): Envelope<{ dataset: string }> {
  return {
    protocolVersion: 1,
    requestId: 'blob-request',
    kind: 'snapshot',
    schemaFingerprint: 'blob-schema',
    session: { ...session },
    payload: { dataset: 'catalog' },
  }
}
function body() {
  return {
    ...request(),
    payload: {
      schemaFingerprint: 'blob-schema',
      dataset: 'catalog',
      generation: '1',
      cursor: '1',
      hash: 'blob-hash',
      byteSize: 0,
      records: [
        {
          model: 'Item',
          id: '1',
          revision: '1',
          attributes: { title: 'Příliš žluťoučký 😀' },
        },
      ],
      relationSets: [],
      scope: {
        dataset: 'catalog',
        authorizationGeneration: '1',
        projectionGeneration: '1',
        schemaFingerprint: 'blob-schema',
        completeness: 'complete',
      },
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
const nextTurn = () =>
  new Promise<void>((resolveTurn) => setImmediate(resolveTurn))
function hasCode(failure: unknown, code: string) {
  return (
    typeof failure === 'object' &&
    failure !== null &&
    'code' in failure &&
    failure.code === code
  )
}

// A public body ownership fixture models the RN close-capable Blob contract.
// The installed WHATWG/RN implementation and physical memory need separate native evidence.
function fixture(options: FixtureOptions = {}) {
  const events: string[] = []
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const applicationTasks = new Set<ReturnType<typeof setImmediate>>()
  const bodies: NativeBlob[] = []
  const responses: NativeResponse[] = []
  const fetchGate = deferred<PublicBody>()
  const blobGate = deferred<NativeBlob>()
  const textGate = deferred<string>()
  const primaryFailure = new Error('owned raw text failure')
  let clock = 0
  let fetchCount = 0
  let rawReadCount = 0
  let blobAcquisitions = 0
  let authCancellations = 0

  class NativeBlob {
    closed = false
    rawPending = false
    closeCalls = 0
    constructor(readonly content: string) {
      bodies.push(this)
    }
    readText(): Promise<string> {
      rawReadCount += 1
      events.push('raw:start')
      assert.equal(this.closed, false)
      if (options.textThrows) {
        events.push('raw:sync-throw')
        throw primaryFailure
      }
      this.rawPending = true
      const pending =
        options.pending === 'text'
          ? textGate.promise
          : options.textRejects
            ? Promise.reject(primaryFailure)
            : Promise.resolve(this.content)
      return pending.then(
        (content) => {
          assert.equal(
            this.closed,
            false,
            'Raw read must keep its native body until fulfillment',
          )
          this.rawPending = false
          events.push('raw:fulfilled')
          return content
        },
        (failure) => {
          assert.equal(
            this.closed,
            false,
            'Raw read must keep its native body until rejection',
          )
          this.rawPending = false
          events.push('raw:rejected')
          throw failure
        },
      )
    }
    close() {
      this.closeCalls += 1
      assert.equal(
        this.rawPending,
        false,
        'Cancellation cannot close a body while the raw reader still owns it',
      )
      if (options.closeThrows) throw new Error('owned close failure')
      assert.equal(this.closed, false, 'Native body must close exactly once')
      this.closed = true
      events.push('blob:close')
    }
  }
  class NativeResponse implements PublicBody {
    bodyUsed = false
    readonly status: number
    readonly ok: boolean
    readonly headers: Headers
    constructor(
      private readonly body: NativeBlob | string,
      settings: { status?: number; headers?: Record<string, string> } = {},
    ) {
      this.status = settings.status ?? 200
      this.ok = this.status >= 200 && this.status < 300
      this.headers = new Headers(settings.headers)
      responses.push(this)
    }
    blob(): Promise<NativeBlob> {
      if (this.bodyUsed) return Promise.reject(new TypeError('Already read'))
      this.bodyUsed = true
      blobAcquisitions += 1
      assert.ok(this.body instanceof NativeBlob)
      return options.pending === 'blob'
        ? blobGate.promise
        : Promise.resolve(this.body)
    }
    text(): Promise<string> {
      if (this.bodyUsed) return Promise.reject(new TypeError('Already read'))
      this.bodyUsed = true
      events.push('response:text')
      return this.body instanceof NativeBlob
        ? this.body.readText()
        : Promise.resolve(this.body)
    }
  }
  class OrdinaryResponse extends NativeResponse {}
  const content = options.raw ?? JSON.stringify(body())
  const nativeBody = new NativeBlob(content)
  const response: PublicBody = options.foreignResponse
    ? new Response(content, { status: options.status ?? 200 })
    : options.fallback
      ? new OrdinaryResponse(nativeBody, { status: options.status ?? 200 })
      : new NativeResponse(nativeBody, {
          status: options.status ?? 200,
          headers: {
            'Retry-After': '1.5',
            'Server-Timing': 'owned',
            'X-Synloquent-Profile': 'profile',
          },
        })
  const readHeader = response.headers.get.bind(response.headers)
  Object.defineProperty(response.headers, 'get', {
    value: (name: string) => {
      events.push(`header:${name}`)
      if (options.boundedHeaderFailure && name === 'Content-Length')
        return '16385'
      if (options.headerThrows && name === 'Server-Timing') throw primaryFailure
      assert.equal(nativeBody.rawPending, false)
      return readHeader(name)
    },
  })
  if (options.instanceBlobOverride && response instanceof NativeResponse) {
    response.blob = () => {
      throw new Error('Unsupported instance blob method must not be called')
    }
  }
  if (options.instanceTextOverride || options.foreignResponse) {
    const readText = response.text.bind(response)
    response.text = () => {
      events.push('custom:text')
      if (options.textThrows) throw primaryFailure
      return readText()
    }
  }
  if (options.subclassTextOverride && response instanceof NativeResponse) {
    class SubclassResponse extends NativeResponse {
      override text() {
        events.push('subclass:text')
        return super.text()
      }
    }
    Object.setPrototypeOf(response, SubclassResponse.prototype)
  }
  const schedule = (callback: () => void, delay: number) => {
    if (delay > 0) {
      const timer = setTimeout(() => {
        timers.delete(timer)
        callback()
      }, delay)
      timers.add(timer)
      return () => {
        clearTimeout(timer)
        timers.delete(timer)
      }
    }
    const task = setImmediate(() => {
      applicationTasks.delete(task)
      callback()
    })
    applicationTasks.add(task)
    return () => {
      clearImmediate(task)
      applicationTasks.delete(task)
    }
  }
  const context = createContext({
    AbortController,
    Promise,
    Blob: options.fallback ? Blob : NativeBlob,
    Response: NativeResponse,
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
      address: string,
      settings: {
        method: string
        body: string
        headers: Record<string, string>
        signal: AbortSignal
      },
    ) {
      fetchCount += 1
      assert.equal(address, 'https://owned.invalid/protocol')
      assert.equal(settings.method, 'POST')
      assert.equal(settings.headers['X-Synloquent-Device'], session.deviceId)
      assert.equal(settings.signal.aborted, false)
      assert.deepEqual(
        JSON.parse(settings.body),
        options.boundedHeaderFailure
          ? {
              ...request(),
              payload: { ...request().payload, delivery: 'parts-v1' },
            }
          : request(),
      )
      return options.pending === 'fetch'
        ? fetchGate.promise
        : Promise.resolve(response)
    },
  })
  const modules = new Map<string, object>()
  function load(filename: string): object {
    const existing = modules.get(filename)
    if (existing) return existing
    const actualFilename =
      process.env.SYNLOQUENT_NATIVE_HTTP_BLOB_BASELINE &&
      filename === resolve(sourceDirectory, 'http/transport.ts')
        ? resolve(process.env.SYNLOQUENT_NATIVE_HTTP_BLOB_BASELINE)
        : filename
    let compiled = compiledSources.get(actualFilename)
    if (!compiled) {
      compiled = typescript.transpileModule(
        readFileSync(actualFilename, 'utf8'),
        {
          compilerOptions: {
            target: typescript.ScriptTarget.ES2022,
            module: typescript.ModuleKind.CommonJS,
          },
        },
      ).outputText
      compiledSources.set(actualFilename, compiled)
    }
    const exported = {}
    modules.set(filename, exported)
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
    createReactNativeHttpTransport(configuration: Configuration): HttpOwner
  }
  const binding = exported.createReactNativeHttpTransport({
    endpoint: 'https://owned.invalid/protocol',
    session,
    timeoutMilliseconds: 60000,
    nowMilliseconds: () => clock,
    schedule,
    authenticate(identity, lifecycle) {
      lifecycle.subscribe(() => {
        authCancellations += 1
      })
      return { session: identity.session, headers: { Authorization: 'owned' } }
    },
    observePhase(phase) {
      events.push(`phase:${phase}`)
    },
    observeStage(stage) {
      events.push(`stage:${stage.phase}`)
    },
  })
  function start() {
    const promise = options.boundedHeaderFailure
      ? binding.transport.snapshotParts!(request())
      : binding.transport.snapshot(request())
    let state = 'pending'
    void promise.then(
      () => {
        state = 'fulfilled'
      },
      () => {
        state = 'rejected'
      },
    )
    return {
      promise,
      get state() {
        return state
      },
    }
  }
  return {
    binding,
    start,
    nativeBody,
    response,
    bodies,
    responses,
    events,
    fetchGate,
    blobGate,
    textGate,
    content,
    primaryFailure,
    get rawReadCount() {
      return rawReadCount
    },
    get blobAcquisitions() {
      return blobAcquisitions
    },
    get authCancellations() {
      return authCancellations
    },
    get fetchCount() {
      return fetchCount
    },
    expire() {
      clock = 60001
    },
    async dispose() {
      await binding.close()
      fetchGate.resolve(response)
      blobGate.resolve(nativeBody)
      textGate.resolve(content)
      await nextTurn()
      for (const timer of timers) clearTimeout(timer)
      for (const task of applicationTasks) clearImmediate(task)
      assert.equal(timers.size, 0)
      assert.equal(applicationTasks.size, 0)
    },
  }
}

async function withFixture(
  options: FixtureOptions,
  execute: (harness: ReturnType<typeof fixture>) => Promise<void>,
) {
  const harness = fixture(options)
  try {
    await execute(harness)
  } finally {
    await harness.dispose()
  }
}

test('native response uses the same Blob once and closes after raw text before decode', async () => {
  await withFixture({}, async (harness) => {
    const result = await harness.start().promise
    assert.equal(JSON.stringify(result), JSON.stringify(body().payload))
    assert.equal(harness.bodies.length, 1)
    assert.equal(harness.blobAcquisitions, 1)
    assert.equal(harness.rawReadCount, 1)
    assert.equal(harness.response.bodyUsed, true)
    assert.equal(harness.responses.length, 2)
    assert.equal(harness.responses[1]?.bodyUsed, true)
    assert.equal(harness.nativeBody.closeCalls, 1)
    assert.equal(harness.nativeBody.closed, true)
    assert.ok(
      harness.events.indexOf('raw:fulfilled') <
        harness.events.indexOf('blob:close'),
    )
    assert.ok(
      harness.events.indexOf('blob:close') <
        harness.events.indexOf('phase:jsonDecode'),
    )
    assert.equal(harness.authCancellations, 0)
  })
})
for (const ending of ['resolve', 'reject'] as const) {
  test(`pending raw text ${ending} closes only after settlement`, async () => {
    await withFixture({ pending: 'text' }, async (harness) => {
      const operation = harness.start()
      await nextTurn()
      assert.equal(harness.nativeBody.rawPending, true)
      assert.equal(harness.nativeBody.closeCalls, 0)
      if (ending === 'resolve') {
        harness.textGate.resolve(harness.content)
        await operation.promise
      } else {
        harness.textGate.reject(harness.primaryFailure)
        await assert.rejects(
          operation.promise,
          (failure) => failure === harness.primaryFailure,
        )
      }
      assert.equal(harness.nativeBody.rawPending, false)
      assert.equal(harness.nativeBody.closeCalls, 1)
      assert.equal(harness.nativeBody.closed, true)
    })
  })
  test(`cancelled raw text late ${ending} is handled without premature close`, async () => {
    await withFixture({ pending: 'text' }, async (harness) => {
      const operation = harness.start()
      await nextTurn()
      harness.binding.cancelPending()
      await assert.rejects(operation.promise, (failure) =>
        hasCode(failure, 'session_changed'),
      )
      await harness.binding.close()
      assert.equal(harness.nativeBody.rawPending, true)
      assert.equal(harness.nativeBody.closeCalls, 0)
      assert.equal(harness.authCancellations, 1)
      if (ending === 'resolve') harness.textGate.resolve(harness.content)
      else harness.textGate.reject(harness.primaryFailure)
      await nextTurn()
      assert.equal(harness.nativeBody.closeCalls, 1)
      assert.equal(harness.nativeBody.closed, true)
      assert.equal(harness.nativeBody.rawPending, false)
    })
  })
}
for (const stage of ['fetch', 'blob'] as const) {
  test(`cancelled ${stage} late fulfillment releases once without starting a raw read`, async () => {
    await withFixture({ pending: stage }, async (harness) => {
      const operation = harness.start()
      await nextTurn()
      harness.binding.suspend()
      await assert.rejects(operation.promise, (failure) =>
        hasCode(failure, 'session_changed'),
      )
      await harness.binding.close()
      assert.equal(harness.nativeBody.closeCalls, 0)
      if (stage === 'fetch') harness.fetchGate.resolve(harness.response)
      else harness.blobGate.resolve(harness.nativeBody)
      await nextTurn()
      assert.equal(harness.nativeBody.closeCalls, 1)
      assert.equal(harness.nativeBody.closed, true)
      assert.equal(harness.rawReadCount, 0)
    })
  })
  test(`cancelled ${stage} late rejection remains handled`, async () => {
    await withFixture({ pending: stage }, async (harness) => {
      const operation = harness.start()
      await nextTurn()
      harness.binding.suspend()
      await assert.rejects(operation.promise, (failure) =>
        hasCode(failure, 'session_changed'),
      )
      if (stage === 'fetch') harness.fetchGate.reject(harness.primaryFailure)
      else harness.blobGate.reject(harness.primaryFailure)
      await nextTurn()
      assert.equal(harness.rawReadCount, 0)
      assert.equal(harness.nativeBody.closeCalls, 0)
    })
  })
}
for (const options of [{ textThrows: true }, { textRejects: true }] as const) {
  test(`native raw failure retains the original error and releases (${JSON.stringify(options)})`, async () => {
    await withFixture(options, async (harness) => {
      await assert.rejects(
        harness.start().promise,
        (failure) => failure === harness.primaryFailure,
      )
      assert.equal(harness.nativeBody.closeCalls, 1)
      assert.equal(harness.nativeBody.closed, true)
    })
  })
}
for (const options of [{ status: 42 }, { headerThrows: true }] as const) {
  test(`pre-text native failure disposes unused ownership (${JSON.stringify(options)})`, async () => {
    await withFixture(options, async (harness) => {
      await assert.rejects(harness.start().promise)
      await nextTurn()
      assert.equal(harness.nativeBody.closeCalls, 1)
      assert.equal(harness.nativeBody.closed, true)
      assert.equal(harness.rawReadCount, 0)
    })
  })
}
test('status and original Retry-After metadata remain usable after Blob close', async () => {
  await withFixture(
    {
      status: 503,
      raw: JSON.stringify({ error: { code: 'busy', message: 'later' } }),
    },
    async (harness) => {
      await assert.rejects(harness.start().promise, (failure) => {
        assert.ok(hasCode(failure, 'busy'))
        assert.equal((failure as Error & { status: number }).status, 503)
        assert.equal(
          (failure as Error & { retryAfterMilliseconds: number })
            .retryAfterMilliseconds,
          1500,
        )
        return true
      })
      assert.equal(harness.nativeBody.closed, true)
      assert.ok(
        harness.events.indexOf('blob:close') <
          harness.events.indexOf('header:Retry-After'),
      )
    },
  )
})
for (const options of [
  { fallback: true },
  { foreignResponse: true },
  { instanceBlobOverride: true },
  { instanceTextOverride: true },
  { subclassTextOverride: true },
] as const) {
  test(`unsupported public body keeps direct text without blob consumption (${JSON.stringify(options)})`, async () => {
    await withFixture(options, async (harness) => {
      assert.equal(
        JSON.stringify(await harness.start().promise),
        JSON.stringify(body().payload),
      )
      assert.equal(harness.blobAcquisitions, 0)
      assert.equal(harness.nativeBody.closeCalls, 0)
      assert.equal(harness.response.bodyUsed, true)
    })
  })
}
for (const options of [
  { foreignResponse: true, textThrows: true },
  { instanceTextOverride: true, textThrows: true },
] as const) {
  test(`direct text synchronous throw preserves its original error (${JSON.stringify(options)})`, async () => {
    await withFixture(options, async (harness) => {
      await assert.rejects(
        harness.start().promise,
        (failure) => failure === harness.primaryFailure,
      )
      assert.equal(harness.blobAcquisitions, 0)
      assert.equal(harness.nativeBody.closeCalls, 0)
    })
  })
}
test('deadline after fetch preserves timeout priority and releases the late body', async () => {
  await withFixture({ pending: 'fetch' }, async (harness) => {
    const operation = harness.start()
    await nextTurn()
    harness.expire()
    harness.fetchGate.resolve(harness.response)
    await assert.rejects(operation.promise, (failure) =>
      hasCode(failure, 'transport_failed'),
    )
    await nextTurn()
    assert.equal(harness.nativeBody.closed, true)
    assert.equal(harness.rawReadCount, 0)
  })
})
for (const first of ['fulfillment', 'cancellation'] as const) {
  test(`queued raw ${first} keeps cancellation priority and closes once`, async () => {
    await withFixture({ pending: 'text' }, async (harness) => {
      const operation = harness.start()
      await nextTurn()
      if (first === 'fulfillment') {
        harness.textGate.resolve(harness.content)
        harness.binding.cancelPending()
      } else {
        harness.binding.cancelPending()
        harness.textGate.resolve(harness.content)
      }
      await assert.rejects(operation.promise, (failure) =>
        hasCode(failure, 'session_changed'),
      )
      await nextTurn()
      assert.equal(harness.nativeBody.closeCalls, 1)
      assert.equal(harness.nativeBody.closed, true)
    })
  })
}
test('release failure cannot replace the successful payload', async () => {
  await withFixture({ closeThrows: true }, async (harness) => {
    assert.equal(
      JSON.stringify(await harness.start().promise),
      JSON.stringify(body().payload),
    )
    assert.equal(harness.nativeBody.closeCalls, 1)
    assert.equal(harness.nativeBody.closed, false)
  })
})

test('a bounded pre-text rejection retains public body ownership until discard settles', async () => {
  const control = fixture({ pending: 'blob', boundedHeaderFailure: true })
  try {
    await assert.rejects(control.start().promise, (failure) =>
      hasCode(failure, 'schema_mismatch'),
    )
    assert.equal(control.blobAcquisitions, 1)
    assert.equal(control.nativeBody.closed, false)
    await assert.rejects(control.start().promise, (failure) =>
      hasCode(failure, 'snapshot_admission_required'),
    )
    assert.equal(control.fetchCount, 1)
    control.blobGate.resolve(control.nativeBody)
    await nextTurn()
    assert.equal(control.nativeBody.closed, true)
    assert.equal(control.nativeBody.closeCalls, 1)
    assert.equal(control.rawReadCount, 0)
  } finally {
    control.blobGate.resolve(control.nativeBody)
    await nextTurn()
    await control.dispose()
  }
})

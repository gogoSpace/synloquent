import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { test } from 'node:test'
import typescript from 'typescript'
import type { DigestLifecycle } from '../src/core/types.js'

interface NativeDigestResult {
  digest: string
  bytes: number
  cpuMilliseconds: number
  wallMilliseconds: number
}
interface NativeDigestBinding {
  start(): Promise<string>
  append(identifier: string, content: string): Promise<void>
  finish(identifier: string): Promise<NativeDigestResult>
  cancel(identifier: string): Promise<void>
}
interface DigestConfiguration {
  nowMilliseconds?: () => number
  yieldToApplication?: () => Promise<void>
  observeNativeContinuation?: () => void
  observeDigest?: (measurement: {
    nativeHashBytes: number
    nativeHashChunks: number
    maximumBufferedUtf16Units: number
  }) => void
}
interface DigestProvider {
  digest(content: string, lifecycle?: DigestLifecycle): Promise<string>
  digestChunks(
    chunks: AsyncIterable<string>,
    lifecycle?: DigestLifecycle,
  ): Promise<string>
  close(): Promise<void>
}
interface ProviderExports {
  createNativeCryptoProvider(
    configuration?: DigestConfiguration,
  ): DigestProvider
  createNativeDigestLifecycle(): {
    lifecycle: DigestLifecycle
    cancel(): void
  }
}

const compiledProvider = readFile(
  process.env.SYNLOQUENT_NATIVE_CRYPTO_BASELINE
    ? resolve(process.env.SYNLOQUENT_NATIVE_CRYPTO_BASELINE)
    : new URL('../src/native-crypto/index.ts', import.meta.url),
  'utf8',
).then((source) => {
  const withoutBindingImport = source.replace(
    /^import NativeSynloquentCrypto from '[^']+'\n/,
    '',
  )
  assert.notEqual(withoutBindingImport, source)
  return typescript.transpileModule(withoutBindingImport, {
    compilerOptions: {
      target: typescript.ScriptTarget.ES2022,
      module: typescript.ModuleKind.CommonJS,
    },
  }).outputText
})

async function loadProvider(
  native: NativeDigestBinding,
  promiseConstructor: PromiseConstructor = Promise,
) {
  const exported: Partial<ProviderExports> = {}
  new Function(
    'NativeSynloquentCrypto',
    'exports',
    'Promise',
    await compiledProvider,
  )(native, exported, promiseConstructor)
  assert.ok(exported.createNativeCryptoProvider)
  assert.ok(exported.createNativeDigestLifecycle)
  return {
    createProvider: exported.createNativeCryptoProvider,
    createLifecycle: exported.createNativeDigestLifecycle,
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

function observedPromises() {
  interface Observation {
    settled: boolean
    pendingSubscriptions: number
  }
  const observations: Observation[] = []
  const promises = new WeakMap<object, Observation>()
  class ObservedPromise<Value> extends Promise<Value> {
    constructor(
      executor: (
        resolveValue: (value: Value | PromiseLike<Value>) => void,
        rejectValue: (reason?: unknown) => void,
      ) => void,
    ) {
      const observation = { settled: false, pendingSubscriptions: 0 }
      super((resolveValue, rejectValue) => {
        executor(
          (value) => {
            observation.settled = true
            resolveValue(value)
          },
          (failure) => {
            observation.settled = true
            rejectValue(failure)
          },
        )
      })
      observations.push(observation)
      promises.set(this, observation)
    }
    override then<Fulfilled = Value, Rejected = never>(
      onfulfilled?:
        ((value: Value) => Fulfilled | PromiseLike<Fulfilled>) | null,
      onrejected?:
        ((reason: unknown) => Rejected | PromiseLike<Rejected>) | null,
    ): Promise<Fulfilled | Rejected> {
      const observation = promises.get(this)
      assert.ok(observation)
      if (!observation.settled) observation.pendingSubscriptions += 1
      return super.then(onfulfilled, onrejected)
    }
  }
  return {
    constructor: ObservedPromise,
    maximumPendingSubscriptions: () =>
      Math.max(0, ...observations.map((item) => item.pendingSubscriptions)),
    unresolvedSubscriptions: () =>
      observations
        .filter((item) => !item.settled)
        .map((item) => item.pendingSubscriptions),
  }
}

interface BindingHooks {
  start?: (identifier: string) => Promise<string>
  append?: (identifier: string, content: string) => Promise<void>
  finish?: (
    identifier: string,
    result: NativeDigestResult,
  ) => Promise<NativeDigestResult>
  cancel?: (identifier: string) => Promise<void>
}
function nativeBinding(hooks: BindingHooks = {}) {
  const contexts = new Map<
    string,
    { hash: ReturnType<typeof createHash>; bytes: number }
  >()
  const started: string[] = []
  const cancelled: string[] = []
  const appendedUnits: number[] = []
  const finished: string[] = []
  const binding: NativeDigestBinding = {
    start() {
      const identifier = `owned-digest-${started.length}`
      started.push(identifier)
      contexts.set(identifier, { hash: createHash('sha256'), bytes: 0 })
      return hooks.start?.(identifier) ?? Promise.resolve(identifier)
    },
    append(identifier, content) {
      const context = contexts.get(identifier)
      assert.ok(context)
      assert.ok(content.length <= 65536)
      context.hash.update(content)
      context.bytes += Buffer.byteLength(content)
      appendedUnits.push(content.length)
      return hooks.append?.(identifier, content) ?? Promise.resolve()
    },
    finish(identifier) {
      const context = contexts.get(identifier)
      assert.ok(context)
      finished.push(identifier)
      const result = {
        digest: context.hash.digest('hex'),
        bytes: context.bytes,
        cpuMilliseconds: 1,
        wallMilliseconds: 2,
      }
      return hooks.finish?.(identifier, result) ?? Promise.resolve(result)
    },
    cancel(identifier) {
      assert.ok(contexts.has(identifier))
      cancelled.push(identifier)
      return hooks.cancel?.(identifier) ?? Promise.resolve()
    },
  }
  return { binding, started, cancelled, appendedUnits, finished }
}

function producer(
  pieces: string[],
  request?: () => Promise<IteratorResult<string>>,
  returned?: () => Promise<IteratorResult<string>>,
) {
  let position = 0
  let returnCount = 0
  let nextCount = 0
  const chunks: AsyncIterable<string> = {
    [Symbol.asyncIterator]() {
      return {
        next() {
          nextCount += 1
          if (request) return request()
          const value = pieces[position++]
          return Promise.resolve(
            value === undefined
              ? { done: true, value: undefined }
              : { done: false, value },
          )
        },
        return() {
          returnCount += 1
          return (
            returned?.() ?? Promise.resolve({ done: true, value: undefined })
          )
        },
      }
    },
  }
  return { chunks, returnCount: () => returnCount, nextCount: () => nextCount }
}

for (const count of [16, 64, 256]) {
  test(
    `C51 native cancellation pending Promise reactions remain bounded for ${count} producer waits`,
    { timeout: 5000 },
    async () => {
      const observation = observedPromises()
      const native = nativeBinding()
      const { createProvider } = await loadProvider(
        native.binding,
        observation.constructor,
      )
      const provider = createProvider({ nowMilliseconds: () => 0 })
      const chunk = 'x'.repeat(4096)
      const expected = createHash('sha256')
      async function* chunks() {
        for (let index = 0; index < count; index++) {
          expected.update(chunk)
          yield chunk
        }
      }
      try {
        assert.equal(
          await provider.digestChunks(chunks()),
          expected.digest('hex'),
        )
        assert.equal(native.finished.length, 1)
        assert.deepEqual(native.cancelled, [])
        // Only public constructor and then hooks are observed. No Promise or payload
        // is retained by these counters, and no garbage collection is requested.
        // Resolve adoption is not a settlement clock. The never-resolved cancellation
        // operand is measured exactly until cancellation or successful completion.
        assert.ok(
          observation.maximumPendingSubscriptions() <= 2,
          `A pending Promise accumulated ${observation.maximumPendingSubscriptions()} reactions for ${count} waits`,
        )
        assert.ok(
          observation.unresolvedSubscriptions().every((value) => value <= 1),
        )
      } finally {
        await provider.close()
      }
    },
  )
}

for (const pieces of [
  [],
  ['ordinary text'],
  ['a'.repeat(65535) + '\ud83d', '\ude00', '\ud800', 'z'],
]) {
  test(`C55 native cancellation repair preserves SHA256 and canonical Unicode for ${pieces.length} input pieces`, async () => {
    const native = nativeBinding()
    const { createProvider } = await loadProvider(native.binding)
    const produced = producer(pieces)
    let observedBytes = -1
    const provider = createProvider({
      nowMilliseconds: () => 0,
      observeNativeContinuation() {
        throw new Error('isolated continuation observer')
      },
      observeDigest(measurement) {
        observedBytes = measurement.nativeHashBytes
        assert.equal(measurement.maximumBufferedUtf16Units, 65536)
        assert.equal(measurement.nativeHashChunks, native.appendedUnits.length)
      },
    })
    try {
      assert.equal(
        await provider.digestChunks(produced.chunks),
        createHash('sha256').update(pieces.join('')).digest('hex'),
      )
      assert.equal(observedBytes, Buffer.byteLength(pieces.join('')))
      assert.equal(produced.returnCount(), 0)
      assert.deepEqual(native.cancelled, [])
      assert.ok(native.appendedUnits.every((value) => value <= 65536))
    } finally {
      await provider.close()
    }
  })
}

const stages = ['start', 'producer', 'append', 'yield', 'finish'] as const
for (const stage of stages) {
  for (const disposition of ['resolve', 'reject'] as const) {
    test(
      `C51 cancelling pending ${stage} handles late ${disposition} and releases exactly its context`,
      { timeout: 5000 },
      async () => {
        const entered = deferred<void>()
        const pending = deferred<unknown>()
        const lateFailure = new Error(`late ${stage} failure`)
        const unhandled: unknown[] = []
        const onUnhandled = (failure: unknown) => unhandled.push(failure)
        process.on('unhandledRejection', onUnhandled)
        let milliseconds = 0
        let expectedResult: NativeDigestResult | undefined
        const hooks: BindingHooks = {}
        if (stage === 'start')
          hooks.start = () => {
            entered.resolve()
            return pending.promise.then((value) => String(value))
          }
        if (stage === 'append')
          hooks.append = () => {
            entered.resolve()
            return pending.promise.then(() => undefined)
          }
        if (stage === 'finish')
          hooks.finish = (_, result) => {
            expectedResult = result
            entered.resolve()
            return pending.promise.then(() => result)
          }
        const native = nativeBinding(hooks)
        const { createProvider, createLifecycle } = await loadProvider(
          native.binding,
        )
        const lifecycle = createLifecycle()
        const produced = producer(
          [stage === 'append' ? 'x'.repeat(65536) : 'content'],
          stage === 'producer'
            ? () => {
                entered.resolve()
                return pending.promise.then(() => ({
                  done: false,
                  value: 'late content',
                }))
              }
            : undefined,
        )
        const provider = createProvider({
          nowMilliseconds: () => milliseconds,
          ...(stage === 'yield'
            ? {
                yieldToApplication() {
                  entered.resolve()
                  return pending.promise.then(() => undefined)
                },
              }
            : {}),
        })
        const operation = provider.digestChunks(
          produced.chunks,
          lifecycle.lifecycle,
        )
        const rejected = assert.rejects(operation, {
          name: 'NativeDigestCancelledError',
        })
        if (stage === 'yield') milliseconds = 5
        try {
          await entered.promise
          lifecycle.cancel()
          lifecycle.cancel()
          if (disposition === 'reject') pending.reject(lateFailure)
          else
            pending.resolve(
              stage === 'start' ? native.started[0] : expectedResult,
            )
          await rejected
          await nextTurn()
          assert.deepEqual(unhandled, [])
          assert.deepEqual(
            native.cancelled,
            stage === 'start' && disposition === 'reject' ? [] : native.started,
          )
          assert.equal(native.started.length, 1)
          assert.equal(
            produced.returnCount(),
            stage === 'start' || stage === 'finish' ? 0 : 1,
          )
        } finally {
          await provider.close()
          process.off('unhandledRejection', onUnhandled)
        }
      },
    )
  }
}

for (const order of [
  'fulfill-first',
  'cancel-first',
  'reject-first',
] as const) {
  test(
    `C51 finish queued ${order} preserves the existing Promise race winner`,
    { timeout: 5000 },
    async () => {
      const entered = deferred<NativeDigestResult>()
      const pending = deferred<NativeDigestResult>()
      const native = nativeBinding({
        finish: (_, result) => {
          entered.resolve(result)
          return pending.promise
        },
      })
      const { createProvider, createLifecycle } = await loadProvider(
        native.binding,
      )
      const lifecycle = createLifecycle()
      const provider = createProvider({ nowMilliseconds: () => 0 })
      const operation = provider.digest('queued finish', lifecycle.lifecycle)
      const failure = new Error('original native finish failure')
      const checked =
        order === 'fulfill-first'
          ? operation.then((digest) =>
              assert.equal(
                digest,
                createHash('sha256').update('queued finish').digest('hex'),
              ),
            )
          : assert.rejects(
              operation,
              order === 'reject-first'
                ? (value) => value === failure
                : { name: 'NativeDigestCancelledError' },
            )
      try {
        const result = await entered.promise
        if (order === 'fulfill-first') pending.resolve(result)
        if (order === 'reject-first') pending.reject(failure)
        lifecycle.cancel()
        if (order === 'cancel-first') pending.resolve(result)
        await checked
        assert.deepEqual(native.cancelled, native.started)
      } finally {
        await provider.close()
      }
    },
  )
}

test(
  'C51 close is idempotent and drains a pending start and its owned native cancellation',
  { timeout: 5000 },
  async () => {
    const pendingStart = deferred<string>()
    const pendingCancellation = deferred<void>()
    const native = nativeBinding({
      start: () => pendingStart.promise,
      cancel: () => pendingCancellation.promise,
    })
    const { createProvider } = await loadProvider(native.binding)
    const provider = createProvider({ nowMilliseconds: () => 0 })
    const produced = producer(['not acquired'])
    const operation = provider.digestChunks(produced.chunks)
    const rejected = assert.rejects(operation, {
      name: 'NativeDigestCancelledError',
    })
    const closing = provider.close()
    assert.equal(provider.close(), closing)
    let closed = false
    void closing.then(() => {
      closed = true
    })
    await nextTurn()
    assert.equal(closed, false)
    assert.deepEqual(native.cancelled, [])
    await assert.rejects(provider.digest('new stream'), {
      name: 'NativeDigestCancelledError',
    })
    pendingStart.resolve(native.started[0]!)
    await nextTurn()
    assert.deepEqual(native.cancelled, native.started)
    assert.equal(closed, false)
    pendingCancellation.resolve()
    await rejected
    await closing
    assert.equal(closed, true)
    assert.equal(produced.nextCount(), 0)
    assert.equal(produced.returnCount(), 0)
  },
)

for (const returnBehavior of ['pending', 'reject', 'throw'] as const) {
  test(
    `C51 cancelled producer return ${returnBehavior} is requested once without retaining native cleanup`,
    { timeout: 5000 },
    async () => {
      const entered = deferred<void>()
      const pendingProducer = deferred<IteratorResult<string>>()
      const pendingReturn = deferred<IteratorResult<string>>()
      const native = nativeBinding()
      const { createProvider, createLifecycle } = await loadProvider(
        native.binding,
      )
      const lifecycle = createLifecycle()
      const produced = producer(
        [],
        () => {
          entered.resolve()
          return pendingProducer.promise
        },
        () => {
          if (returnBehavior === 'throw') throw new Error('return failure')
          if (returnBehavior === 'reject')
            return Promise.reject(new Error('return rejection'))
          return pendingReturn.promise
        },
      )
      const provider = createProvider({ nowMilliseconds: () => 0 })
      const operation = provider.digestChunks(
        produced.chunks,
        lifecycle.lifecycle,
      )
      const rejected = assert.rejects(operation, {
        name: 'NativeDigestCancelledError',
      })
      await entered.promise
      lifecycle.cancel()
      await rejected
      await provider.close()
      await nextTurn()
      assert.equal(produced.returnCount(), 1)
      assert.deepEqual(native.cancelled, native.started)
      pendingProducer.reject(new Error('late producer failure'))
      pendingReturn.resolve({ done: true, value: undefined })
      await nextTurn()
    },
  )
}

test(
  'C51 cancelling one concurrent digest leaves the other digest and lifecycle intact',
  { timeout: 5000 },
  async () => {
    const entered = deferred<void>()
    const pendingProducer = deferred<IteratorResult<string>>()
    const native = nativeBinding()
    const { createProvider, createLifecycle } = await loadProvider(
      native.binding,
    )
    const lifecycle = createLifecycle()
    const produced = producer([], () => {
      entered.resolve()
      return pendingProducer.promise
    })
    const provider = createProvider({ nowMilliseconds: () => 0 })
    const cancelled = assert.rejects(
      provider.digestChunks(produced.chunks, lifecycle.lifecycle),
      { name: 'NativeDigestCancelledError' },
    )
    await entered.promise
    const successful = provider.digest('independent stream')
    lifecycle.cancel()
    assert.equal(
      await successful,
      createHash('sha256').update('independent stream').digest('hex'),
    )
    await cancelled
    await provider.close()
    assert.deepEqual(native.cancelled, [native.started[0]])
    assert.equal(produced.returnCount(), 1)
    pendingProducer.reject(new Error('late cancelled stream failure'))
    await nextTurn()
  },
)

test('C51 already cancelled lifecycle never starts a native context', async () => {
  const native = nativeBinding()
  const { createProvider, createLifecycle } = await loadProvider(native.binding)
  const lifecycle = createLifecycle()
  lifecycle.cancel()
  const provider = createProvider({ nowMilliseconds: () => 0 })
  await assert.rejects(provider.digest('not started', lifecycle.lifecycle), {
    name: 'NativeDigestCancelledError',
  })
  await provider.close()
  assert.deepEqual(native.started, [])
})

for (const stage of [
  'start',
  'producer',
  'append',
  'yield',
  'finish',
] as const) {
  test(
    `C51 ordinary ${stage} rejection preserves failure identity and native cleanup`,
    { timeout: 5000 },
    async () => {
      const failure = new Error(`original ${stage} error`)
      let milliseconds = 0
      const native = nativeBinding({
        ...(stage === 'start' ? { start: () => Promise.reject(failure) } : {}),
        ...(stage === 'append'
          ? { append: () => Promise.reject(failure) }
          : {}),
        ...(stage === 'finish'
          ? { finish: () => Promise.reject(failure) }
          : {}),
      })
      const { createProvider } = await loadProvider(native.binding)
      const produced = producer(
        ['x'.repeat(65536)],
        stage === 'producer' ? () => Promise.reject(failure) : undefined,
      )
      const provider = createProvider({
        nowMilliseconds: () => milliseconds,
        ...(stage === 'yield'
          ? { yieldToApplication: () => Promise.reject(failure) }
          : {}),
      })
      const operation = provider.digestChunks(produced.chunks)
      if (stage === 'yield') milliseconds = 5
      await assert.rejects(operation, (value) => value === failure)
      await provider.close()
      assert.deepEqual(
        native.cancelled,
        stage === 'start' ? [] : native.started,
      )
      assert.equal(
        produced.returnCount(),
        stage === 'start' || stage === 'finish' ? 0 : 1,
      )
    },
  )
}

for (const stage of ['producer', 'append', 'yield', 'finish'] as const) {
  test(
    `C51 synchronous cancellation inside ${stage} observes an already cancelled current wait and handles its late rejection`,
    { timeout: 5000 },
    async () => {
      const pending = deferred<never>()
      let cancel: () => void = () => undefined
      let milliseconds = 0
      const cancelBeforeReturning = () => {
        cancel()
        return pending.promise
      }
      const native = nativeBinding({
        ...(stage === 'append' ? { append: cancelBeforeReturning } : {}),
        ...(stage === 'finish' ? { finish: cancelBeforeReturning } : {}),
      })
      const { createProvider, createLifecycle } = await loadProvider(
        native.binding,
      )
      const lifecycle = createLifecycle()
      cancel = lifecycle.cancel
      const produced = producer(
        [stage === 'append' ? 'x'.repeat(65536) : 'content'],
        stage === 'producer' ? cancelBeforeReturning : undefined,
      )
      const provider = createProvider({
        nowMilliseconds: () => milliseconds,
        ...(stage === 'yield'
          ? { yieldToApplication: cancelBeforeReturning }
          : {}),
      })
      const operation = provider.digestChunks(
        produced.chunks,
        lifecycle.lifecycle,
      )
      if (stage === 'yield') milliseconds = 5
      await assert.rejects(operation, { name: 'NativeDigestCancelledError' })
      await provider.close()
      assert.deepEqual(native.cancelled, native.started)
      assert.equal(produced.returnCount(), stage === 'finish' ? 0 : 1)
      pending.reject(
        new Error(`late synchronous ${stage} cancellation failure`),
      )
      await nextTurn()
    },
  )
}

test(
  'C51 closing three concurrent pending producers cancels each context once without waiting for producer completion',
  { timeout: 5000 },
  async () => {
    const native = nativeBinding()
    const { createProvider } = await loadProvider(native.binding)
    const provider = createProvider({ nowMilliseconds: () => 0 })
    const controls = Array.from({ length: 3 }, () => {
      const entered = deferred<void>()
      const pending = deferred<IteratorResult<string>>()
      const produced = producer([], () => {
        entered.resolve()
        return pending.promise
      })
      const rejected = assert.rejects(provider.digestChunks(produced.chunks), {
        name: 'NativeDigestCancelledError',
      })
      return { entered, pending, produced, rejected }
    })
    await Promise.all(controls.map((control) => control.entered.promise))
    const closing = provider.close()
    assert.equal(provider.close(), closing)
    await closing
    await Promise.all(controls.map((control) => control.rejected))
    assert.deepEqual(native.cancelled, native.started)
    assert.equal(new Set(native.cancelled).size, 3)
    for (const control of controls) {
      assert.equal(control.produced.returnCount(), 1)
      control.pending.reject(new Error('late close producer failure'))
    }
    await nextTurn()
  },
)

test(
  'C51 cancellation preserves native cleanup rejection identity and close drain behavior',
  { timeout: 5000 },
  async () => {
    const entered = deferred<void>()
    const pendingProducer = deferred<IteratorResult<string>>()
    const pendingCancellation = deferred<void>()
    const failure = new Error('owned native cancellation failed')
    const native = nativeBinding({ cancel: () => pendingCancellation.promise })
    const { createProvider } = await loadProvider(native.binding)
    const produced = producer([], () => {
      entered.resolve()
      return pendingProducer.promise
    })
    const provider = createProvider({ nowMilliseconds: () => 0 })
    const rejected = assert.rejects(
      provider.digestChunks(produced.chunks),
      (value) => value === failure,
    )
    await entered.promise
    const closing = provider.close()
    const closeRejected = assert.rejects(closing, (value) => value === failure)
    assert.equal(provider.close(), closing)
    pendingCancellation.reject(failure)
    await rejected
    await closeRejected
    assert.deepEqual(native.cancelled, native.started)
    assert.equal(produced.returnCount(), 1)
    pendingProducer.reject(new Error('late producer failure'))
    await nextTurn()
  },
)

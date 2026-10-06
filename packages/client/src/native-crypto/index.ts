import NativeSynloquentCrypto from './specs/NativeSynloquentCrypto.js'

export interface NativeDigestMeasurement {
  readonly maximumDigestSliceMilliseconds: number
  readonly maximumIteratorDispatchMilliseconds: number
  readonly maximumIteratorAwaitMilliseconds: number
  readonly iteratorAwaitMilliseconds: number
  readonly hashingMilliseconds: number
  readonly nativeHashCpuMilliseconds: number
  readonly nativeHashWallMilliseconds: number
  readonly nativeHashBytes: number
  readonly nativeHashChunks: number
  readonly implementation: 'system SHA256 on a serial native worker'
  readonly maximumBufferedUtf16Units: 65536
}
export interface NativeCryptoConfiguration {
  readonly maximumBufferedUnits?: () => number
  readonly nowMilliseconds?: () => number
  readonly yieldToApplication?: () => Promise<void>
  readonly observeNativeContinuation?: () => void
  readonly observeDigest?: (measurement: NativeDigestMeasurement) => void
}
export interface NativeDigestLifecycle {
  readonly cancelled: boolean
  subscribe(listener: () => void): () => void
}
export interface NativeCryptoProvider {
  digest(content: string, lifecycle?: NativeDigestLifecycle): Promise<string>
  digestChunks(
    chunks: AsyncIterable<string>,
    lifecycle?: NativeDigestLifecycle,
  ): Promise<string>
  close(): Promise<void>
}
export class NativeDigestCancelledError extends Error {
  constructor() {
    super('The native digest stream was cancelled.')
    this.name = 'NativeDigestCancelledError'
  }
}
export function createNativeDigestLifecycle(): {
  readonly lifecycle: NativeDigestLifecycle
  cancel(): void
} {
  let cancelled = false
  const listeners = new Set<() => void>()
  return {
    lifecycle: {
      get cancelled() {
        return cancelled
      },
      subscribe(listener) {
        if (cancelled) {
          listener()
          return () => undefined
        }
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
    },
    cancel() {
      if (cancelled) return
      cancelled = true
      for (const listener of listeners) {
        try {
          listener()
        } catch {
          /* Cancellation reaches every subscribed stream. */
        }
      }
      listeners.clear()
    },
  }
}

/** Optional React Native entry. Each stream owns one bounded system SHA256 context. */
export function createNativeCryptoProvider(
  options: NativeCryptoConfiguration = {},
): NativeCryptoProvider {
  const nowMilliseconds =
    options.nowMilliseconds ??
    (() => {
      const clock = (
        globalThis as typeof globalThis & {
          readonly performance?: { now(): number }
        }
      ).performance
      if (!clock)
        throw new Error('Native crypto requires a monotonic application clock.')
      return clock.now()
    })
  const observeNativeContinuation = () => {
    try {
      options.observeNativeContinuation?.()
    } catch {
      /* Diagnostic observers never change a hash stream. */
    }
  }
  const bufferLimit = (): number => {
    const value = options.maximumBufferedUnits?.() ?? 65536
    if (!Number.isSafeInteger(value) || value < 16384 || value > 65536)
      throw new Error('Native digest buffer budget is invalid.')
    return value
  }
  const operations = new Set<{ cancel(): void; cleanup(): Promise<void> }>()
  let closed = false
  let closing: Promise<void> | undefined
  async function digestChunks(
    chunks: AsyncIterable<string>,
    lifecycle?: NativeDigestLifecycle,
  ): Promise<string> {
    if (closed || lifecycle?.cancelled) throw new NativeDigestCancelledError()
    let maximumDigestSliceMilliseconds = 0
    let maximumIteratorDispatchMilliseconds = 0
    let maximumIteratorAwaitMilliseconds = 0
    let iteratorAwaitMilliseconds = 0
    let hashingMilliseconds = 0
    let nativeHashChunks = 0
    let previousYield = nowMilliseconds()
    let cancelled = false
    let nativeStarted: Promise<string> | undefined
    let nativeFinalized = false
    let cleanupOperation: Promise<void> | undefined
    let iterator: AsyncIterator<string> | undefined
    let iteratorDone = false
    let iteratorReturnRequested = false
    let unsubscribe: () => void = () => undefined
    let cancellationFailure: NativeDigestCancelledError | undefined
    const cancellationListeners = new Set<(failure: Error) => void>()
    const requestIteratorReturn = () => {
      if (!iterator || iteratorDone || iteratorReturnRequested) return
      iteratorReturnRequested = true
      try {
        const returned = iterator.return?.()
        if (returned) void Promise.resolve(returned).catch(() => undefined)
      } catch {
        /* Producer cleanup cannot retain a cancelled native context. */
      }
    }
    const cleanup = (): Promise<void> => {
      requestIteratorReturn()
      if (!cleanupOperation)
        cleanupOperation =
          nativeFinalized || !nativeStarted
            ? Promise.resolve()
            : nativeStarted.then(
                (identifier) => NativeSynloquentCrypto.cancel(identifier),
                () => undefined,
              )
      return cleanupOperation
    }
    const operation = {
      cancel() {
        if (cancelled || nativeFinalized) return
        cancelled = true
        cancellationFailure = new NativeDigestCancelledError()
        for (const listener of cancellationListeners)
          listener(cancellationFailure)
        cancellationListeners.clear()
        void cleanup().catch(() => undefined)
      },
      cleanup,
    }
    operations.add(operation)
    const race = <Result>(pending: Promise<Result>): Promise<Result> =>
      new Promise<Result>((resolveResult, rejectResult) => {
        let rejectCurrentCancellation: (failure: Error) => void = () =>
          undefined
        const cancellation = new Promise<never>((_, reject) => {
          rejectCurrentCancellation = reject
        })
        Promise.resolve(pending).then(
          (result) => {
            cancellationListeners.delete(rejectCurrentCancellation)
            resolveResult(result)
          },
          (failure) => {
            cancellationListeners.delete(rejectCurrentCancellation)
            rejectResult(failure)
          },
        )
        void cancellation.catch((failure) => {
          cancellationListeners.delete(rejectCurrentCancellation)
          rejectResult(failure)
        })
        if (cancellationFailure) rejectCurrentCancellation(cancellationFailure)
        else cancellationListeners.add(rejectCurrentCancellation)
      })
    let identifier = ''
    const parts: string[] = []
    let bufferedUnits = 0
    let pendingSurrogate = ''
    let finished = false
    const measure = (started: number) => {
      const elapsed = nowMilliseconds() - started
      maximumDigestSliceMilliseconds = Math.max(
        maximumDigestSliceMilliseconds,
        elapsed,
      )
      hashingMilliseconds += elapsed
    }
    const flush = async () => {
      if (cancelled) throw new NativeDigestCancelledError()
      if (!bufferedUnits) return
      const started = nowMilliseconds()
      const content = parts.join('')
      parts.length = 0
      bufferedUnits = 0
      const appended = NativeSynloquentCrypto.append(identifier, content)
      measure(started)
      await race(appended)
      observeNativeContinuation()
      nativeHashChunks += 1
    }
    try {
      if (lifecycle) unsubscribe = lifecycle.subscribe(() => operation.cancel())
      if (cancelled || lifecycle?.cancelled)
        throw new NativeDigestCancelledError()
      nativeStarted = NativeSynloquentCrypto.start()
      identifier = await race(nativeStarted)
      observeNativeContinuation()
      iterator = chunks[Symbol.asyncIterator]()
      while (true) {
        if (cancelled) throw new NativeDigestCancelledError()
        if (
          options.yieldToApplication &&
          nowMilliseconds() - previousYield >= 4
        ) {
          await race(options.yieldToApplication())
          previousYield = nowMilliseconds()
        }
        const requested = nowMilliseconds()
        const request = iterator.next()
        maximumIteratorDispatchMilliseconds = Math.max(
          maximumIteratorDispatchMilliseconds,
          nowMilliseconds() - requested,
        )
        const next = await race(Promise.resolve(request))
        const iteratorElapsed = nowMilliseconds() - requested
        maximumIteratorAwaitMilliseconds = Math.max(
          maximumIteratorAwaitMilliseconds,
          iteratorElapsed,
        )
        iteratorAwaitMilliseconds += iteratorElapsed
        if (next.done) {
          iteratorDone = true
          break
        }
        if (
          options.yieldToApplication &&
          nowMilliseconds() - previousYield >= 4
        ) {
          await race(options.yieldToApplication())
          previousYield = nowMilliseconds()
        }
        if (typeof next.value !== 'string')
          throw new Error('Native digest producers must yield strings.')
        const content = pendingSurrogate + next.value
        pendingSurrogate = ''
        let position = 0
        while (position < content.length) {
          let started = nowMilliseconds()
          let end = Math.min(position + 8192, content.length)
          const finalUnit = content.charCodeAt(end - 1)
          if (finalUnit >= 0xd800 && finalUnit <= 0xdbff) {
            end -= 1
            if (end === position) {
              pendingSurrogate = content.slice(position)
              measure(started)
              break
            }
          }
          const normalized = content
            .slice(position, end)
            .replace(
              /([\ud800-\udbff])([\udc00-\udfff])|[\ud800-\udfff]/g,
              (
                matched,
                leading: string | undefined,
                following: string | undefined,
              ) => (leading && following ? matched : '\ufffd'),
            )
          let offset = 0
          while (offset < normalized.length) {
            const maximumBufferedUnits = bufferLimit()
            if (bufferedUnits >= maximumBufferedUnits - 1) {
              measure(started)
              await flush()
              started = nowMilliseconds()
              continue
            }
            let boundary = Math.min(
              offset + maximumBufferedUnits - bufferedUnits,
              normalized.length,
            )
            const lastUnit = normalized.charCodeAt(boundary - 1)
            if (lastUnit >= 0xd800 && lastUnit <= 0xdbff) boundary -= 1
            if (boundary === offset) {
              measure(started)
              await flush()
              started = nowMilliseconds()
              continue
            }
            parts.push(normalized.slice(offset, boundary))
            bufferedUnits += boundary - offset
            offset = boundary
            if (bufferedUnits >= maximumBufferedUnits - 1) {
              measure(started)
              await flush()
              started = nowMilliseconds()
            }
          }
          position = end
          measure(started)
          if (nowMilliseconds() - previousYield >= 4) {
            if (options.yieldToApplication)
              await race(options.yieldToApplication())
            else await flush()
            previousYield = nowMilliseconds()
          }
        }
      }
      if (pendingSurrogate) {
        if (bufferedUnits >= bufferLimit()) await flush()
        parts.push('\ufffd')
        bufferedUnits += 1
      }
      await flush()
      const result = await race(NativeSynloquentCrypto.finish(identifier))
      nativeFinalized = true
      observeNativeContinuation()
      finished = true
      if (
        !/^[0-9a-f]{64}$/.test(result.digest) ||
        !Number.isSafeInteger(result.bytes) ||
        result.bytes < 0 ||
        !Number.isFinite(result.cpuMilliseconds) ||
        result.cpuMilliseconds < 0 ||
        !Number.isFinite(result.wallMilliseconds) ||
        result.wallMilliseconds < 0
      )
        throw new Error(
          'The native SHA256 result failed its boundary validation.',
        )
      try {
        options.observeDigest?.({
          maximumDigestSliceMilliseconds,
          maximumIteratorDispatchMilliseconds,
          maximumIteratorAwaitMilliseconds,
          iteratorAwaitMilliseconds,
          hashingMilliseconds,
          nativeHashCpuMilliseconds: result.cpuMilliseconds,
          nativeHashWallMilliseconds: result.wallMilliseconds,
          nativeHashBytes: result.bytes,
          nativeHashChunks,
          implementation: 'system SHA256 on a serial native worker',
          maximumBufferedUtf16Units: 65536,
        })
      } catch {
        /* Diagnostic observers never change a verified digest. */
      }
      return result.digest
    } finally {
      try {
        unsubscribe()
      } catch {
        /* Cleanup still releases the native context. */
      }
      try {
        if (!finished) await cleanup()
      } finally {
        operations.delete(operation)
      }
    }
  }

  async function digest(
    content: string,
    lifecycle?: NativeDigestLifecycle,
  ): Promise<string> {
    async function* chunks(): AsyncIterable<string> {
      yield content
    }
    return digestChunks(chunks(), lifecycle)
  }
  return {
    digest,
    digestChunks,
    close() {
      if (closing) return closing
      closed = true
      const pending = [...operations]
      for (const operation of pending) operation.cancel()
      closing = Promise.all(
        pending.map((operation) => operation.cleanup()),
      ).then(() => undefined)
      return closing
    },
  }
}

/** Constant-time diagnostic system clock for the calling thread. Native qualification verifies JS-thread affinity. */
export function callingThreadCpuMilliseconds(): number {
  const measured = NativeSynloquentCrypto.threadCpuMilliseconds()
  if (!Number.isFinite(measured) || measured < 0)
    throw new Error('Native calling-thread CPU timing is unavailable.')
  return measured
}

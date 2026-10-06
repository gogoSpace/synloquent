import { createSynloquent, type SynloquentClient } from '../core/client.js'
import type { ClientConfiguration, Session } from '../core/types.js'
import { SynloquentError } from '../core/errors.js'
import {
  createDatabaseAdapter,
  type DatabaseConfiguration,
  type NativeDatabaseAdapter,
} from '../sqlite/index.js'
import {
  createNativeCryptoProvider,
  type NativeCryptoProvider,
} from '../native-crypto/index.js'
import {
  assertNativeScheduler,
  scheduleApplication,
  monotonicMilliseconds,
  yieldToApplication,
} from './scheduler.js'
import {
  createReactNativeHttpTransport,
  copySession,
} from './http/transport.js'
import type {
  ReactNativeHttpConfiguration,
  ReactNativeHttpTransport,
} from './http/types.js'
import { createNativeMemoryBudget, type NativeMemoryBudget } from './memory.js'

export {
  createReactNativeHttpTransport,
  ReactNativeHttpError,
} from './http/transport.js'
export { scheduleApplication, yieldToApplication } from './scheduler.js'
export type * from './http/types.js'
export { createNativeMemoryBudget } from './memory.js'
export type { NativeMemoryBudget } from './memory.js'

function beginCleanup(
  callback: () => Promise<void> | undefined,
): Promise<void> {
  try {
    const pending = Promise.resolve(callback())
    void pending.catch(() => undefined)
    return pending
  } catch (failure) {
    const pending = Promise.reject<void>(failure)
    void pending.catch(() => undefined)
    return pending
  }
}

export interface ReactNativeClientConfiguration extends Omit<
  ClientConfiguration,
  'database' | 'transport' | 'digest' | 'digestChunks' | 'schedule' | 'now'
> {
  readonly database: DatabaseConfiguration
  readonly http: Omit<ReactNativeHttpConfiguration, 'session'>
  readonly now?: () => string
}
export interface ReactNativeClientRuntime<
  Bindings extends object,
  Commands extends object,
  Scopes extends object,
> {
  readonly client: SynloquentClient<Bindings, Commands, Scopes>
  setSession(session: Session): Promise<void>
  close(): Promise<void>
}

/** One lifecycle coordinates HTTP, native digest contexts and the database owner. */
export async function createReactNativeClient<
  Bindings extends object = Record<
    string,
    import('../core/query.js').ModelBinding
  >,
  Commands extends object = Record<
    string,
    (
      arguments_: import('../core/types.js').Attributes,
      operationId: string,
    ) => Promise<import('../core/types.js').WireValue>
  >,
  Scopes extends object = Record<
    string,
    (
      arguments_: import('../core/types.js').Attributes,
    ) => import('../core/query.js').Query<
      import('../core/types.js').Attributes,
      import('../core/types.js').Attributes,
      string,
      undefined,
      'remote'
    >
  >,
>(
  configuration: ReactNativeClientConfiguration,
): Promise<ReactNativeClientRuntime<Bindings, Commands, Scopes>> {
  assertNativeScheduler()
  let database: NativeDatabaseAdapter | undefined
  let crypto: NativeCryptoProvider | undefined
  let http: ReactNativeHttpTransport | undefined
  let memory: NativeMemoryBudget | undefined
  try {
    let releaseMemoryCache: () => void = () => undefined
    memory = createNativeMemoryBudget({
      nowMilliseconds: monotonicMilliseconds,
      onCacheBudgetReduced: () => releaseMemoryCache(),
    })
    const memoryBudget = configuration.memoryBudget ?? memory.policy
    database = createDatabaseAdapter(configuration.database)
    crypto = createNativeCryptoProvider({
      nowMilliseconds: monotonicMilliseconds,
      yieldToApplication,
      maximumBufferedUnits: () => memoryBudget.current().maximumHashBufferUnits,
    })
    http = createReactNativeHttpTransport({
      ...configuration.http,
      session: configuration.session,
      digest: crypto.digest,
    })
    const client = await createSynloquent<Bindings, Commands, Scopes>({
      schema: configuration.schema,
      session: copySession(configuration.session),
      generateIdentity: configuration.generateIdentity,
      now: configuration.now ?? (() => new Date().toISOString()),
      database,
      digest: crypto.digest,
      digestChunks: crypto.digestChunks,
      schedule: scheduleApplication,
      transport: http.transport,
      memoryBudget,
      refreshMemoryBudget: configuration.refreshMemoryBudget ?? memory.refresh,
      ...(configuration.observeSnapshotPhase === undefined
        ? {}
        : { observeSnapshotPhase: configuration.observeSnapshotPhase }),
    })
    releaseMemoryCache = () =>
      client.storage.memoryCache.reduceToCurrentBudget()
    const transport = http
    const cryptoProvider = crypto
    const memoryProvider = memory
    const originalSetSession = client.sync.setSession.bind(client.sync)
    const originalClose = client.close.bind(client)
    let queue: Promise<unknown> = Promise.resolve()
    let closing: Promise<void> | undefined
    let transitionSequence = 0
    const enqueue = <Result>(
      callback: () => Promise<Result>,
    ): Promise<Result> => {
      const result = queue.then(callback)
      queue = result.catch(() => undefined)
      return result
    }
    const setSession = (value: Session): Promise<void> => {
      memoryProvider.reset()
      if (closing)
        return Promise.reject(
          new SynloquentError(
            'closed_database',
            'The React Native runtime is closing.',
          ),
        )
      let next: Session
      try {
        next = copySession(value)
      } catch (failure) {
        return Promise.reject(failure)
      }
      const sequence = ++transitionSequence
      transport.suspend()
      return enqueue(async () => {
        await originalSetSession(next)
        if (!closing && sequence === transitionSequence)
          transport.setSession(client.storage.session)
      })
    }
    const close = (): Promise<void> => {
      if (closing) return closing
      // These calls synchronously cancel before awaiting a queued transition.
      const cancelledHttp = beginCleanup(() => transport.close())
      const cancelledCrypto = beginCleanup(() => cryptoProvider.close())
      memoryProvider.close()
      closing = enqueue(async () => {
        const results = await Promise.allSettled([
          cancelledHttp,
          cancelledCrypto,
          beginCleanup(originalClose),
        ])
        const failures = results.flatMap((result) =>
          result.status === 'rejected' ? [result.reason] : [],
        )
        if (failures.length)
          throw new AggregateError(
            failures,
            'React Native runtime cleanup failed.',
            { cause: failures[0] },
          )
      })
      return closing
    }
    // The factory-owned instance routes its public lifecycle methods through
    // the same coordinator. A raw client call cannot bypass cancellation.
    client.setSession = setSession
    client.sync.setSession = setSession
    client.close = close
    const guardScopedLifecycle = (scoped: typeof client): typeof client => {
      const unavailable = (): Promise<never> =>
        Promise.reject(
          new SynloquentError(
            'nested_transaction',
            'Change the React Native lifecycle outside a client transaction.',
          ),
        )
      scoped.setSession = unavailable
      scoped.sync.setSession = unavailable
      scoped.close = unavailable
      const nested: typeof scoped.transaction = scoped.transaction.bind(scoped)
      scoped.transaction = (callback) =>
        nested((child) => callback(guardScopedLifecycle(child)))
      return scoped
    }
    const originalTransaction: typeof client.transaction =
      client.transaction.bind(client)
    client.transaction = (callback) =>
      originalTransaction((scoped) => callback(guardScopedLifecycle(scoped)))
    return { client, setSession, close }
  } catch (failure) {
    memory?.close()
    const cleanup = await Promise.allSettled([
      beginCleanup(() => http?.close()),
      beginCleanup(() => crypto?.close()),
      beginCleanup(() => database?.close()),
    ])
    const failures = cleanup.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    )
    if (failures.length)
      throw new AggregateError(
        [failure, ...failures],
        'React Native initialization and cleanup failed.',
        { cause: failure },
      )
    throw failure
  }
}

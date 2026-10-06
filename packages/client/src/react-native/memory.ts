import { AppState } from 'react-native'
import NativeSynloquentCrypto from '../native-crypto/specs/NativeSynloquentCrypto.js'
import {
  createMemoryBudgetPolicy,
  memoryBudgetTiming,
  type MemoryBudgetConfiguration,
  type MemoryBudgetPolicy,
  type MemoryObservation,
} from '../core/memory-budget.js'

export interface NativeMemoryBudget {
  readonly policy: MemoryBudgetPolicy
  readonly sampleCount: number
  readonly sampleRequestCount: number
  readonly lastObservation: MemoryObservation | undefined
  readonly nativePressureSubscriptionActive: boolean
  /** Single-flight, rate-limited admission sampling. No polling timer is owned. */
  refresh(): Promise<void>
  /** Reject observations from the previous account or database lifecycle. */
  reset(): void
  close(): void
}

function bytes(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined
}

function sampleObservation(
  value: unknown,
  observedAtMilliseconds: number,
): MemoryObservation {
  const unavailable: MemoryObservation = {
    observedAtMilliseconds,
    validity: 'unavailable',
    pressure: 'unknown',
  }
  if (typeof value !== 'object' || value === null) return unavailable
  const sample = value as Record<string, unknown>
  if (
    typeof sample.sampledAtMonotonicMilliseconds !== 'number' ||
    !Number.isFinite(sample.sampledAtMonotonicMilliseconds) ||
    sample.sampledAtMonotonicMilliseconds < 0 ||
    ![
      'processHeadroomBytes',
      'systemAvailableBytes',
      'systemLowMemoryThresholdBytes',
    ].every(
      (field) =>
        sample[field] === null ||
        (typeof sample[field] === 'number' &&
          Number.isSafeInteger(sample[field]) &&
          (sample[field] as number) >= 0),
    ) ||
    (sample.systemLowMemory !== null &&
      typeof sample.systemLowMemory !== 'boolean')
  )
    return unavailable
  const processHeadroomBytes =
    sample.processHeadroomBytes === 0
      ? undefined
      : bytes(sample.processHeadroomBytes)
  const systemAvailableBytes = bytes(sample.systemAvailableBytes)
  return {
    observedAtMilliseconds,
    validity:
      processHeadroomBytes !== undefined || systemAvailableBytes !== undefined
        ? 'valid'
        : 'unavailable',
    pressure: sample.systemLowMemory === true ? 'warning' : 'normal',
    ...(processHeadroomBytes === undefined ? {} : { processHeadroomBytes }),
    ...(systemAvailableBytes === undefined ? {} : { systemAvailableBytes }),
  }
}

/** Native clocks are not compared with the application clock. Request age is conservative. */
export function createNativeMemoryBudget(
  configuration: MemoryBudgetConfiguration,
): NativeMemoryBudget {
  const policy = createMemoryBudgetPolicy(configuration)
  const subscriptions: { remove(): void }[] = []
  let closed = false
  let revision = 0
  let lastRequestMilliseconds: number | undefined
  let pending: Promise<void> | undefined
  let foregroundRevision: number | undefined
  let sampleCount = 0
  let sampleRequestCount = 0
  let lastObservation: MemoryObservation | undefined
  let nativePressureSubscriptionActive = false
  const unknown = () => {
    policy.observe({
      observedAtMilliseconds: configuration.nowMilliseconds(),
      validity: 'unavailable',
      pressure: 'unknown',
    })
  }
  const reset = () => {
    revision += 1
    foregroundRevision = undefined
    lastRequestMilliseconds = undefined
    if (!closed) unknown()
  }
  const sample = (foreground = false): Promise<void> | undefined => {
    const requested = configuration.nowMilliseconds()
    if (
      lastRequestMilliseconds !== undefined &&
      requested >= lastRequestMilliseconds &&
      requested - lastRequestMilliseconds < 2000
    )
      return undefined
    lastRequestMilliseconds = requested
    const requestedRevision = revision
    return Promise.resolve()
      .then(() => {
        if (foreground && (closed || revision !== requestedRevision)) return
        sampleRequestCount += 1
        return NativeSynloquentCrypto.sampleMemory()
      })
      .then(
        (sample: unknown) => {
          if (closed || revision !== requestedRevision) return
          const completed = configuration.nowMilliseconds()
          if (
            completed < requested ||
            completed - requested >
              memoryBudgetTiming.maximumObservationAgeMilliseconds
          ) {
            unknown()
            return
          }
          lastObservation = sampleObservation(sample, requested)
          sampleCount += 1
          policy.observe(lastObservation)
        },
        () => {
          if (!closed && revision === requestedRevision) unknown()
        },
      )
  }
  const refresh = (): Promise<void> => {
    if (closed) return Promise.resolve()
    policy.current()
    if (pending) return pending
    const next = sample()
    if (next === undefined) return Promise.resolve()
    let resolveCompletion!: () => void
    let rejectCompletion!: (failure: unknown) => void
    const completion = new Promise<void>((resolve, reject) => {
      resolveCompletion = resolve
      rejectCompletion = reject
    })
    pending = completion
    const finish = (rejected: boolean, failure?: unknown) => {
      foregroundRevision = undefined
      pending = undefined
      if (rejected) rejectCompletion(failure)
      else resolveCompletion()
    }
    const drain = (operation: Promise<void>) => {
      void operation.then(
        () => {
          const queuedRevision = foregroundRevision
          foregroundRevision = undefined
          if (
            !closed &&
            queuedRevision !== undefined &&
            queuedRevision === revision
          ) {
            try {
              const next = sample(true)
              if (next !== undefined) {
                drain(next)
                return
              }
            } catch (failure) {
              finish(true, failure)
              return
            }
          }
          finish(false)
        },
        (failure: unknown) => {
          finish(true, failure)
        },
      )
    }
    drain(next)
    return pending
  }
  try {
    const pressureSubscription = NativeSynloquentCrypto.onMemoryPressure(
      (event) => {
        if (closed) return
        // Invalidate any earlier read, including a large value returning after pressure.
        revision += 1
        foregroundRevision = undefined
        const valid =
          typeof event === 'object' &&
          event !== null &&
          typeof event.observedAtMonotonicMilliseconds === 'number' &&
          Number.isFinite(event.observedAtMonotonicMilliseconds) &&
          event.observedAtMonotonicMilliseconds >= 0
        policy.observe({
          observedAtMilliseconds: configuration.nowMilliseconds(),
          validity: 'unavailable',
          pressure:
            valid && (event.kind === 'warning' || event.kind === 'critical')
              ? event.kind
              : 'unknown',
        })
      },
    )
    if (
      !pressureSubscription ||
      typeof pressureSubscription.remove !== 'function'
    )
      throw new Error('Native pressure subscription is unavailable.')
    subscriptions.push(pressureSubscription)
    nativePressureSubscriptionActive = true
  } catch {
    unknown()
  }
  try {
    subscriptions.push(
      AppState.addEventListener('change', (state) => {
        reset()
        if (state === 'active') {
          if (pending) foregroundRevision = revision
          void refresh()
        }
      }),
    )
    subscriptions.push(
      AppState.addEventListener('memoryWarning', () => {
        revision += 1
        foregroundRevision = undefined
        policy.observe({
          observedAtMilliseconds: configuration.nowMilliseconds(),
          validity: 'unavailable',
          pressure: 'warning',
        })
      }),
    )
  } catch {
    unknown()
  }
  return {
    policy,
    get sampleCount() {
      return sampleCount
    },
    get sampleRequestCount() {
      return sampleRequestCount
    },
    get lastObservation() {
      return lastObservation
    },
    get nativePressureSubscriptionActive() {
      return nativePressureSubscriptionActive
    },
    refresh,
    reset,
    close() {
      if (closed) return
      closed = true
      nativePressureSubscriptionActive = false
      revision += 1
      foregroundRevision = undefined
      for (const subscription of subscriptions) {
        try {
          subscription.remove()
        } catch {
          /* One failed listener cleanup does not keep the other owners subscribed. */
        }
      }
      subscriptions.length = 0
      policy.close()
    },
  }
}

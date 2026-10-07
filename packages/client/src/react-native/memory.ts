import { AppState } from 'react-native'
import NativeSynloquentCrypto from '../native-crypto/specs/NativeSynloquentCrypto.js'
import {
  createMemoryBudgetPolicy,
  memoryBudgetTiming,
  type MemoryBudgetConfiguration,
  type MemoryBudgetPolicy,
  type MemoryObservation,
  type MemoryWorkBudget,
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

// Internal diagnostics, deliberately not re-exported from the public entrypoint.
interface MemoryEvidenceEvent {
  readonly sequence: number
  readonly source: string
  readonly receivedAtMilliseconds: number | null
  readonly revision: number
  readonly requestedAtMilliseconds?: number
  readonly payload: Readonly<Record<string, unknown>>
  readonly observation?: MemoryObservation
  readonly decision?: MemoryWorkBudget
}
const evidenceReaders = new WeakMap<NativeMemoryBudget, () => unknown>()
export function readNativeMemoryEvidence(owner: NativeMemoryBudget): unknown {
  return evidenceReaders.get(owner)?.()
}
function diagnosticPayload(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null)
    return { value: String(value).slice(0, 128) }
  const record = value as Record<string, unknown>
  return Object.fromEntries(
    [
      'kind',
      'source',
      'trimMemoryLevel',
      'observedAtMonotonicMilliseconds',
      'processHeadroomBytes',
      'systemAvailableBytes',
      'systemLowMemoryThresholdBytes',
      'systemLowMemory',
      'sampledAtMonotonicMilliseconds',
    ]
      .filter((field) => field in record)
      .map((field) => {
        const value = record[field]
        return [
          field,
          typeof value === 'string'
            ? value.slice(0, 128)
            : typeof value === 'number' ||
                typeof value === 'boolean' ||
                value === null
              ? value
              : typeof value,
        ]
      }),
  )
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
  const events: MemoryEvidenceEvent[] = []
  let eventSequence = 0
  let lastPressure: MemoryEvidenceEvent | undefined
  let lastObservedDecision: MemoryWorkBudget | undefined
  const record = (
    source: string,
    payload: unknown,
    observation?: MemoryObservation,
    requestedAtMilliseconds?: number,
  ) => {
    // Preserve the original policy operation before best-effort diagnostics.
    if (observation !== undefined)
      lastObservedDecision = policy.observe(observation)
    try {
      let receivedAtMilliseconds: number | null = null
      try {
        receivedAtMilliseconds = configuration.nowMilliseconds()
      } catch {
        /* Unavailable diagnostic clock. */
      }
      const event: MemoryEvidenceEvent = {
        sequence: ++eventSequence,
        source,
        receivedAtMilliseconds,
        revision,
        payload: diagnosticPayload(payload),
        ...(requestedAtMilliseconds === undefined
          ? {}
          : { requestedAtMilliseconds }),
        ...(observation === undefined ? {} : { observation }),
        ...(lastObservedDecision === undefined
          ? {}
          : { decision: lastObservedDecision }),
      }
      if (events.length === 32) events.shift()
      events.push(event)
      if (
        observation?.pressure === 'warning' ||
        observation?.pressure === 'critical'
      )
        lastPressure = event
    } catch {
      /* Diagnostics cannot prevent the policy decision or listener cleanup. */
    }
  }

  const unknown = (source = 'unavailable', payload: unknown = null) => {
    record(source, payload, {
      observedAtMilliseconds: configuration.nowMilliseconds(),
      validity: 'unavailable',
      pressure: 'unknown',
    })
  }
  const reset = () => {
    revision += 1
    foregroundRevision = undefined
    lastRequestMilliseconds = undefined
    if (!closed) unknown('reset')
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
          if (closed || revision !== requestedRevision) {
            if (!closed)
              record('discarded-sample', sample, undefined, requested)
            return
          }
          const completed = configuration.nowMilliseconds()
          if (
            completed < requested ||
            completed - requested >
              memoryBudgetTiming.maximumObservationAgeMilliseconds
          ) {
            unknown('expired-sample', sample)
            return
          }
          lastObservation = sampleObservation(sample, requested)
          sampleCount += 1
          record('sample', sample, lastObservation, requested)
        },
        () => {
          if (!closed && revision === requestedRevision) unknown('sample-error')
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
        record('native-pressure', event, {
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
        record('lifecycle', { source: state })
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
        record('app-state-memory-warning', null, {
          observedAtMilliseconds: configuration.nowMilliseconds(),
          validity: 'unavailable',
          pressure: 'warning',
        })
      }),
    )
  } catch {
    unknown()
  }
  const owner: NativeMemoryBudget = {
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
      lastObservedDecision = policy.current()
      record('close', null)
    },
  }
  evidenceReaders.set(owner, () => ({
    eventSequence,
    events: events.slice(),
    lastPressure: lastPressure ?? null,
    revision,
  }))
  return owner
}

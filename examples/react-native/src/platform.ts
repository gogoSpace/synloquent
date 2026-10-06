import 'react-native-get-random-values'
import {
  createNativeCryptoProvider,
  callingThreadCpuMilliseconds,
} from '@synloquent/client/native-crypto'
import { scheduleApplication } from '@synloquent/client/react-native'
import {
  unstable_NormalPriority,
  unstable_scheduleCallback,
  unstable_cancelCallback,
  type ScheduledTask,
} from 'scheduler'

export const nativeClock = (
  globalThis as typeof globalThis & {
    readonly performance: {
      now(): number
      readonly memory: { readonly usedJSHeapSize?: number }
    }
  }
).performance

export function generateIdentity(): string {
  const bytes = new Uint8Array(16)
  const nativeCrypto = (
    globalThis as typeof globalThis & {
      readonly crypto: { getRandomValues(buffer: Uint8Array): Uint8Array }
    }
  ).crypto
  nativeCrypto.getRandomValues(bytes)
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hexadecimal = Array.from(bytes, (value) =>
    value.toString(16).padStart(2, '0'),
  ).join('')
  return `${hexadecimal.slice(0, 8)}-${hexadecimal.slice(8, 12)}-${hexadecimal.slice(12, 16)}-${hexadecimal.slice(16, 20)}-${hexadecimal.slice(20)}`
}

export function encodeUtf8(content: string): Uint8Array {
  const bytes = new Uint8Array(content.length * 3)
  let position = 0
  for (let index = 0; index < content.length; index += 1) {
    let point = content.charCodeAt(index)
    if (point >= 0xd800 && point <= 0xdbff) {
      const following = content.charCodeAt(index + 1)
      if (following >= 0xdc00 && following <= 0xdfff) {
        point = 0x10000 + ((point - 0xd800) << 10) + following - 0xdc00
        index += 1
      } else point = 0xfffd
    } else if (point >= 0xdc00 && point <= 0xdfff) point = 0xfffd
    if (point <= 0x7f) bytes[position++] = point
    else if (point <= 0x7ff) {
      bytes[position++] = 0xc0 | (point >> 6)
      bytes[position++] = 0x80 | (point & 0x3f)
    } else if (point <= 0xffff) {
      bytes[position++] = 0xe0 | (point >> 12)
      bytes[position++] = 0x80 | ((point >> 6) & 0x3f)
      bytes[position++] = 0x80 | (point & 0x3f)
    } else {
      bytes[position++] = 0xf0 | (point >> 18)
      bytes[position++] = 0x80 | ((point >> 12) & 0x3f)
      bytes[position++] = 0x80 | ((point >> 6) & 0x3f)
      bytes[position++] = 0x80 | (point & 0x3f)
    }
  }
  return bytes.subarray(0, position)
}

let maximumDigestSliceMilliseconds = 0
let maximumIteratorDispatchMilliseconds = 0
let maximumIteratorAwaitMilliseconds = 0
let iteratorAwaitMilliseconds = 0
let hashingMilliseconds = 0
let nativeHashCpuMilliseconds = 0
let nativeHashWallMilliseconds = 0
let nativeHashBytes = 0
let nativeHashChunks = 0

export function resetDigestMeasurements(): void {
  maximumDigestSliceMilliseconds = 0
  maximumIteratorDispatchMilliseconds = 0
  maximumIteratorAwaitMilliseconds = 0
  iteratorAwaitMilliseconds = 0
  hashingMilliseconds = 0
  nativeHashCpuMilliseconds = 0
  nativeHashWallMilliseconds = 0
  nativeHashBytes = 0
  nativeHashChunks = 0
}

export function digestMeasurements() {
  return {
    maximumDigestSliceMilliseconds,
    maximumIteratorDispatchMilliseconds,
    maximumIteratorAwaitMilliseconds,
    iteratorAwaitMilliseconds,
    hashingMilliseconds,
    nativeHashCpuMilliseconds,
    nativeHashWallMilliseconds,
    nativeHashBytes,
    nativeHashChunks,
    implementation: 'system SHA256 on a serial native worker',
    maximumBufferedUtf16Units: 65536,
  }
}
export function createMeasuredCryptoProvider(
  maximumBufferedUnits?: () => number,
) {
  return createNativeCryptoProvider({
    ...(maximumBufferedUnits === undefined ? {} : { maximumBufferedUnits }),
    nowMilliseconds: () => nativeClock.now(),
    yieldToApplication,
    observeNativeContinuation,
    observeDigest(measurement) {
      maximumDigestSliceMilliseconds = Math.max(
        maximumDigestSliceMilliseconds,
        measurement.maximumDigestSliceMilliseconds,
      )
      maximumIteratorDispatchMilliseconds = Math.max(
        maximumIteratorDispatchMilliseconds,
        measurement.maximumIteratorDispatchMilliseconds,
      )
      maximumIteratorAwaitMilliseconds = Math.max(
        maximumIteratorAwaitMilliseconds,
        measurement.maximumIteratorAwaitMilliseconds,
      )
      iteratorAwaitMilliseconds += measurement.iteratorAwaitMilliseconds
      hashingMilliseconds += measurement.hashingMilliseconds
      nativeHashCpuMilliseconds += measurement.nativeHashCpuMilliseconds
      nativeHashWallMilliseconds += measurement.nativeHashWallMilliseconds
      nativeHashBytes += measurement.nativeHashBytes
      nativeHashChunks += measurement.nativeHashChunks
    },
  })
}
const nativeCryptoProvider = createMeasuredCryptoProvider()
export const digest = nativeCryptoProvider.digest
export const digestChunks = nativeCryptoProvider.digestChunks

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`
}

function requireNativeScheduler(): void {
  const binding = (
    globalThis as typeof globalThis & {
      readonly nativeRuntimeScheduler?: {
        readonly unstable_scheduleCallback?: unknown
        readonly unstable_cancelCallback?: unknown
      }
    }
  ).nativeRuntimeScheduler
  if (
    !binding ||
    typeof binding.unstable_scheduleCallback !== 'function' ||
    typeof binding.unstable_cancelCallback !== 'function'
  )
    throw new Error(
      'This consumer requires the installed native React RuntimeScheduler binding.',
    )
}

let applicationWorkPhase = 'outside-import'
let applicationWorkStatement = 'application continuation'
let continuationObserver: (() => void) | undefined
type NativeSqlPhase =
  | 'validation'
  | 'digest'
  | 'staging'
  | 'records'
  | 'relationSets'
  | 'integrity'
  | 'commit'
  | 'checkpoint'
interface NativeSqlStatistics {
  readonly settledCount: number
  readonly sumSettledAwaitWallMilliseconds: number
  readonly maximumSettledAwaitWallMilliseconds: number
}
interface NativeSqlDatabaseIdentity {
  readonly adapterOrdinal: number
  readonly databaseName: string
}
export interface NativeSqlMeasurement {
  readonly complete: boolean
  readonly incompleteReason: string | null
  readonly settledCount: number | null
  readonly sumSettledAwaitWallMilliseconds: number | null
  readonly maximumSettledAwaitWallMilliseconds: number | null
  readonly databases: readonly {
    readonly identity: NativeSqlDatabaseIdentity
    readonly observed: NativeSqlStatistics
    readonly regions: readonly {
      readonly region: string
      readonly observed: NativeSqlStatistics
    }[]
    readonly maintenance: readonly {
      readonly kind: string
      readonly observed: NativeSqlStatistics
    }[]
  }[]
  readonly coverage: 'executeNative settled callbacks during responsiveness window'
  readonly excludes: 'direct initialization, direct rollback, pre-dispatch refusal and work outside window'
  readonly clockDomain: 'application await wall including result normalization'
  readonly regionSumsOverlap: true
  readonly crossDatabaseWallSumsAreNotElapsedTotal: true
  readonly includesRejectedSettlements: true
  readonly countMeans: 'observed callbacks, not all SQLite invocations'
  readonly exclusiveImportCausality: false
}
let nextNativeSqlAdapterOrdinal = 0
const nativeSqlClientIdentities = new WeakMap<
  object,
  NativeSqlDatabaseIdentity
>()
let nativeSqlObservation:
  ReturnType<typeof createNativeSqlObservation> | undefined

function createNativeSqlObservation() {
  type Statistics = {
    settledCount: number
    sumSettledAwaitWallMilliseconds: number
    maximumSettledAwaitWallMilliseconds: number
  }
  const empty = (): Statistics => ({
    settledCount: 0,
    sumSettledAwaitWallMilliseconds: 0,
    maximumSettledAwaitWallMilliseconds: 0,
  })
  const total = empty()
  const databases = new Map<
    NativeSqlDatabaseIdentity,
    {
      observed: Statistics
      regions: Map<string, Statistics>
      maintenance: Map<string, Statistics>
    }
  >()
  const phases: NativeSqlPhase[] = []
  let owner: NativeSqlDatabaseIdentity | undefined
  let digestCompleted = false
  let incompleteReason: string | null = null
  let result: NativeSqlMeasurement | undefined
  const fail = (reason: string) => {
    incompleteReason ??= reason
  }
  const database = (identity: NativeSqlDatabaseIdentity) => {
    if (
      !Number.isSafeInteger(identity.adapterOrdinal) ||
      identity.adapterOrdinal < 1 ||
      !identity.databaseName ||
      identity.databaseName.length > 256
    )
      throw new Error('invalid-database-identity')
    let entry = databases.get(identity)
    if (!entry) {
      if (databases.size >= 8) throw new Error('database-identity-bound')
      entry = { observed: empty(), regions: new Map(), maintenance: new Map() }
      databases.set(identity, entry)
    }
    return entry
  }
  const include = (statistics: Statistics, elapsed: number) => {
    const count = statistics.settledCount + 1
    const sum = statistics.sumSettledAwaitWallMilliseconds + elapsed
    if (!Number.isSafeInteger(count) || !Number.isFinite(sum))
      throw new Error('scalar-overflow')
    statistics.settledCount = count
    statistics.sumSettledAwaitWallMilliseconds = sum
    statistics.maximumSettledAwaitWallMilliseconds = Math.max(
      statistics.maximumSettledAwaitWallMilliseconds,
      elapsed,
    )
  }
  const includeGroup = (
    groups: Map<string, Statistics>,
    name: string,
    elapsed: number,
  ) => {
    const statistics = groups.get(name) ?? empty()
    include(statistics, elapsed)
    groups.set(name, statistics)
  }
  const region = (phase: NativeSqlPhase) =>
    phase === 'commit' || phase === 'checkpoint'
      ? 'commit-and-maintenance'
      : phase
  return {
    fail,
    record(
      identity: NativeSqlDatabaseIdentity,
      event: {
        readonly phase: 'settled'
        readonly statement: string
        readonly elapsedMilliseconds: number
      },
    ) {
      if (result) return
      try {
        if (
          event.phase !== 'settled' ||
          typeof event.statement !== 'string' ||
          !Number.isFinite(event.elapsedMilliseconds) ||
          event.elapsedMilliseconds < 0
        )
          throw new Error('invalid-settled-event')
        const entry = database(identity)
        include(total, event.elapsedMilliseconds)
        include(entry.observed, event.elapsedMilliseconds)
        const activeRegions: string[] = phases
          .filter((phase) => phase !== 'validation')
          .map(region)
        if (!activeRegions.length)
          activeRegions.push(
            digestCompleted
              ? 'after-global-digest-outside-phase'
              : 'monitor-window-before-global-digest',
          )
        for (const name of new Set(activeRegions))
          includeGroup(entry.regions, name, event.elapsedMilliseconds)
        const kind =
          event.statement === 'PRAGMA freelist_count'
            ? 'freelist_count'
            : event.statement === 'VACUUM'
              ? 'VACUUM'
              : event.statement === 'PRAGMA wal_checkpoint(TRUNCATE)'
                ? 'wal_checkpoint'
                : 'other'
        includeGroup(entry.maintenance, kind, event.elapsedMilliseconds)
      } catch (failure) {
        fail(
          failure instanceof Error ? failure.message : 'sql-observer-failure',
        )
      }
    },
    phase(
      identity: NativeSqlDatabaseIdentity,
      event: {
        readonly phase: NativeSqlPhase
        readonly state: 'begin' | 'end'
      },
    ) {
      if (result) return
      try {
        database(identity)
        if (
          ![
            'validation',
            'digest',
            'staging',
            'records',
            'relationSets',
            'integrity',
            'commit',
            'checkpoint',
          ].includes(event.phase) ||
          (event.state !== 'begin' && event.state !== 'end')
        )
          throw new Error('unknown-phase-event')
        owner ??= identity
        if (owner !== identity) throw new Error('foreign-phase-owner')
        if (event.state === 'begin') {
          if (
            phases.length &&
            !(
              phases.length === 1 &&
              phases[0] === 'staging' &&
              ['records', 'relationSets', 'integrity'].includes(event.phase)
            )
          )
            throw new Error('overlapping-phase')
          phases.push(event.phase)
        } else {
          if (phases.at(-1) !== event.phase)
            throw new Error('unmatched-phase-end')
          phases.pop()
          if (event.phase === 'digest') digestCompleted = true
        }
      } catch (failure) {
        fail(
          failure instanceof Error ? failure.message : 'phase-observer-failure',
        )
      }
    },
    finish(): NativeSqlMeasurement {
      if (result) return result
      if (phases.length) fail('unfinished-phase')
      const statistics = (value: Statistics) => Object.freeze({ ...value })
      result = Object.freeze({
        complete: incompleteReason === null,
        incompleteReason,
        settledCount: incompleteReason === null ? total.settledCount : null,
        sumSettledAwaitWallMilliseconds:
          incompleteReason === null
            ? total.sumSettledAwaitWallMilliseconds
            : null,
        maximumSettledAwaitWallMilliseconds:
          incompleteReason === null
            ? total.maximumSettledAwaitWallMilliseconds
            : null,
        databases: Object.freeze(
          [...databases].map(([identity, entry]) =>
            Object.freeze({
              identity,
              observed: statistics(entry.observed),
              regions: Object.freeze(
                [...entry.regions].map(([name, value]) =>
                  Object.freeze({ region: name, observed: statistics(value) }),
                ),
              ),
              maintenance: Object.freeze(
                [...entry.maintenance].map(([name, value]) =>
                  Object.freeze({ kind: name, observed: statistics(value) }),
                ),
              ),
            }),
          ),
        ),
        coverage:
          'executeNative settled callbacks during responsiveness window',
        excludes:
          'direct initialization, direct rollback, pre-dispatch refusal and work outside window',
        clockDomain: 'application await wall including result normalization',
        regionSumsOverlap: true,
        crossDatabaseWallSumsAreNotElapsedTotal: true,
        includesRejectedSettlements: true,
        countMeans: 'observed callbacks, not all SQLite invocations',
        exclusiveImportCausality: false,
      })
      return result
    },
  }
}

export function createNativeSqlObserver(databaseName: string) {
  const identity = Object.freeze({
    adapterOrdinal: ++nextNativeSqlAdapterOrdinal,
    databaseName,
  })
  return {
    bindClient(client: object): void {
      nativeSqlClientIdentities.set(client, identity)
    },
    observeSnapshotPhase(event: {
      readonly phase: NativeSqlPhase
      readonly state: 'begin' | 'end'
    }): void {
      nativeSqlObservation?.phase(identity, event)
    },
    observeNativeWork(event: {
      readonly phase: 'settled'
      readonly statement: string
      readonly elapsedMilliseconds: number
    }): void {
      nativeSqlObservation?.record(identity, event)
      observeNativeContinuation(event)
    },
  }
}

export function observeNativeSqlPhase(
  client: object,
  phase: NativeSqlPhase,
  state: 'begin' | 'end',
): void {
  if (!nativeSqlObservation) return
  const identity = nativeSqlClientIdentities.get(client)
  if (!identity) {
    nativeSqlObservation.fail('unregistered-phase-client')
    return
  }
  nativeSqlObservation.phase(identity, { phase, state })
}

export function setApplicationWorkPhase(phase: string): void {
  applicationWorkPhase = phase
}
export function observeNativeContinuation(event?: {
  readonly statement?: string
}): void {
  applicationWorkStatement =
    event?.statement?.slice(0, 200) ?? 'native SHA256 continuation'
  continuationObserver?.()
}

export function schedule(
  callback: () => void,
  delayMilliseconds: number,
): () => void {
  if (delayMilliseconds > 0)
    return scheduleApplication(callback, delayMilliseconds)
  requireNativeScheduler()
  return scheduleApplication(() => {
    observeNativeContinuation({
      statement: 'native NormalPriority yield callback',
    })
    callback()
  }, delayMilliseconds)
}

export function yieldToApplication(): Promise<void> {
  return new Promise((resolve) => schedule(resolve, 0))
}

export interface ApplicationCallbackGap {
  readonly phase: string
  readonly statement: string
  readonly wallMilliseconds: number
  readonly callingThreadCpuMilliseconds: number
}
export interface ResponsivenessMeasurement {
  readonly nativeSql: NativeSqlMeasurement
  readonly maximumCallbackGapMilliseconds: number
  readonly maximumCallingThreadCpuMilliseconds: number
  readonly phaseMaximumGaps: readonly ApplicationCallbackGap[]
  readonly callbacks: number
  readonly armedBoundaries: number
  readonly boundary: 'native React RuntimeScheduler task after microtask checkpoint'
  readonly includesNativeSchedulingDelay: true
}

export async function monitorApplicationResponsiveness(): Promise<{
  markContinuation(): void
  stop(): ResponsivenessMeasurement
}> {
  requireNativeScheduler()
  if (continuationObserver)
    throw new Error('Only one native responsiveness observer may be active.')
  const sqlObservation = createNativeSqlObservation()
  nativeSqlObservation = sqlObservation
  let maximumCallbackGapMilliseconds = 0
  let maximumCallingThreadCpuMilliseconds = 0
  const phaseMaximumGaps = new Map<string, ApplicationCallbackGap>()
  let callbacks = 0
  let armedBoundaries = 0
  let requestedAt = nativeClock.now()
  let requestedCpu = callingThreadCpuMilliseconds()
  let requestedPhase = applicationWorkPhase
  let requestedStatement = applicationWorkStatement
  let closed = false
  let task: ScheduledTask | undefined
  let initialized: () => void = () => undefined
  const ready = new Promise<void>((resolve) => {
    initialized = resolve
  })
  const includeGap = () => {
    const wallMilliseconds = nativeClock.now() - requestedAt
    const cpuMilliseconds = callingThreadCpuMilliseconds() - requestedCpu
    maximumCallbackGapMilliseconds = Math.max(
      maximumCallbackGapMilliseconds,
      wallMilliseconds,
    )
    maximumCallingThreadCpuMilliseconds = Math.max(
      maximumCallingThreadCpuMilliseconds,
      cpuMilliseconds,
    )
    if (
      wallMilliseconds >
      (phaseMaximumGaps.get(requestedPhase)?.wallMilliseconds ?? 0)
    )
      phaseMaximumGaps.set(requestedPhase, {
        phase: requestedPhase,
        statement: requestedStatement,
        wallMilliseconds,
        callingThreadCpuMilliseconds: cpuMilliseconds,
      })
  }
  const arm = () => {
    if (closed || task) return
    requestedAt = nativeClock.now()
    requestedCpu = callingThreadCpuMilliseconds()
    requestedPhase = applicationWorkPhase
    requestedStatement = applicationWorkStatement
    armedBoundaries += 1
    task = unstable_scheduleCallback(unstable_NormalPriority, () => {
      task = undefined
      if (closed) return
      includeGap()
      callbacks += 1
      if (callbacks === 1) initialized()
    })
  }
  continuationObserver = arm
  arm()
  await ready
  return {
    markContinuation: arm,
    stop() {
      closed = true
      continuationObserver = undefined
      if (nativeSqlObservation === sqlObservation)
        nativeSqlObservation = undefined
      if (task) {
        includeGap()
        unstable_cancelCallback(task)
      }
      return {
        nativeSql: sqlObservation.finish(),
        maximumCallbackGapMilliseconds,
        maximumCallingThreadCpuMilliseconds,
        phaseMaximumGaps: [...phaseMaximumGaps.values()],
        callbacks,
        armedBoundaries,
        boundary:
          'native React RuntimeScheduler task after microtask checkpoint',
        includesNativeSchedulingDelay: true,
      }
    },
  }
}

export interface NativeAnimationFramePoint {
  readonly edge: 'begin' | 'callback' | 'stop'
  readonly milliseconds: number
  readonly frameBudgetMilliseconds: number
}

export function monitorAnimationFrames(
  frameBudgetMilliseconds: number,
  observeFrame?: (point: NativeAnimationFramePoint) => void,
): {
  stop(): {
    readonly frames: number
    readonly maximumFrameGapMilliseconds: number
    readonly estimatedMissedFrames: number
    readonly elapsedMilliseconds: number
    readonly firstFrameGapMilliseconds: number | null
    readonly finalFrameGapMilliseconds: number
    readonly callbackCoverageRatio: number
  }
} {
  let frames = 0
  let maximumFrameGapMilliseconds = 0
  let estimatedMissedFrames = 0
  const started = nativeClock.now()
  let previousFrame = started
  let firstFrameGapMilliseconds: number | null = null
  let closed = false
  let request: ReturnType<typeof requestAnimationFrame>
  const includeGap = (gap: number) => {
    maximumFrameGapMilliseconds = Math.max(maximumFrameGapMilliseconds, gap)
    estimatedMissedFrames += Math.max(
      0,
      Math.round(gap / frameBudgetMilliseconds) - 1,
    )
  }
  const callback = () => {
    if (closed) return
    const now = nativeClock.now()
    const gap = now - previousFrame
    if (firstFrameGapMilliseconds === null) firstFrameGapMilliseconds = gap
    includeGap(gap)
    previousFrame = now
    observeFrame?.({
      edge: 'callback',
      milliseconds: now,
      frameBudgetMilliseconds,
    })
    frames += 1
    request = requestAnimationFrame(callback)
  }
  request = requestAnimationFrame(callback)
  observeFrame?.({
    edge: 'begin',
    milliseconds: started,
    frameBudgetMilliseconds,
  })
  return {
    stop() {
      const finished = nativeClock.now()
      const finalFrameGapMilliseconds = finished - previousFrame
      includeGap(finalFrameGapMilliseconds)
      closed = true
      cancelAnimationFrame(request)
      observeFrame?.({
        edge: 'stop',
        milliseconds: finished,
        frameBudgetMilliseconds,
      })
      return {
        frames,
        maximumFrameGapMilliseconds,
        estimatedMissedFrames,
        elapsedMilliseconds: finished - started,
        firstFrameGapMilliseconds,
        finalFrameGapMilliseconds,
        callbackCoverageRatio:
          (frames * frameBudgetMilliseconds) / (finished - started),
      }
    },
  }
}

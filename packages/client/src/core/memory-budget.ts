export type MemoryPressure = 'normal' | 'warning' | 'critical' | 'unknown'
export type MemoryBudgetLevel = 'reduced' | 'conservative' | 'normal'
export type MemoryBudgetReason =
  | 'startup'
  | 'pressure'
  | 'low_headroom'
  | 'unknown'
  | 'invalid_observation'
  | 'invalid_clock'
  | 'stale'
  | 'recovery'
  | 'fresh'
  | 'closed'

/** Byte observations are advisory. System availability is not process headroom. */
export interface MemoryObservation {
  readonly observedAtMilliseconds: number
  readonly validity: 'valid' | 'unavailable'
  readonly pressure: MemoryPressure
  readonly processHeadroomBytes?: number
  readonly systemAvailableBytes?: number
}

export interface MemoryWorkBudget {
  readonly level: MemoryBudgetLevel
  readonly reason: MemoryBudgetReason
  readonly maximumBatchRows: number
  readonly maximumBindingBytes: number
  /** UTF-16 units retained by the portable/native text hash adapter. */
  readonly maximumHashBufferUnits: number
  readonly maximumCacheBytes: number
  readonly maximumCacheEntries: number
  readonly maximumPrefetchConcurrency: number
  readonly maximumSnapshotConcurrency: number
  readonly maximumSnapshotResponseBytes: number
}

export interface MemoryCacheReduction {
  readonly previous: MemoryWorkBudget
  readonly current: MemoryWorkBudget
}

export interface MemoryBudgetConfiguration {
  /** Observations and this clock must use the same monotonic coordinate system. */
  readonly nowMilliseconds: () => number
  readonly onCacheBudgetReduced?: (event: MemoryCacheReduction) => void
}

export interface MemoryBudgetPolicy {
  observe(observation: MemoryObservation): MemoryWorkBudget
  /** Admission-time freshness check. No timer or native API is owned here. */
  current(): MemoryWorkBudget
  close(): void
}

export const memoryBudgetTiming = Object.freeze({
  maximumObservationAgeMilliseconds: 5000,
  recoveryQuietMilliseconds: 30000,
  recoveryObservations: 3,
  recoveryHeadroomBytes: 64 * 1024 ** 2,
  reducedHeadroomBytes: 32 * 1024 ** 2,
})

type BudgetLimits = Omit<MemoryWorkBudget, 'level' | 'reason'>
const budgetLimits: Readonly<Record<MemoryBudgetLevel, BudgetLimits>> =
  Object.freeze({
    reduced: Object.freeze({
      maximumBatchRows: 4,
      maximumBindingBytes: 8192,
      maximumHashBufferUnits: 16384,
      maximumCacheBytes: 0,
      maximumCacheEntries: 0,
      maximumPrefetchConcurrency: 0,
      maximumSnapshotConcurrency: 0,
      maximumSnapshotResponseBytes: 65536,
    }),
    conservative: Object.freeze({
      maximumBatchRows: 16,
      maximumBindingBytes: 16384,
      maximumHashBufferUnits: 16384,
      maximumCacheBytes: 512 * 1024,
      maximumCacheEntries: 64,
      maximumPrefetchConcurrency: 0,
      maximumSnapshotConcurrency: 1,
      maximumSnapshotResponseBytes: 65536,
    }),
    normal: Object.freeze({
      maximumBatchRows: 64,
      maximumBindingBytes: 65536,
      maximumHashBufferUnits: 65536,
      maximumCacheBytes: 4 * 1024 ** 2,
      maximumCacheEntries: 256,
      maximumPrefetchConcurrency: 1,
      maximumSnapshotConcurrency: 1,
      maximumSnapshotResponseBytes: 65536,
    }),
  })

function validBytes(value: number | undefined): boolean {
  return value === undefined || (Number.isSafeInteger(value) && value >= 0)
}

class PortableMemoryBudget implements MemoryBudgetPolicy {
  private readonly clock: () => number
  private cacheReduction: ((event: MemoryCacheReduction) => void) | undefined
  private budget: MemoryWorkBudget = Object.freeze({
    level: 'conservative',
    reason: 'startup',
    ...budgetLimits.conservative,
  })
  private lastClockMilliseconds: number | undefined
  private observation: MemoryObservation | undefined
  private lastObservationMilliseconds: number | undefined
  private recoveryStartedMilliseconds: number | undefined
  private recoveryObservationCount = 0
  private closed = false

  constructor(configuration: MemoryBudgetConfiguration) {
    this.clock = configuration.nowMilliseconds
    this.cacheReduction = configuration.onCacheBudgetReduced
  }

  private transition(
    level: MemoryBudgetLevel,
    reason: MemoryBudgetReason,
  ): MemoryWorkBudget {
    if (level === this.budget.level && reason === this.budget.reason)
      return this.budget
    const previous = this.budget
    this.budget = Object.freeze({ level, reason, ...budgetLimits[level] })
    if (
      this.budget.maximumCacheBytes < previous.maximumCacheBytes ||
      this.budget.maximumCacheEntries < previous.maximumCacheEntries
    ) {
      try {
        this.cacheReduction?.({ previous, current: this.budget })
      } catch {
        /* Cache observers cannot prevent a budget reduction. */
      }
    }
    return this.budget
  }

  private resetRecovery(): void {
    this.recoveryStartedMilliseconds = undefined
    this.recoveryObservationCount = 0
  }

  private fallback(reason: MemoryBudgetReason): MemoryWorkBudget {
    this.observation = undefined
    this.resetRecovery()
    return this.transition(
      this.budget.level === 'reduced' ? 'reduced' : 'conservative',
      reason,
    )
  }

  private readClock(): number | undefined {
    let current: number
    try {
      current = this.clock()
    } catch {
      this.fallback('invalid_clock')
      return undefined
    }
    if (
      !Number.isFinite(current) ||
      current < 0 ||
      (this.lastClockMilliseconds !== undefined &&
        current < this.lastClockMilliseconds)
    ) {
      this.fallback('invalid_clock')
      return undefined
    }
    this.lastClockMilliseconds = current
    return current
  }

  current(): MemoryWorkBudget {
    if (this.closed) return this.budget
    const current = this.readClock()
    if (current === undefined) return this.budget
    if (
      this.observation &&
      current - this.observation.observedAtMilliseconds >
        memoryBudgetTiming.maximumObservationAgeMilliseconds
    )
      return this.fallback('stale')
    return this.budget
  }

  observe(observation: MemoryObservation): MemoryWorkBudget {
    if (this.closed) return this.budget
    const current = this.readClock()
    // Pressure is a reduction-only input even when accompanying bytes are absent.
    if (
      observation.pressure === 'warning' ||
      observation.pressure === 'critical'
    ) {
      this.observation = undefined
      this.resetRecovery()
      return this.transition('reduced', 'pressure')
    }
    if (current === undefined) return this.budget
    if (
      !Number.isFinite(observation.observedAtMilliseconds) ||
      observation.observedAtMilliseconds < 0 ||
      observation.observedAtMilliseconds > current ||
      (this.lastObservationMilliseconds !== undefined &&
        observation.observedAtMilliseconds <
          this.lastObservationMilliseconds) ||
      !validBytes(observation.processHeadroomBytes) ||
      !validBytes(observation.systemAvailableBytes)
    )
      return this.fallback('invalid_observation')
    if (
      current - observation.observedAtMilliseconds >
      memoryBudgetTiming.maximumObservationAgeMilliseconds
    )
      return this.fallback('stale')
    const distinct =
      observation.observedAtMilliseconds !== this.lastObservationMilliseconds
    this.lastObservationMilliseconds = observation.observedAtMilliseconds
    if (observation.validity !== 'valid' || observation.pressure !== 'normal')
      return this.fallback('unknown')
    if (
      this.observation &&
      current - this.observation.observedAtMilliseconds >
        memoryBudgetTiming.maximumObservationAgeMilliseconds
    )
      this.fallback('stale')
    const { processHeadroomBytes, systemAvailableBytes } = observation
    if (
      (processHeadroomBytes !== undefined &&
        processHeadroomBytes < memoryBudgetTiming.reducedHeadroomBytes) ||
      (systemAvailableBytes !== undefined &&
        systemAvailableBytes < memoryBudgetTiming.reducedHeadroomBytes)
    ) {
      this.observation = { ...observation }
      this.resetRecovery()
      return this.transition('reduced', 'low_headroom')
    }
    if (processHeadroomBytes === undefined) {
      if (systemAvailableBytes === undefined) return this.fallback('unknown')
      if (this.budget.level === 'normal') this.fallback('unknown')
      if (this.budget.level === 'conservative') {
        this.observation = { ...observation }
        this.resetRecovery()
        return this.transition('conservative', 'fresh')
      }
    }
    this.observation = { ...observation }
    if (this.budget.level === 'normal')
      return this.transition('normal', 'fresh')
    if (
      (processHeadroomBytes !== undefined &&
        processHeadroomBytes < memoryBudgetTiming.recoveryHeadroomBytes) ||
      (systemAvailableBytes !== undefined &&
        systemAvailableBytes < memoryBudgetTiming.recoveryHeadroomBytes)
    ) {
      this.resetRecovery()
      return this.budget
    }
    this.recoveryStartedMilliseconds ??= current
    if (distinct) this.recoveryObservationCount += 1
    if (
      this.recoveryObservationCount < memoryBudgetTiming.recoveryObservations ||
      current - this.recoveryStartedMilliseconds <
        memoryBudgetTiming.recoveryQuietMilliseconds
    )
      return this.budget
    this.recoveryStartedMilliseconds = current
    this.recoveryObservationCount = 0
    return this.transition(
      this.budget.level === 'reduced' ? 'conservative' : 'normal',
      'recovery',
    )
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.observation = undefined
    this.resetRecovery()
    this.transition('reduced', 'closed')
    this.cacheReduction = undefined
  }
}

/** Fixed ceilings bound work. Observations never guarantee future allocations. */
export function createMemoryBudgetPolicy(
  configuration: MemoryBudgetConfiguration,
): MemoryBudgetPolicy {
  return new PortableMemoryBudget(configuration)
}

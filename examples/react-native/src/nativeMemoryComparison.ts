import {
  createMemoryBudgetPolicy,
  memoryBudgetTiming,
  type ClientConfiguration,
  type MemoryBudgetPolicy,
  type MemoryWorkBudget,
} from '@synloquent/client'
import {
  createNativeMemoryBudget,
  type NativeMemoryBudget,
} from '@synloquent/client/react-native'
import { callingThreadCpuMilliseconds } from '@synloquent/client/native-crypto'
import { nativeClock } from './platform'

export type NativeMemoryMode = 'fixed-conservative' | 'adaptive'
type Owner = 'sdk' | 'reference' | 'largeHTTP' | 'batchSync'
type Operation = 'current' | 'observe' | 'refresh' | 'close'
interface Timing {
  calls: number
  failures: number
  measuredCalls: number
  wallMilliseconds: number
  callingThreadCpuMilliseconds: number
  maximumWallMilliseconds: number
}
interface Decision {
  readonly observedAtMilliseconds: number | null
  readonly origin: Operation | 'cache-reduction' | 'startup'
  readonly budget: MemoryWorkBudget
}
const maximumDecisions = 64
const timing = (): Timing => ({
  calls: 0,
  failures: 0,
  measuredCalls: 0,
  wallMilliseconds: 0,
  callingThreadCpuMilliseconds: 0,
  maximumWallMilliseconds: 0,
})

/** Diagnostic owners inject the same public configuration seam into every client. */
export function createNativeMemoryComparison(mode: NativeMemoryMode) {
  if (mode !== 'fixed-conservative' && mode !== 'adaptive')
    throw new Error('Unsupported diagnostic memory mode.')
  const owners = new Map<Owner, ReturnType<typeof createOwner>>()
  let closing: Promise<void> | undefined
  let closed = false
  let callingThreadCpuReadFailures = 0
  const callingThreadCpu = () => {
    try {
      const value = callingThreadCpuMilliseconds()
      if (!Number.isFinite(value) || value < 0)
        throw new Error('Invalid diagnostic calling-thread CPU clock.')
      return value
    } catch {
      callingThreadCpuReadFailures += 1
      return undefined
    }
  }

  function createOwner(name: Owner, reduceCache: () => void) {
    const timings = {
      current: timing(),
      observe: timing(),
      refresh: timing(),
      close: timing(),
    }
    let native: NativeMemoryBudget | undefined
    let closedOwner = false
    let pendingRefresh: Promise<void> | undefined
    let coalescedRefreshCalls = 0
    let clockReadFailures = 0
    let decisionCount = 0
    let latest: Decision | undefined
    const decisions: Decision[] = []
    const bookkeeping = timing()
    const setup = timing()
    const cacheReduction = timing()
    const point = () => {
      try {
        const wallMilliseconds = nativeClock.now()
        const callingThreadCpuMilliseconds = callingThreadCpu()
        if (
          !Number.isFinite(wallMilliseconds) ||
          callingThreadCpuMilliseconds === undefined ||
          wallMilliseconds < 0
        )
          throw new Error('Invalid diagnostic measurement clock.')
        return { wallMilliseconds, callingThreadCpuMilliseconds }
      } catch {
        clockReadFailures += 1
        return undefined
      }
    }
    const elapsed = (
      entry: Timing,
      start: ReturnType<typeof point>,
      end: ReturnType<typeof point>,
    ) => {
      if (
        !start ||
        !end ||
        end.wallMilliseconds < start.wallMilliseconds ||
        end.callingThreadCpuMilliseconds < start.callingThreadCpuMilliseconds
      )
        return
      const wallMilliseconds = end.wallMilliseconds - start.wallMilliseconds
      entry.measuredCalls += 1
      entry.wallMilliseconds += wallMilliseconds
      entry.callingThreadCpuMilliseconds +=
        end.callingThreadCpuMilliseconds - start.callingThreadCpuMilliseconds
      entry.maximumWallMilliseconds = Math.max(
        entry.maximumWallMilliseconds,
        wallMilliseconds,
      )
    }
    const record = (
      budget: MemoryWorkBudget,
      origin: Decision['origin'],
      observedAtMilliseconds: number | null,
    ) => {
      if (
        latest &&
        latest.budget.level === budget.level &&
        latest.budget.reason === budget.reason
      )
        return
      const decision: Decision = {
        origin,
        observedAtMilliseconds,
        budget: { ...budget },
      }
      decisionCount += 1
      if (decisions.length < maximumDecisions) decisions.push(decision)
      latest = decision
    }
    const setupStarted = point()
    setup.calls += 1
    if (mode === 'adaptive') {
      native = createNativeMemoryBudget({
        nowMilliseconds: () => nativeClock.now(),
        onCacheBudgetReduced: ({ current }) => {
          cacheReduction.calls += 1
          const started = point()
          record(current, 'cache-reduction', started?.wallMilliseconds ?? null)
          try {
            reduceCache()
          } catch (failure) {
            cacheReduction.failures += 1
            throw failure
          } finally {
            elapsed(cacheReduction, started, point())
          }
        },
      })
    }
    const policy =
      native?.policy ??
      createMemoryBudgetPolicy({
        nowMilliseconds: () => nativeClock.now(),
      })
    const fixed = policy.current()
    record(fixed, 'startup', point()?.wallMilliseconds ?? null)
    elapsed(setup, setupStarted, point())
    const measure = (
      operation: Operation,
      callback: () => MemoryWorkBudget,
    ): MemoryWorkBudget => {
      const entry = timings[operation]
      entry.calls += 1
      const start = point()
      let returned: MemoryWorkBudget | undefined
      try {
        returned = callback()
        return returned
      } catch (failure) {
        entry.failures += 1
        throw failure
      } finally {
        const finished = point()
        elapsed(entry, start, finished)
        if (returned)
          record(returned, operation, finished?.wallMilliseconds ?? null)
        bookkeeping.calls += 1
        elapsed(bookkeeping, finished, point())
      }
    }
    const measuredPolicy: MemoryBudgetPolicy = {
      current: () =>
        measure('current', () =>
          mode === 'fixed-conservative' && !closedOwner
            ? fixed
            : policy.current(),
        ),
      observe: (observation) =>
        measure('observe', () =>
          mode === 'fixed-conservative' && !closedOwner
            ? fixed
            : policy.observe(observation),
        ),
      close: () => {
        void close().catch(() => undefined)
      },
    }
    const refresh = (): Promise<void> => {
      timings.refresh.calls += 1
      if (closedOwner) return Promise.resolve()
      if (pendingRefresh) {
        coalescedRefreshCalls += 1
        return pendingRefresh
      }
      const start = point()
      let pending: Promise<void>
      try {
        pending = native?.refresh() ?? Promise.resolve()
      } catch (failure) {
        timings.refresh.failures += 1
        throw failure
      }
      pendingRefresh = pending
        .then(
          () => undefined,
          (failure) => {
            timings.refresh.failures += 1
            throw failure
          },
        )
        .finally(() => {
          const finished = point()
          elapsed(timings.refresh, start, finished)
          record(
            mode === 'fixed-conservative' && !closedOwner
              ? fixed
              : policy.current(),
            'refresh',
            finished?.wallMilliseconds ?? null,
          )
          pendingRefresh = undefined
        })
      return pendingRefresh
    }
    let closingOwner: Promise<void> | undefined
    function close(): Promise<void> {
      if (closingOwner) return closingOwner
      closedOwner = true
      const pending = pendingRefresh ? [pendingRefresh] : []
      try {
        measure('close', () => {
          try {
            native?.close()
          } finally {
            if (!native) policy.close()
          }
          return policy.current()
        })
      } catch (failure) {
        pending.push(Promise.reject(failure))
      }
      closingOwner = Promise.allSettled(pending).then((results) => {
        const errors = results.flatMap((result) =>
          result.status === 'rejected' ? [result.reason] : [],
        )
        if (errors.length)
          throw new AggregateError(
            errors,
            'Diagnostic memory client cleanup failed.',
          )
      })
      return closingOwner
    }
    return {
      configuration: {
        memoryBudget: measuredPolicy,
        refreshMemoryBudget: refresh,
      } satisfies Pick<
        ClientConfiguration,
        'memoryBudget' | 'refreshMemoryBudget'
      >,
      close,
      report() {
        return {
          owner: name,
          closed: closedOwner,
          pendingOwnedRefresh: pendingRefresh !== undefined,
          nativePressureSubscriptionActive:
            native?.nativePressureSubscriptionActive ?? false,
          nativeSampleRequestCount: native?.sampleRequestCount ?? 0,
          acceptedSampleCount: native?.sampleCount ?? 0,
          acceptedSampleCountMeaning:
            'Current-lifecycle completed observations, including unavailable values. Actual native attempts are nativeSampleRequestCount.',
          lastObservation: native?.lastObservation ?? null,
          nativePressureEventCount: null,
          nativePressureEventCountMeaning:
            'Not exposed by the supported controller interface',
          timings: Object.fromEntries(
            Object.entries(timings).map(([operation, value]) => [
              operation,
              { ...value },
            ]),
          ),
          bookkeeping: { ...bookkeeping },
          setup: { ...setup },
          cacheReduction: { ...cacheReduction },
          clockReadFailures,
          coalescedRefreshCalls,
          decisionCount,
          decisionTraceMeaning:
            'Changes observed at wrapper admission, refresh completion and cache reduction. Native pressure event count is not exposed.',
          droppedDecisions: Math.max(0, decisionCount - maximumDecisions),
          decisions: decisions.slice(),
          latest,
        }
      },
    }
  }
  return {
    callingThreadCpu,
    client(name: Owner, reduceCache: () => void) {
      if (closed || owners.has(name) || owners.size >= 4)
        throw new Error(
          'Diagnostic memory owner is closed or already enrolled.',
        )
      const owner = createOwner(name, reduceCache)
      owners.set(name, owner)
      return owner.configuration
    },
    close(): Promise<void> {
      if (closing) return closing
      closed = true
      closing = Promise.allSettled(
        [...owners.values()].map((owner) => owner.close()),
      ).then((results) => {
        const errors = results.flatMap((result) =>
          result.status === 'rejected' ? [result.reason] : [],
        )
        if (errors.length)
          throw new AggregateError(
            errors,
            'Diagnostic memory owner cleanup failed.',
          )
      })
      return closing
    },
    report() {
      return {
        mode,
        closed,
        maximumOwners: 4,
        maximumDecisionsPerOwner: maximumDecisions,
        startup: 'conservative',
        preconditioning: 'none',
        recoveryTiming: memoryBudgetTiming,
        helperInjectedSyntheticPressure: false,
        callingThreadCpuReadFailures,
        timingMeaning:
          'Calling-thread CPU across awaited refresh includes other Hermes work. Operation windows can overlap. Setup, cache callback and bookkeeping windows are partial overhead measurements. Clock probe cost is not isolated. Entire comparison is acceptance-excluded.',
        owners: [...owners.values()].map((owner) => owner.report()),
      }
    },
  }
}

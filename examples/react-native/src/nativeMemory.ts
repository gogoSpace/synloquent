import { Platform } from 'react-native'
import { createNativeMemoryBudget } from '@synloquent/client/react-native'
import { callingThreadCpuMilliseconds } from '@synloquent/client/native-crypto'
import { nativeClock } from './platform'

/** Actual platform sampling and generated-event registration, without synthetic pressure. */
export async function verifyNativeMemoryBudget() {
  const started = nativeClock.now()
  const cpuStarted = callingThreadCpuMilliseconds()
  const memory = createNativeMemoryBudget({
    nowMilliseconds: () => nativeClock.now(),
  })
  try {
    if (memory.policy.current().level !== 'conservative')
      throw new Error('Native memory work must start conservatively.')
    await memory.refresh()
    const first = memory.lastObservation
    const firstWorkBudget = memory.policy.current()
    const unavailableFallback = (
      observation: typeof first,
      budget: typeof firstWorkBudget,
    ) =>
      Platform.OS === 'ios' &&
      observation?.validity === 'unavailable' &&
      observation.pressure === 'normal' &&
      observation.processHeadroomBytes === undefined &&
      observation.systemAvailableBytes === undefined &&
      (budget.reason === 'unknown' ||
        (budget.reason === 'pressure' && budget.level === 'reduced')) &&
      (budget.level === 'conservative' || budget.level === 'reduced') &&
      budget.maximumBatchRows === (budget.level === 'reduced' ? 4 : 16) &&
      budget.maximumBindingBytes ===
        (budget.level === 'reduced' ? 8192 : 16384) &&
      budget.maximumHashBufferUnits === 16384 &&
      budget.maximumCacheBytes ===
        (budget.level === 'reduced' ? 0 : 512 * 1024) &&
      budget.maximumCacheEntries === (budget.level === 'reduced' ? 0 : 64) &&
      budget.maximumPrefetchConcurrency === 0 &&
      budget.maximumSnapshotConcurrency ===
        (budget.level === 'reduced' ? 0 : 1) &&
      budget.maximumSnapshotResponseBytes === 65536
    if (
      memory.sampleCount !== 1 ||
      first === undefined ||
      (first?.validity !== 'valid' &&
        !unavailableFallback(first, firstWorkBudget)) ||
      !memory.nativePressureSubscriptionActive
    )
      throw new Error(
        'The real native memory sample or generated event bridge is unavailable.',
      )
    if (
      Platform.OS === 'ios' &&
      first.validity === 'valid' &&
      (first.processHeadroomBytes === undefined ||
        first.processHeadroomBytes <= 0 ||
        first.systemAvailableBytes !== undefined)
    )
      throw new Error('iOS memory must report advisory application headroom.')
    if (
      Platform.OS === 'android' &&
      (first.processHeadroomBytes !== undefined ||
        first.systemAvailableBytes === undefined)
    )
      throw new Error(
        'Android system availability must not be represented as application headroom.',
      )
    for (let index = 0; index < 8; index++) await memory.refresh()
    if (memory.sampleCount !== 1)
      throw new Error('Native admission sampling must be rate limited.')
    memory.reset()
    await memory.refresh()
    const last = memory.lastObservation
    const lastWorkBudget = memory.policy.current()
    if (
      Number(memory.sampleCount) !== 2 ||
      lastWorkBudget.level === 'normal' ||
      (last?.validity !== 'valid' &&
        !unavailableFallback(last, lastWorkBudget)) ||
      (last?.validity === 'valid' &&
        (Platform.OS === 'ios'
          ? last.processHeadroomBytes === undefined ||
            last.processHeadroomBytes <= 0 ||
            last.systemAvailableBytes !== undefined
          : last.processHeadroomBytes !== undefined ||
            last.systemAvailableBytes === undefined))
    )
      throw new Error(
        'Lifecycle replacement must discard previous recovery and resample conservatively.',
      )
    memory.close()
    memory.close()
    await memory.refresh()
    if (Number(memory.sampleCount) !== 2)
      throw new Error('Closed memory observers must not sample again.')
    return {
      platform: Platform.OS,
      actualNativeSample: true,
      generatedEventSubscription: true,
      syntheticPressure: false,
      pressureDeliveryGuaranteed: false,
      systemAvailabilityIsApplicationHeadroom: false,
      sampleCount: memory.sampleCount,
      firstObservation: first,
      lastObservation: last,
      firstWorkBudget,
      lastWorkBudget,
      rateLimitedRequests: 8,
      lifecycleResampled: true,
      closeIdempotent: true,
      elapsedMilliseconds: nativeClock.now() - started,
      cpuMilliseconds: callingThreadCpuMilliseconds() - cpuStarted,
    }
  } finally {
    memory.close()
  }
}

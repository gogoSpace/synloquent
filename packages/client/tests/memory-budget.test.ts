import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createMemoryBudgetPolicy,
  memoryBudgetTiming,
} from '../src/core/memory-budget.js'
import type {
  MemoryCacheReduction,
  MemoryObservation,
  MemoryWorkBudget,
} from '../src/core/memory-budget.js'

const availableHeadroomBytes = 128 * 1024 ** 2

function createHarness() {
  let currentMilliseconds = 0
  const reductions: MemoryCacheReduction[] = []
  const policy = createMemoryBudgetPolicy({
    nowMilliseconds: () => currentMilliseconds,
    onCacheBudgetReduced: (event) => reductions.push(event),
  })
  return {
    policy,
    reductions,
    now: () => currentMilliseconds,
    setTime(value: number) {
      currentMilliseconds = value
    },
    observe(overrides: Partial<MemoryObservation> = {}) {
      return policy.observe({
        observedAtMilliseconds: currentMilliseconds,
        validity: 'valid',
        pressure: 'normal',
        processHeadroomBytes: availableHeadroomBytes,
        ...overrides,
      })
    },
  }
}

function recoverOneLevel(harness: ReturnType<typeof createHarness>) {
  const started = harness.now()
  let budget = harness.observe()
  for (let elapsed = 5000; elapsed <= 30000; elapsed += 5000) {
    harness.setTime(started + elapsed)
    budget = harness.observe()
  }
  return budget
}

function assertHardCeilings(budget: MemoryWorkBudget) {
  const ceilings = {
    maximumBatchRows: 64,
    maximumBindingBytes: 65536,
    maximumHashBufferUnits: 65536,
    maximumCacheBytes: 4 * 1024 ** 2,
    maximumCacheEntries: 256,
    maximumPrefetchConcurrency: 1,
    maximumSnapshotConcurrency: 1,
    maximumSnapshotResponseBytes: 65536,
  }
  for (const key of Object.keys(ceilings) as (keyof typeof ceilings)[]) {
    assert.ok(Number.isSafeInteger(budget[key]), key)
    assert.ok(budget[key] >= 0, key)
    assert.ok(budget[key] <= ceilings[key], key)
  }
  assert.ok(budget.maximumBatchRows > 0)
  assert.ok(budget.maximumBindingBytes > 0)
  assert.ok(budget.maximumHashBufferUnits > 0)
  assert.equal(budget.maximumSnapshotResponseBytes, 65536)
  assert.ok(Object.isFrozen(budget))
}

test('startup has finite conservative work and no optional prefetch', () => {
  const harness = createHarness()
  const budget = harness.policy.current()
  assert.equal(budget.level, 'conservative')
  assert.equal(budget.maximumBatchRows, 16)
  assert.equal(budget.maximumSnapshotConcurrency, 1)
  assert.equal(budget.maximumPrefetchConcurrency, 0)
  assertHardCeilings(budget)
})

test('large system availability cannot hide low application headroom', () => {
  const harness = createHarness()
  const budget = harness.observe({
    processHeadroomBytes: 8 * 1024 ** 2,
    systemAvailableBytes: 16 * 1024 ** 3,
  })
  assert.equal(budget.level, 'reduced')
  assert.equal(budget.reason, 'low_headroom')
  assert.equal(budget.maximumSnapshotConcurrency, 0)
  assert.equal(budget.maximumPrefetchConcurrency, 0)
  assert.equal(budget.maximumCacheBytes, 0)
})

test('system-only observations cannot increase a portable process budget', () => {
  const harness = createHarness()
  for (let count = 0; count < 20; count++) {
    harness.setTime(count * 2000)
    const budget = harness.policy.observe({
      observedAtMilliseconds: harness.now(),
      validity: 'valid',
      pressure: 'normal',
      systemAvailableBytes: 16 * 1024 ** 3,
    })
    assert.equal(budget.level, 'conservative')
    assert.equal(budget.reason, 'fresh')
  }
})

test('fresh system-only recovery restores conservative admissions but never normal', () => {
  const harness = createHarness()
  harness.observe({ pressure: 'critical' })
  for (let elapsed = 0; elapsed <= 90000; elapsed += 5000) {
    harness.setTime(elapsed)
    const budget = harness.policy.observe({
      observedAtMilliseconds: elapsed,
      validity: 'valid',
      pressure: 'normal',
      systemAvailableBytes: availableHeadroomBytes,
    })
    assert.equal(budget.level, elapsed < 30000 ? 'reduced' : 'conservative')
    assert.equal(budget.maximumPrefetchConcurrency, 0)
  }
  assert.equal(harness.policy.current().maximumSnapshotConcurrency, 1)
})

test('missing or stale system-only observations cannot restore reduced admissions', () => {
  const harness = createHarness()
  harness.observe({ pressure: 'critical' })
  for (const elapsed of [0, 15000, 30000, 45000]) {
    harness.setTime(elapsed)
    const budget = harness.policy.observe({
      observedAtMilliseconds: elapsed,
      validity: 'valid',
      pressure: 'normal',
      systemAvailableBytes: availableHeadroomBytes,
    })
    assert.equal(budget.level, 'reduced')
  }
  for (let count = 0; count < 20; count++) {
    harness.setTime(harness.now() + 2000)
    assert.equal(
      harness.policy.observe({
        observedAtMilliseconds: harness.now(),
        validity: 'valid',
        pressure: 'normal',
      }).level,
      'reduced',
    )
  }
})

test('system-only observation demotes a previous application-headroom normal budget', () => {
  const harness = createHarness()
  recoverOneLevel(harness)
  const budget = harness.policy.observe({
    observedAtMilliseconds: harness.now(),
    validity: 'valid',
    pressure: 'normal',
    systemAvailableBytes: availableHeadroomBytes,
  })
  assert.equal(budget.level, 'conservative')
  assert.equal(harness.reductions.length, 1)
})

test('warning and critical pressure reduce immediately without byte estimates', () => {
  for (const pressure of ['warning', 'critical'] as const) {
    const harness = createHarness()
    assert.equal(recoverOneLevel(harness).level, 'normal')
    const budget = harness.policy.observe({
      observedAtMilliseconds: Number.NaN,
      validity: 'unavailable',
      pressure,
    })
    assert.equal(budget.level, 'reduced')
    assert.equal(budget.reason, 'pressure')
    assert.equal(harness.reductions.length, 1)
    assert.equal(harness.reductions[0]?.current.maximumCacheEntries, 0)
  }
})

test('recovery requires quiet fresh observations and advances one level at a time', () => {
  const harness = createHarness()
  harness.observe({ pressure: 'critical' })
  assert.equal(recoverOneLevel(harness).level, 'conservative')
  assert.equal(harness.policy.current().maximumPrefetchConcurrency, 0)
  assert.equal(recoverOneLevel(harness).level, 'normal')
  assert.equal(harness.policy.current().maximumPrefetchConcurrency, 1)
})

test('many immediate samples do not replace the recovery quiet period', () => {
  const harness = createHarness()
  for (let count = 0; count < 100; count++) {
    harness.setTime(count)
    assert.equal(harness.observe().level, 'conservative')
  }
})

test('a gap longer than freshness resets recovery even without current calls', () => {
  const harness = createHarness()
  for (const current of [0, 15000, 30000, 45000]) {
    harness.setTime(current)
    assert.equal(harness.observe().level, 'conservative')
  }
  assert.equal(recoverOneLevel(harness).level, 'normal')
})

test('admission expires a normal budget at the original observation TTL', () => {
  const harness = createHarness()
  assert.equal(recoverOneLevel(harness).level, 'normal')
  const observedAt = harness.now()
  harness.setTime(
    observedAt + memoryBudgetTiming.maximumObservationAgeMilliseconds,
  )
  assert.equal(harness.policy.current().level, 'normal')
  harness.setTime(
    observedAt + memoryBudgetTiming.maximumObservationAgeMilliseconds + 1,
  )
  const budget = harness.policy.current()
  assert.equal(budget.level, 'conservative')
  assert.equal(budget.reason, 'stale')
  assert.equal(harness.reductions.length, 1)
  assert.equal(harness.reductions[0]?.previous.maximumCacheBytes, 4 * 1024 ** 2)
})

test('unknown and unavailable observations reduce normal and cannot recover reduced', () => {
  for (const observation of [
    { pressure: 'unknown' },
    { validity: 'unavailable' },
  ] as const) {
    const harness = createHarness()
    recoverOneLevel(harness)
    assert.equal(harness.observe(observation).level, 'conservative')
    harness.observe({ pressure: 'critical' })
    assert.equal(harness.observe(observation).level, 'reduced')
  }
})

test('invalid byte observations cannot authorize an increased budget', () => {
  for (const invalid of [
    -1,
    Number.NaN,
    Infinity,
    1.25,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    for (const key of [
      'processHeadroomBytes',
      'systemAvailableBytes',
    ] as const) {
      const harness = createHarness()
      recoverOneLevel(harness)
      const budget = harness.observe({ [key]: invalid })
      assert.equal(budget.level, 'conservative')
      assert.equal(budget.reason, 'invalid_observation')
    }
  }
})

test('future, stale and reordered timestamps never authorize recovery', () => {
  for (const timestamp of [-1, Number.NaN, Infinity, 31000, 1]) {
    const harness = createHarness()
    recoverOneLevel(harness)
    const budget = harness.observe({ observedAtMilliseconds: timestamp })
    assert.equal(budget.level, 'conservative')
    assert.ok(['stale', 'invalid_observation'].includes(budget.reason))
  }
})

test('repeated timestamps do not count as distinct recovery observations', () => {
  const harness = createHarness()
  for (let count = 0; count < 100; count++) {
    harness.setTime(count * 50)
    assert.equal(
      harness.observe({ observedAtMilliseconds: 0 }).level,
      'conservative',
    )
  }
  harness.setTime(5001)
  assert.equal(harness.observe({ observedAtMilliseconds: 0 }).reason, 'stale')
})

test('headroom hysteresis resists oscillation and recovery resets on pressure', () => {
  const harness = createHarness()
  recoverOneLevel(harness)
  assert.equal(
    harness.observe({ processHeadroomBytes: 48 * 1024 ** 2 }).level,
    'normal',
  )
  assert.equal(
    harness.observe({ processHeadroomBytes: 31 * 1024 ** 2 }).level,
    'reduced',
  )
  for (let count = 1; count <= 20; count++) {
    harness.setTime(harness.now() + 2000)
    assert.equal(
      harness.observe({
        processHeadroomBytes: (count % 2 ? 80 : 16) * 1024 ** 2,
      }).level,
      'reduced',
    )
  }
  assert.equal(recoverOneLevel(harness).level, 'conservative')
})

test('low system availability is a reduction signal despite high process headroom', () => {
  const harness = createHarness()
  recoverOneLevel(harness)
  assert.equal(harness.observe({ systemAvailableBytes: 1024 }).level, 'reduced')
  assert.equal(
    harness.observe({ systemAvailableBytes: 48 * 1024 ** 2 }).level,
    'reduced',
  )
})

test('backwards clocks invalidate recovery and cannot create a new clock epoch', () => {
  const harness = createHarness()
  recoverOneLevel(harness)
  harness.setTime(0)
  assert.equal(harness.policy.current().reason, 'invalid_clock')
  for (const current of [5000, 15000, 29999]) {
    harness.setTime(current)
    assert.equal(harness.observe().level, 'conservative')
    assert.equal(harness.policy.current().reason, 'invalid_clock')
  }
  harness.setTime(30000)
  assert.equal(harness.observe().level, 'conservative')
  assert.equal(recoverOneLevel(harness).level, 'normal')
})

test('throwing, nonfinite and negative clocks fail safely', () => {
  for (const clock of [
    () => {
      throw new Error('clock unavailable')
    },
    () => Number.NaN,
    () => Infinity,
    () => -1,
  ]) {
    const policy = createMemoryBudgetPolicy({ nowMilliseconds: clock })
    assert.equal(policy.current().reason, 'invalid_clock')
    assert.equal(
      policy.observe({
        observedAtMilliseconds: 0,
        validity: 'valid',
        pressure: 'normal',
        processHeadroomBytes: availableHeadroomBytes,
      }).level,
      'conservative',
    )
    assert.equal(
      policy.observe({
        observedAtMilliseconds: 0,
        validity: 'unavailable',
        pressure: 'critical',
      }).level,
      'reduced',
    )
  }
})

test('caller mutation cannot extend the retained observation freshness', () => {
  const harness = createHarness()
  recoverOneLevel(harness)
  const observation = {
    observedAtMilliseconds: harness.now(),
    validity: 'valid' as const,
    pressure: 'normal' as const,
    processHeadroomBytes: availableHeadroomBytes,
  }
  harness.policy.observe(observation)
  harness.setTime(harness.now() + 5001)
  observation.observedAtMilliseconds = harness.now()
  assert.equal(harness.policy.current().reason, 'stale')
})

test('cache reduction notifications release rebuildable ownership without blocking policy', () => {
  const cache = new Map([['model', { values: ['rebuildable'] }]])
  let notifications = 0
  const policy = createMemoryBudgetPolicy({
    nowMilliseconds: () => 0,
    onCacheBudgetReduced: () => {
      notifications++
      cache.clear()
      throw new Error('observer failure')
    },
  })
  const pressure: MemoryObservation = {
    observedAtMilliseconds: 0,
    validity: 'unavailable',
    pressure: 'critical',
  }
  assert.equal(policy.observe(pressure).level, 'reduced')
  assert.equal(cache.size, 0)
  assert.equal(notifications, 1)
  policy.observe(pressure)
  assert.equal(notifications, 1)
})

test('close is idempotent and releases observer ownership without subsequent reads', () => {
  let clockCalls = 0
  let cacheNotifications = 0
  const policy = createMemoryBudgetPolicy({
    nowMilliseconds: () => {
      clockCalls++
      return 0
    },
    onCacheBudgetReduced: () => cacheNotifications++,
  })
  policy.current()
  policy.close()
  policy.close()
  const previousClockCalls = clockCalls
  const budget = policy.observe({
    observedAtMilliseconds: 0,
    validity: 'valid',
    pressure: 'normal',
    processHeadroomBytes: availableHeadroomBytes,
  })
  assert.equal(budget.reason, 'closed')
  assert.equal(policy.current(), budget)
  assert.equal(clockCalls, previousClockCalls)
  assert.equal(cacheNotifications, 1)
  assert.equal(budget.maximumSnapshotConcurrency, 0)
  assert.equal(budget.maximumCacheEntries, 0)
})

test('changing conditions always preserve hard ceilings and reject optional work under pressure', () => {
  const harness = createHarness()
  for (let count = 0; count < 256; count++) {
    harness.setTime(count * 2000)
    const budget = harness.observe(
      count % 31 === 30
        ? { pressure: 'critical' }
        : count % 19 === 18
          ? { validity: 'unavailable' }
          : { processHeadroomBytes: availableHeadroomBytes },
    )
    assertHardCeilings(budget)
    if (budget.level === 'reduced') {
      assert.equal(budget.maximumCacheEntries, 0)
      assert.equal(budget.maximumSnapshotConcurrency, 0)
      assert.equal(budget.maximumPrefetchConcurrency, 0)
    }
  }
})

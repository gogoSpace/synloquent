import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import typescript from 'typescript'
import * as memoryPolicy from '../src/core/memory-budget.js'
import type { MemoryBudgetConfiguration } from '../src/core/memory-budget.js'

interface MemoryBoundary {
  readonly policy: memoryPolicy.MemoryBudgetPolicy
  readonly nativePressureSubscriptionActive: boolean
  readonly sampleCount: number
  readonly sampleRequestCount: number
  refresh(): Promise<void>
  reset(): void
  close(): void
}

type Listener = (event: unknown) => void

async function harness(
  options: { missingPressure?: boolean; failedRemoval?: boolean } = {},
) {
  let nowMilliseconds = 0
  let clockFailure = false
  let calls = 0
  let removals = 0
  const listeners = new Map<string, Listener>()
  let sample: () => Promise<unknown> = async () => nativeSample()
  const subscribe = (name: string, listener: Listener) => {
    listeners.set(name, listener)
    return {
      remove() {
        removals += 1
        listeners.delete(name)
        if (options.failedRemoval) throw new Error('remove failed')
      },
    }
  }
  const source = await readFile(
    new URL('../src/react-native/memory.ts', import.meta.url),
    'utf8',
  )
  const compiled = typescript.transpileModule(source, {
    compilerOptions: {
      target: typescript.ScriptTarget.ES2022,
      module: typescript.ModuleKind.CommonJS,
    },
  }).outputText
  const exported: {
    readNativeMemoryEvidence?: (owner: MemoryBoundary) => {
      eventSequence: number
      events: Array<Record<string, unknown>>
      lastPressure: Record<string, unknown> | null
    }
    createNativeMemoryBudget?: (
      configuration: MemoryBudgetConfiguration,
    ) => MemoryBoundary
  } = {}
  new Function('require', 'exports', compiled)((name: string) => {
    if (name === 'react-native')
      return { AppState: { addEventListener: subscribe } }
    if (name === '../core/memory-budget.js') return memoryPolicy
    if (name === '../native-crypto/specs/NativeSynloquentCrypto.js')
      return {
        default: {
          sampleMemory: () => {
            calls += 1
            return sample()
          },
          onMemoryPressure: options.missingPressure
            ? undefined
            : (listener: Listener) => subscribe('pressure', listener),
        },
      }
    throw new Error(`Unexpected source dependency ${name}`)
  }, exported)
  assert.ok(exported.createNativeMemoryBudget)
  const boundary = exported.createNativeMemoryBudget({
    nowMilliseconds: () => {
      if (clockFailure) throw new Error('unavailable clock')
      return nowMilliseconds
    },
  })
  return {
    boundary,
    evidence: () => exported.readNativeMemoryEvidence!(boundary),
    listeners,
    get calls() {
      return calls
    },
    get removals() {
      return removals
    },
    failClock() {
      clockFailure = true
    },
    setTime(value: number) {
      nowMilliseconds = value
    },
    setSample(value: () => Promise<unknown>) {
      sample = value
    },
    emit(name: string, value: unknown) {
      listeners.get(name)?.(value)
    },
  }
}

function nativeSample(overrides: Record<string, unknown> = {}) {
  return {
    processHeadroomBytes: 128 * 1024 ** 2,
    systemAvailableBytes: null,
    systemLowMemoryThresholdBytes: null,
    systemLowMemory: null,
    // Different native clock epoch must not be compared with the JS clock.
    sampledAtMonotonicMilliseconds: 9_000_000,
    ...overrides,
  }
}

for (const missingPressure of [false, true])
  test(`native pressure registration evidence is truthful with missingPressure=${missingPressure}`, async () => {
    const fixture = await harness({ missingPressure })
    try {
      assert.equal(
        fixture.boundary.nativePressureSubscriptionActive,
        !missingPressure,
      )
      await fixture.boundary.refresh()
      assert.equal(fixture.boundary.sampleCount, 1)
      assert.equal(
        fixture.boundary.nativePressureSubscriptionActive,
        !missingPressure,
      )
    } finally {
      fixture.boundary.close()
      assert.equal(fixture.boundary.nativePressureSubscriptionActive, false)
      assert.equal(fixture.listeners.size, 0)
    }
  })

function deferred<Value>() {
  let resolve!: (value: Value) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function settle() {
  for (let index = 0; index < 6; index += 1) await Promise.resolve()
}

test('native admission is single-flight, rate limited and owns no polling work', async () => {
  const fixture = await harness()
  try {
    const waiting = deferred<unknown>()
    fixture.setSample(() => waiting.promise)
    const first = fixture.boundary.refresh()
    assert.equal(fixture.boundary.refresh(), first)
    await settle()
    assert.equal(fixture.calls, 1)
    waiting.resolve(nativeSample())
    await first
    fixture.setTime(1999)
    await fixture.boundary.refresh()
    assert.equal(fixture.calls, 1)
    fixture.setTime(2000)
    await fixture.boundary.refresh()
    assert.equal(fixture.calls, 2)
    await settle()
    assert.equal(fixture.calls, 2)
  } finally {
    fixture.boundary.close()
  }
})

test('fresh iOS headroom can recover only after repeated quiet observations', async () => {
  const fixture = await harness()
  try {
    for (let time = 0; time <= 30000; time += 5000) {
      fixture.setTime(time)
      await fixture.boundary.refresh()
      if (time < 30000)
        assert.equal(fixture.boundary.policy.current().level, 'conservative')
    }
    assert.equal(fixture.boundary.policy.current().level, 'normal')
    fixture.setTime(35001)
    assert.equal(fixture.boundary.policy.current().level, 'conservative')
  } finally {
    fixture.boundary.close()
  }
})

for (const [name, overrides] of [
  ['zero process headroom', { processHeadroomBytes: 0 }],
  ['unknown fields', { processHeadroomBytes: null }],
  ['negative bytes', { processHeadroomBytes: -1 }],
  ['unsafe bytes', { processHeadroomBytes: Number.MAX_SAFE_INTEGER + 1 }],
  ['nonfinite native time', { sampledAtMonotonicMilliseconds: Infinity }],
  ['negative native time', { sampledAtMonotonicMilliseconds: -1 }],
  ['invalid pressure flag', { systemLowMemory: 'true' }],
  [
    'system-only availability',
    { processHeadroomBytes: null, systemAvailableBytes: 16 * 1024 ** 3 },
  ],
] as const) {
  test(`${name} cannot establish normal application capacity`, async () => {
    const fixture = await harness()
    try {
      fixture.setSample(async () => nativeSample(overrides))
      for (let time = 0; time <= 40000; time += 5000) {
        fixture.setTime(time)
        await fixture.boundary.refresh()
      }
      assert.equal(fixture.boundary.policy.current().level, 'conservative')
    } finally {
      fixture.boundary.close()
    }
  })
}

test('Android low-memory sample reduces work without a warning event', async () => {
  const fixture = await harness({ missingPressure: true })
  try {
    fixture.setSample(async () =>
      nativeSample({
        processHeadroomBytes: null,
        systemAvailableBytes: 100,
        systemLowMemory: true,
      }),
    )
    await fixture.boundary.refresh()
    assert.equal(fixture.boundary.policy.current().level, 'reduced')
    assert.equal(fixture.boundary.policy.current().maximumCacheEntries, 0)
    assert.equal(
      fixture.boundary.policy.current().maximumSnapshotConcurrency,
      0,
    )
  } finally {
    fixture.boundary.close()
  }
})

for (const completedTime of [5001, -1]) {
  test(`sample completing at ${completedTime} is discarded conservatively`, async () => {
    const fixture = await harness()
    try {
      const waiting = deferred<unknown>()
      fixture.setSample(() => waiting.promise)
      const result = fixture.boundary.refresh()
      await settle()
      fixture.setTime(completedTime)
      waiting.resolve(nativeSample({ processHeadroomBytes: 1 }))
      await result
      assert.equal(fixture.boundary.policy.current().level, 'conservative')
    } finally {
      fixture.boundary.close()
    }
  })
}

test('reset discards delayed previous account observations and resets the rate limit', async () => {
  const fixture = await harness()
  try {
    const waiting = deferred<unknown>()
    fixture.setSample(() => waiting.promise)
    const result = fixture.boundary.refresh()
    await settle()
    fixture.boundary.reset()
    waiting.resolve(nativeSample({ processHeadroomBytes: 1 }))
    await result
    assert.equal(fixture.boundary.policy.current().level, 'conservative')
    fixture.setSample(async () => nativeSample())
    await fixture.boundary.refresh()
    assert.equal(fixture.calls, 2)
  } finally {
    fixture.boundary.close()
  }
})

test('native request evidence counts discarded attempts separately from accepted samples', async () => {
  const fixture = await harness()
  try {
    const waiting = deferred<unknown>()
    fixture.setSample(() => waiting.promise)
    const pending = fixture.boundary.refresh()
    await settle()
    assert.equal(fixture.boundary.sampleRequestCount, 1)
    assert.equal(fixture.boundary.sampleCount, 0)
    fixture.boundary.reset()
    waiting.resolve(nativeSample())
    await pending
    assert.equal(fixture.boundary.sampleRequestCount, fixture.calls)
    assert.equal(fixture.boundary.sampleCount, 0)
    fixture.setSample(async () => nativeSample())
    await fixture.boundary.refresh()
    assert.equal(fixture.boundary.sampleRequestCount, 2)
    assert.equal(fixture.boundary.sampleCount, 1)
    await fixture.boundary.refresh()
    assert.equal(fixture.boundary.sampleRequestCount, 2)
    fixture.boundary.close()
    await fixture.boundary.refresh()
    assert.equal(fixture.boundary.sampleRequestCount, 2)
    assert.equal(fixture.calls, 2)
  } finally {
    fixture.boundary.close()
  }
})

for (const pressure of ['warning', 'critical']) {
  test(`${pressure} invalidates an earlier sample and immediately reduces work`, async () => {
    const fixture = await harness()
    try {
      const waiting = deferred<unknown>()
      fixture.setSample(() => waiting.promise)
      const result = fixture.boundary.refresh()
      await settle()
      fixture.emit('pressure', {
        kind: pressure,
        observedAtMonotonicMilliseconds: 123,
      })
      assert.equal(fixture.boundary.policy.current().level, 'reduced')
      waiting.resolve(nativeSample())
      await result
      assert.equal(fixture.boundary.policy.current().level, 'reduced')
    } finally {
      fixture.boundary.close()
    }
  })
}

test('lifecycle admission samples on foreground and memoryWarning reduces without polling', async () => {
  const fixture = await harness()
  try {
    fixture.emit('change', 'background')
    await settle()
    assert.equal(fixture.calls, 0)
    fixture.emit('change', 'active')
    await settle()
    assert.equal(fixture.calls, 1)
    fixture.emit('memoryWarning', undefined)
    assert.equal(fixture.boundary.policy.current().level, 'reduced')
  } finally {
    fixture.boundary.close()
  }
})

test('missing native pressure subscription leaves supported lifecycle and sampling active', async () => {
  const fixture = await harness({ missingPressure: true })
  try {
    await fixture.boundary.refresh()
    assert.equal(fixture.calls, 1)
    assert.equal(fixture.listeners.size, 2)
    assert.equal(fixture.boundary.policy.current().level, 'conservative')
  } finally {
    fixture.boundary.close()
  }
})

test('native sample rejection is handled and a later admission can recover', async () => {
  const fixture = await harness()
  try {
    fixture.setSample(async () => {
      throw new Error('native unavailable')
    })
    await fixture.boundary.refresh()
    assert.equal(fixture.boundary.policy.current().level, 'conservative')
    fixture.setTime(2000)
    fixture.setSample(async () => nativeSample({ processHeadroomBytes: 1 }))
    await fixture.boundary.refresh()
    assert.equal(fixture.boundary.policy.current().level, 'reduced')
  } finally {
    fixture.boundary.close()
  }
})

test('close is idempotent, removes every listener and ignores late samples/events', async () => {
  const fixture = await harness({ failedRemoval: true })
  const waiting = deferred<unknown>()
  fixture.setSample(() => waiting.promise)
  const result = fixture.boundary.refresh()
  await settle()
  const latePressure = fixture.listeners.get('pressure')!
  fixture.boundary.close()
  fixture.boundary.close()
  assert.equal(fixture.removals, 3)
  assert.equal(fixture.listeners.size, 0)
  waiting.resolve(nativeSample())
  await result
  latePressure({ kind: 'normal' })
  await fixture.boundary.refresh()
  assert.equal(fixture.calls, 1)
  assert.equal(fixture.boundary.policy.current().level, 'reduced')
})

for (const event of [
  null,
  undefined,
  {},
  { kind: 'warning' },
  { kind: 'critical', observedAtMonotonicMilliseconds: -1 },
  { kind: 'warning', observedAtMonotonicMilliseconds: NaN },
  { kind: 'unsupported', observedAtMonotonicMilliseconds: 10 },
]) {
  test(`malformed pressure event ${JSON.stringify(event)} safely discards pending observations`, async () => {
    const fixture = await harness()
    try {
      const waiting = deferred<unknown>()
      fixture.setSample(() => waiting.promise)
      const result = fixture.boundary.refresh()
      await settle()
      assert.doesNotThrow(() => fixture.emit('pressure', event))
      waiting.resolve(nativeSample({ processHeadroomBytes: 1 }))
      await result
      assert.equal(fixture.boundary.policy.current().level, 'conservative')
    } finally {
      fixture.boundary.close()
    }
  })
}

for (const sample of [
  null,
  undefined,
  {},
  nativeSample({ systemAvailableBytes: undefined }),
  nativeSample({ systemLowMemoryThresholdBytes: -1 }),
]) {
  test(`malformed native sample ${JSON.stringify(sample)} is unavailable`, async () => {
    const fixture = await harness()
    try {
      fixture.setSample(async () => sample)
      await fixture.boundary.refresh()
      assert.equal(fixture.boundary.policy.current().level, 'conservative')
    } finally {
      fixture.boundary.close()
    }
  })
}

test('foreground invalidation keeps the original admission pending through the current sample', async () => {
  const fixture = await harness()
  const previous = deferred<unknown>()
  const current = deferred<unknown>()
  let inFlight = 0
  let maximumInFlight = 0
  let admissionCompleted = false
  fixture.setSample(() => {
    inFlight += 1
    maximumInFlight = Math.max(maximumInFlight, inFlight)
    return (fixture.calls === 1 ? previous.promise : current.promise).finally(
      () => {
        inFlight -= 1
      },
    )
  })
  const admission = fixture.boundary.refresh()
  void admission.then(() => {
    admissionCompleted = true
  })
  try {
    await settle()
    fixture.emit('change', 'active')
    assert.equal(fixture.boundary.refresh(), admission)
    fixture.setTime(6000)
    previous.resolve(nativeSample({ processHeadroomBytes: 1 }))
    await settle()
    await settle()
    assert.equal(fixture.calls, 2)
    assert.equal(fixture.boundary.sampleRequestCount, 2)
    assert.equal(fixture.boundary.sampleCount, 0)
    assert.equal(fixture.boundary.policy.current().level, 'conservative')
    assert.equal(fixture.boundary.refresh(), admission)
    assert.equal(admissionCompleted, false)
    current.resolve(nativeSample())
    await admission
    assert.equal(admissionCompleted, true)
    assert.equal(fixture.boundary.sampleCount, 1)
    assert.equal(maximumInFlight, 1)
    fixture.setTime(7999)
    await fixture.boundary.refresh()
    assert.equal(fixture.calls, 2)
    await settle()
    assert.equal(fixture.calls, 2)
  } finally {
    previous.resolve(nativeSample())
    current.resolve(nativeSample())
    fixture.boundary.close()
    await admission
    assert.equal(fixture.listeners.size, 0)
  }
})

test('multiple foreground changes coalesce into one latest current sample', async () => {
  const fixture = await harness()
  const previous = deferred<unknown>()
  const current = deferred<unknown>()
  fixture.setSample(() =>
    fixture.calls === 1 ? previous.promise : current.promise,
  )
  const admission = fixture.boundary.refresh()
  try {
    await settle()
    for (let index = 0; index < 3; index += 1) {
      fixture.emit('change', 'active')
      assert.equal(fixture.boundary.refresh(), admission)
    }
    previous.resolve(nativeSample({ processHeadroomBytes: 1 }))
    await settle()
    assert.equal(fixture.calls, 2)
    assert.equal(fixture.boundary.sampleCount, 0)
    current.resolve(nativeSample())
    await admission
    assert.equal(fixture.boundary.sampleRequestCount, 2)
    assert.equal(fixture.boundary.sampleCount, 1)
    await settle()
    assert.equal(fixture.calls, 2)
  } finally {
    previous.resolve(nativeSample())
    current.resolve(nativeSample())
    fixture.boundary.close()
    await admission
  }
})

test('a foreground change during the drain retains only the latest queued revision', async () => {
  const fixture = await harness()
  const requests = [
    deferred<unknown>(),
    deferred<unknown>(),
    deferred<unknown>(),
  ]
  fixture.setSample(() => requests[fixture.calls - 1]!.promise)
  const admission = fixture.boundary.refresh()
  try {
    await settle()
    fixture.emit('change', 'active')
    requests[0]!.resolve(nativeSample({ processHeadroomBytes: 1 }))
    await settle()
    assert.equal(fixture.calls, 2)
    fixture.emit('change', 'active')
    fixture.emit('change', 'active')
    assert.equal(fixture.boundary.refresh(), admission)
    requests[1]!.resolve(nativeSample({ processHeadroomBytes: 1 }))
    await settle()
    assert.equal(fixture.calls, 3)
    assert.equal(fixture.boundary.sampleCount, 0)
    requests[2]!.resolve(nativeSample())
    await admission
    assert.equal(fixture.boundary.sampleCount, 1)
    assert.equal(fixture.boundary.sampleRequestCount, 3)
    await settle()
    assert.equal(fixture.calls, 3)
  } finally {
    for (const request of requests) request.resolve(nativeSample())
    fixture.boundary.close()
    await admission
  }
})

test('an invalidated native rejection drains only the event-requested foreground sample', async () => {
  const fixture = await harness()
  const previous = deferred<unknown>()
  const current = deferred<unknown>()
  fixture.setSample(() =>
    fixture.calls === 1 ? previous.promise : current.promise,
  )
  const admission = fixture.boundary.refresh()
  try {
    await settle()
    fixture.emit('change', 'active')
    previous.reject(new Error('previous native request rejected'))
    await settle()
    assert.equal(fixture.calls, 2)
    assert.equal(fixture.boundary.refresh(), admission)
    current.resolve(nativeSample())
    await admission
    assert.equal(fixture.boundary.sampleCount, 1)
    assert.equal(fixture.boundary.sampleRequestCount, 2)
  } finally {
    previous.resolve(nativeSample())
    current.resolve(nativeSample())
    fixture.boundary.close()
    await admission
  }
})

test('foreground sample rejection remains conservative without an automatic retry', async () => {
  const fixture = await harness()
  const previous = deferred<unknown>()
  const current = deferred<unknown>()
  fixture.setSample(() =>
    fixture.calls === 1 ? previous.promise : current.promise,
  )
  const admission = fixture.boundary.refresh()
  try {
    await settle()
    fixture.emit('change', 'active')
    fixture.setTime(1000)
    previous.resolve(nativeSample({ processHeadroomBytes: 1 }))
    await settle()
    assert.equal(fixture.calls, 2)
    current.reject(new Error('current native request rejected'))
    await admission
    assert.equal(fixture.boundary.sampleCount, 0)
    assert.equal(fixture.boundary.policy.current().level, 'conservative')
    await settle()
    fixture.setTime(2999)
    await fixture.boundary.refresh()
    assert.equal(fixture.calls, 2)
    fixture.setTime(3000)
    fixture.setSample(async () => nativeSample())
    await fixture.boundary.refresh()
    assert.equal(fixture.calls, 3)
    assert.equal(fixture.boundary.sampleCount, 1)
  } finally {
    previous.resolve(nativeSample())
    current.resolve(nativeSample())
    fixture.boundary.close()
    await admission
  }
})

test('foreground demand arriving between sample settlement and cleanup is not lost', async () => {
  const fixture = await harness()
  const previous = deferred<unknown>()
  const current = deferred<unknown>()
  let admissionCompleted = false
  fixture.setSample(() =>
    fixture.calls === 1 ? previous.promise : current.promise,
  )
  const admission = fixture.boundary.refresh()
  void admission.then(() => {
    admissionCompleted = true
  })
  try {
    await settle()
    void previous.promise.then(() => {
      queueMicrotask(() => fixture.emit('change', 'active'))
    })
    previous.resolve(nativeSample())
    await settle()
    assert.equal(fixture.calls, 2)
    assert.equal(fixture.boundary.sampleCount, 1)
    assert.equal(fixture.boundary.refresh(), admission)
    assert.equal(admissionCompleted, false)
    current.resolve(nativeSample())
    await admission
    assert.equal(fixture.boundary.sampleCount, 2)
    assert.equal(fixture.calls, 2)
  } finally {
    previous.resolve(nativeSample())
    current.resolve(nativeSample())
    fixture.boundary.close()
    await admission
  }
})

const foregroundCancellationReasons = [
  'reset',
  'pressure',
  'malformed pressure',
  'memoryWarning',
  'inactive',
  'close',
] as const

type ForegroundCancellationReason =
  (typeof foregroundCancellationReasons)[number]

function cancelForegroundDemand(
  fixture: Awaited<ReturnType<typeof harness>>,
  reason: ForegroundCancellationReason,
) {
  if (reason === 'reset') fixture.boundary.reset()
  else if (reason === 'pressure')
    fixture.emit('pressure', {
      kind: 'warning',
      observedAtMonotonicMilliseconds: 123,
    })
  else if (reason === 'malformed pressure') fixture.emit('pressure', null)
  else if (reason === 'memoryWarning') fixture.emit('memoryWarning', undefined)
  else if (reason === 'inactive') fixture.emit('change', 'background')
  else fixture.boundary.close()
}

for (const reason of foregroundCancellationReasons) {
  test(`${reason} cancels queued foreground work while the previous native request is pending`, async () => {
    const fixture = await harness()
    const previous = deferred<unknown>()
    fixture.setSample(() => previous.promise)
    const admission = fixture.boundary.refresh()
    try {
      await settle()
      fixture.emit('change', 'active')
      cancelForegroundDemand(fixture, reason)
      previous.resolve(nativeSample({ processHeadroomBytes: 1 }))
      await admission
      assert.equal(fixture.calls, 1)
      assert.equal(fixture.boundary.sampleRequestCount, 1)
      assert.equal(fixture.boundary.sampleCount, 0)
      await settle()
      assert.equal(fixture.calls, 1)
    } finally {
      previous.resolve(nativeSample())
      fixture.boundary.close()
      await admission
      assert.equal(fixture.listeners.size, 0)
    }
  })

  test(`${reason} cancels consumed foreground work before its deferred native invocation`, async () => {
    const fixture = await harness()
    const previous = deferred<unknown>()
    let cancellationObserved = false
    fixture.setSample(() => previous.promise)
    const admission = fixture.boundary.refresh()
    try {
      await settle()
      fixture.emit('change', 'active')
      void previous.promise.then(() => {
        queueMicrotask(() => {
          queueMicrotask(() => {
            cancellationObserved = true
            cancelForegroundDemand(fixture, reason)
          })
        })
      })
      previous.resolve(nativeSample({ processHeadroomBytes: 1 }))
      await admission
      assert.equal(cancellationObserved, true)
      assert.equal(fixture.calls, 1)
      assert.equal(fixture.boundary.sampleRequestCount, 1)
      assert.equal(fixture.boundary.sampleCount, 0)
      await settle()
      assert.equal(fixture.calls, 1)
    } finally {
      previous.resolve(nativeSample())
      fixture.boundary.close()
      await admission
      assert.equal(fixture.listeners.size, 0)
    }
  })
}

for (let depth = 0; depth <= 6; depth += 1) {
  test(`public foreground admission settlement is atomic at nested microtask depth ${depth}`, async () => {
    const fixture = await harness()
    const requests = [
      deferred<unknown>(),
      deferred<unknown>(),
      deferred<unknown>(),
    ]
    let admissionCompleted = false
    let stateAtEvent: Promise<'pending' | 'fulfilled'> | undefined
    let latestAdmission: Promise<void> | undefined
    fixture.setSample(() => requests[fixture.calls - 1]!.promise)
    const admission = fixture.boundary.refresh()
    void admission.then(() => {
      admissionCompleted = true
    })
    try {
      await settle()
      fixture.emit('change', 'active')
      requests[0]!.resolve(nativeSample({ processHeadroomBytes: 1 }))
      await settle()
      assert.equal(fixture.calls, 2)
      void requests[1]!.promise.then(() => {
        const enqueue = (remaining: number) => {
          if (remaining > 0) queueMicrotask(() => enqueue(remaining - 1))
          else {
            // An already fulfilled admission wins by registration order.
            // A pending admission loses to the already resolved marker even
            // when its fulfillment reaction has not run at this boundary.
            const pendingMarker = Symbol('pending-at-foreground-event')
            stateAtEvent = Promise.race([
              admission,
              Promise.resolve(pendingMarker),
            ]).then((value) =>
              value === pendingMarker ? 'pending' : 'fulfilled',
            )
            fixture.emit('change', 'active')
            latestAdmission = fixture.boundary.refresh()
          }
        }
        enqueue(depth)
      })
      requests[1]!.resolve(nativeSample())
      for (let index = 0; index < 4; index += 1) await settle()
      assert.ok(stateAtEvent)
      assert.ok(latestAdmission)
      assert.equal(fixture.calls, 3)
      if ((await stateAtEvent) === 'pending') {
        assert.equal(latestAdmission, admission)
        assert.equal(admissionCompleted, false)
      } else {
        // An event after real public settlement starts a new admission.
        assert.notEqual(latestAdmission, admission)
        assert.equal(admissionCompleted, true)
      }
      const currentPendingMarker = Symbol('current-native-request-pending')
      assert.equal(
        await Promise.race([
          latestAdmission,
          Promise.resolve(currentPendingMarker),
        ]),
        currentPendingMarker,
      )
      assert.equal(fixture.boundary.sampleRequestCount, 3)
      requests[2]!.resolve(nativeSample())
      await latestAdmission
      await admission
      assert.equal(fixture.calls, 3)
      assert.equal(admissionCompleted, true)
    } finally {
      for (const request of requests) request.resolve(nativeSample())
      fixture.boundary.close()
      await admission
      await latestAdmission
      assert.equal(fixture.listeners.size, 0)
    }
  })
}

test('bounded memory evidence separates pressure, samples, lifecycle and recovery without losing the cause', async () => {
  const fixture = await harness()
  try {
    await fixture.boundary.refresh()
    fixture.setTime(1)
    fixture.emit('pressure', {
      kind: 'critical',
      source: 'onTrimMemory',
      trimMemoryLevel: 15,
      observedAtMonotonicMilliseconds: 900001,
    })
    const pressure = fixture.evidence().lastPressure!
    assert.deepEqual(pressure.payload, {
      kind: 'critical',
      source: 'onTrimMemory',
      trimMemoryLevel: 15,
      observedAtMonotonicMilliseconds: 900001,
    })
    assert.equal(pressure.receivedAtMilliseconds, 1)
    assert.equal(
      (pressure.decision as memoryPolicy.MemoryWorkBudget)
        .maximumSnapshotConcurrency,
      0,
    )
    const sequence = fixture.evidence().eventSequence
    for (let index = 0; index < 100000; index++)
      fixture.boundary.policy.current()
    assert.equal(fixture.evidence().eventSequence, sequence)
    fixture.setTime(2001)
    await fixture.boundary.refresh()
    assert.equal(fixture.boundary.policy.current().reason, 'pressure')
    for (let index = 2; index < 40; index++) {
      fixture.setTime(index * 2000 + 1)
      await fixture.boundary.refresh()
    }
    assert.equal(fixture.evidence().events.length, 32)
    assert.deepEqual(fixture.evidence().lastPressure, pressure)
    fixture.emit('change', 'background')
    assert.equal(fixture.evidence().events.at(-1)!.source, 'lifecycle')
    fixture.emit('memoryWarning', undefined)
    assert.equal(
      fixture.evidence().lastPressure!.source,
      'app-state-memory-warning',
    )
    assert.equal(
      fixture.boundary.policy.current().maximumSnapshotConcurrency,
      0,
    )
  } finally {
    fixture.boundary.close()
  }
})

test('discarded native sample retains original values without replacing a pressure decision', async () => {
  const fixture = await harness()
  try {
    const waiting = deferred<unknown>()
    fixture.setSample(() => waiting.promise)
    const pending = fixture.boundary.refresh()
    await settle()
    fixture.setTime(5)
    fixture.emit('memoryWarning', undefined)
    waiting.resolve(nativeSample())
    await pending
    const event = fixture.evidence().events.at(-1)!
    assert.equal(event.source, 'discarded-sample')
    assert.equal(event.requestedAtMilliseconds, 0)
    assert.equal(event.receivedAtMilliseconds, 5)
    assert.equal(
      (event.decision as memoryPolicy.MemoryWorkBudget).reason,
      'pressure',
    )
    assert.equal(fixture.boundary.sampleCount, 0)
  } finally {
    fixture.boundary.close()
  }
})

test('diagnostic clock failure cannot break close or retain subscriptions', async () => {
  const fixture = await harness()
  await fixture.boundary.refresh()
  fixture.failClock()
  assert.doesNotThrow(() => fixture.boundary.close())
  assert.equal(fixture.listeners.size, 0)
  assert.equal(fixture.evidence().events.at(-1)!.source, 'close')
  assert.equal(fixture.evidence().events.at(-1)!.receivedAtMilliseconds, null)
})

test('logging a discarded sample does not advance the policy clock or recovery', async () => {
  const fixture = await harness()
  try {
    await fixture.boundary.refresh()
    fixture.setTime(2000)
    const waiting = deferred<unknown>()
    fixture.setSample(() => waiting.promise)
    const pending = fixture.boundary.refresh()
    await settle()
    fixture.boundary.reset()
    fixture.setTime(10000)
    waiting.resolve(nativeSample())
    await pending
    fixture.setTime(4000)
    fixture.setSample(async () => nativeSample())
    await fixture.boundary.refresh()
    assert.notEqual(fixture.boundary.policy.current().reason, 'invalid_clock')
  } finally {
    fixture.boundary.close()
  }
})

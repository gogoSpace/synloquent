import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import typescript from 'typescript'
import type { Transport } from '../src/core/types.js'
import type {
  HttpStage,
  ReactNativeHttpConfiguration,
} from '../src/react-native/http/types.js'

interface StageDiagnostics {
  readonly maximumRetainedGroups: number
  readonly retainedGroups: number
  readonly observedEvents: number
  readonly droppedGroupAdmissions: number
  readonly discardedEvents: number
  readonly discardedFields: number
  readonly maximumObservedHeapBytes?: number | undefined
}
interface ObservedStage extends HttpStage {
  readonly heapBytes?: number
  readonly callCount: number
  readonly aggregation: StageDiagnostics & {
    readonly method: string
    readonly responseCharactersUnit: string
    readonly boundarySelection: string
  }
}
interface Emission {
  readonly stage: HttpStage
  readonly heapBytes?: number
}

const availabilityBoundary =
  'complete response availability from React Native fetch'

async function fixture() {
  let heapBytes: number | undefined
  let emissions: readonly Emission[] = []
  let configuration: ReactNativeHttpConfiguration | undefined
  let closed = 0
  const phases: string[] = []
  const digest = async (content: string) => `owned-digest:${content}`
  const session = {
    accountId: '1',
    tenantId: '1',
    deviceId: 'stage-control',
    deviceEpoch: 'stage-epoch',
    generation: 1,
  }
  const emit = async () => {
    assert.ok(configuration)
    for (const emission of emissions) {
      heapBytes = emission.heapBytes
      configuration.observePhase?.(emission.stage.phase)
      configuration.observeStage?.(emission.stage)
    }
    return { records: [], relationSets: [] }
  }
  const dependencies: Record<string, unknown> = {
    '@synloquent/client/react-native': {
      ReactNativeHttpError: class extends Error {},
      createReactNativeHttpTransport(value: ReactNativeHttpConfiguration) {
        assert.equal(value.digest, digest)
        assert.equal(
          value.endpoint,
          'https://owned.invalid/synloquent/v1/protocol',
        )
        configuration = value
        return {
          transport: { snapshot: emit } as unknown as Transport,
          setSession() {},
          suspend() {},
          async close() {
            closed++
          },
        }
      },
    },
    './platform': {
      nativeClock: {
        now: () => 100,
        memory: {
          get usedJSHeapSize() {
            return heapBytes
          },
        },
      },
      setApplicationWorkPhase(value: string) {
        phases.push(value)
      },
      observeNativeContinuation() {},
      schedule() {
        throw new Error('Telemetry must not schedule new work.')
      },
      digest,
    },
  }
  const source = await readFile(
    process.env.SYNLOQUENT_NATIVE_HTTP_STAGE_BASELINE ??
      new URL(
        '../../../examples/react-native/src/httpTransport.ts',
        import.meta.url,
      ),
    'utf8',
  )
  const compiled = typescript.transpileModule(source, {
    compilerOptions: {
      module: typescript.ModuleKind.CommonJS,
      target: typescript.ScriptTarget.ES2022,
    },
  }).outputText
  const exported = {} as {
    createExampleTransport(configuration: {
      address: string
      digest: typeof digest
    }): Transport & { close(): Promise<void> }
    nativeHttpStages(): readonly ObservedStage[]
    nativeHttpStageDiagnostics(): StageDiagnostics
    resetNativeHttpStages(): void
  }
  new Function('require', 'exports', compiled)((name: string) => {
    assert.ok(name in dependencies, `Unexpected source dependency ${name}`)
    return dependencies[name]
  }, exported)
  const transport = exported.createExampleTransport({
    address: 'https://owned.invalid',
    digest,
  })
  return {
    ...exported,
    phases,
    async send(values: readonly Emission[], kind = 'snapshot') {
      emissions = values
      await transport.snapshot({
        protocolVersion: 1,
        kind,
        requestId: 'stage-request',
        schemaFingerprint: 'stage-schema',
        session,
        payload: { dataset: 'catalog' },
      })
    },
    async close() {
      await transport.close()
      assert.equal(closed, 1)
    },
  }
}

function emission(
  phase: HttpStage['phase'],
  elapsedMilliseconds: number,
  options: Partial<HttpStage> = {},
  heapBytes = 100,
): Emission {
  return {
    stage: { kind: 'snapshot', phase, elapsedMilliseconds, ...options },
    heapBytes,
  }
}

test('1000 immutable parts retain exactly four cumulative snapshot phases', async () => {
  const control = await fixture()
  const descriptorText = '{"metadata":"😀雪"}'
  const confirmationText = '{"confirmed":true}'
  const events: Emission[] = [
    emission('responseAvailable', 11, {
      boundary: availabilityBoundary,
      serverTiming: 'snapshot;dur=4.5',
      serverProfile: '{"preparation":"first"}',
    }),
    emission('responseText', 2, {
      responseCharacters: descriptorText.length,
    }),
    emission('jsonDecode', 3, { maximumWorkSliceMilliseconds: 1 }),
    emission('shapeValidation', 5, { maximumWorkSliceMilliseconds: 2 }),
  ]
  let bundleCharacters = 0
  for (let bundle = 0; bundle < 63; bundle++) {
    const text = `bundle-${bundle}:😀雪`
    bundleCharacters += text.length
    events.push(
      emission('responseAvailable', 7, {
        boundary: availabilityBoundary,
        serverTiming: null,
        serverProfile: null,
      }),
      emission('responseText', 4, { responseCharacters: text.length }),
    )
  }
  for (let ordinal = 0; ordinal < 1000; ordinal++)
    events.push(
      emission(
        'jsonDecode',
        ordinal === 901 ? 8.25 : 2.5,
        {
          boundary: `immutable part ${ordinal}`,
          maximumWorkSliceMilliseconds: ordinal === 901 ? 7.75 : 0.5,
        },
        1000 + ordinal,
      ),
      emission(
        'shapeValidation',
        ordinal === 777 ? 5.5 : 1.25,
        {
          boundary: `immutable part ${ordinal}`,
          maximumWorkSliceMilliseconds: ordinal === 777 ? 5 : 0.25,
        },
        900 + ordinal,
      ),
    )
  events.push(
    emission('responseAvailable', 13, {
      boundary: availabilityBoundary,
      serverTiming: 'snapshot;dur=99',
      serverProfile: '{"preparation":"later"}',
    }),
    emission('responseText', 1, {
      responseCharacters: confirmationText.length,
    }),
    emission('jsonDecode', 1, { maximumWorkSliceMilliseconds: 0.1 }),
    emission('shapeValidation', 1, { maximumWorkSliceMilliseconds: 0.2 }),
  )
  try {
    await control.send(events)
    const stages = control.nativeHttpStages()
    assert.equal(stages.length, 4)
    assert.deepEqual(
      stages.map((stage) => stage.phase),
      ['responseAvailable', 'responseText', 'jsonDecode', 'shapeValidation'],
    )
    const [available, text, decode, shape] = stages
    assert.equal(available!.elapsedMilliseconds, 11 + 63 * 7 + 13)
    assert.equal(available!.callCount, 65)
    assert.equal(available!.boundary, availabilityBoundary)
    assert.equal(available!.serverTiming, 'snapshot;dur=4.5')
    assert.equal(available!.serverProfile, '{"preparation":"first"}')
    assert.equal(text!.elapsedMilliseconds, 2 + 63 * 4 + 1)
    assert.equal(text!.callCount, 65)
    assert.equal(
      text!.responseCharacters,
      descriptorText.length + bundleCharacters + confirmationText.length,
    )
    assert.equal(decode!.elapsedMilliseconds, 3 + 999 * 2.5 + 8.25 + 1)
    assert.equal(decode!.callCount, 1002)
    assert.equal(decode!.maximumWorkSliceMilliseconds, 7.75)
    assert.equal(decode!.heapBytes, 1999)
    assert.equal(decode!.boundary, 'immutable part 0')
    assert.equal(shape!.elapsedMilliseconds, 5 + 999 * 1.25 + 5.5 + 1)
    assert.equal(shape!.callCount, 1002)
    assert.equal(shape!.maximumWorkSliceMilliseconds, 5)
    assert.equal(shape!.heapBytes, 1899)
    for (const stage of stages) {
      assert.equal(stage.aggregation.method, 'sum by request kind and phase')
      assert.equal(
        stage.aggregation.responseCharactersUnit,
        'UTF-16 code units',
      )
      assert.equal(stage.aggregation.observedEvents, 2134)
      assert.equal(stage.aggregation.discardedEvents, 0)
    }
    assert.equal(control.phases.length, events.length)
  } finally {
    await control.close()
  }
})

test('legacy single response preserves its original four scalar measurements', async () => {
  const control = await fixture()
  const stages = [
    emission('responseAvailable', 12.5, {
      boundary: availabilityBoundary,
      serverTiming: 'snapshot;dur=3',
      serverProfile: 'legacy-profile',
    }),
    emission('responseText', 4.25, { responseCharacters: '😀雪'.length }),
    emission('jsonDecode', 7, { maximumWorkSliceMilliseconds: 1.5 }),
    emission('shapeValidation', 3, { maximumWorkSliceMilliseconds: 0.75 }),
  ]
  try {
    await control.send(stages)
    const actual = control.nativeHttpStages()
    assert.equal(actual.length, 4)
    for (let index = 0; index < stages.length; index++) {
      const { callCount, aggregation, ...original } = actual[index]!
      assert.equal(callCount, 1)
      assert.equal(aggregation.droppedGroupAdmissions, 0)
      assert.deepEqual(original, { ...stages[index]!.stage, heapBytes: 100 })
    }
  } finally {
    await control.close()
  }
})

test('grouping keeps request kinds separate and snapshots own aggregate metadata', async () => {
  const control = await fixture()
  try {
    await control.send([
      emission('responseAvailable', 1, { serverTiming: null }),
      emission('responseAvailable', 2, { serverTiming: 'snapshot;dur=1' }),
      emission('responseAvailable', 4, { serverTiming: 'snapshot;dur=9' }),
      emission('responseText', 5, { kind: 'query', responseCharacters: 3 }),
    ])
    const first = control.nativeHttpStages()
    assert.equal(first[0]!.serverTiming, 'snapshot;dur=1')
    assert.equal(first[0]!.elapsedMilliseconds, 7)
    assert.equal(first[1]!.kind, 'query')
    Reflect.set(first[0]!, 'elapsedMilliseconds', -100)
    Reflect.set(first[0]!.aggregation, 'discardedEvents', 999)
    assert.equal(control.nativeHttpStages()[0]!.elapsedMilliseconds, 7)
    assert.equal(control.nativeHttpStages()[0]!.aggregation.discardedEvents, 0)
    await control.send([emission('responseAvailable', 8)])
    assert.equal(control.nativeHttpStages()[0]!.elapsedMilliseconds, 15)
    assert.equal(first[0]!.elapsedMilliseconds, -100)
  } finally {
    await control.close()
  }
})

test('64-group cap reports every refused admission and continues retained groups', async () => {
  const control = await fixture()
  try {
    await control.send(
      Array.from({ length: 80 }, (_, index) =>
        emission(
          'responseText',
          1,
          {
            kind: `arbitrary-${index}`,
            responseCharacters: 2,
          },
          index === 79 ? 9000 : 100,
        ),
      ),
    )
    await control.send([
      emission('responseText', 3, {
        kind: 'arbitrary-0',
        responseCharacters: 4,
      }),
      emission('responseText', 3, { kind: 'arbitrary-79' }),
    ])
    const stages = control.nativeHttpStages()
    assert.equal(stages.length, 64)
    assert.equal(stages[0]!.callCount, 2)
    assert.equal(stages[0]!.elapsedMilliseconds, 4)
    assert.equal(stages[0]!.responseCharacters, 6)
    const diagnostics = control.nativeHttpStageDiagnostics()
    assert.deepEqual(diagnostics, {
      maximumRetainedGroups: 64,
      retainedGroups: 64,
      observedEvents: 82,
      droppedGroupAdmissions: 17,
      discardedEvents: 17,
      discardedFields: 0,
      maximumObservedHeapBytes: 9000,
    })
    assert.equal(stages[0]!.aggregation.droppedGroupAdmissions, 17)
    Reflect.set(diagnostics, 'discardedEvents', 0)
    assert.equal(control.nativeHttpStageDiagnostics().discardedEvents, 17)
  } finally {
    await control.close()
  }
})

test('oversized kind, boundary and headers are discarded explicitly without truncation', async () => {
  const control = await fixture()
  try {
    await control.send([
      emission('responseAvailable', 1, { kind: 'k'.repeat(129) }),
      emission('responseAvailable', 2, {
        boundary: 'b'.repeat(257),
        serverTiming: 'snapshot;dur=1,' + 't'.repeat(4096),
        serverProfile: 'p'.repeat(4097),
      }),
      emission('responseAvailable', 3, {
        boundary: availabilityBoundary,
        serverTiming: 'snapshot;dur=2',
        serverProfile: 'accepted-profile',
      }),
    ])
    const [stage] = control.nativeHttpStages()
    assert.equal(stage!.elapsedMilliseconds, 5)
    assert.equal(stage!.callCount, 2)
    assert.equal(stage!.boundary, availabilityBoundary)
    assert.equal(stage!.serverTiming, 'snapshot;dur=2')
    assert.equal(stage!.serverProfile, 'accepted-profile')
    assert.equal(control.nativeHttpStageDiagnostics().discardedFields, 4)
    assert.equal(control.nativeHttpStageDiagnostics().discardedEvents, 1)
  } finally {
    await control.close()
  }
})

test('reset clears all groups and counters while preserving earlier owned snapshots', async () => {
  const control = await fixture()
  try {
    await control.send([
      emission('responseText', 2, { responseCharacters: 8 }, 500),
      emission('responseText', 3, { responseCharacters: 10 }, 100),
      emission('responseText', 1, { kind: 'k'.repeat(129) }),
    ])
    const before = control.nativeHttpStages()
    control.resetNativeHttpStages()
    assert.deepEqual(control.nativeHttpStages(), [])
    assert.deepEqual(control.nativeHttpStageDiagnostics(), {
      maximumRetainedGroups: 64,
      retainedGroups: 0,
      observedEvents: 0,
      droppedGroupAdmissions: 0,
      discardedEvents: 0,
      discardedFields: 0,
      maximumObservedHeapBytes: undefined,
    })
    await control.send([
      emission('responseText', 7, { responseCharacters: 3 }, 50),
    ])
    assert.equal(control.nativeHttpStages()[0]!.callCount, 1)
    assert.equal(control.nativeHttpStages()[0]!.heapBytes, 50)
    assert.equal(before[0]!.callCount, 2)
    assert.equal(before[0]!.heapBytes, 500)
    assert.equal(before[0]!.aggregation.discardedEvents, 1)
  } finally {
    await control.close()
  }
})

test('facade retains only bounded stage scalar fields and preserves a peak across missing samples', async () => {
  const control = await fixture()
  const value = emission('responseText', 1, { responseCharacters: 2 }, 900)
  Reflect.set(value.stage, 'rawDocument', 'owned-only-raw-body')
  Reflect.set(value.stage, 'token', 'owned-only-token')
  Reflect.set(value.stage, 'graph', { records: [{ id: 'not-telemetry' }] })
  try {
    await control.send([value, { stage: value.stage }])
    const [stage] = control.nativeHttpStages()
    assert.equal(stage!.callCount, 2)
    assert.equal(stage!.heapBytes, 900)
    assert.equal(stage!.aggregation.maximumObservedHeapBytes, 900)
    assert.equal('rawDocument' in stage!, false)
    assert.equal('token' in stage!, false)
    assert.equal('graph' in stage!, false)
  } finally {
    await control.close()
  }
})

test('all discarded events still expose bounded diagnostics and the observed global peak', async () => {
  const control = await fixture()
  try {
    await control.send([
      emission('jsonDecode', 1, { kind: 'k'.repeat(129) }, 5000),
      emission('jsonDecode', 2, { kind: 'k'.repeat(129) }, 3000),
    ])
    assert.deepEqual(control.nativeHttpStages(), [])
    assert.deepEqual(control.nativeHttpStageDiagnostics(), {
      maximumRetainedGroups: 64,
      retainedGroups: 0,
      observedEvents: 2,
      droppedGroupAdmissions: 0,
      discardedEvents: 2,
      discardedFields: 2,
      maximumObservedHeapBytes: 5000,
    })
  } finally {
    await control.close()
  }
})

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import typescript from 'typescript'
import * as memoryPolicy from '../src/core/memory-budget.js'

interface Timing {
  calls: number
  failures: number
  measuredCalls: number
  wallMilliseconds: number
  callingThreadCpuMilliseconds: number
}
interface OwnerReport {
  owner: string
  closed: boolean
  pendingOwnedRefresh: boolean
  nativePressureSubscriptionActive: boolean
  nativeSampleRequestCount: number
  acceptedSampleCount: number
  nativePressureEventCount: null
  timings: Record<string, Timing>
  cacheReduction: Timing
  coalescedRefreshCalls: number
  clockReadFailures: number
  decisionCount: number
  droppedDecisions: number
  decisions: { budget: memoryPolicy.MemoryWorkBudget }[]
  latest: { budget: memoryPolicy.MemoryWorkBudget }
}
interface Comparison {
  client(
    name: 'sdk' | 'reference' | 'largeHTTP' | 'batchSync',
    reduceCache: () => void,
  ): {
    memoryBudget: memoryPolicy.MemoryBudgetPolicy
    refreshMemoryBudget(): Promise<void>
  }
  callingThreadCpu(): number | undefined
  close(): Promise<void>
  report(): {
    closed: boolean
    preconditioning: string
    recoveryTiming: typeof memoryPolicy.memoryBudgetTiming
    helperInjectedSyntheticPressure: boolean
    callingThreadCpuReadFailures: number
    owners: OwnerReport[]
  }
}

async function load(
  path: URL | string,
  dependencies: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const source = await readFile(path, 'utf8')
  const compiled = typescript.transpileModule(source, {
    compilerOptions: {
      target: typescript.ScriptTarget.ES2022,
      module: typescript.ModuleKind.CommonJS,
    },
  }).outputText
  const exported: Record<string, unknown> = {}
  new Function('require', 'exports', compiled)((name: string) => {
    assert.ok(
      Object.hasOwn(dependencies, name),
      `Unexpected dependency ${name}`,
    )
    return dependencies[name]
  }, exported)
  return exported
}

function deferred<Value>() {
  let resolve!: (value: Value) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<Value>((fulfill, fail) => {
    resolve = fulfill
    reject = fail
  })
  return { promise, resolve, reject }
}
function nativeSample(overrides: Record<string, unknown> = {}) {
  return {
    processHeadroomBytes: 128 * 1024 ** 2,
    systemAvailableBytes: null,
    systemLowMemoryThresholdBytes: null,
    systemLowMemory: null,
    sampledAtMonotonicMilliseconds: 9_000_000,
    ...overrides,
  }
}

async function harness(
  mode: 'fixed-conservative' | 'adaptive',
  options: { missingPressure?: boolean; failedRemoval?: boolean } = {},
) {
  let nowMilliseconds = 0
  let callingThreadCpu = 0
  let failedCpu = false
  let nativeCalls = 0
  let policyCreations = 0
  let nativeControllers = 0
  let removals = 0
  let sample: () => Promise<unknown> = async () => nativeSample()
  const listeners = new Set<{
    name: string
    listener: (event: unknown) => void
  }>()
  const subscribe = (name: string, listener: (event: unknown) => void) => {
    const registration = { name, listener }
    listeners.add(registration)
    return {
      remove() {
        removals += 1
        listeners.delete(registration)
        if (options.failedRemoval) throw new Error('controlled removal failure')
      },
    }
  }
  const portable = {
    ...memoryPolicy,
    createMemoryBudgetPolicy: (
      configuration: memoryPolicy.MemoryBudgetConfiguration,
    ) => {
      policyCreations += 1
      return memoryPolicy.createMemoryBudgetPolicy(configuration)
    },
  }
  const native = await load(
    new URL('../src/react-native/memory.ts', import.meta.url),
    {
      'react-native': { AppState: { addEventListener: subscribe } },
      '../core/memory-budget.js': portable,
      '../native-crypto/specs/NativeSynloquentCrypto.js': {
        default: {
          sampleMemory() {
            nativeCalls += 1
            return sample()
          },
          onMemoryPressure: options.missingPressure
            ? undefined
            : (listener: (event: unknown) => void) =>
                subscribe('pressure', listener),
        },
      },
    },
  )
  const createNativeMemoryBudget = native.createNativeMemoryBudget as (
    configuration: memoryPolicy.MemoryBudgetConfiguration,
  ) => unknown
  const module = await load(
    process.env.SYNLOQUENT_MEMORY_COMPARISON_SOURCE ??
      new URL(
        '../../../examples/react-native/src/nativeMemoryComparison.ts',
        import.meta.url,
      ),
    {
      '@synloquent/client': portable,
      '@synloquent/client/react-native': {
        createNativeMemoryBudget(
          configuration: memoryPolicy.MemoryBudgetConfiguration,
        ) {
          nativeControllers += 1
          return createNativeMemoryBudget(configuration)
        },
      },
      '@synloquent/client/native-crypto': {
        callingThreadCpuMilliseconds() {
          if (failedCpu) throw new Error('controlled CPU clock failure')
          return callingThreadCpu
        },
      },
      './platform': { nativeClock: { now: () => nowMilliseconds } },
    },
  )
  const comparison = (
    module.createNativeMemoryComparison as (mode: string) => Comparison
  )(mode)
  return {
    comparison,
    listeners,
    get nativeCalls() {
      return nativeCalls
    },
    get policyCreations() {
      return policyCreations
    },
    get nativeControllers() {
      return nativeControllers
    },
    get removals() {
      return removals
    },
    setTime(value: number, cpu = value / 2) {
      nowMilliseconds = value
      callingThreadCpu = cpu
    },
    failCpu() {
      failedCpu = true
    },
    setSample(value: () => Promise<unknown>) {
      sample = value
    },
    emit(name: string, event: unknown) {
      for (const registration of listeners)
        if (registration.name === name) registration.listener(event)
    },
  }
}

for (const mode of ['fixed-conservative', 'adaptive'] as const)
  test(`${mode} starts at the same public conservative limits and owns at most four policies`, async () => {
    const fixture = await harness(mode)
    const original = memoryPolicy.createMemoryBudgetPolicy({
      nowMilliseconds: () => 0,
    })
    try {
      for (const name of [
        'sdk',
        'reference',
        'largeHTTP',
        'batchSync',
      ] as const) {
        const configuration = fixture.comparison.client(name, () => undefined)
        assert.deepEqual(
          configuration.memoryBudget.current(),
          original.current(),
        )
      }
      assert.equal(fixture.policyCreations, 4)
      assert.equal(fixture.nativeControllers, mode === 'adaptive' ? 4 : 0)
      assert.equal(fixture.listeners.size, mode === 'adaptive' ? 12 : 0)
      assert.equal(fixture.nativeCalls, 0)
      assert.throws(
        () => fixture.comparison.client('sdk', () => undefined),
        /already enrolled/,
      )
      const report = fixture.comparison.report()
      assert.equal(report.preconditioning, 'none')
      assert.equal(report.recoveryTiming.recoveryQuietMilliseconds, 30000)
      assert.equal(report.helperInjectedSyntheticPressure, false)
    } finally {
      original.close()
      await fixture.comparison.close()
      assert.equal(fixture.listeners.size, 0)
      assert.ok(
        fixture.comparison.report().owners.every((owner) => owner.closed),
      )
      assert.throws(
        () => fixture.comparison.client('sdk', () => undefined),
        /closed/,
      )
    }
  })

test('fixed baseline ignores source-controlled pressure and never calls native sampling', async () => {
  const fixture = await harness('fixed-conservative')
  const configuration = fixture.comparison.client('sdk', () =>
    assert.fail('fixed cache callback'),
  )
  const initial = configuration.memoryBudget.current()
  try {
    configuration.memoryBudget.observe({
      observedAtMilliseconds: 0,
      validity: 'unavailable',
      pressure: 'critical',
    })
    fixture.setTime(60000)
    await configuration.refreshMemoryBudget()
    assert.deepEqual(configuration.memoryBudget.current(), initial)
    assert.equal(fixture.nativeCalls, 0)
    assert.equal(
      fixture.comparison.report().owners[0]!.nativeSampleRequestCount,
      0,
    )
  } finally {
    await fixture.comparison.close()
  }
})

test('adaptive admission preserves 30-second recovery and pressure evicts the live cache promptly', async () => {
  const fixture = await harness('adaptive')
  let cacheReductions = 0
  const configuration = fixture.comparison.client('sdk', () => {
    cacheReductions += 1
  })
  try {
    for (let time = 0; time <= 30000; time += 2000) {
      fixture.setTime(time)
      await configuration.refreshMemoryBudget()
      assert.equal(
        configuration.memoryBudget.current().level,
        time < 30000 ? 'conservative' : 'normal',
      )
    }
    assert.equal(configuration.memoryBudget.current().maximumBatchRows, 64)
    assert.equal(
      configuration.memoryBudget.current().maximumHashBufferUnits,
      65536,
    )
    fixture.emit('pressure', {
      kind: 'critical',
      observedAtMonotonicMilliseconds: 9_000_001,
    })
    assert.equal(configuration.memoryBudget.current().level, 'reduced')
    assert.equal(cacheReductions, 1)
    const report = fixture.comparison.report().owners[0]!
    assert.equal(report.nativeSampleRequestCount, fixture.nativeCalls)
    assert.equal(report.acceptedSampleCount, 16)
    assert.equal(report.nativePressureEventCount, null)
    assert.equal(report.latest.budget.level, 'reduced')
  } finally {
    await fixture.comparison.close()
  }
})

test('actual refresh attempts are single-flight and rate limited without extra subscriptions', async () => {
  const fixture = await harness('adaptive')
  const configuration = fixture.comparison.client('sdk', () => undefined)
  const waiting = deferred<unknown>()
  fixture.setSample(() => waiting.promise)
  try {
    const pending = configuration.refreshMemoryBudget()
    for (let index = 0; index < 50; index += 1)
      assert.equal(configuration.refreshMemoryBudget(), pending)
    await Promise.resolve()
    assert.equal(fixture.nativeCalls, 1)
    assert.equal(fixture.listeners.size, 3)
    fixture.setTime(100, 40)
    waiting.resolve(nativeSample())
    await pending
    fixture.setTime(1999)
    await configuration.refreshMemoryBudget()
    const report = fixture.comparison.report().owners[0]!
    assert.equal(report.nativeSampleRequestCount, 1)
    assert.equal(report.acceptedSampleCount, 1)
    assert.equal(report.coalescedRefreshCalls, 50)
    assert.equal(report.timings.refresh!.wallMilliseconds, 100)
    assert.equal(report.timings.refresh!.callingThreadCpuMilliseconds, 40)
  } finally {
    await fixture.comparison.close()
  }
})

for (const lifecycle of ['pressure', 'background', 'close'] as const)
  test(`${lifecycle} invalidates pending native samples without confusing accepted count with request count`, async () => {
    const fixture = await harness('adaptive')
    const configuration = fixture.comparison.client('sdk', () => undefined)
    const waiting = deferred<unknown>()
    fixture.setSample(() => waiting.promise)
    const pending = configuration.refreshMemoryBudget()
    await Promise.resolve()
    let closing: Promise<void> | undefined
    if (lifecycle === 'pressure')
      fixture.emit('pressure', {
        kind: 'warning',
        observedAtMonotonicMilliseconds: 1,
      })
    if (lifecycle === 'background') fixture.emit('change', 'background')
    if (lifecycle === 'close') closing = fixture.comparison.close()
    waiting.resolve(nativeSample())
    await pending
    await closing
    const report = fixture.comparison.report().owners[0]!
    assert.equal(report.nativeSampleRequestCount, 1)
    assert.equal(report.acceptedSampleCount, 0)
    await fixture.comparison.close()
    assert.equal(fixture.listeners.size, 0)
  })

test('late native rejection settles owned refresh and close without leaking subscriptions', async () => {
  const fixture = await harness('adaptive')
  const configuration = fixture.comparison.client('sdk', () => undefined)
  const waiting = deferred<unknown>()
  fixture.setSample(() => waiting.promise)
  const pending = configuration.refreshMemoryBudget()
  await Promise.resolve()
  const closing = fixture.comparison.close()
  let closed = false
  void closing.then(() => {
    closed = true
  })
  await Promise.resolve()
  assert.equal(closed, false)
  waiting.reject(new Error('late native failure'))
  await pending
  await closing
  assert.equal(fixture.comparison.report().owners[0]!.acceptedSampleCount, 0)
  assert.equal(fixture.listeners.size, 0)
})

test('missing native pressure capability remains explicit and CPU probe failures cannot alter policy results', async () => {
  const fixture = await harness('adaptive', { missingPressure: true })
  const configuration = fixture.comparison.client('sdk', () => undefined)
  fixture.failCpu()
  try {
    assert.equal(configuration.memoryBudget.current().level, 'conservative')
    await configuration.refreshMemoryBudget()
    assert.equal(fixture.comparison.callingThreadCpu(), undefined)
    const report = fixture.comparison.report()
    assert.ok(report.callingThreadCpuReadFailures > 0)
    assert.ok(report.owners[0]!.clockReadFailures > 0)
    assert.equal(report.owners[0]!.nativePressureSubscriptionActive, false)
    assert.equal(report.owners[0]!.timings.refresh!.measuredCalls, 0)
  } finally {
    await fixture.comparison.close()
  }
})

test('diagnostic decisions retain only the first 64 changes and the latest complete decision', async () => {
  const fixture = await harness('adaptive')
  const configuration = fixture.comparison.client('sdk', () => undefined)
  try {
    for (let index = 0; index < 100; index += 1) {
      configuration.memoryBudget.observe({
        observedAtMilliseconds: 0,
        validity: 'unavailable',
        pressure: index % 2 ? 'unknown' : 'warning',
      })
    }
    const report = fixture.comparison.report().owners[0]!
    assert.equal(report.decisions.length, 64)
    assert.ok(report.decisionCount > 64)
    assert.equal(report.droppedDecisions, report.decisionCount - 64)
    assert.deepEqual(report.latest.budget, configuration.memoryBudget.current())
  } finally {
    await fixture.comparison.close()
  }
})

test('all four native owners remove their original subscriptions even when removal throws', async () => {
  const fixture = await harness('adaptive', { failedRemoval: true })
  for (const name of ['sdk', 'reference', 'largeHTTP', 'batchSync'] as const)
    fixture.comparison.client(name, () => undefined)
  const closing = fixture.comparison.close()
  assert.equal(fixture.comparison.close(), closing)
  await closing
  assert.equal(fixture.listeners.size, 0)
  assert.equal(fixture.removals, 12)
  assert.ok(
    fixture.comparison
      .report()
      .owners.every((owner) => !owner.nativePressureSubscriptionActive),
  )
})

function withoutMemoryDiagnostics(source: string) {
  const parsed = typescript.createSourceFile(
    'nativePerformance.ts',
    source,
    typescript.ScriptTarget.Latest,
    true,
  )
  const onlyComparisonBranches = (block: typescript.Block) =>
    block.statements.length > 0 &&
    block.statements.every(
      (statement) =>
        typescript.isIfStatement(statement) &&
        statement.expression.getText(parsed) === 'comparison',
    )
  const transformed = typescript.transform(parsed, [
    (context) => {
      const visit: typescript.Visitor = (node) => {
        if (
          typescript.isImportDeclaration(node) &&
          node.moduleSpecifier.getText(parsed) === "'./nativeMemoryComparison'"
        )
          return undefined
        if (
          typescript.isPropertySignature(node) &&
          node.name.getText(parsed) === 'memoryMode'
        )
          return undefined
        if (
          typescript.isVariableStatement(node) &&
          node.declarationList.declarations.some((declaration) =>
            ['comparison', 'diagnosticLargeCallingThreadCpuStarted'].includes(
              declaration.name.getText(parsed),
            ),
          )
        )
          return undefined
        if (
          typescript.isIfStatement(node) &&
          ['provenance.memoryMode', 'comparison'].includes(
            node.expression.getText(parsed),
          )
        )
          return undefined
        if (
          typescript.isSpreadAssignment(node) &&
          node.expression
            .getText(parsed)
            .startsWith("comparison?.client('largeHTTP'")
        )
          return undefined
        if (
          typescript.isConditionalExpression(node) &&
          node.condition.getText(parsed) === 'comparison'
        )
          return typescript.visitNode(node.whenFalse, visit)
        if (
          typescript.isTryStatement(node) &&
          !node.catchClause &&
          node.finallyBlock
        ) {
          if (onlyComparisonBranches(node.tryBlock))
            return typescript.visitNodes(node.finallyBlock.statements, visit)
          if (onlyComparisonBranches(node.finallyBlock))
            return typescript.visitNodes(node.tryBlock.statements, visit)
        }
        return typescript.visitEachChild(node, visit, context)
      }
      return (root) =>
        typescript.visitNode(root, visit) as typescript.SourceFile
    },
  ])
  try {
    return typescript
      .createPrinter({
        removeComments: true,
        newLine: typescript.NewLineKind.LineFeed,
      })
      .printFile(transformed.transformed[0]!)
  } finally {
    transformed.dispose()
  }
}

test('removing only memory diagnostic seams restores the complete original performance program', async () => {
  const source = await readFile(
    process.env.SYNLOQUENT_MEMORY_PERFORMANCE_SOURCE ??
      new URL(
        '../../../examples/react-native/src/nativePerformance.ts',
        import.meta.url,
      ),
    'utf8',
  )
  const original = withoutMemoryDiagnostics(source)
  const parsed = typescript.createSourceFile(
    'projected.ts',
    original,
    typescript.ScriptTarget.Latest,
    true,
  )
  const tokens: [number, string][] = []
  const collect = (node: typescript.Node) => {
    const children = node.getChildren(parsed)
    if (children.length) children.forEach(collect)
    else if (
      node.kind !== typescript.SyntaxKind.EndOfFileToken &&
      node.kind !== typescript.SyntaxKind.SyntaxList
    )
      tokens.push([node.kind, node.getText(parsed)])
  }
  collect(parsed)
  // Golden includes every nontrivia token in the full pre-seam program.
  const { createHash } = await import('node:crypto')
  assert.equal(
    createHash('sha256').update(JSON.stringify(tokens)).digest('hex'),
    'a3d2fb55684b4efaa7541f77e6a80a8b71ea6fe438eeded0b54698e174cdf31e',
  )
})

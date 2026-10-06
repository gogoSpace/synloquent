import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Script, createContext } from 'node:vm'
import test from 'node:test'
import typescript from 'typescript'

const repository = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../..',
)
const sourceDirectory = resolve(repository, 'packages/client/src/react-native')
// The immutable historical budget is an optional negative control. All other
// modules and all workloads remain identical to the current-source run.
const historicalBudget = process.env.SYNLOQUENT_HTTP_HOST_TURN_BUDGET_SOURCE

// This models the installed RuntimeScheduler_Modern queue drain and microtask
// checkpoint, separately from host timers and a pending frame/input callback.
// It does not model Hermes execution costs, native frames or device performance.
class ApplicationTurns {
  time = 0
  clockStep = 0.25
  nextIdentity = 0
  nativeTasks = []
  timers = []
  hostCallbacks = []
  history = []
  controllers = []
  phase = ''
  hostWaitMilliseconds = 13

  now = () => {
    const result = this.time
    this.time += this.clockStep
    return result
  }

  enqueue(callback, kind, delayMilliseconds = 0) {
    const task = {
      identity: ++this.nextIdentity,
      callback,
      kind,
      delayMilliseconds,
      due: this.time + delayMilliseconds,
      phase: this.phase,
      active: true,
      delivered: false,
    }
    this.history.push(task)
    if (kind === 'native') this.nativeTasks.push(task)
    else this.timers.push(task)
    return task
  }

  nativeScheduler = {
    unstable_NormalPriority: 3,
    unstable_scheduleCallback: (priority, callback) => {
      assert.equal(priority, 3, 'Application work must retain NormalPriority')
      return this.enqueue(callback, 'native')
    },
    unstable_cancelCallback: (task) => {
      task.active = false
    },
  }

  setTimeout = (callback, delayMilliseconds) =>
    this.enqueue(callback, 'timer', delayMilliseconds)

  clearTimeout = (task) => {
    task.active = false
  }

  async checkpoint() {
    // The actual decoder/budget/transport promise chain is finite between
    // scheduled callbacks. Drain it without delivering any modeled host work.
    for (let step = 0; step < 32; step += 1) await Promise.resolve()
  }

  deliver(task) {
    task.active = false
    task.delivered = true
    task.callback()
  }

  async drainNative() {
    await this.checkpoint()
    let deliveries = 0
    while (this.nativeTasks.some((task) => task.active)) {
      assert(deliveries++ < 10000, 'The bounded native queue must terminate')
      this.deliver(this.nativeTasks.find((task) => task.active))
      await this.checkpoint()
    }
  }

  requestHostCallback(callback) {
    this.hostCallbacks.push(callback)
  }

  async hostTurn() {
    assert.equal(
      this.nativeTasks.some((task) => task.active),
      false,
      'A queued native task runs before the modeled host resumes',
    )
    for (const callback of this.hostCallbacks.splice(0)) callback()
    const task = this.timers
      .filter((entry) => entry.active)
      .sort((left, right) => left.due - right.due)[0]
    if (task) {
      this.time = Math.max(this.time + this.hostWaitMilliseconds, task.due)
      this.deliver(task)
    }
    await this.checkpoint()
  }

  async complete(outcome) {
    for (let turn = 0; turn < 10000; turn += 1) {
      await this.drainNative()
      if (outcome.status !== 'pending') {
        for (const callback of this.hostCallbacks.splice(0)) callback()
        return outcome
      }
      assert(
        this.timers.some((task) => task.active),
        'Pending work must have a scheduled continuation',
      )
      await this.hostTurn()
    }
    assert.fail('The bounded workload must settle')
  }

  assertClean() {
    assert.equal(this.history.filter((task) => task.active).length, 0)
    for (const controller of this.controllers)
      assert.equal(controller.listeners.size, 0, 'Abort listeners must detach')
  }
}

function actualModules(turns, fetchResponse) {
  class ObservedAbortController extends AbortController {
    constructor() {
      super()
      this.listeners = new Set()
      turns.controllers.push(this)
      const add = this.signal.addEventListener.bind(this.signal)
      const remove = this.signal.removeEventListener.bind(this.signal)
      this.signal.addEventListener = (type, listener, ...options) => {
        if (type === 'abort') this.listeners.add(listener)
        return add(type, listener, ...options)
      }
      this.signal.removeEventListener = (type, listener, ...options) => {
        if (type === 'abort') this.listeners.delete(listener)
        return remove(type, listener, ...options)
      }
    }
  }
  const context = createContext({
    AbortController: ObservedAbortController,
    performance: { now: turns.now },
    nativeRuntimeScheduler: turns.nativeScheduler,
    setTimeout: turns.setTimeout,
    clearTimeout: turns.clearTimeout,
    fetch: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => fetchResponse(),
    }),
  })
  const modules = new Map()
  function load(filename) {
    if (modules.has(filename)) return modules.get(filename)
    const actualFilename =
      historicalBudget &&
      filename === resolve(sourceDirectory, 'http/work-budget.ts')
        ? resolve(historicalBudget)
        : filename
    const compiled = typescript.transpileModule(
      readFileSync(actualFilename, 'utf8'),
      {
        compilerOptions: {
          module: typescript.ModuleKind.CommonJS,
          target: typescript.ScriptTarget.ES2022,
        },
        fileName: actualFilename,
      },
    ).outputText
    const loaded = { exports: {} }
    modules.set(filename, loaded.exports)
    new Script(`(function(require,module,exports){${compiled}\n})`, {
      filename: actualFilename,
    }).runInContext(context)(
      (specifier) => {
        if (specifier === 'scheduler') return turns.nativeScheduler
        assert(specifier.startsWith('.'), `Unexpected dependency ${specifier}`)
        return load(
          resolve(dirname(filename), specifier.replace(/\.js$/, '.ts')),
        )
      },
      loaded,
      loaded.exports,
    )
    return loaded.exports
  }
  return {
    budget: load(resolve(sourceDirectory, 'http/work-budget.ts')),
    decoder: load(resolve(sourceDirectory, 'http/json.ts')),
    validator: load(resolve(sourceDirectory, 'http/validation.ts')),
    scheduler: load(resolve(sourceDirectory, 'scheduler.ts')),
    transport: load(resolve(sourceDirectory, 'http/transport.ts')),
    ObservedAbortController,
  }
}

function observeOutcome(promise) {
  const outcome = { status: 'pending' }
  promise.then(
    (value) => Object.assign(outcome, { status: 'fulfilled', value }),
    (failure) => Object.assign(outcome, { status: 'rejected', failure }),
  )
  return outcome
}

function boundedSnapshot() {
  return {
    schemaFingerprint: 'host-turn-fixture',
    dataset: 'catalog',
    generation: '1',
    cursor: '1',
    hash: 'host-turn-fixture',
    byteSize: 1,
    records: Array.from({ length: 640 }, (_, index) => ({
      model: 'Item',
      id: String(index),
      revision: '1',
      attributes: Object.fromEntries(
        Array.from({ length: 32 }, (_, field) => [
          `field${field}`,
          `record ${index} value ${field} ${'x'.repeat(24)}`,
        ]),
      ),
    })),
    relationSets: [],
    scope: {
      dataset: 'catalog',
      authorizationGeneration: '1',
      projectionGeneration: '1',
      schemaFingerprint: 'host-turn-fixture',
    },
  }
}

function budgetFixture(turns) {
  const modules = actualModules(turns)
  const controller = new modules.ObservedAbortController()
  const budget = new modules.budget.HttpWorkBudget({
    now: turns.now,
    deadline: 100000,
    cancellation: controller.signal,
    abort: () => controller.abort(),
    schedule: modules.scheduler.scheduleApplication,
  })
  return { ...modules, controller, budget }
}

for (const kind of ['decode', 'validate']) {
  test(`real ${kind} work lets host frame/input run before completion`, async () => {
    const payload = boundedSnapshot()
    const turns = new ApplicationTurns()
    const { budget, decoder, validator } = budgetFixture(turns)
    budget.beginMeasurement()
    const started = turns.time
    const outcome = observeOutcome(
      kind === 'decode'
        ? decoder.decodeHttpJson(JSON.stringify(payload), budget)
        : validator.validateHttpPayload('snapshot', payload, budget),
    )
    const hostObservations = []
    turns.requestHostCallback(() => hostObservations.push(outcome.status))
    await turns.complete(outcome)
    assert.equal(outcome.status, 'fulfilled')
    assert.deepEqual(
      hostObservations,
      ['pending'],
      `${kind} starved the host frame/input until work completed`,
    )
    assert(turns.history.some((task) => task.kind === 'native'))
    assert(
      turns.history.some((task) => task.kind === 'timer' && task.delivered),
      `${kind} must leave the RuntimeScheduler queue through a real host timer`,
    )
    if (kind === 'decode')
      assert.deepEqual(JSON.parse(JSON.stringify(outcome.value)), payload)
    else assert.equal(outcome.value, true)
    const elapsed = turns.time - started
    assert(elapsed >= turns.hostWaitMilliseconds)
    assert(
      budget.endMeasurement() >= 2,
      'Inner work measurement must remain active',
    )
    turns.assertClean()
  })
}

test('host fence resets on delivered host callback and keeps 2ms/8192 inner checks', async () => {
  const turns = new ApplicationTurns()
  turns.clockStep = 0
  const { budget } = budgetFixture(turns)
  turns.time = 1.9
  assert.equal(budget.shouldYield(256), false)
  turns.time = 2
  assert.equal(budget.shouldYield(256), true)
  let outcome = observeOutcome(budget.yield())
  assert.equal(turns.history.at(-1).kind, 'native')
  await turns.drainNative()
  assert.equal(outcome.status, 'fulfilled')
  turns.time = 9
  outcome = observeOutcome(budget.yield())
  const hostTask = turns.history.at(-1)
  assert.equal(hostTask.kind, 'timer')
  assert.equal(hostTask.delayMilliseconds, 1)
  turns.time = 25
  assert.equal(outcome.status, 'pending')
  turns.deliver(hostTask)
  await turns.checkpoint()
  assert.equal(outcome.status, 'fulfilled')
  turns.time = 29
  outcome = observeOutcome(budget.yield())
  assert.equal(
    turns.history.at(-1).kind,
    'native',
    'Time waiting for a host timer must not consume the next host fence',
  )
  await turns.drainNative()
  assert.equal(outcome.status, 'fulfilled')
  assert.equal(
    budget.shouldYield(8192),
    true,
    'The unit bound remains effective',
  )
  turns.assertClean()
})

function transportFixture() {
  const turns = new ApplicationTurns()
  const payload = boundedSnapshot()
  const session = {
    accountId: 'account',
    tenantId: 'tenant',
    deviceId: 'device',
    deviceEpoch: 'epoch',
    generation: 0,
  }
  const request = {
    protocolVersion: 1,
    requestId: 'host-turn-request',
    kind: 'snapshot',
    schemaFingerprint: 'host-turn-fixture',
    session,
    payload: { dataset: 'catalog' },
  }
  const response = JSON.stringify({ ...request, payload })
  const modules = actualModules(turns, () => response)
  const stages = []
  const hostObservations = []
  const continuations = []
  let outcome
  const owner = modules.transport.createReactNativeHttpTransport({
    endpoint: 'https://host-turn.invalid/protocol',
    session,
    timeoutMilliseconds: 100000,
    authenticate: (identity) => ({ session: identity.session, headers: {} }),
    observePhase: (phase) => {
      turns.phase = phase
      if (phase === 'jsonDecode' || phase === 'shapeValidation')
        turns.requestHostCallback(() =>
          hostObservations.push({
            phase,
            status: outcome.status,
            currentPhase: turns.phase,
          }),
        )
    },
    observeStage: (stage) => stages.push(stage),
    observeNativeContinuation: (event) =>
      continuations.push({
        statement: event.statement,
        status: outcome.status,
        phase: turns.phase,
      }),
  })
  outcome = observeOutcome(owner.transport.snapshot(request))
  return {
    turns,
    payload,
    owner,
    outcome,
    stages,
    hostObservations,
    continuations,
  }
}

test('public HTTP transport propagates host turns and keeps complete stage wall time', async () => {
  const {
    turns,
    payload,
    owner,
    outcome,
    stages,
    hostObservations,
    continuations,
  } = transportFixture()
  await turns.complete(outcome)
  assert.equal(outcome.status, 'fulfilled')
  assert.deepEqual(JSON.parse(JSON.stringify(outcome.value)), payload)
  assert.deepEqual(
    hostObservations,
    [
      { phase: 'jsonDecode', status: 'pending', currentPhase: 'jsonDecode' },
      {
        phase: 'shapeValidation',
        status: 'pending',
        currentPhase: 'shapeValidation',
      },
    ],
    'Both public HTTP phases must allow host work before finishing',
  )
  for (const phase of ['jsonDecode', 'shapeValidation']) {
    const stage = stages.find((entry) => entry.phase === phase)
    const timers = turns.history.filter(
      (task) =>
        task.kind === 'timer' &&
        task.delayMilliseconds === 1 &&
        task.phase === phase,
    )
    assert(timers.length > 0, `${phase} must propagate actual host timers`)
    assert(
      stage.elapsedMilliseconds >= timers.length * turns.hostWaitMilliseconds,
      `${phase} wall time must include all waiting between cooperative slices`,
    )
    assert(stage.maximumWorkSliceMilliseconds >= 2)
    assert(stage.elapsedMilliseconds > stage.maximumWorkSliceMilliseconds)
    assert(
      continuations.some(
        (entry) =>
          entry.statement ===
            'HTTP host timer response processing continuation' &&
          entry.phase === phase &&
          entry.status === 'pending',
      ),
      'Host callback diagnostics must precede resolving response work',
    )
  }
  await owner.close()
  turns.assertClean()
})

for (const phase of ['jsonDecode', 'shapeValidation']) {
  for (const cancellation of ['abort', 'deadline', 'late deadline callback']) {
    test(`HTTP ${phase} ${cancellation} removes timers/listeners and cannot return partial JSON`, async () => {
      const { turns, owner, outcome, stages } = transportFixture()
      await turns.drainNative()
      for (let turn = 0; turns.phase !== phase; turn += 1) {
        assert(
          turn < 10000,
          'The bounded workload must reach the requested phase',
        )
        assert.equal(outcome.status, 'pending')
        await turns.hostTurn()
        await turns.drainNative()
      }
      assert.equal(outcome.status, 'pending')
      const hostTask = turns.history.find(
        (task) =>
          task.active && task.kind === 'timer' && task.delayMilliseconds === 1,
      )
      assert(hostTask, 'Cancellation must exercise a pending HTTP host timer')
      const deadlineTask = turns.history.find(
        (task) =>
          task.active &&
          task.kind === 'timer' &&
          task.delayMilliseconds === 100000,
      )
      const cancelledCallbacks = [hostTask.callback, deadlineTask.callback]
      if (cancellation === 'abort') owner.cancelPending()
      else {
        turns.time = deadlineTask.due + 1
        turns.deliver(cancellation === 'deadline' ? deadlineTask : hostTask)
      }
      await turns.checkpoint()
      assert.equal(outcome.status, 'rejected')
      assert.equal(
        outcome.failure.code,
        cancellation === 'abort' ? 'session_changed' : 'transport_failed',
      )
      assert.equal(outcome.value, undefined)
      assert.equal(
        stages.some((stage) => stage.phase === phase),
        false,
      )
      turns.assertClean()
      for (const callback of cancelledCallbacks) callback()
      await turns.checkpoint()
      assert.equal(
        outcome.status,
        'rejected',
        'Late callbacks must not resurrect cancelled work',
      )
      assert.equal(outcome.value, undefined)
      turns.assertClean()
      await owner.close()
    })
  }
}

import { createHash } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { resolve } from 'node:path'
import { performance } from 'node:perf_hooks'

const HASH = /^[a-f0-9]{64}$/
const PROTOCOL =
  'ecde5d642dafd5d50facdec348fc3634cfa6562857b09391d312a20dcddedfc7'
const PREFIXES = [
  'synloquent_fixture_',
  'synloquent_performance_',
  'synloquent_reference_',
  'synloquent_large_http_',
  'synloquent_batch_sync_',
]
const ORIGINAL_DUTIES = [
  'sdk/install',
  'sdk/witness',
  'sdk/checkpoint',
  'reference/install',
  'reference/witness',
  'repeat0/install',
  'repeat0/witness',
  'repeat0/checkpoint',
  'repeat1/install',
  'repeat1/witness',
  'repeat1/checkpoint',
  'invalid/prepare',
  'invalidSDK/install',
  'invalidReference/install',
  'invalidSDK/witness',
  'invalidReference/witness',
  'catalog/read-and-subscription',
  'largeHTTP/prepare',
  'largeHTTP/resnapshot',
  'largeHTTP/witness',
  'batchSync',
]
const ROLES = [
  'app-result',
  'checkpoints',
  'ui',
  'rss',
  'heap',
  'raf',
  'task-disk',
  'collector',
  'network',
  'session',
  'build-provenance',
  'package-before',
  'package-after',
  'program-before',
  'program-after',
  'owner-execution',
  'supervisor-closure',
]
const COMMON = [
  'sessionName',
  'authorization',
  'purpose',
  'order',
  'trial',
  'seriesLength',
  'candidateFingerprint',
  'runtimeFingerprint',
  'packageArchiveSha256',
  'profileSha256',
  'fixtureFingerprint',
]
const stable = (value) =>
  JSON.stringify(value, (_key, field) =>
    field && typeof field === 'object' && !Array.isArray(field)
      ? Object.fromEntries(
          Object.entries(field).sort(([left], [right]) =>
            left.localeCompare(right),
          ),
        )
      : field,
  )
const same = (left, right) => stable(left) === stable(right)
const hashing = (bytes) => createHash('sha256').update(bytes).digest('hex')
const requireValue = (condition, message) => {
  if (!condition) throw new Error(message)
}
const scalar = (value) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
const integer = (value) => Number.isSafeInteger(value) && value >= 0
const clock = () => ({
  hostReceivedAtUtc: new Date().toISOString(),
  hostReceivedAtMonotonicMilliseconds: performance.now(),
})

export function orderedCalibrationCheckpoints(order) {
  requireValue(['A', 'B'].includes(order), 'Unknown paired order.')
  const operations = []
  for (const stratum of ['cold', 'warm1', 'warm2'])
    for (const arm of order === 'A'
      ? ['sdk', 'reference']
      : ['reference', 'sdk'])
      for (const stage of ['install', 'checkpoint', 'witness'])
        operations.push(`pair/${stratum}/${arm}/${stage}`)
  operations.push(
    ...ORIGINAL_DUTIES.slice(11),
    'control/synchronous-checksum',
    'control/awaited-timer',
  )
  return operations.map((operation, index) => ({
    sequence: index + 1,
    operation,
  }))
}

export function readCalibrationRequestSpecification(
  path,
  expectedSha256,
  platform,
  skipBuild,
) {
  requireValue(
    HASH.test(expectedSha256 ?? ''),
    'The command specification needs its exact approved byte hash.',
  )
  requireValue(
    typeof path === 'string' && path === resolve(path),
    'The immutable command specification path must be absolute and normalized.',
  )
  const status = lstatSync(path)
  requireValue(
    status.isFile() && !status.isSymbolicLink() && status.size <= 65536,
    'The immutable command specification must be a bounded original regular file.',
  )
  const bytes = readFileSync(path)
  requireValue(
    bytes.length <= 65536 && hashing(bytes) === expectedSha256,
    'Command specification bytes differ from the approved immutable input.',
  )
  const specification = JSON.parse(bytes.toString('utf8'))
  requireValue(
    specification.schema === 'synloquent-native-calibration-request-spec' &&
      specification.schemaVersion === 2,
    'Unknown command specification schema.',
  )
  requireValue(
    new RegExp(`^synloquent-native-${platform}-[A-Za-z0-9-]{1,128}$`).test(
      specification.sessionName,
    ),
    'The command does not own a fresh platform-bound session name.',
  )
  requireValue(
    [
      'canonical-fullrun',
      'calibration-pilot',
      'calibration-confirmatory',
    ].includes(specification.purpose),
    'Unknown calibration purpose.',
  )
  requireValue(
    Number.isInteger(specification.trial) &&
      specification.trial >= 1 &&
      specification.trial <= specification.seriesLength,
    'Invalid locked trial index.',
  )
  const schedules =
    specification.purpose === 'canonical-fullrun'
      ? [platform === 'ios' ? 'A' : 'B']
      : specification.purpose === 'calibration-pilot'
        ? (platform === 'ios' ? 'ABBA' : 'BAAB').split('')
        : (specification.seriesLength === 6
            ? platform === 'ios'
              ? 'ABBAAB'
              : 'BAABBA'
            : specification.seriesLength === 10
              ? platform === 'ios'
                ? 'ABBAABBAAB'
                : 'BAABBAABBA'
              : ''
          ).split('')
  requireValue(
    schedules.length === specification.seriesLength &&
      specification.order === schedules[specification.trial - 1],
    'Trial order differs from the locked platform schedule.',
  )
  const canonical = specification.purpose === 'canonical-fullrun'
  requireValue(
    canonical
      ? !skipBuild &&
          specification.authorization?.kind === 'canonical-contract' &&
          HASH.test(specification.authorization.contractCoreSha256 ?? '')
      : skipBuild &&
          specification.authorization?.kind === 'locked-calibration-plan' &&
          HASH.test(specification.authorization.planSha256 ?? ''),
    'Canonical needs a fresh normal build. Calibration reuse needs its locked approved plan.',
  )
  requireValue(
    specification.provenance?.protocolSha256 === PROTOCOL &&
      specification.provenance.profile === 'fixed-conservative-paired-v2' &&
      specification.provenance.release === true &&
      specification.provenance.hermes === true,
    'Unknown approved profile or protocol.',
  )
  for (const name of [
    'candidateFingerprint',
    'runtimeFingerprint',
    'packageArchiveSha256',
    'packageInventorySha256',
    'sourceInventorySha256',
    'fixtureFingerprint',
    'profileSha256',
    'methodApprovalSha256',
  ])
    requireValue(
      HASH.test(specification.provenance[name] ?? ''),
      `Missing immutable provenance ${name}.`,
    )
  for (const name of [
    'recoverySha256',
    'staleSessionSha256',
    'atomicitySha256',
    'pendingClosureSha256',
  ])
    requireValue(
      HASH.test(specification.externalCorrectnessEvidence?.[name] ?? ''),
      `Missing original correctness evidence ${name}.`,
    )
  requireValue(
    specification.provenance.sqliteDriver &&
      HASH.test(specification.provenance.sqliteDriver.sourceSha256 ?? ''),
    'SQLite driver source identity is missing.',
  )
  requireValue(
    !canonical ||
      specification.applicability?.measuredProgramSourceInventorySha256 ===
        specification.provenance.sourceInventorySha256,
    'Canonical lacks explicit applicability to the measured campaign program.',
  )
  if (canonical)
    requireValue(
      HASH.test(
        specification.applicability?.measuredProgramReleaseBundleSha256 ?? '',
      ) &&
        specification.applicability.measuredProfileSha256 ===
          specification.provenance.profileSha256,
      'Canonical lacks preregistered measured program bundle/profile applicability.',
    )
  if (!canonical)
    for (const name of ['buildProvenanceSha256', 'releaseBundleSha256'])
      requireValue(
        HASH.test(specification.provenance[name] ?? ''),
        `Calibration reuse needs a preregistered ${name}.`,
      )
  return {
    specification,
    specificationPath: resolve(path),
    specificationSha256: expectedSha256,
    originalBytes: bytes,
  }
}

export function hydrateCalibrationRequest(ownedSpecification, facts) {
  const { specification } = ownedSpecification
  const provenance = { ...specification.provenance }
  for (const [name, actual] of Object.entries(facts)) {
    requireValue(
      actual !== undefined && actual !== null,
      `Actual hydration fact ${name} is unknown.`,
    )
    if (provenance[name] !== undefined)
      requireValue(
        same(provenance[name], actual),
        `Actual ${name} differs from the preregistered expected fact.`,
      )
    provenance[name] = actual
  }
  for (const name of ['buildProvenanceSha256', 'releaseBundleSha256'])
    requireValue(
      HASH.test(provenance[name] ?? ''),
      `Actual ${name} was not discovered.`,
    )
  requireValue(
    provenance.device &&
      ['physical', 'simulator', 'emulator'].includes(provenance.device.kind) &&
      typeof provenance.device.identity === 'string' &&
      provenance.device.identity.length > 0 &&
      typeof provenance.device.operatingSystem === 'string' &&
      provenance.device.operatingSystem.length > 0,
    'Actual device discovery is missing.',
  )
  if (specification.purpose === 'canonical-fullrun')
    requireValue(
      specification.applicability.measuredProgramReleaseBundleSha256 ===
        provenance.releaseBundleSha256,
      'Fresh canonical bundle differs from the measured campaign program.',
    )
  const request = {
    sessionName: specification.sessionName,
    authorization: specification.authorization,
    purpose: specification.purpose,
    order: specification.order,
    trial: specification.trial,
    seriesLength: specification.seriesLength,
    provenance,
    externalCorrectnessEvidence: specification.externalCorrectnessEvidence,
  }
  const requestBytes = Buffer.from(JSON.stringify(request) + '\n')
  return {
    request,
    requestBytes,
    requestSha256: hashing(requestBytes),
    specificationSha256: ownedSpecification.specificationSha256,
  }
}

export function createNativeCalibrationHostCompanion({
  request,
  platform,
  artifactDirectory,
  sampleResident,
  validateNativePath,
  sampleNativeFiles,
  uiReport,
  fail,
}) {
  const directory = resolve(artifactDirectory, request.sessionName)
  requireValue(
    !existsSync(directory),
    'The owned schema2 session directory already exists.',
  )
  mkdirSync(directory, { recursive: true })
  writeFileSync(
    resolve(directory, 'session-claim.json'),
    JSON.stringify({
      sessionName: request.sessionName,
      platform,
      createdAtUtc: new Date().toISOString(),
    }) + '\n',
    { flag: 'wx' },
  )
  const bindings = Object.fromEntries(
    COMMON.map((name) => [
      name,
      name in request ? request[name] : request.provenance[name],
    ]),
  )
  const common = { ...request.provenance, ...bindings, schemaVersion: 2 }
  const paths = Object.fromEntries(
    [
      'checkpoints',
      'rss',
      'heap',
      'raf',
      'task-disk',
      'collector',
      'network',
      'app-result',
    ].map((role) => [
      role,
      resolve(directory, role + (role === 'app-result' ? '.json' : '.jsonl')),
    ]),
  )
  const counts = Object.fromEntries(Object.keys(paths).map((role) => [role, 0]))
  for (const path of Object.values(paths))
    writeFileSync(path, '', { flag: 'wx' })
  const manifest = orderedCalibrationCheckpoints(request.order)
  let checkpointSequence = 0
  let checkpointClock = -1
  let completed = new Map()
  let heapSequence = 0
  let heapPointCount = 0
  let heapClock = -1
  let rafSequence = 0
  let rafClock = -1
  let rafMonitor = 0
  let activeRafMonitor = null
  let closed = false
  const busy = new Set()
  let latestPhase = null
  let readiness
  let completion
  let controlIndex = 0
  let readyAction = null
  let baselinePending = false
  let baseline = null
  let baselineAcknowledgement = null
  let rssSequence = 0
  let rssIdentity = null
  let samplingTimer
  let sampleInFlight
  let firstSample
  let lastSample
  let maximumObservedGap = 0
  let samplingFailure = null
  let nativeStageSequence = 0
  let nativeStageOrdinal = 0
  let diskQueue = Promise.resolve()
  let residentQueue = Promise.resolve()
  function diskOwned(operation) {
    const pending = diskQueue.then(operation)
    diskQueue = pending.catch(() => undefined)
    return pending
  }
  const registrations = []
  const actions = new Map()
  const failures = []
  function append(role, value) {
    const line = JSON.stringify(value) + '\n'
    requireValue(
      Buffer.byteLength(line) <= 262144 &&
        lstatSync(paths[role]).size + Buffer.byteLength(line) <= 64 * 1024 ** 2,
      'Bounded raw host evidence exceeded.',
    )
    appendFileSync(paths[role], line)
    counts[role] += 1
  }
  function failure(error) {
    const reason = String(error)
    failures.push(reason)
    fail(error)
    return error
  }
  function validateBinding(body) {
    requireValue(
      body && typeof body === 'object' && !Array.isArray(body),
      'Invalid schema2 request object.',
    )
    for (const [name, expected] of Object.entries(common))
      requireValue(
        same(body[name], expected),
        `Fresh schema2 request binding differs ${name}.`,
      )
  }
  function packet(received, requestBody, responseBody, responseStatus, kind) {
    return {
      ...received,
      ...(kind ? { kind } : {}),
      requestBody,
      responseBody,
      responseStatus,
    }
  }
  async function bodyText(incoming, maximum) {
    const chunks = []
    let bytes = 0
    for await (const chunk of incoming) {
      bytes += chunk.length
      requireValue(
        bytes <= maximum,
        'Bounded calibration request body exceeded.',
      )
      chunks.push(chunk)
    }
    const text = Buffer.concat(chunks).toString('utf8')
    const body = JSON.parse(text)
    requireValue(
      JSON.stringify(body) === text,
      'Calibration request has duplicate fields or noncanonical scalar bytes.',
    )
    return { text, body }
  }
  function observeUI(line) {
    if (closed) return
    const value = JSON.parse(line)
    if (value.kind === 'action-admitted') {
      requireValue(
        actions.size < 32,
        'Unclosed schema2 UI action evidence exceeded.',
      )
      actions.set(value.actionId, {
        ...value,
        delivered: false,
        physicalSucceeded: false,
      })
    }
    if (value.kind === 'phase') latestPhase = value
    const actionIdentifier =
      value.kind === 'action-delivered' ? value.id : value.actionId
    const action = actions.get(actionIdentifier)
    if (action && value.phase !== undefined)
      requireValue(
        value.phase === action.phase &&
          value.probeIdentity === action.probeIdentity,
        'UI raw immutable context changed.',
      )
    if (
      action &&
      (value.kind === 'host-command-owned' ||
        value.kind === 'ios-physical-command-start')
    ) {
      const physical =
        value.kind === 'ios-physical-command-start' ||
        (value.purpose === action.type &&
          Number.isInteger(value.commandProcessIdentifier) &&
          value.commandProcessIdentifier > 0)
      if (
        physical &&
        readiness &&
        action.phase === 'idle' &&
        action.probeIdentity === readiness.probeIdentity &&
        action.type === 'input' &&
        value.hostTimestamp >= readiness.requestBoundary
      ) {
        readyAction = action
        readiness.resolve({
          accepted: true,
          correlationSchema: 2,
          actionId: action.actionId,
          commandStarted: true,
          phase: 'idle',
          probeIdentity: action.probeIdentity,
        })
      }
    }
    if (action && value.kind === 'physical-command-closed')
      action.physicalSucceeded = value.succeeded === true
    if (action && value.kind === 'action-delivered') action.delivered = true
    if (action && value.kind === 'action-closed') {
      action.closed = true
      if (
        !readyAction ||
        action.actionId < readyAction.actionId ||
        action.phase !== 'idle' ||
        action.probeIdentity !== readyAction.probeIdentity
      )
        actions.delete(action.actionId)
    }
    if (action && value.kind === 'action-discarded') {
      action.discarded = true
    }
    globalThis.queueMicrotask(settleCompletion)
  }
  function settleCompletion() {
    if (!completion || !readyAction) return
    const inputs = [...actions.values()].filter(
      (action) =>
        action.actionId >= readyAction.actionId &&
        action.phase === 'idle' &&
        action.probeIdentity === readyAction.probeIdentity &&
        action.delivered &&
        action.physicalSucceeded &&
        action.closed &&
        !action.discarded,
    )
    const input = inputs.find((action) => action.type === 'input')
    const scroll = inputs.find((action) => action.type === 'scroll')
    if (input && scroll && uiReport().correlation.unresolvedAction === null)
      completion.resolve({
        accepted: true,
        correlationSchema: 2,
        readinessActionId: readyAction.actionId,
        completionActionId: Math.max(input.actionId, scroll.actionId),
        inputCompleted: true,
        scrollCompleted: true,
        unresolvedAction: null,
        phase: 'idle',
        probeIdentity: readyAction.probeIdentity,
      })
  }
  async function waitControl(body, completing, incoming) {
    requireValue(
      body.phase === 'idle' &&
        /^probe-[0-9]{1,12}$/.test(body.probeIdentity) &&
        uiReport().correlation.correlationSchema === 2 &&
        latestPhase?.phase === 'idle' &&
        latestPhase.probeIdentity === body.probeIdentity,
      'Control lacks the current strict idle probe.',
    )
    requireValue(
      body.kind === ['synchronous-checksum', 'awaited-timer'][controlIndex],
      'Control order differs from its locked schedule.',
    )
    requireValue(
      uiReport().phases && !closed && !readiness && !completion,
      'Duplicate or closed control request.',
    )
    if (completing)
      requireValue(
        readyAction &&
          body.readinessActionId === readyAction.actionId &&
          body.probeIdentity === readyAction.probeIdentity,
        'Completion does not bind the actual readiness action.',
      )
    else
      requireValue(
        checkpointSequence === 29 + controlIndex,
        'Control readiness precedes all required settled work.',
      )
    return new Promise((resolveWait, rejectWait) => {
      let settled = false
      const pending = {
        probeIdentity: body.probeIdentity,
        requestBoundary: Date.now(),
        resolve(value) {
          if (!settled) {
            settled = true
            clearTimeout(timer)
            incoming.off('aborted', abort)
            if (completing) {
              completion = undefined
              controlIndex += 1
              actions.clear()
            } else readiness = undefined
            resolveWait(value)
          }
        },
      }
      const abort = () => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          readiness = undefined
          completion = undefined
          rejectWait(
            new Error(
              'Control request aborted before actual physical evidence.',
            ),
          )
        }
      }
      pending.cancel = abort
      const timer = setTimeout(() => {
        abort()
      }, 1900)
      incoming.once('aborted', abort)
      if (completing) {
        completion = pending
        settleCompletion()
      } else readiness = pending
    })
  }
  function takeResident() {
    const pending = residentQueue.then(async () => {
      requireValue(!closed, 'RSS requested after owned observation closure.')
      const measurement = await sampleResident()
      requireValue(
        integer(measurement.residentBytes) &&
          measurement.residentBytes > 0 &&
          measurement.processIdentity &&
          Number.isInteger(measurement.processIdentity.pid) &&
          measurement.processIdentity.pid > 0 &&
          measurement.processIdentity.birthWitness &&
          measurement.processIdentity.domain,
        'Unknown exact native PID/birth or RSS observation.',
      )
      if (rssIdentity)
        requireValue(
          same(rssIdentity, measurement.processIdentity),
          'Native process identity changed during coverage.',
        )
      rssIdentity = measurement.processIdentity
      const timestamp = performance.now()
      if (lastSample !== undefined)
        maximumObservedGap = Math.max(
          maximumObservedGap,
          timestamp - lastSample,
        )
      firstSample ??= timestamp
      lastSample = timestamp
      const sample = {
        sequence: ++rssSequence,
        hostUtc: new Date().toISOString(),
        hostMonotonicMilliseconds: timestamp,
        residentBytes: measurement.residentBytes,
        processIdentity: measurement.processIdentity,
      }
      append('rss', sample)
      return sample
    })
    residentQueue = pending.catch(() => undefined)
    return pending
  }
  async function observeDiskSnapshot(names) {
    requireValue(
      [3, 4, 5].includes(names.length) &&
        same(
          names,
          registrations.map((entry) => entry.name),
        ),
      'Task disk snapshot must cover exactly the actual registered prefix3/4/5.',
    )
    const files = await sampleNativeFiles(registrations)
    requireValue(
      Array.isArray(files) && files.length === names.length * 3,
      'Physical task main/WAL/SHM observation is incomplete.',
    )
    const identities = new Set()
    for (const file of files) {
      const key = file.name + ':' + file.kind
      requireValue(
        names.includes(file.name) &&
          ['main', 'wal', 'shm'].includes(file.kind) &&
          !identities.has(key),
        'Duplicate or unrelated physical task file.',
      )
      identities.add(key)
      requireValue(
        file.status === 'present'
          ? integer(file.bytes)
          : file.status === 'absent' && file.bytes === null,
        'Unknown native file became absent or zero.',
      )
    }
    return { ...common, names, files }
  }
  async function sampleWholeRun() {
    if (sampleInFlight || closed) return sampleInFlight
    sampleInFlight = (async () => {
      await takeResident()
      await diskOwned(async () => {
        if (registrations.length >= 3) {
          const received = clock()
          const body = {
            ...common,
            names: registrations.map((entry) => entry.name),
          }
          const response = await observeDiskSnapshot(body.names)
          append(
            'task-disk',
            packet(
              received,
              JSON.stringify(body),
              JSON.stringify(response),
              200,
              'sample',
            ),
          )
        }
      })
    })()
      .catch((error) => {
        samplingFailure = String(error)
        failure(error)
        throw error
      })
      .finally(() => {
        sampleInFlight = undefined
      })
    return sampleInFlight
  }
  async function handle(incoming, outgoing) {
    const endpoint = incoming.url
    const routes = [
      '/diagnostic/performance-checkpoint',
      '/diagnostic/calibration/heap-samples',
      '/diagnostic/calibration/raf-samples',
      '/diagnostic/calibration/task-disk/register',
      '/diagnostic/calibration/task-disk',
      '/diagnostic/calibration/control-ready',
      '/diagnostic/calibration/control-complete',
      '/diagnostic/calibration/native-http-stages',
    ]
    if (!routes.includes(endpoint)) return false
    const received = clock()
    let raw = ''
    let role = endpoint.includes('native-http-stages')
      ? 'network'
      : endpoint.includes('heap')
        ? 'heap'
        : endpoint.includes('raf')
          ? 'raf'
          : endpoint.includes('task-disk')
            ? 'task-disk'
            : endpoint.includes('checkpoint')
              ? 'checkpoints'
              : 'collector'
    let kind = endpoint.endsWith('/register')
      ? 'registration'
      : endpoint.endsWith('/task-disk')
        ? 'snapshot'
        : undefined
    let status = 200
    let result
    let originalResponseBody
    let diskRecorded = false
    const lock = role === 'collector' ? 'control' : role
    let acquired = false
    try {
      requireValue(
        incoming.method === 'POST' && !closed && !busy.has(lock),
        'Closed, duplicate or overlapping host stream.',
      )
      busy.add(lock)
      acquired = true
      const decoded = await bodyText(
        incoming,
        role === 'heap' || role === 'raf' || role === 'network' ? 65536 : 16384,
      )
      raw = decoded.text
      const body = decoded.body
      validateBinding(body)
      if (role === 'network') {
        requireValue(
          body.sequence === nativeStageSequence + 1 &&
            Array.isArray(body.events) &&
            body.events.length >= 1 &&
            body.events.length <= 128,
          'Incomplete or unbounded original native HTTP stage batch.',
        )
        for (const event of body.events) {
          requireValue(
            event.ordinal === nativeStageOrdinal + 1 &&
              event.stage &&
              typeof event.stage.kind === 'string' &&
              [
                'responseAvailable',
                'responseText',
                'jsonDecode',
                'shapeValidation',
              ].includes(event.stage.phase) &&
              scalar(event.stage.elapsedMilliseconds),
            'Unknown original native HTTP scalar stage or dropped ordinal.',
          )
          nativeStageOrdinal += 1
        }
        nativeStageSequence += 1
        kind = 'native-stage-batch'
        result = { accepted: true, sequence: body.sequence }
      } else if (role === 'checkpoints') {
        const declared = manifest[checkpointSequence]
        requireValue(
          declared &&
            body.version === 2 &&
            body.contractVersion === 2 &&
            body.platform === platform &&
            body.sequence === declared.sequence &&
            body.nextOperation === declared.operation &&
            body.diagnosticOnly === (request.purpose !== 'canonical-fullrun') &&
            body.excludedFromAcceptance ===
              (request.purpose !== 'canonical-fullrun'),
          'Checkpoint differs from the complete locked thirty-entry contract.',
        )
        requireValue(
          body.milestoneKind ===
            (declared.operation.endsWith('/checkpoint')
              ? 'settled checkpoint evidence'
              : 'next operation') &&
            scalar(body.applicationMonotonicMilliseconds) &&
            body.applicationMonotonicMilliseconds >= checkpointClock,
          'Wrong checkpoint boundary or clock domain.',
        )
        requireValue(
          Array.isArray(body.completedMeasurements) &&
            body.completedMeasurements.length <= 7,
          'Completed measurement list is unbounded.',
        )
        const observed = new Map()
        for (const entry of body.completedMeasurements) {
          requireValue(
            (/^pair\/(cold|warm1|warm2)\/(sdk|reference)\/install$/.test(
              entry.operation,
            ) ||
              entry.operation === 'largeHTTP/resnapshot') &&
              scalar(entry.elapsedMilliseconds) &&
              !observed.has(entry.operation),
            'Unknown or duplicate settled measurement.',
          )
          observed.set(entry.operation, entry.elapsedMilliseconds)
        }
        for (const [operation, duration] of completed)
          requireValue(
            observed.get(operation) === duration,
            'Earlier settled work disappeared or changed.',
          )
        completed = observed
        checkpointClock = body.applicationMonotonicMilliseconds
        checkpointSequence += 1
        result = { accepted: true, sequence: checkpointSequence }
      } else if (role === 'heap' || role === 'raf') {
        const expected = role === 'heap' ? heapSequence + 1 : rafSequence + 1
        requireValue(
          body.sequence === expected &&
            Array.isArray(body.samples) &&
            body.samples.length >= 1 &&
            body.samples.length <= (role === 'heap' ? 128 : 64),
          'Missing or unbounded original raw batch sequence.',
        )
        for (const sample of body.samples) {
          requireValue(
            scalar(sample.milliseconds) &&
              sample.milliseconds >= (role === 'heap' ? heapClock : rafClock),
            'Original application sample clock moved backwards.',
          )
          if (role === 'heap') {
            requireValue(
              integer(sample.bytes),
              'Unknown actual Hermes heap value.',
            )
            heapClock = sample.milliseconds
            heapPointCount += 1
          } else {
            requireValue(
              Number.isInteger(sample.monitor) &&
                sample.monitor > 0 &&
                scalar(sample.frameBudgetMilliseconds) &&
                sample.frameBudgetMilliseconds > 0 &&
                ['begin', 'callback', 'stop'].includes(sample.edge),
              'Unknown native RAF monitor sample.',
            )
            if (sample.edge === 'begin') {
              requireValue(
                activeRafMonitor === null && sample.monitor === rafMonitor + 1,
                'Duplicate or overlapping RAF monitor.',
              )
              activeRafMonitor = sample.monitor
              rafMonitor = sample.monitor
            } else {
              requireValue(
                activeRafMonitor === sample.monitor,
                'RAF point lacks its actual active native monitor.',
              )
              if (sample.edge === 'stop') activeRafMonitor = null
            }
            rafClock = sample.milliseconds
          }
        }
        if (role === 'heap') heapSequence += 1
        else rafSequence += 1
        result = { accepted: true, sequence: body.sequence }
      } else if (kind === 'registration') {
        const index = registrations.length
        requireValue(
          index < 5 &&
            typeof body.name === 'string' &&
            body.name.startsWith(PREFIXES[index]) &&
            /^[A-Za-z0-9_-]+\.sqlite$/.test(body.name) &&
            typeof body.path === 'string' &&
            body.path.length <= 2048 &&
            body.path.endsWith('/' + body.name) &&
            !registrations.some(
              (entry) => entry.name === body.name || entry.path === body.path,
            ),
          'Actual task database path registration is missing, reordered or replaced.',
        )
        requireValue(
          body.origin ===
            (index === 0
              ? 'fixture adapter PRAGMA database_list'
              : 'client owner.read PRAGMA database_list'),
          'Path did not come from its original owned SQLite handle.',
        )
        const entry = { name: body.name, path: body.path, origin: body.origin }
        await diskOwned(async () => {
          await validateNativePath(entry)
          registrations.push(entry)
          result = { accepted: true, name: body.name, path: body.path }
          originalResponseBody = JSON.stringify(result)
          append(
            'task-disk',
            packet(received, raw, originalResponseBody, 200, kind),
          )
          diskRecorded = true
        })
      } else if (kind === 'snapshot')
        await diskOwned(async () => {
          result = await observeDiskSnapshot(body.names)
          originalResponseBody = JSON.stringify(result)
          append(
            'task-disk',
            packet(received, raw, originalResponseBody, 200, kind),
          )
          diskRecorded = true
        })
      else
        result = await waitControl(
          body,
          endpoint.endsWith('control-complete'),
          incoming,
        )
    } catch (error) {
      status = 400
      result = { accepted: false, error: String(error) }
      failure(error)
    } finally {
      if (acquired) busy.delete(lock)
    }
    const responseBody = originalResponseBody ?? JSON.stringify(result)
    if (!diskRecorded)
      append(
        role,
        role === 'collector'
          ? {
              ...packet(received, raw, responseBody, status),
              method: incoming.method,
              path: endpoint,
              headers: incoming.headers,
            }
          : packet(received, raw, responseBody, status, kind),
      )
    if (role !== 'collector')
      append('collector', {
        ...packet(received, raw, responseBody, status),
        method: incoming.method,
        path: endpoint,
        headers: incoming.headers,
      })
    outgoing
      .writeHead(status, { 'Content-Type': 'application/json' })
      .end(responseBody)
    return true
  }
  return {
    directory,
    paths,
    request,
    bindings,
    handle,
    observeUI,
    appendNetworkRecord(record) {
      append('network', record)
    },
    async sampleSelectedTarget(path) {
      return diskOwned(async () => {
        const registered = registrations.find((entry) => entry.path === path)
        requireValue(
          registered,
          'Selected target lacks actual original PRAGMA registration.',
        )
        const received = clock()
        const body = {
          ...common,
          names: registrations.map((entry) => entry.name),
        }
        const measured = await observeDiskSnapshot(body.names)
        append(
          'task-disk',
          packet(
            received,
            JSON.stringify(body),
            JSON.stringify(measured),
            200,
            'sample',
          ),
        )
        const main = measured.files.find(
          (entry) => entry.name === registered.name && entry.kind === 'main',
        )
        const wal = measured.files.find(
          (entry) => entry.name === registered.name && entry.kind === 'wal',
        )
        return {
          timestamp: Date.now(),
          databaseBytes: main.status === 'present' ? main.bytes : 0,
          walBytes: wal.status === 'present' ? wal.bytes : 0,
        }
      })
    },
    async baseline(incoming) {
      const encodedBinding =
        incoming.headers['x-synloquent-calibration-binding']
      requireValue(
        typeof encodedBinding === 'string' &&
          Buffer.byteLength(encodedBinding) <= 16384,
        'Missing bounded immutable prefixture request binding.',
      )
      validateBinding(JSON.parse(decodeURIComponent(encodedBinding)))
      requireValue(
        !baselinePending &&
          baseline === null &&
          checkpointSequence === 0 &&
          registrations.length === 0,
        'Prefixture baseline requested late or twice.',
      )
      baselinePending = true
      const received = clock()
      let sample
      try {
        sample = await takeResident()
      } finally {
        baselinePending = false
      }
      baseline = {
        rssSampleSequence: sample.sequence,
        residentBytes: sample.residentBytes,
        appClockPoint: null,
        collectorBaselineRequestSha256: hashing(
          Buffer.from('GET /measurement/baseline\n' + encodedBinding),
        ),
        beforeFixtureConstruction: true,
      }
      baselineAcknowledgement = {
        sessionName: request.sessionName,
        candidateFingerprint: request.provenance.candidateFingerprint,
        rssSampleSequence: sample.sequence,
        rssRawPath: paths.rss,
        processIdentitySha256: hashing(
          Buffer.from(stable(sample.processIdentity)),
        ),
        sampledExactProcess: true,
      }
      const responseBody = JSON.stringify({
        accepted: true,
        residentBytes: sample.residentBytes,
        ...baselineAcknowledgement,
      })
      append('collector', {
        ...packet(received, '', responseBody, 200),
        method: incoming.method,
        path: incoming.url,
        headers: incoming.headers,
      })
      return responseBody
    },
    startSampling() {
      requireValue(!samplingTimer && !closed, 'Duplicate host sampler.')
      samplingTimer = setInterval(() => {
        void sampleWholeRun().catch(() => undefined)
      }, 1000)
    },
    acceptResult(raw) {
      requireValue(
        Buffer.byteLength(raw) <= 2 * 1024 ** 2,
        'App result exceeds original bounded result envelope.',
      )
      writeFileSync(paths['app-result'], raw)
      counts['app-result'] = 1
      const result = JSON.parse(raw)
      const trial = result.pairedTrial
      requireValue(
        trial?.schema === 'synloquent-native-performance' &&
          trial.schemaVersion === 2,
        'Legacy or unknown app result cannot satisfy schema2.',
      )
      for (const name of [
        'sessionName',
        'authorization',
        'purpose',
        'order',
        'trial',
        'seriesLength',
      ])
        requireValue(
          same(trial[name], request[name]),
          `App result binding differs ${name}.`,
        )
      requireValue(
        result.hermes === true &&
          same(trial.provenance, request.provenance) &&
          trial.numericAcceptance?.status === 'not-evaluated',
        'App substituted provenance or numerical acceptance authority.',
      )
      requireValue(
        checkpointSequence === 30 &&
          heapSequence > 0 &&
          heapPointCount === trial.memory.samples &&
          rafSequence > 0 &&
          completed.size === 7 &&
          nativeStageOrdinal > 0 &&
          trial.memory.nativeHttpStageObservation?.observedEvents ===
            nativeStageOrdinal &&
          trial.memory.nativeHttpStageObservation.acknowledgedEvents ===
            nativeStageOrdinal &&
          registrations.length === 5 &&
          controlIndex === 2 &&
          activeRafMonitor === null &&
          baseline &&
          !failures.length &&
          !samplingFailure &&
          trial.operational?.status === 'complete' &&
          trial.operational.cleanupComplete === true &&
          same(trial.taskDisk.registrations, registrations),
        'App success lacks complete actual host duties or cleanup.',
      )
      baseline.appClockPoint = trial.memory.baseline
      requireValue(
        trial.memory.nativeBaselineResidentBytes === baseline.residentBytes &&
          same(
            trial.memory.nativeBaselineAcknowledgement,
            baselineAcknowledgement,
          ) &&
          same(trial.correctness?.originalLogicalDuties, ORIGINAL_DUTIES) &&
          same(
            [...trial.correctness.completedLogicalDuties].sort(),
            [...ORIGINAL_DUTIES].sort(),
          ),
        'Original prefixture memory or twenty-one logical duties changed.',
      )
      return result
    },
    async stop() {
      clearInterval(samplingTimer)
      samplingTimer = undefined
      if (readiness || completion) {
        failure(new Error('Host control request remains unresolved.'))
        readiness?.cancel()
        completion?.cancel()
      }
      try {
        if (sampleInFlight) await sampleInFlight
        await diskQueue
        await residentQueue
        if (baseline && !samplingFailure) await takeResident()
      } finally {
        closed = true
      }
      requireValue(
        !failures.length && !samplingFailure,
        'Original host observation contains failed or unknown coverage.',
      )
      return {
        failures: [...failures],
        samplingIntervalMilliseconds: 1000,
        firstSample,
        lastSample,
        maximumObservedGap,
        observationCount: rssSequence,
        applicationIdentity: rssIdentity,
        pendingOwnedWork: false,
      }
    },
    recordCollectorExchange({
      method,
      path,
      headers,
      requestBody,
      responseBody,
      responseStatus,
      received,
    }) {
      append('collector', {
        ...packet(
          received ?? clock(),
          requestBody,
          responseBody,
          responseStatus,
        ),
        method,
        path,
        headers,
      })
    },
    prepareEnvelope(references, guestClosure) {
      const rawArtifacts = []
      for (const role of ROLES) {
        const path = references[role] ?? paths[role]
        if (path === undefined || !existsSync(path)) continue
        const bytes = readFileSync(path)
        rawArtifacts.push({
          role,
          path: resolve(path),
          sha256: hashing(bytes),
          byteCount: bytes.length,
          recordCount:
            counts[role] ??
            (role === 'ui'
              ? bytes.toString('utf8').split('\n').filter(Boolean).length
              : 1),
        })
      }
      return {
        schema: 'synloquent-native-host-receipt',
        schemaVersion: 2,
        bindings,
        provenance: request.provenance,
        rawArtifacts,
        prefixtureBaseline: baseline,
        storageRegistrations: [...registrations],
        processClosure: {
          complete: false,
          authority: 'external caller after runner return',
          remaining: null,
          cleanupFailures: null,
        },
        guestClosure,
      }
    },
  }
}

export function finalizeNativeHostEnvelope(
  pendingEnvelope,
  {
    ownerExecution,
    supervisorClosure,
    processClosure,
    trustedReferences,
    nativeCommandBinding,
  },
) {
  requireValue(
    pendingEnvelope.schema === 'synloquent-native-host-receipt' &&
      pendingEnvelope.schemaVersion === 2 &&
      pendingEnvelope.processClosure.complete === false,
    'Unknown or already finalized host envelope.',
  )
  requireValue(
    ownerExecution.completed === true &&
      ownerExecution.reaped === true &&
      ownerExecution.remaining?.length === 0 &&
      ownerExecution.cleanupFailures?.length === 0 &&
      supervisorClosure.absent === true &&
      supervisorClosure.targetedOnly === true &&
      supervisorClosure.signals === 0 &&
      supervisorClosure.inspectorPid !== ownerExecution.directPid &&
      processClosure.complete === true,
    'External actual owner/reap and separate supervisor absence evidence is incomplete.',
  )
  requireValue(
    nativeCommandBinding &&
      same(ownerExecution.nativeCommandBinding, nativeCommandBinding) &&
      nativeCommandBinding.sessionName ===
        pendingEnvelope.bindings.sessionName &&
      nativeCommandBinding.purpose === pendingEnvelope.bindings.purpose &&
      HASH.test(nativeCommandBinding.runnerSha256) &&
      HASH.test(nativeCommandBinding.requestSpecificationSha256) &&
      typeof nativeCommandBinding.requestSpecificationPath === 'string' &&
      nativeCommandBinding.requestSpecificationPath.startsWith('/'),
    'External actual ownership does not bind the exact immutable request specification and frozen runner.',
  )
  requireValue(
    processClosure.remaining?.length === 0 &&
      processClosure.cleanupFailures?.length === 0 &&
      supervisorClosure.inspectorPid !==
        supervisorClosure.recordedIdentity?.pid &&
      scalar(ownerExecution.endedAt) &&
      Date.parse(supervisorClosure.finishedAtUtc) / 1000 >=
        ownerExecution.endedAt,
    'External post-return closure is stale, unknown or self-inspected.',
  )
  const merged = [...pendingEnvelope.rawArtifacts]
  for (const role of ['owner-execution', 'supervisor-closure']) {
    const reference = trustedReferences[role]
    requireValue(
      reference?.role === role &&
        HASH.test(reference.sha256) &&
        integer(reference.byteCount) &&
        reference.recordCount === 1,
      'External raw closure reference is missing.',
    )
    requireValue(
      !merged.some((entry) => entry.role === role),
      'Closure evidence was already registered.',
    )
    merged.push(reference)
  }
  requireValue(
    merged.length === ROLES.length &&
      ROLES.every(
        (role) => merged.filter((entry) => entry.role === role).length === 1,
      ),
    'Finalized raw artifact roster is not complete and unique.',
  )
  return { ...pendingEnvelope, rawArtifacts: merged, processClosure }
}

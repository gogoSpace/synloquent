import { calibrationHostBinding } from './nativeCalibrationHost'
import { Platform } from 'react-native'
import { callingThreadCpuMilliseconds } from '@synloquent/client/native-crypto'
import { canonicalJson, nativeClock } from './platform'
import { calibrationUtf8Length } from './nativeCalibrationSource'
import type {
  CalibrationClockPoint,
  CalibrationInterval,
  CalibrationRequest,
  CalibrationTrialReceipt,
  CalibrationUiWindow,
} from './nativeCalibrationReceipts'
import type { CalibrationClientOwner } from './nativeCalibrationClient'
import { observeCalibrationHeapValue } from './nativeCalibrationHeap'

const address = 'http://127.0.0.1:8767'
export const originalLogicalDuties = Object.freeze([
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
])

export function calibrationPoint(): CalibrationClockPoint {
  const applicationMonotonicMilliseconds = nativeClock.now()
  const callingThreadCpu = callingThreadCpuMilliseconds()
  const hermesUsedHeapBytes = nativeClock.memory.usedJSHeapSize
  observeCalibrationHeapValue(hermesUsedHeapBytes)
  if (
    !Number.isFinite(applicationMonotonicMilliseconds) ||
    applicationMonotonicMilliseconds < 0 ||
    !Number.isFinite(callingThreadCpu) ||
    callingThreadCpu < 0 ||
    !Number.isSafeInteger(hermesUsedHeapBytes) ||
    hermesUsedHeapBytes! < 0
  )
    throw new Error(
      'Calibration requires actual native monotonic, calling-thread CPU and Hermes clocks.',
    )
  return {
    applicationMonotonicMilliseconds,
    callingThreadCpuMilliseconds: callingThreadCpu,
    hermesUsedHeapBytes: hermesUsedHeapBytes!,
  }
}
export function calibrationInterval(
  start: CalibrationClockPoint,
  end: CalibrationClockPoint,
): CalibrationInterval {
  if (
    end.applicationMonotonicMilliseconds <
      start.applicationMonotonicMilliseconds ||
    end.callingThreadCpuMilliseconds < start.callingThreadCpuMilliseconds
  )
    throw new Error('Calibration clocks moved backwards.')
  return {
    start,
    end,
    wallMilliseconds:
      end.applicationMonotonicMilliseconds -
      start.applicationMonotonicMilliseconds,
    callingThreadCpuMilliseconds:
      end.callingThreadCpuMilliseconds - start.callingThreadCpuMilliseconds,
    cpuBoundary:
      'same calling JavaScript thread across awaits, includes intervening work on that thread',
  }
}
export function validateCalibrationRequest(request: CalibrationRequest): void {
  const hash = /^[a-f0-9]{64}$/
  const provenance = request.provenance
  if (
    typeof request.sessionName !== 'string' ||
    !/^synloquent-native-(?:ios|android)-[A-Za-z0-9-]{1,128}$/.test(
      request.sessionName,
    )
  )
    throw new Error(
      'Paired trial requires its fresh owned native session name.',
    )
  if (
    request.purpose === 'canonical-fullrun'
      ? request.authorization.kind !== 'canonical-contract' ||
        !hash.test(request.authorization.contractCoreSha256)
      : request.authorization.kind !== 'locked-calibration-plan' ||
        !hash.test(request.authorization.planSha256)
  )
    throw new Error(
      'Paired trial is not bound to its independent contract core or locked campaign plan.',
    )
  if (
    ![
      'canonical-fullrun',
      'calibration-pilot',
      'calibration-confirmatory',
    ].includes(request.purpose) ||
    !['A', 'B'].includes(request.order) ||
    !Number.isSafeInteger(request.trial) ||
    request.trial < 1 ||
    request.trial > 10
  )
    throw new Error('Calibration purpose, trial or locked order is invalid.')
  const orders =
    request.purpose === 'canonical-fullrun'
      ? Platform.OS === 'ios'
        ? 'A'
        : 'B'
      : request.purpose === 'calibration-pilot'
        ? Platform.OS === 'ios'
          ? 'ABBA'
          : 'BAAB'
        : request.seriesLength === 6
          ? Platform.OS === 'ios'
            ? 'ABBAAB'
            : 'BAABBA'
          : Platform.OS === 'ios'
            ? 'ABBAABBAAB'
            : 'BAABBAABBA'
  if (
    (request.purpose === 'canonical-fullrun' && request.seriesLength !== 1) ||
    (request.purpose === 'calibration-pilot' && request.seriesLength !== 4) ||
    (request.purpose === 'calibration-confirmatory' &&
      ![6, 10].includes(request.seriesLength)) ||
    request.trial > request.seriesLength ||
    request.order !== orders[request.trial - 1]
  )
    throw new Error(
      'Paired purpose, preregistered series length or order differs from the reviewed method.',
    )
  if (
    !['ios', 'android'].includes(Platform.OS) ||
    provenance.profile !== 'fixed-conservative-paired-v2' ||
    provenance.release !== true ||
    provenance.hermes !== true ||
    !(globalThis as typeof globalThis & { HermesInternal?: unknown })
      .HermesInternal
  )
    throw new Error('Calibration requires its declared Release Hermes profile.')
  for (const field of [
    'candidateFingerprint',
    'runtimeFingerprint',
    'packageArchiveSha256',
    'packageInventorySha256',
    'sourceInventorySha256',
    'buildProvenanceSha256',
    'releaseBundleSha256',
    'fixtureFingerprint',
    'profileSha256',
    'protocolSha256',
    'methodApprovalSha256',
  ] as const)
    if (!hash.test(provenance[field]))
      throw new Error('Calibration provenance hash is invalid: ' + field)
  if (
    provenance.protocolSha256 !==
    'ecde5d642dafd5d50facdec348fc3634cfa6562857b09391d312a20dcddedfc7'
  )
    throw new Error('Calibration protocol is not the reviewed method.')
  if (
    !provenance.device.identity ||
    provenance.device.identity.length > 256 ||
    !provenance.device.operatingSystem ||
    provenance.device.operatingSystem.length > 128 ||
    !['physical', 'simulator', 'emulator'].includes(provenance.device.kind) ||
    !provenance.sqliteDriver.name ||
    !provenance.sqliteDriver.version ||
    !hash.test(provenance.sqliteDriver.sourceSha256)
  )
    throw new Error('Calibration device or SQLite provenance is incomplete.')
  for (const field of [
    'recoverySha256',
    'staleSessionSha256',
    'atomicitySha256',
    'pendingClosureSha256',
  ] as const)
    if (!hash.test(request.externalCorrectnessEvidence[field]))
      throw new Error(
        'Calibration requires separately preserved recovery, stale-session, atomicity and pending closure evidence.',
      )
}
export function orderedCalibrationCheckpoints(order: 'A' | 'B') {
  const entries: {
    sequence: number
    operation: string
    legacyLogicalDuties: readonly string[]
  }[] = []
  const add = (
    operation: string,
    legacyLogicalDuties: readonly string[] = [],
  ) =>
    entries.push({
      sequence: entries.length + 1,
      operation,
      legacyLogicalDuties,
    })
  for (const [index, stratum] of ['cold', 'warm1', 'warm2'].entries()) {
    for (const arm of order === 'A'
      ? ['sdk', 'reference']
      : ['reference', 'sdk']) {
      const prefix = `pair/${stratum}/${arm}`
      const legacy =
        arm === 'sdk'
          ? index === 0
            ? 'sdk'
            : `repeat${index - 1}`
          : index === 0
            ? 'reference'
            : undefined
      add(prefix + '/install', legacy ? [legacy + '/install'] : [])
      // This marker records settled real checkpoint work, never its guessed start.
      add(
        prefix + '/checkpoint',
        legacy && arm === 'sdk' ? [legacy + '/checkpoint'] : [],
      )
      add(prefix + '/witness', legacy ? [legacy + '/witness'] : [])
    }
  }
  for (const operation of originalLogicalDuties.slice(11))
    add(operation, [operation])
  add('control/synchronous-checksum')
  add('control/awaited-timer')
  return Object.freeze(entries.map((entry) => Object.freeze(entry)))
}
export function createCalibrationCheckpoint(
  request: CalibrationRequest,
  trial: CalibrationTrialReceipt,
) {
  let sequence = 0
  return async (
    operation: string,
    completed: readonly {
      readonly operation: string
      readonly elapsedMilliseconds: number
    }[],
  ) => {
    const expected = trial.orderedCheckpointManifest[sequence]
    if (!expected || expected.operation !== operation)
      throw new Error(
        'Paired checkpoint order differs from its locked manifest.',
      )
    const body = JSON.stringify({
      ...calibrationHostBinding(request),
      version: 2,
      schemaVersion: 2,
      contractVersion: 2,
      purpose: request.purpose,
      diagnosticOnly: request.purpose !== 'canonical-fullrun',
      excludedFromAcceptance: request.purpose !== 'canonical-fullrun',
      candidateFingerprint: request.provenance.candidateFingerprint,
      packageArchiveSha256: request.provenance.packageArchiveSha256,
      runtimeFingerprint: request.provenance.runtimeFingerprint,
      profileSha256: request.provenance.profileSha256,
      platform: Platform.OS,
      order: request.order,
      trial: request.trial,
      seriesLength: request.seriesLength,
      milestoneKind: operation.endsWith('/checkpoint')
        ? 'settled checkpoint evidence'
        : 'next operation',
      sequence: sequence + 1,
      nextOperation: operation,
      applicationMonotonicMilliseconds: nativeClock.now(),
      completedMeasurements: completed.map((entry) => ({
        operation: entry.operation,
        elapsedMilliseconds: entry.elapsedMilliseconds,
      })),
    })
    if (calibrationUtf8Length(body) > 16384)
      throw new Error(
        'Paired checkpoint exceeds the original bounded 16 KiB envelope.',
      )
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 2000)
    try {
      const response = await fetch(
        address + '/diagnostic/performance-checkpoint',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          signal: controller.signal,
        },
      )
      const acknowledgement: { accepted?: boolean; sequence?: number } =
        await response.json()
      if (
        !response.ok ||
        acknowledgement.accepted !== true ||
        acknowledgement.sequence !== sequence + 1
      )
        throw new Error('Paired checkpoint was not actually acknowledged.')
      sequence += 1
    } finally {
      clearTimeout(timeout)
    }
  }
}
export interface UiReport {
  readonly phases: Record<
    string,
    { readonly inputEvents: number; readonly scrollEvents: number }
  >
  readonly correlation: {
    readonly correlationSchema: number
    readonly strictCorrelation: boolean
    readonly receiptPath: string
    readonly receiptCount: number
    readonly receiptBytes: number
    readonly unresolvedAction: null | object
  }
}
export async function calibrationUiReport(): Promise<UiReport> {
  const response = await fetch(address + '/ui/report')
  const report: UiReport = await response.json()
  if (
    !response.ok ||
    report.correlation.correlationSchema !== 2 ||
    report.correlation.strictCorrelation !== true ||
    !report.correlation.receiptPath ||
    !Number.isSafeInteger(report.correlation.receiptCount) ||
    !Number.isSafeInteger(report.correlation.receiptBytes)
  )
    throw new Error(
      'Paired UI requires actual strict schema2 collector receipts.',
    )
  return report
}
export function calibrationUiWindow(
  before: UiReport,
  after: UiReport,
  phase: string,
  probeIdentity: string,
  mountedQueryKey: string,
  mountedDatabaseName: string,
): CalibrationUiWindow {
  if (
    before.correlation.receiptPath !== after.correlation.receiptPath ||
    after.correlation.receiptCount < before.correlation.receiptCount ||
    after.correlation.receiptBytes < before.correlation.receiptBytes ||
    after.correlation.unresolvedAction !== null ||
    !probeIdentity ||
    !mountedQueryKey ||
    !mountedDatabaseName
  )
    throw new Error(
      'Paired UI receipt window or mounted client identity is incomplete.',
    )
  const previous = before.phases[phase] ?? { inputEvents: 0, scrollEvents: 0 }
  const current = after.phases[phase] ?? { inputEvents: 0, scrollEvents: 0 }
  const inputEvents = current.inputEvents - previous.inputEvents
  const scrollEvents = current.scrollEvents - previous.scrollEvents
  if (
    !Number.isSafeInteger(inputEvents) ||
    !Number.isSafeInteger(scrollEvents) ||
    inputEvents < 1 ||
    scrollEvents < 1
  )
    throw new Error(
      'The measured arm did not deliver actual strict input and scroll.',
    )
  return {
    correlationSchema: 2,
    strictCorrelation: true,
    phase,
    probeIdentity,
    receiptPath: after.correlation.receiptPath,
    firstReceiptExclusive: before.correlation.receiptCount,
    lastReceiptInclusive: after.correlation.receiptCount,
    firstReceiptByteExclusive: before.correlation.receiptBytes,
    lastReceiptByteInclusive: after.correlation.receiptBytes,
    inputEvents,
    scrollEvents,
    mountedQueryKey,
    mountedDatabaseName,
    maximumFromCompleteJsonl:
      'host validator must project this exact receipt window',
    latencyClock:
      'host admission to original host callback receipt, no subtraction from application clocks',
  }
}
export async function calibrationProbeIdentity(): Promise<string> {
  const response = await fetch(address + '/ui/state')
  const value: { phase?: string; probeIdentity?: string } =
    await response.json()
  if (
    !response.ok ||
    typeof value.probeIdentity !== 'string' ||
    !value.probeIdentity ||
    value.probeIdentity.length > 32
  )
    throw new Error(
      'Current mounted physical UI probe identity is unavailable.',
    )
  return value.probeIdentity
}
export async function registerCalibrationTaskPath(
  request: CalibrationRequest,
  name: string,
  path: string,
  origin:
    | 'fixture adapter PRAGMA database_list'
    | 'client owner.read PRAGMA database_list',
): Promise<void> {
  if (
    !name ||
    !path ||
    !path.endsWith('/' + name) ||
    path.length > 2048 ||
    !name.endsWith('.sqlite')
  )
    throw new Error(
      'Task-owned database registration is not an actual bounded main path.',
    )
  const body = JSON.stringify({
    ...calibrationHostBinding(request),
    name,
    path,
    origin,
  })
  if (calibrationUtf8Length(body) > 16384)
    throw new Error(
      'Task database path registration exceeds its bounded envelope.',
    )
  const response = await fetch(
    address + '/diagnostic/calibration/task-disk/register',
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body },
  )
  const acknowledgement: { accepted?: boolean; name?: string; path?: string } =
    await response.json()
  if (
    !response.ok ||
    acknowledgement.accepted !== true ||
    acknowledgement.name !== name ||
    acknowledgement.path !== path
  )
    throw new Error('Task-owned actual database path was not acknowledged.')
}
export async function calibrationTaskDisk(
  request: CalibrationRequest,
  names: readonly string[],
): Promise<unknown> {
  const response = await fetch(address + '/diagnostic/calibration/task-disk', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...calibrationHostBinding(request), names }),
  })
  const value: {
    candidateFingerprint?: string
    packageArchiveSha256?: string
    names?: readonly string[]
    files?: readonly {
      name: string
      kind: 'main' | 'wal' | 'shm'
      status: 'present' | 'absent'
      bytes: number | null
    }[]
  } = await response.json()
  if (
    !response.ok ||
    value.candidateFingerprint !== request.provenance.candidateFingerprint ||
    value.packageArchiveSha256 !== request.provenance.packageArchiveSha256 ||
    canonicalJson(value.names) !== canonicalJson(names) ||
    !Array.isArray(value.files) ||
    value.files.length !== names.length * 3
  )
    throw new Error(
      'Whole task-owned disk evidence is not actually bound to this trial.',
    )
  const seen = new Set<string>()
  for (const file of value.files) {
    const key = file.name + ':' + file.kind
    if (
      !names.includes(file.name) ||
      !['main', 'wal', 'shm'].includes(file.kind) ||
      seen.has(key) ||
      (file.status !== 'present' && file.status !== 'absent') ||
      (file.status === 'present' &&
        (!Number.isSafeInteger(file.bytes) || file.bytes! < 0)) ||
      (file.status === 'absent' && file.bytes !== null)
    )
      throw new Error(
        'Task-owned disk evidence has missing, duplicate or unknown file observations.',
      )
    seen.add(key)
  }
  return value
}
export async function calibrationDatabaseIdentity(
  owner: CalibrationClientOwner,
) {
  return owner.client.storage.owner.read(async (executor) => {
    const version = (
      await executor.execute('SELECT sqlite_version() AS version')
    ).rows[0]?.version
    const journalMode = (await executor.execute('PRAGMA journal_mode')).rows[0]
      ?.journal_mode
    const synchronous = (await executor.execute('PRAGMA synchronous')).rows[0]
      ?.synchronous
    const foreignKeys = (await executor.execute('PRAGMA foreign_keys')).rows[0]
      ?.foreign_keys
    const like = (
      await executor.execute(
        "SELECT 'A' LIKE 'a' AS ascii_match, 'Ž' LIKE 'ž' AS unicode_match",
      )
    ).rows[0]
    const schema = (
      await executor.execute(
        "SELECT type,name,sql FROM sqlite_master WHERE name LIKE 'syn_%' ORDER BY type,name",
      )
    ).rows
    if (
      typeof version !== 'string' ||
      journalMode !== 'wal' ||
      synchronous !== 2 ||
      foreignKeys !== 1 ||
      like?.ascii_match !== 0 ||
      like?.unicode_match !== 0
    )
      throw new Error(
        'Matched target SQLite version, constraints or PRAGMA are not actually available.',
      )
    return {
      version,
      journalMode,
      synchronous,
      foreignKeys,
      caseSensitiveLike: true,
      schemaJson: canonicalJson(schema),
      driverCapabilities: owner.client.storage.owner.adapter.capabilities,
    }
  })
}
export async function causalCalibrationResidentBaseline(
  request: CalibrationRequest,
) {
  const binding = encodeURIComponent(
    JSON.stringify(calibrationHostBinding(request)),
  )
  if (binding.length > 16384)
    throw new Error('Causal baseline binding exceeds the bounded header.')
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 2000)
  try {
    const response = await fetch(address + '/measurement/baseline', {
      headers: { 'X-Synloquent-Calibration-Binding': binding },
      signal: controller.signal,
    })
    const value: {
      accepted?: boolean
      residentBytes?: number
      sessionName?: string
      candidateFingerprint?: string
      rssSampleSequence?: number
      rssRawPath?: string
      processIdentitySha256?: string
      sampledExactProcess?: boolean
    } = await response.json()
    if (
      !response.ok ||
      value.accepted !== true ||
      !Number.isSafeInteger(value.residentBytes) ||
      value.residentBytes! < 1 ||
      value.sessionName !== request.sessionName ||
      value.candidateFingerprint !== request.provenance.candidateFingerprint ||
      !Number.isSafeInteger(value.rssSampleSequence) ||
      value.rssSampleSequence! < 1 ||
      typeof value.rssRawPath !== 'string' ||
      !value.rssRawPath ||
      value.rssRawPath.length > 2048 ||
      !/^[a-f0-9]{64}$/.test(value.processIdentitySha256 ?? '') ||
      value.sampledExactProcess !== true
    )
      throw new Error(
        'The exact-process prefixture RSS sample was not causally acknowledged.',
      )
    return {
      residentBytes: value.residentBytes!,
      acknowledgement: {
        sessionName: value.sessionName,
        candidateFingerprint: value.candidateFingerprint,
        rssSampleSequence: value.rssSampleSequence!,
        rssRawPath: value.rssRawPath,
        processIdentitySha256: value.processIdentitySha256!,
        sampledExactProcess: true as const,
      },
    }
  } finally {
    clearTimeout(timeout)
  }
}
export function beginCalibrationHeapSamples(
  request: CalibrationRequest,
  memory: CalibrationTrialReceipt['memory'],
) {
  let batch: { milliseconds: number; bytes: number }[] = []
  let pending: Promise<void> | undefined
  let failure: unknown
  let previous: number | undefined
  let sequence = 0
  const flush = () => {
    if (pending || !batch.length || failure) return
    const own = batch
    batch = []
    pending = (async () => {
      const ownSequence = ++sequence
      const body = JSON.stringify({
        ...calibrationHostBinding(request),
        sequence: ownSequence,
        samples: own,
      })
      if (calibrationUtf8Length(body) > 65536)
        throw new Error('Raw Hermes batch exceeds its bounded 64 KiB envelope.')
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 2000)
      try {
        const response = await fetch(
          address + '/diagnostic/calibration/heap-samples',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
            signal: controller.signal,
          },
        )
        const acknowledgement: { accepted?: boolean; sequence?: number } =
          await response.json()
        if (
          !response.ok ||
          acknowledgement.accepted !== true ||
          acknowledgement.sequence !== ownSequence
        )
          throw new Error(
            'Raw calibration Hermes samples were not acknowledged.',
          )
      } finally {
        clearTimeout(timeout)
      }
    })()
      .catch((error: unknown) => {
        failure = error
      })
      .finally(() => {
        pending = undefined
      })
  }
  const sample = () => {
    try {
      const milliseconds = nativeClock.now()
      if (
        !Number.isFinite(milliseconds) ||
        milliseconds < 0 ||
        (previous !== undefined && milliseconds < previous)
      )
        throw new Error('Hermes sample monotonic clock is invalid.')
      const bytes = nativeClock.memory.usedJSHeapSize
      if (!Number.isSafeInteger(bytes) || bytes! < 0) {
        failure = new Error('Hermes sampling became unavailable.')
        return
      }
      memory.peakHermesUsedHeapBytes = Math.max(
        memory.peakHermesUsedHeapBytes,
        bytes!,
      )
      memory.samples += 1
      memory.firstSampleMilliseconds ??= milliseconds
      memory.lastSampleMilliseconds = milliseconds
      if (previous !== undefined)
        memory.maximumSampleGapMilliseconds = Math.max(
          memory.maximumSampleGapMilliseconds,
          milliseconds - previous,
        )
      previous = milliseconds
      if (batch.length >= 128) {
        failure = new Error('Bounded raw Hermes sample transport overflowed.')
        return
      }
      if (!failure) batch.push({ milliseconds, bytes: bytes! })
      if (batch.length === 128) flush()
    } catch (error) {
      failure ??= error
    }
  }
  sample()
  const timer = setInterval(sample, 25)
  return {
    timer,
    async close() {
      clearInterval(timer)
      await pending
      flush()
      await pending
      if (failure) throw failure
    },
  }
}

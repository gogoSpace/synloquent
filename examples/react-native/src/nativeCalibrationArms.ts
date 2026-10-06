import { monitorCalibrationAnimationFrames as monitorAnimationFrames } from './nativeCalibrationAnimationFrames'
import type { SnapshotPhase, Transport } from '@synloquent/client'
import {
  installCalibrationReference,
  type CalibrationReferenceReceipt,
} from './nativeCalibrationReference'
import {
  calibrationCaps,
  withCalibrationSourceView,
  type CalibrationSourceIdentity,
} from './nativeCalibrationSource'
import {
  calibrationInterval,
  calibrationPoint,
  calibrationProbeIdentity,
  calibrationUiReport,
  calibrationUiWindow,
} from './nativeCalibrationEvidence'
import { interactionPhase } from './nativeInteraction'
import { snapshotMetadata, verifyPendingCatalog } from './nativeReference'
import {
  canonicalJson,
  digestMeasurements,
  monitorApplicationResponsiveness,
  nativeClock,
  observeNativeSqlPhase,
  resetDigestMeasurements,
  setApplicationWorkPhase,
} from './platform'
import type { MountQuery, QueryMount } from './nativeQualification'
import type { CalibrationClientOwner } from './nativeCalibrationClient'
import type {
  CalibrationArm,
  CalibrationArmReceipt,
  CalibrationClockPoint,
  CalibrationPhaseInterval,
  CalibrationStratum,
} from './nativeCalibrationReceipts'

export function calibrationTransportSlot(fallback: Transport) {
  let current = fallback
  const transport: Transport = {
    manifest: (request) => current.manifest(request),
    query: (request) => current.query(request),
    push: (request) => current.push(request),
    pull: (request) => current.pull(request),
    snapshot: (request) => current.snapshot(request),
    snapshotParts: (request, lifecycle) =>
      current.snapshotParts!(request, lifecycle),
    snapshotPartBatch: (request, lifecycle) =>
      current.snapshotPartBatch!(request, lifecycle),
    confirmSnapshotParts: (request, lifecycle) =>
      current.confirmSnapshotParts!(request, lifecycle),
    command: (request) => current.command(request),
  }
  return {
    transport,
    set(value: Transport) {
      current = value
    },
    reset() {
      current = fallback
    },
  }
}
export function calibrationPhaseObserver() {
  const starts = new Map<
    string,
    { point: CalibrationClockPoint; parent: string | null }
  >()
  const stack: string[] = []
  const intervals: CalibrationPhaseInterval[] = []
  let failure: unknown
  const observe = (
    phase: string,
    edge: 'begin' | 'end',
    milliseconds?: number,
  ) => {
    try {
      const now = calibrationPoint()
      const point =
        milliseconds === undefined
          ? now
          : { ...now, applicationMonotonicMilliseconds: milliseconds }
      if (edge === 'begin') {
        if (starts.has(phase))
          throw new Error('Calibration phase begins twice without closure.')
        starts.set(phase, { point, parent: stack.at(-1) ?? null })
        stack.push(phase)
      } else {
        const start = starts.get(phase)
        if (!start)
          throw new Error('Calibration phase ends without an actual beginning.')
        if (intervals.length >= 64)
          throw new Error(
            'Calibration phase evidence exceeded its fixed capacity.',
          )
        const interval = calibrationInterval(start.point, point)
        intervals.push({
          phase: phase as CalibrationPhaseInterval['phase'],
          start: interval.start,
          end: interval.end,
          wallMilliseconds: interval.wallMilliseconds,
          callingThreadCpuMilliseconds: interval.callingThreadCpuMilliseconds,
          inclusive: true,
          parent: start.parent,
        })
        starts.delete(phase)
        const index = stack.lastIndexOf(phase)
        if (index >= 0) stack.splice(index, 1)
      }
    } catch (error) {
      failure ??= error
    }
  }
  return {
    observe,
    snapshot(event: { phase: SnapshotPhase; state: 'begin' | 'end' }) {
      observe(event.phase, event.state)
    },
    finish() {
      if (failure) throw failure
      if (starts.size) throw new Error('Calibration phase has no actual end.')
      return intervals.slice()
    },
  }
}
export async function calibrationMaintenance(owner: CalibrationClientOwner) {
  return owner.client.storage.owner.read(async (executor) => {
    const free = Number(
      (await executor.execute('PRAGMA freelist_count')).rows[0]?.freelist_count,
    )
    const pages = Number(
      (await executor.execute('PRAGMA page_count')).rows[0]?.page_count,
    )
    const pageSize = Number(
      (await executor.execute('PRAGMA page_size')).rows[0]?.page_size,
    )
    if (
      ![free, pages, pageSize].every(Number.isSafeInteger) ||
      free !== 0 ||
      pages < 1 ||
      pageSize < 1
    )
      throw new Error(
        'Settled calibration activation requires proven successful physical reclaim.',
      )
    return { freelistPages: 0 as const, databaseBytes: pages * pageSize }
  })
}
export async function registerCalibrationStorage(
  owner: CalibrationClientOwner,
): Promise<void> {
  const path = await owner.client.storage.read(async (executor) =>
    String(
      (await executor.execute('PRAGMA database_list')).rows.find(
        (row) => row.name === 'main',
      )?.file,
    ),
  )
  if (!path || path === 'undefined')
    throw new Error(
      'Measured calibration target has no actual main database path.',
    )
  const response = await fetch('http://127.0.0.1:8767/measurement/storage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  })
  if (!response.ok)
    throw new Error('Physical calibration target telemetry did not register.')
}
export async function calibrationPhysicalStorage(): Promise<unknown> {
  const response = await fetch('http://127.0.0.1:8767/measurement/storage')
  if (!response.ok)
    throw new Error('Physical calibration target measurement is unavailable.')
  return response.json()
}
export async function runCalibrationArm(options: {
  readonly arm: CalibrationArm
  readonly stratum: CalibrationStratum
  readonly owner: CalibrationClientOwner
  readonly source: CalibrationSourceIdentity
  readonly generation: () => string
  readonly transportSlot: ReturnType<typeof calibrationTransportSlot>
  readonly expected: Parameters<typeof verifyPendingCatalog>[1]
  readonly mountQuery: MountQuery
  readonly cadence: number
  readonly checkpoint: (operation: string) => Promise<void>
  readonly setSdkObserver: (
    observer: ReturnType<typeof calibrationPhaseObserver> | undefined,
  ) => void
  readonly setMounted: (mount: QueryMount | undefined) => void
  readonly setStopObservers: (stop: () => void) => void
  readonly preservePartial: (value: Record<string, unknown>) => void
  readonly recordCleanupFailure: (resource: string, failure: unknown) => void
  readonly recordObservationFailure: (
    operation: string,
    failure: unknown,
  ) => void
}): Promise<{
  receipt: CalibrationArmReceipt
  witness: Awaited<ReturnType<typeof verifyPendingCatalog>>
}> {
  const { owner, source, arm, stratum } = options
  const client = owner.client
  const generation = options.generation()
  const scopeJson = canonicalJson(source.metadata.scope)
  const sessionJson = canonicalJson(client.storage.session)
  const partition = client.storage.partition
  const ownerGenerationBefore = client.storage.owner.generation
  const pendingBeforeJson = canonicalJson(await snapshotMetadata(client))
  const budget = owner.policy.current()
  if (
    budget.level !== 'conservative' ||
    budget.reason !== 'startup' ||
    budget.maximumBatchRows !== 16 ||
    budget.maximumBindingBytes !== 16384 ||
    budget.maximumHashBufferUnits !== 16384 ||
    budget.maximumSnapshotResponseBytes !== 65536
  )
    throw new Error(
      'Paired arms must execute the same actual conservative profile.',
    )
  const mount = await options.mountQuery(
    client,
    client.query('Item').orderBy('id').take(25),
  )
  options.setMounted(mount)
  await registerCalibrationStorage(owner)
  await options.checkpoint(`pair/${stratum}/${arm}/install`)
  const phase = arm === 'sdk' ? 'sdk-import' : 'reference-import'
  const uiBefore = await calibrationUiReport()
  await interactionPhase(phase)
  const probeIdentity = await calibrationProbeIdentity()
  const mountedQueryKey = mount.observedQueryKey()
  if (!mountedQueryKey)
    throw new Error('Measured client query did not actually mount.')
  const phases = calibrationPhaseObserver()
  let responsiveness:
    Awaited<ReturnType<typeof monitorApplicationResponsiveness>> | undefined
  let frames: ReturnType<typeof monitorAnimationFrames> | undefined
  let stoppedFrames = false
  let stoppedResponsiveness = false
  let stopFailed = false
  let stopFailure: unknown
  const stopObservers = () => {
    for (const [resource, stop] of [
      [
        'RAF',
        () => {
          if (frames && !stoppedFrames) {
            stoppedFrames = true
            frameMeasurement = frames.stop()
          }
        },
      ],
      [
        'responsiveness',
        () => {
          if (responsiveness && !stoppedResponsiveness) {
            stoppedResponsiveness = true
            responsivenessMeasurement = responsiveness.stop()
          }
        },
      ],
    ] as const) {
      try {
        stop()
      } catch (failure) {
        options.recordCleanupFailure(
          'arm ' + stratum + '/' + arm + ' ' + resource,
          failure,
        )
        if (!stopFailed) {
          stopFailed = true
          stopFailure = failure
        }
      }
    }
    if (stopFailed) throw stopFailure
  }
  options.setStopObservers(stopObservers)
  let outsideArmSqlSnapshot!: ReturnType<typeof owner.sql.receipt>
  let publicStart!: CalibrationClockPoint
  let publicEnd!: CalibrationClockPoint
  let checkpointStart!: CalibrationClockPoint
  let checkpointEnd!: CalibrationClockPoint
  let maintenanceStart!: CalibrationClockPoint
  let maintenanceEnd!: CalibrationClockPoint
  let referenceReceipt: CalibrationReferenceReceipt | undefined
  let referenceObservationFailure: unknown
  let maintenanceReceipt:
    Awaited<ReturnType<typeof calibrationMaintenance>> | undefined
  let initialDispatchMilliseconds = 0
  let ended!: CalibrationClockPoint
  let frameMeasurement!: ReturnType<
    ReturnType<typeof monitorAnimationFrames>['stop']
  >
  let responsivenessMeasurement!: ReturnType<
    Awaited<ReturnType<typeof monitorApplicationResponsiveness>>['stop']
  >
  let installed = false
  let operationFailed = false
  let operationFailure: unknown
  let observationFailure: unknown
  let started!: CalibrationClockPoint
  try {
    responsiveness = await monitorApplicationResponsiveness()
    frames = monitorAnimationFrames(options.cadence)
    resetDigestMeasurements()
    outsideArmSqlSnapshot = owner.sql.receipt()
    owner.sql.reset()
    started = calibrationPoint()
    responsiveness.markContinuation()
    if (arm === 'sdk') {
      options.setSdkObserver(phases)
      await withCalibrationSourceView(
        source,
        async (view) => {
          options.transportSlot.set(view.transport(options.generation))
          try {
            publicStart = calibrationPoint()
            const installing = client.sync.resnapshot(source.metadata.dataset)
            initialDispatchMilliseconds =
              nativeClock.now() - publicStart.applicationMonotonicMilliseconds
            await installing
            publicEnd = calibrationPoint()
            checkpointStart = calibrationPoint()
            phases.observe(
              'checkpoint',
              'begin',
              checkpointStart.applicationMonotonicMilliseconds,
            )
            setApplicationWorkPhase('checkpoint')
            await client.storage.owner.checkpoint()
            checkpointEnd = calibrationPoint()
            phases.observe(
              'checkpoint',
              'end',
              checkpointEnd.applicationMonotonicMilliseconds,
            )
            maintenanceStart = calibrationPoint()
            phases.observe(
              'maintenance',
              'begin',
              maintenanceStart.applicationMonotonicMilliseconds,
            )
            maintenanceReceipt = await calibrationMaintenance(owner)
            maintenanceEnd = calibrationPoint()
            phases.observe(
              'maintenance',
              'end',
              maintenanceEnd.applicationMonotonicMilliseconds,
            )
          } finally {
            options.transportSlot.reset()
          }
        },
        client.storage.configuration.digestChunks,
        owner.sql.observeSource,
      )
    } else {
      publicStart = calibrationPoint()
      const installing = installCalibrationReference(
        client,
        source,
        options.generation,
        (event) => {
          try {
            const point = calibrationPoint()
            const actual = {
              ...point,
              applicationMonotonicMilliseconds:
                event.applicationMonotonicMilliseconds,
            }
            if (event.phase === 'checkpoint') {
              if (event.state === 'begin') checkpointStart = actual
              else checkpointEnd = actual
            }
            if (event.phase === 'maintenance') {
              if (event.state === 'begin') maintenanceStart = actual
              else maintenanceEnd = actual
            }
            phases.observe(
              event.phase,
              event.state,
              event.applicationMonotonicMilliseconds,
            )
            switch (event.phase) {
              case 'validation':
              case 'digest':
              case 'staging':
              case 'records':
              case 'relationSets':
              case 'integrity':
              case 'checkpoint':
                observeNativeSqlPhase(client, event.phase, event.state)
                break
              case 'commit-and-reclaim':
              case 'maintenance':
                observeNativeSqlPhase(client, 'commit', event.state)
                break
              default:
                throw new Error('Calibration reference SQL phase is unknown.')
            }
          } catch (failure) {
            referenceObservationFailure ??= failure
          }
        },
        owner.sql.observeSource,
      )
      initialDispatchMilliseconds =
        nativeClock.now() - publicStart.applicationMonotonicMilliseconds
      referenceReceipt = await installing
      if (referenceObservationFailure) throw referenceObservationFailure
      publicEnd = calibrationPoint()
    }
    installed = true
  } catch (failure) {
    operationFailed = true
    operationFailure = failure
  } finally {
    options.setSdkObserver(undefined)
    try {
      ended = calibrationPoint()
    } catch (failure) {
      options.recordObservationFailure(
        'arm ' + stratum + '/' + arm + ' end point',
        failure,
      )
      observationFailure ??= failure
    }
    try {
      stopObservers()
    } catch (failure) {
      observationFailure ??= failure
    }
    options.setStopObservers(() => undefined)
    try {
      options.preservePartial({
        arm,
        stratum,
        generation,
        completeInstall: installed,
        ingestionTotal:
          started && ended ? calibrationInterval(started, ended) : null,
        frameMeasurement,
        responsivenessMeasurement,
        digestMeasurement: digestMeasurements(),
        sql: owner.sql.receipt(),
      })
    } catch (failure) {
      options.recordObservationFailure(
        'arm ' + stratum + '/' + arm + ' partial diagnostics',
        failure,
      )
      observationFailure ??= failure
    }
  }
  if (operationFailed) throw operationFailure
  if (observationFailure) throw observationFailure
  const ingestionTotal = calibrationInterval(started, ended)
  const digestMeasurement = digestMeasurements()
  const sql = owner.sql.receipt()
  if (
    sql.rejectedVacuumStatements ||
    sql.rejectedCheckpoints ||
    sql.maximumParameters > sql.actualDriverParameterLimit ||
    sql.maximumBindingBytes > 16384 ||
    sql.maximumActivationPageRows > 16 ||
    sql.maximumModelInsertRows > 16 ||
    sql.rejectedSourceStatements ||
    sql.maximumSourceParameters > sql.actualDriverParameterLimit ||
    sql.maximumSourceBindingBytes > 16384 ||
    sql.maximumSourceReturnedRows > 16
  )
    throw new Error(
      'Actual paired SQL or committed maintenance violated the declared bounds.',
    )
  await interactionPhase('between-imports')
  const uiAfter = await calibrationUiReport()
  const ui = calibrationUiWindow(
    uiBefore,
    uiAfter,
    phase,
    probeIdentity,
    mountedQueryKey,
    owner.databaseName,
  )
  const physical = await calibrationPhysicalStorage()
  const maintenance = referenceReceipt
    ? {
        freelistPages: referenceReceipt.maintenance.freelistPages as 0,
        databaseBytes:
          referenceReceipt.maintenance.pageCount *
          referenceReceipt.maintenance.pageSize,
      }
    : maintenanceReceipt!
  await options.checkpoint(`pair/${stratum}/${arm}/checkpoint`)
  await options.checkpoint(`pair/${stratum}/${arm}/witness`)
  const oracleStarted = calibrationPoint()
  const witness = await verifyPendingCatalog(client, options.expected)
  const oracleEnded = calibrationPoint()
  if (
    canonicalJson(client.storage.session) !== sessionJson ||
    client.storage.partition !== partition ||
    options.generation() !== generation ||
    client.storage.owner.generation !== ownerGenerationBefore + 1
  )
    throw new Error(
      'Paired oracle belongs to a changed target session or source.',
    )
  const receipt: CalibrationArmReceipt = {
    arm,
    stratum,
    generation,
    cursor: source.metadata.cursor,
    scopeJson,
    sessionJson,
    partition,
    pendingBeforeJson,
    fullWitnessJson: canonicalJson(witness),
    outsideArmSqlSnapshot,
    outsideArmSqlWindow:
      'before this arm reset, includes previous oracle when warm, never summed as an exclusive phase',
    source: {
      rawHash: source.metadata.hash,
      rawBytes: source.metadata.byteSize,
      records: 117115,
      relationSets: 100,
      targets: 300,
      partInventoryHash: source.partInventoryHash,
    },
    ingestionTotal,
    initialDispatchMilliseconds,
    publicCall: calibrationInterval(publicStart, publicEnd),
    checkpoint: calibrationInterval(checkpointStart, checkpointEnd),
    maintenance: calibrationInterval(maintenanceStart, maintenanceEnd),
    oracle: calibrationInterval(oracleStarted, oracleEnded),
    sourceViewCloseIncluded: true,
    reclaimRequested: true,
    checkpointSettled: true,
    freelistPages: maintenance.freelistPages,
    databaseBytes: maintenance.databaseBytes,
    fileMeasurement: physical,
    sql,
    caps: calibrationCaps,
    actualPolicy: {
      level: 'conservative',
      reason: 'startup',
      nativeSampleAttempts: 0,
    },
    phases: phases.finish(),
    frameMonitorId: frames!.monitorId,
    frameMeasurement,
    responsivenessMeasurement,
    digestMeasurement,
    hashCapacityEvidence: {
      actualConfiguredHashUnits: 16384,
      enforcedBy:
        'public native crypto maximumBufferedUnits callback and source hash pieces',
      measuredBufferedUnits: null,
      legacyInstrumentationCeiling: 65536,
      referenceMaximumYieldedPieceUnits:
        referenceReceipt?.maximumObservedHashUnits ?? null,
    },
    ui,
  }
  if (
    referenceReceipt &&
    (referenceReceipt.records !== 117115 ||
      referenceReceipt.relationSets !== 100 ||
      referenceReceipt.targets !== 300 ||
      referenceReceipt.rawHash !== source.metadata.hash ||
      referenceReceipt.rawBytes !== source.metadata.byteSize ||
      referenceReceipt.partInventoryHash !== source.partInventoryHash ||
      referenceReceipt.maximumObservedRows > 16 ||
      referenceReceipt.maximumObservedBindingBytes > 16384 ||
      referenceReceipt.maximumObservedHashUnits > 16384 ||
      referenceReceipt.reclaimRequested !== true ||
      referenceReceipt.checkpointSettled !== true)
  )
    throw new Error(
      'Independent reference receipt does not prove its complete matched input.',
    )
  await mount.unmount()
  options.setMounted(undefined)
  if (client.storage.owner.listenerCount !== 0)
    throw new Error('Measured arm unmount retained its owner listener.')
  return { receipt, witness }
}

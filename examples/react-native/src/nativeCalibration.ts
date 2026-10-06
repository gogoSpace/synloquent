import {
  QueryCompiler,
  SynloquentError,
  type CanonicalRecord,
  type SnapshotPhase,
} from '@synloquent/client'
import { beginCalibrationHttpStageSamples } from './nativeCalibrationHttpStages'
import {
  beginCalibrationDirectHeapObservation,
  observeCalibrationHeapValue,
} from './nativeCalibrationHeap'
import {
  monitorCalibrationAnimationFrames as monitorAnimationFrames,
  beginCalibrationFrameSamples,
} from './nativeCalibrationAnimationFrames'
import { Platform } from 'react-native'
import { createNativeFixture, type NativeFixture } from './nativeFixture'
import {
  installReferenceSnapshot,
  preparePendingCatalog,
  snapshotContent,
  snapshotMetadata,
  verifyPendingCatalog,
} from './nativeReference'
import {
  awaitIdleInteraction,
  interactionPhase,
  interactionReport,
} from './nativeInteraction'
import {
  nativeHttpStages,
  resetNativeHttpStages,
  nativeHttpStageDiagnostics,
} from './httpTransport'
import { verifyHttpCatalog } from './nativeHttpOracle'
import { backendSchema } from '../backend.generated'
import { deleteDatabase, type MountQuery } from './nativeQualification'
import {
  canonicalJson,
  generateIdentity,
  yieldToApplication,
  nativeClock,
  digestMeasurements,
  resetDigestMeasurements,
  monitorApplicationResponsiveness,
  setApplicationWorkPhase,
  type ResponsivenessMeasurement,
} from './platform'
import type { NativeSpikeResult } from '../../../packages/client/tests/native/driver-spike'
import {
  makeCalibrationClient,
  type CalibrationClientOwner,
} from './nativeCalibrationClient'
import {
  calibrationTransportSlot,
  runCalibrationArm,
  type calibrationPhaseObserver,
} from './nativeCalibrationArms'
import { sealCalibrationFixture } from './nativeCalibrationSource'
import {
  calibrationPoint,
  calibrationInterval,
  originalLogicalDuties,
  orderedCalibrationCheckpoints,
  createCalibrationCheckpoint,
  beginCalibrationHeapSamples,
  calibrationTaskDisk,
  registerCalibrationTaskPath,
  calibrationDatabaseIdentity,
  calibrationUiReport,
  calibrationProbeIdentity,
  calibrationUiWindow,
  causalCalibrationResidentBaseline,
} from './nativeCalibrationEvidence'
import { runCalibrationNegativeControl } from './nativeCalibrationControls'
import type {
  CalibrationRequest,
  CalibrationSnapshotAdmissionFailure,
  CalibrationTrialReceipt,
  CalibrationTrialResult,
} from './nativeCalibrationReceipts'

const fixtureSeed = 20261002
const itemCount = 17000
const imageCount = 100001

interface PerformanceCheckpointMeasurement {
  readonly operation: string
  readonly elapsedMilliseconds: number
  readonly phaseMeasurements?: readonly {
    readonly phase: SnapshotPhase
    readonly startedMilliseconds?: number
    readonly elapsedMilliseconds: number
  }[]
  readonly frameMeasurement?: ReturnType<
    ReturnType<typeof monitorAnimationFrames>['stop']
  >
  readonly responsivenessMeasurement?: {
    readonly maximumCallbackGapMilliseconds: number
    readonly maximumCallingThreadCpuMilliseconds: number
    readonly callbacks: number
    readonly armedBoundaries: number
    readonly phaseMaximumGaps: readonly {
      readonly phase: string
      readonly wallMilliseconds: number
      readonly callingThreadCpuMilliseconds: number
    }[]
  }
  readonly digestMeasurement?: ReturnType<typeof digestMeasurements>
}

type RepeatedImportMeasurement = Partial<
  Awaited<ReturnType<typeof verifyPendingCatalog>>
> & {
  readonly elapsedMilliseconds: number
  readonly frameMeasurement: ReturnType<
    ReturnType<typeof monitorAnimationFrames>['stop']
  >
  readonly responsivenessMeasurement: ResponsivenessMeasurement
  readonly checkpointMilliseconds?: number
  readonly walAfterCheckpointBytes?: number
  readonly databaseBytes?: number
}

function checkpointResponsiveness(measurement: ResponsivenessMeasurement) {
  return {
    maximumCallbackGapMilliseconds: measurement.maximumCallbackGapMilliseconds,
    maximumCallingThreadCpuMilliseconds:
      measurement.maximumCallingThreadCpuMilliseconds,
    callbacks: measurement.callbacks,
    armedBoundaries: measurement.armedBoundaries,
    phaseMaximumGaps: measurement.phaseMaximumGaps.map((gap) => ({
      phase: gap.phase,
      wallMilliseconds: gap.wallMilliseconds,
      callingThreadCpuMilliseconds: gap.callingThreadCpuMilliseconds,
    })),
  }
}

async function frameCadence(): Promise<{
  frameBudgetMilliseconds: number
  originalRafTimestamps: number[]
}> {
  const durations: number[] = []
  const originalRafTimestamps: number[] = []
  let previous: number | undefined
  for (let frame = 0; frame < 32; frame += 1) {
    const timestamp = await new Promise<number>((resolve) =>
      requestAnimationFrame(resolve),
    )
    originalRafTimestamps.push(timestamp)
    if (previous !== undefined) durations.push(timestamp - previous)
    previous = timestamp
  }
  durations.sort((left, right) => left - right)
  return {
    frameBudgetMilliseconds: durations[Math.floor(durations.length / 2)]!,
    originalRafTimestamps,
  }
}

function heapBytes(): number {
  const measured = nativeClock.memory.usedJSHeapSize
  observeCalibrationHeapValue(measured)
  if (measured === undefined)
    throw new Error('Hermes memory instrumentation is unavailable.')
  return measured
}

function calibrationSnapshotAdmissionFailure(
  failure: unknown,
): CalibrationSnapshotAdmissionFailure | undefined {
  try {
    if (
      !(failure instanceof SynloquentError) ||
      failure.code !== 'snapshot_admission_required' ||
      failure.details.reason !== 'memory-pressure'
    )
      return undefined
    const budget = failure.details.memoryBudget
    const context =
      typeof budget === 'object' && budget !== null
        ? (budget as Readonly<Record<string, unknown>>)
        : undefined
    return {
      diagnosticOnly: true,
      acceptedCandidate: false,
      code: 'snapshot_admission_required',
      reason: 'memory-pressure',
      memoryBudgetContextAvailable: Boolean(context),
      memoryBudget: context
        ? (Object.fromEntries(
            [
              'level',
              'reason',
              'maximumBatchRows',
              'maximumBindingBytes',
              'maximumHashBufferUnits',
              'maximumCacheBytes',
              'maximumCacheEntries',
              'maximumPrefetchConcurrency',
              'maximumSnapshotConcurrency',
              'maximumSnapshotResponseBytes',
            ].map((field) => {
              const value = context[field]
              if (field === 'level')
                return [
                  field,
                  typeof value === 'string' &&
                  ['reduced', 'conservative', 'normal'].includes(value)
                    ? value
                    : null,
                ]
              if (field === 'reason')
                return [
                  field,
                  typeof value === 'string' &&
                  [
                    'startup',
                    'pressure',
                    'low_headroom',
                    'unknown',
                    'invalid_observation',
                    'invalid_clock',
                    'stale',
                    'recovery',
                    'fresh',
                    'closed',
                  ].includes(value)
                    ? value
                    : null,
                ]
              return [
                field,
                typeof value === 'number' &&
                Number.isSafeInteger(value) &&
                value >= 0
                  ? value
                  : null,
              ]
            }),
          ) as NonNullable<CalibrationSnapshotAdmissionFailure['memoryBudget']>)
        : null,
    }
  } catch {
    // Diagnostic access cannot replace the original failure.
    return undefined
  }
}

export async function runNativeCalibration(
  address: string,
  mountQuery: MountQuery,
  progress: (message: string) => void,
  largeAddress: string,
  request: CalibrationRequest,
): Promise<CalibrationTrialResult> {
  const provenance = request.provenance
  const startedAt = new Date().toISOString()
  const databaseName = `synloquent_performance_${generateIdentity()}.sqlite`
  const syncDatabaseName = `synloquent_batch_sync_${generateIdentity()}.sqlite`
  const referenceDatabaseName = `synloquent_reference_${generateIdentity()}.sqlite`
  const largeDatabaseName = `synloquent_large_http_${generateIdentity()}.sqlite`
  const fixtureDatabaseName = `synloquent_fixture_${generateIdentity()}.sqlite`
  const owners = new Map<string, CalibrationClientOwner>()
  const makeExampleClient = async (
    name: string,
    targetAddress: string,
    schema = backendSchema,
    diagnostics: Parameters<typeof makeCalibrationClient>[2] = {},
  ) => {
    if (owners.has(name) || owners.size >= 4)
      throw new Error(
        'Calibration client ownership exceeds its four declared clients.',
      )
    const owner = await makeCalibrationClient(
      name,
      targetAddress,
      diagnostics,
      schema,
      recordCleanupFailure,
    )

    owners.set(name, owner)
    const path = await owner.client.storage.owner.read(async (executor) => {
      const result = await executor.execute('PRAGMA database_list')
      const path = result.rows.find((row) => row.name === 'main')?.file
      if (typeof path !== 'string' || !path)
        throw new Error('Owned client has no actual main database path.')
      return path
    })
    const registration = {
      name,
      path,
      origin: 'client owner.read PRAGMA database_list' as const,
    }
    await registerCalibrationTaskPath(
      request,
      registration.name,
      registration.path,
      registration.origin,
    )
    pairedTrial.taskDisk.registrations.push(registration)
    return owner.client
  }
  const pairedTrial: Omit<CalibrationTrialReceipt, 'duties'> & {
    duties: CalibrationTrialReceipt['duties']
  } = {
    schema: 'synloquent-native-performance',
    schemaVersion: 2,
    contractVersion: 2,
    purpose: request.purpose,
    excludedFromAcceptance: request.purpose !== 'canonical-fullrun',
    profile: 'fixed-conservative-paired-v2',
    order: request.order,
    trial: request.trial,
    seriesLength: request.seriesLength,
    provenance,
    sessionName: request.sessionName,
    authorization: request.authorization,
    operational: {
      status: 'incomplete',
      cleanupFailures: [],
      cleanupComplete: false,
    },
    correctness: {
      status: 'incomplete',
      originalLogicalDuties,
      completedLogicalDuties: [],
      externalEvidence: request.externalCorrectnessEvidence,
    },
    numericAcceptance: {
      status: 'not-evaluated',
      authority:
        'separately approved pure host contract selector and numeric checker',
    },
    pairs: [],
    controls: [],
    orderedCheckpointManifest: orderedCalibrationCheckpoints(request.order),
    memory: {
      cadenceObservation: null,
      baseline: null,
      nativeBaselineResidentBytes: null,
      nativeBaselineAcknowledgement: null,
      nativeHttpStageHeapObservation: null,
      nativeHttpStageObservation: {
        observedEvents: 0,
        acknowledgedEvents: 0,
        batches: 0,
        maximumBodyBytes: 0,
      },
      directReadObservation: {
        source:
          'same existing calibrationPoint and heapBytes getter values, no additional heap or clock read',
        reads: 0,
        validReads: 0,
        unavailableReads: 0,
        maximumBytes: null,
      },
      peakHermesUsedHeapBytes: 0,
      samplingPeriodMilliseconds: 25,
      samples: 0,
      firstSampleMilliseconds: null,
      lastSampleMilliseconds: null,
      maximumSampleGapMilliseconds: 0,
      wholePrefixture: true,
      nativeResidencyAuthority:
        'all original runner RSS samples with exact PID and prefixture baseline',
      nativeRawSamplesPath: null,
    },
    taskDisk: {
      policy:
        'all task-owned input, target, reference, HTTP and batch main/WAL/SHM files, no subtraction',
      databaseNames: [
        fixtureDatabaseName,
        databaseName,
        referenceDatabaseName,
        largeDatabaseName,
        syncDatabaseName,
      ],
      registrations: [],
      snapshots: [],
    },
    duties: {},
  }
  let httpStageResetPerformed = false
  let httpStageSampler:
    ReturnType<typeof beginCalibrationHttpStageSamples> | undefined
  let stopDirectHeapObservation: (() => void) | undefined
  let heapSampler: ReturnType<typeof beginCalibrationHeapSamples> | undefined
  let frameSampler: ReturnType<typeof beginCalibrationFrameSamples> | undefined
  let armPhaseObserver: ReturnType<typeof calibrationPhaseObserver> | undefined
  const partialMeasurement: Record<string, unknown> = {
    seed: fixtureSeed,
    items: itemCount,
    relations: imageCount + 300,
  }
  const observationFailures: string[] = []
  partialMeasurement.secondaryObservationFailures = observationFailures
  const recordObservationFailure = (operation: string, failure: unknown) => {
    observationFailures.push(operation + ': ' + String(failure).slice(0, 512))
  }
  const recordCleanupFailure = (resource: string, failure: unknown) => {
    pairedTrial.operational.cleanupFailures.push(
      resource + ': ' + String(failure).slice(0, 512),
    )
  }
  const checks: NativeSpikeResult['checks'][number][] = [
    {
      name: 'synloquent synthetic catalog performance',
      durationMilliseconds: 0,
      detail: partialMeasurement,
    },
  ]
  const checkpoint = createCalibrationCheckpoint(request, pairedTrial)
  const completedMeasurements: PerformanceCheckpointMeasurement[] = []
  let fixtureSource: NativeFixture | undefined
  let active: Awaited<ReturnType<typeof makeExampleClient>> | undefined
  let reference: Awaited<ReturnType<typeof makeExampleClient>> | undefined
  let large: Awaited<ReturnType<typeof makeExampleClient>> | undefined
  let synchronizing: Awaited<ReturnType<typeof makeExampleClient>> | undefined
  let mounted: Awaited<ReturnType<MountQuery>> | undefined
  let stopActiveObservers: () => void = () => undefined
  const phaseStarts = new Map<SnapshotPhase, number>()
  const phaseMeasurements: {
    phase: SnapshotPhase
    startedMilliseconds: number
    elapsedMilliseconds: number
  }[] = []
  const observingImport = false
  const observeSnapshotPhase = (event: {
    readonly phase: SnapshotPhase
    readonly state: 'begin' | 'end'
  }) => {
    if (event.state === 'begin') setApplicationWorkPhase(event.phase)
    armPhaseObserver?.snapshot(event)
    if (!observingImport) return
    const now = nativeClock.now()
    if (event.state === 'begin') {
      phaseStarts.set(event.phase, now)
    } else {
      const started = phaseStarts.get(event.phase)
      if (started !== undefined)
        phaseMeasurements.push({
          phase: event.phase,
          startedMilliseconds: started,
          elapsedMilliseconds: now - started,
        })
      phaseStarts.delete(event.phase)
    }
  }
  try {
    const cadence = await frameCadence()
    const frameBudgetMilliseconds = cadence.frameBudgetMilliseconds
    pairedTrial.memory.cadenceObservation = {
      estimator:
        'median of 31 consecutive intervals from 32 original RAF callbacks',
      originalRafTimestamps: cadence.originalRafTimestamps,
      frameBudgetMilliseconds,
    }
    stopDirectHeapObservation = beginCalibrationDirectHeapObservation(
      pairedTrial.memory.directReadObservation,
    )
    httpStageSampler = beginCalibrationHttpStageSamples(
      request,
      pairedTrial.memory.nativeHttpStageObservation,
    )
    const baselinePoint = calibrationPoint()
    const baselineMemoryBytes = baselinePoint.hermesUsedHeapBytes
    pairedTrial.memory.baseline = baselinePoint
    pairedTrial.memory.peakHermesUsedHeapBytes = baselineMemoryBytes
    heapSampler = beginCalibrationHeapSamples(request, pairedTrial.memory)
    const nativeBaseline = await causalCalibrationResidentBaseline(request)
    pairedTrial.memory.nativeBaselineResidentBytes =
      nativeBaseline.residentBytes
    pairedTrial.memory.nativeBaselineAcknowledgement =
      nativeBaseline.acknowledgement
    frameSampler = beginCalibrationFrameSamples(request)
    progress('Generating the deterministic synthetic catalog')
    fixtureSource = await createNativeFixture(
      fixtureDatabaseName,
      backendSchema,
    )
    const snapshot = fixtureSource
    const fixtureRegistration = {
      name: fixtureDatabaseName,
      path: await snapshot.databasePath(),
      origin: 'fixture adapter PRAGMA database_list' as const,
    }
    await registerCalibrationTaskPath(
      request,
      fixtureRegistration.name,
      fixtureRegistration.path,
      fixtureRegistration.origin,
    )
    pairedTrial.taskDisk.registrations.push(fixtureRegistration)
    const sourceIdentity = await sealCalibrationFixture(
      fixtureDatabaseName,
      snapshot,
    )
    if (
      snapshot.recordCount !== 117115 ||
      snapshot.relationSetCount !== 100 ||
      sourceIdentity.partInventoryHash.length !== 64
    )
      throw new Error(
        'Paired trial did not prepare the entire original durable local fixture.',
      )
    const transportSlot = calibrationTransportSlot(
      snapshot.transport(() => fixtureGeneration),
    )
    let fixtureGeneration = snapshot.metadata.generation
    const fixtureRecords = snapshot.recordCount
    Object.assign(partialMeasurement, {
      syntheticInput: {
        representation: 'immutable SQLite canonical-parts-v1',
        publicSdkPath: 'sync.resnapshot with snapshotParts transport',
        recordCount: snapshot.recordCount,
        relationSetCount: snapshot.relationSetCount,
        partCount: snapshot.partCount,
        maximumPartBytes: 65536,
        maximumPartRows: 256,
        maximumRowBytes: snapshot.maximumRowBytes,
        inputDatabaseBytes: snapshot.databaseBytes,
        catalogHash: snapshot.metadata.hash,
        catalogBytes: snapshot.metadata.byteSize,
      },
    })
    const benchmarkConfiguration = () => {
      let counter = 0
      return {
        observeSnapshotPhase,
        transport: transportSlot.transport,
        now: () => '2026-10-02T00:00:00.000Z',
        generateIdentity: () =>
          `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`,
      }
    }
    active = await makeExampleClient(
      databaseName,
      address,
      backendSchema,
      benchmarkConfiguration(),
    )
    const expected = await preparePendingCatalog(active, snapshot)
    reference = await makeExampleClient(
      referenceDatabaseName,
      address,
      backendSchema,
      benchmarkConfiguration(),
    )
    const referenceExpected = await preparePendingCatalog(reference, snapshot)
    pairedTrial.taskDisk.snapshots.push(
      await calibrationTaskDisk(
        request,
        pairedTrial.taskDisk.registrations.map((entry) => entry.name),
      ),
    )
    const databasePath = await active.storage.read(async (executor) =>
      String(
        (await executor.execute('PRAGMA database_list')).rows.find(
          (row) => row.name === 'main',
        )?.file,
      ),
    )
    const registeringStorage = await fetch(
      'http://127.0.0.1:8767/measurement/storage',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: databasePath }),
      },
    )
    if (!registeringStorage.ok)
      throw new Error('Physical database telemetry did not register.')
    let peakMemoryBytes = Math.max(
      heapBytes(),
      pairedTrial.memory.peakHermesUsedHeapBytes,
    )
    mounted = await mountQuery(
      active,
      active.query('Item').orderBy('id').take(25),
    )
    await awaitIdleInteraction()
    await mounted.unmount()
    mounted = undefined
    let catalogWitness!: Awaited<ReturnType<typeof verifyPendingCatalog>>
    let referenceWitness!: Awaited<ReturnType<typeof verifyPendingCatalog>>
    let sdkRollbackBaseline!: Awaited<ReturnType<typeof verifyPendingCatalog>>
    let referenceRollbackBaseline!: Awaited<
      ReturnType<typeof verifyPendingCatalog>
    >
    const repeatedImports: RepeatedImportMeasurement[] = []
    const sdkOwner = owners.get(databaseName)!
    const referenceOwner = owners.get(referenceDatabaseName)!
    const sdkDatabaseIdentity = await calibrationDatabaseIdentity(sdkOwner)
    const referenceDatabaseIdentity =
      await calibrationDatabaseIdentity(referenceOwner)
    if (
      canonicalJson(sdkDatabaseIdentity) !==
      canonicalJson(referenceDatabaseIdentity)
    )
      throw new Error(
        'Matched target DDL, indexes, SQLite, constraints or actual driver capabilities differ.',
      )
    Object.assign(partialMeasurement, {
      sdkDatabaseIdentity,
      referenceDatabaseIdentity,
    })
    for (const [index, stratum] of (
      ['cold', 'warm1', 'warm2'] as const
    ).entries()) {
      fixtureGeneration =
        index === 0
          ? snapshot.metadata.generation
          : 'native-repeat-' + (index - 1)
      const arms =
        request.order === 'A'
          ? (['sdk', 'reference'] as const)
          : (['reference', 'sdk'] as const)
      const measured = new Map<
        string,
        Awaited<ReturnType<typeof runCalibrationArm>>
      >()
      for (const arm of arms) {
        const result = await runCalibrationArm({
          arm,
          stratum,
          owner: arm === 'sdk' ? sdkOwner : referenceOwner,
          source: sourceIdentity,
          generation: () => fixtureGeneration,
          transportSlot,
          expected: arm === 'sdk' ? expected : referenceExpected,
          mountQuery,
          cadence: frameBudgetMilliseconds,
          checkpoint: (operation) =>
            checkpoint(operation, completedMeasurements),
          setSdkObserver: (observer) => {
            armPhaseObserver = observer
          },
          setMounted: (value) => {
            mounted = value
          },
          setStopObservers: (stop) => {
            stopActiveObservers = stop
          },
          preservePartial: (value) => {
            partialMeasurement.activePairedArm = value
          },
          recordCleanupFailure,
          recordObservationFailure,
        })
        measured.set(arm, result)
        completedMeasurements.push({
          operation: `pair/${stratum}/${arm}/install`,
          elapsedMilliseconds: result.receipt.ingestionTotal.wallMilliseconds,
          frameMeasurement: result.receipt.frameMeasurement,
          responsivenessMeasurement: checkpointResponsiveness(
            result.receipt.responsivenessMeasurement,
          ),
          digestMeasurement: result.receipt.digestMeasurement,
        })
      }
      const sdk = measured.get('sdk')!
      const direct = measured.get('reference')!
      if (
        sdk.receipt.fullWitnessJson !== direct.receipt.fullWitnessJson ||
        sdk.receipt.pendingBeforeJson !== direct.receipt.pendingBeforeJson ||
        sdk.receipt.generation !== direct.receipt.generation ||
        sdk.receipt.cursor !== direct.receipt.cursor ||
        sdk.receipt.scopeJson !== direct.receipt.scopeJson ||
        sdk.receipt.sessionJson !== direct.receipt.sessionJson ||
        sdk.receipt.partition !== direct.receipt.partition ||
        canonicalJson(sdk.receipt.source) !==
          canonicalJson(direct.receipt.source)
      )
        throw new Error(
          'Completed full paired strata differ in raw input, scope, pending or full catalog witnesses.',
        )
      pairedTrial.pairs.push({
        stratum,
        order: request.order,
        sdk: sdk.receipt,
        reference: direct.receipt,
        fullWitnessEqual: true,
        pendingBeforeEqual: true,
        sourceAndScopeEqual: true,
      })
      sdkRollbackBaseline = sdk.witness
      referenceRollbackBaseline = direct.witness
      if (index === 0) {
        catalogWitness = sdk.witness
        referenceWitness = direct.witness
      } else
        repeatedImports.push({
          ...sdk.witness,
          elapsedMilliseconds: sdk.receipt.ingestionTotal.wallMilliseconds,
          frameMeasurement: sdk.receipt.frameMeasurement,
          responsivenessMeasurement: sdk.receipt.responsivenessMeasurement,
          checkpointMilliseconds: sdk.receipt.checkpoint.wallMilliseconds,
          databaseBytes: sdk.receipt.databaseBytes,
        })
      pairedTrial.taskDisk.snapshots.push(
        await calibrationTaskDisk(
          request,
          pairedTrial.taskDisk.registrations.map((entry) => entry.name),
        ),
      )
    }
    const coldPair = pairedTrial.pairs[0]!
    const importMilliseconds = coldPair.sdk.ingestionTotal.wallMilliseconds
    const initialJavaScriptWorkMilliseconds =
      coldPair.sdk.initialDispatchMilliseconds
    const digestMeasurement = coldPair.sdk.digestMeasurement
    const responsivenessMeasurement = coldPair.sdk.responsivenessMeasurement
    const frameMeasurement = coldPair.sdk.frameMeasurement
    phaseMeasurements.push(
      ...coldPair.sdk.phases
        .filter(
          (phase) =>
            !['checkpoint', 'maintenance', 'commit-and-reclaim'].includes(
              phase.phase,
            ),
        )
        .map((phase) => ({
          phase: phase.phase as SnapshotPhase,
          startedMilliseconds: phase.start.applicationMonotonicMilliseconds,
          elapsedMilliseconds: phase.wallMilliseconds,
        })),
    )
    const fairReference = {
      ...referenceWitness,
      ...coldPair.reference,
      elapsedMilliseconds: coldPair.reference.ingestionTotal.wallMilliseconds,
      phaseMeasurements: coldPair.reference.phases,
    }
    const walLifecycle = {
      checkpointMilliseconds: coldPair.sdk.checkpoint.wallMilliseconds,
      fileMeasurement: coldPair.sdk.fileMeasurement,
    }
    Object.assign(partialMeasurement, {
      importMilliseconds,
      frameBudgetMilliseconds,
      digestMeasurement,
      responsivenessMeasurement,
      frameMeasurement,
      phaseMeasurements,
      fairReference,
      repeatedImports,
      walLifecycle,
    })
    checks[0] = { ...checks[0]!, durationMilliseconds: importMilliseconds }
    mounted = await mountQuery(
      active,
      active.query('Item').orderBy('id').take(25),
    )
    await checkpoint('invalid/prepare', completedMeasurements)
    const invalidRecord: CanonicalRecord = {
      model: 'Image',
      id: '1',
      revision: '2',
      attributes: {
        id: 1,
        item_id: 999999,
        url: 'invalid-foreign-key.jpg',
        created_at: null,
        updated_at: null,
      },
    }
    const invalidContent = { records: [invalidRecord], relationSets: [] }
    const invalidSnapshot = {
      ...snapshot.metadata,
      ...invalidContent,
      ...(await snapshotContent(invalidContent)),
      generation: 'native-rejected-snapshot',
    }
    let sdkRejected = false
    let referenceRejected = false
    const sdkMetadataBefore = await snapshotMetadata(active)
    const referenceMetadataBefore = await snapshotMetadata(reference)
    await checkpoint('invalidSDK/install', completedMeasurements)
    try {
      await active.sync.installSnapshot(invalidSnapshot)
    } catch {
      sdkRejected = true
    }
    await checkpoint('invalidReference/install', completedMeasurements)
    try {
      await installReferenceSnapshot(reference, invalidSnapshot)
    } catch {
      referenceRejected = true
    }
    await checkpoint('invalidSDK/witness', completedMeasurements)
    const afterInvalidSdk = await verifyPendingCatalog(active, expected)
    await checkpoint('invalidReference/witness', completedMeasurements)
    const afterInvalidReference = await verifyPendingCatalog(
      reference,
      referenceExpected,
    )
    const invalidSnapshotRollback = {
      sdkRejected,
      referenceRejected,
      beforeStoredHash: sdkRollbackBaseline.actualCatalog.storedContentHash,
      afterStoredHash: afterInvalidSdk.actualCatalog.storedContentHash,
      referenceAfterStoredHash:
        afterInvalidReference.actualCatalog.storedContentHash,
      sdkMetadataBefore,
      sdkMetadataAfter: await snapshotMetadata(active),
      referenceMetadataBefore,
      referenceMetadataAfter: await snapshotMetadata(reference),
    }
    const initialCatalogMatchesReference =
      canonicalJson(catalogWitness) === canonicalJson(referenceWitness)
    const sdkRollbackMatchesBaseline =
      canonicalJson(sdkRollbackBaseline) === canonicalJson(afterInvalidSdk)
    const referenceRollbackMatchesBaseline =
      canonicalJson(referenceRollbackBaseline) ===
      canonicalJson(afterInvalidReference)
    Object.assign(partialMeasurement, {
      invalidSnapshotRollback,
      rollbackCatalogGuarantees: {
        initialCatalogMatchesReference,
        sdkRollbackMatchesBaseline,
        referenceRollbackMatchesBaseline,
      },
      rollbackCatalogWitnesses: {
        sdkBaseline: sdkRollbackBaseline,
        sdkAfter: afterInvalidSdk,
        referenceBaseline: referenceRollbackBaseline,
        referenceAfter: afterInvalidReference,
      },
    })
    if (
      !sdkRejected ||
      !referenceRejected ||
      !initialCatalogMatchesReference ||
      !sdkRollbackMatchesBaseline ||
      !referenceRollbackMatchesBaseline
    )
      throw new Error('Reference or rollback catalog guarantees differ.')
    await checkpoint('catalog/read-and-subscription', completedMeasurements)
    const maximumJavaScriptWorkMilliseconds = Math.max(
      responsivenessMeasurement.maximumCallbackGapMilliseconds,
      initialJavaScriptWorkMilliseconds,
      digestMeasurement.maximumDigestSliceMilliseconds,
      digestMeasurement.maximumIteratorDispatchMilliseconds,
    )
    peakMemoryBytes = Math.max(peakMemoryBytes, heapBytes())
    const readUiBefore = await calibrationUiReport()
    await interactionPhase('catalog-read')
    const readProbeIdentity = await calibrationProbeIdentity()
    const readMountedQueryKey = mounted.observedQueryKey()
    if (!readMountedQueryKey)
      throw new Error('Catalog read did not mount its actual client.')
    let readResponsiveness:
      Awaited<ReturnType<typeof monitorApplicationResponsiveness>> | undefined =
      undefined
    let readFrames: ReturnType<typeof monitorAnimationFrames> | undefined =
      undefined
    let readFrameMeasurement!: ReturnType<
      ReturnType<typeof monitorAnimationFrames>['stop']
    >
    let readResponsivenessMeasurement!: ResponsivenessMeasurement
    let readFramesStopped = false
    let readResponsivenessStopped = false
    let readStopFailed = false
    let readStopFailure: unknown
    const stopReadObservers = () => {
      for (const [resource, stop] of [
        [
          'RAF',
          () => {
            if (readFrames && !readFramesStopped) {
              readFramesStopped = true
              readFrameMeasurement = readFrames.stop()
            }
          },
        ],
        [
          'responsiveness',
          () => {
            if (readResponsiveness && !readResponsivenessStopped) {
              readResponsivenessStopped = true
              readResponsivenessMeasurement = readResponsiveness.stop()
            }
          },
        ],
      ] as const) {
        try {
          stop()
        } catch (failure) {
          recordCleanupFailure('catalog read ' + resource, failure)
          if (!readStopFailed) {
            readStopFailed = true
            readStopFailure = failure
          }
        }
      }
      if (readStopFailed) throw readStopFailure
    }
    stopActiveObservers = stopReadObservers
    readResponsiveness = await monitorApplicationResponsiveness()
    readFrames = monitorAnimationFrames(frameBudgetMilliseconds)
    const readStarted = calibrationPoint()
    readResponsiveness.markContinuation()
    const coldStarted = nativeClock.now()
    const readQuery = active.models.Item.with('images', 'category', 'tags')
    const loaded = await readQuery.findOrFail('2')
    const coldReadMilliseconds = nativeClock.now() - coldStarted
    const warmStarted = nativeClock.now()
    await readQuery.findOrFail('2')
    const warmReadMilliseconds = nativeClock.now() - warmStarted
    if (
      !loaded.relation('images').current?.length ||
      !loaded.relation('category').current?.length ||
      loaded.relation('tags').current?.length !== 3
    )
      throw new Error(
        'Catalog relations failed to hydrate through the public API.',
      )
    const databaseSize = await active.storage.read(async (executor) => {
      const pages = await executor.execute('PRAGMA page_count')
      const pageSize = await executor.execute('PRAGMA page_size')
      return (
        Number(pages.rows[0]?.page_count) * Number(pageSize.rows[0]?.page_size)
      )
    })
    const plans = await active.storage.read(async (executor) => {
      const compiler = new QueryCompiler(
        active!.storage.manifest,
        active!.storage.partition,
      )
      const root = compiler.compile(readQuery.options, loaded.localIdentity)
      const entries = [{ name: 'Item.find', compiled: root }]
      for (const relation of ['images', 'category', 'tags']) {
        const options = readQuery.options.include?.[relation]
        if (!options)
          throw new Error('Actual relation query options are missing.')
        entries.push({
          name: 'Item.' + relation,
          compiled: compiler.compileRelation(
            'Item',
            relation,
            [loaded.localIdentity],
            options,
          ),
        })
      }
      const explained = []
      for (const entry of entries)
        explained.push({
          name: entry.name,
          statement: entry.compiled.statement,
          parameters: entry.compiled.parameters,
          rows: (
            await executor.execute(
              'EXPLAIN QUERY PLAN ' + entry.compiled.statement,
              entry.compiled.parameters,
            )
          ).rows,
        })
      return explained
    })
    const storageStatistics = await active.storage.read(async (executor) => {
      const payloads = await executor.execute(
        'SELECT SUM(length(_canonical)+length(_proposal)) AS canonicalBytes, COUNT(*) AS records FROM syn_model_Image',
      )
      try {
        return {
          imagePayloads: payloads.rows,
          objects: (
            await executor.execute(
              'SELECT name,sum(pgsize) AS bytes FROM dbstat GROUP BY name',
            )
          ).rows,
        }
      } catch (failure) {
        return {
          imagePayloads: payloads.rows,
          databaseStatisticsUnavailable: String(failure),
        }
      }
    })
    const updateStarted = nativeClock.now()
    loaded.fill({ title: 'Synthetic updated item' })
    await loaded.save()
    const subscriptionDeadline = nativeClock.now() + 10000
    while (
      !mounted
        .snapshot()
        .data.items.some(
          (model) => model.attributes.title === 'Synthetic updated item',
        ) &&
      nativeClock.now() < subscriptionDeadline
    )
      await yieldToApplication()
    if (
      !mounted
        .snapshot()
        .data.items.some(
          (model) => model.attributes.title === 'Synthetic updated item',
        )
    )
      throw new Error(
        'Catalog subscription did not reflect its committed edit.',
      )
    const subscriptionMilliseconds = nativeClock.now() - updateStarted
    const readEnded = calibrationPoint()
    const readInterval = calibrationInterval(readStarted, readEnded)
    stopReadObservers()
    Object.assign(partialMeasurement, {
      readInterval,
      readFrameMonitorId: readFrames.monitorId,
      readFrameMeasurement,
      readResponsivenessMeasurement,
    })
    stopActiveObservers = () => undefined
    await interactionPhase('between-imports')
    Object.assign(partialMeasurement, {
      readUi: calibrationUiWindow(
        readUiBefore,
        await calibrationUiReport(),
        'catalog-read',
        readProbeIdentity,
        readMountedQueryKey,
        databaseName,
      ),
    })
    const remainingListenerCount = active.storage.owner.listenerCount
    await mounted.unmount()
    mounted = undefined
    if (active.storage.owner.listenerCount !== 0)
      throw new Error('Catalog unmount retained an owner listener.')
    await fixtureSource.close()
    await checkpoint('largeHTTP/prepare', completedMeasurements)
    progress(
      'Measuring the complete 117k actual HTTP resnapshot including native response text and JSON decode',
    )
    const largePhaseMeasurements: typeof phaseMeasurements = []
    const largePhaseStarts = new Map<SnapshotPhase, number>()
    large = await makeExampleClient(
      largeDatabaseName,
      largeAddress,
      backendSchema,
      {
        observeSnapshotPhase(event) {
          setApplicationWorkPhase(event.phase)
          if (event.state === 'begin')
            largePhaseStarts.set(event.phase, nativeClock.now())
          else {
            const beginning = largePhaseStarts.get(event.phase)
            if (beginning !== undefined)
              largePhaseMeasurements.push({
                phase: event.phase,
                startedMilliseconds: beginning,
                elapsedMilliseconds: nativeClock.now() - beginning,
              })
          }
        },
      },
    )
    pairedTrial.taskDisk.snapshots.push(
      await calibrationTaskDisk(
        request,
        pairedTrial.taskDisk.registrations.map((entry) => entry.name),
      ),
    )
    const largeMount = await mountQuery(
      large,
      large.query('Item').orderBy('id').take(25),
    )
    mounted = largeMount
    const largeBaselineMemoryBytes = heapBytes()
    resetNativeHttpStages()
    httpStageResetPerformed = true
    resetDigestMeasurements()
    await checkpoint('largeHTTP/resnapshot', completedMeasurements)
    const largeUiBefore = await calibrationUiReport()
    await interactionPhase('large-http')
    const largeProbeIdentity = await calibrationProbeIdentity()
    const largeMountedQueryKey = largeMount.observedQueryKey()
    if (!largeMountedQueryKey)
      throw new Error('Actual full HTTP did not mount its client.')
    let largeResponsiveness:
      Awaited<ReturnType<typeof monitorApplicationResponsiveness>> | undefined =
      undefined
    let largeFrames: ReturnType<typeof monitorAnimationFrames> | undefined =
      undefined
    let largeFrameMeasurement!: ReturnType<
      ReturnType<typeof monitorAnimationFrames>['stop']
    >
    let largeResponsivenessMeasurement!: ResponsivenessMeasurement
    let largeFramesStopped = false
    let largeResponsivenessStopped = false
    let largeStopFailed = false
    let largeStopFailure: unknown
    const stopLargeObservers = () => {
      for (const [resource, stop] of [
        [
          'RAF',
          () => {
            if (largeFrames && !largeFramesStopped) {
              largeFramesStopped = true
              largeFrameMeasurement = largeFrames.stop()
            }
          },
        ],
        [
          'responsiveness',
          () => {
            if (largeResponsiveness && !largeResponsivenessStopped) {
              largeResponsivenessStopped = true
              largeResponsivenessMeasurement = largeResponsiveness.stop()
            }
          },
        ],
      ] as const) {
        try {
          stop()
        } catch (failure) {
          recordCleanupFailure('large HTTP ' + resource, failure)
          if (!largeStopFailed) {
            largeStopFailed = true
            largeStopFailure = failure
          }
        }
      }
      if (largeStopFailed) throw largeStopFailure
    }
    stopActiveObservers = stopLargeObservers
    largeResponsiveness = await monitorApplicationResponsiveness()
    largeFrames = monitorAnimationFrames(frameBudgetMilliseconds)
    Object.assign(partialMeasurement, {
      largeHttpFrameMonitorId: largeFrames.monitorId,
    })
    const diagnosticLargeCallingThreadCpuStarted =
      calibrationPoint().callingThreadCpuMilliseconds
    const largeStarted = nativeClock.now()
    largeResponsiveness.markContinuation()
    Object.assign(partialMeasurement, {
      largeHttp: {
        ...provenance,
        actualHttp: true,
        completeInstall: false,
        address: largeAddress,
        baselineMemoryBytes: largeBaselineMemoryBytes,
      },
    })
    let largeOperationFailed = false
    let largeOperationFailure: unknown
    try {
      await large.sync.resnapshot('catalog')
    } catch (failure) {
      largeOperationFailed = true
      largeOperationFailure = failure
    } finally {
      try {
        const finished = calibrationPoint().callingThreadCpuMilliseconds
        Object.assign(partialMeasurement.largeHttp as Record<string, unknown>, {
          diagnosticCallingThreadCpuMilliseconds:
            finished - diagnosticLargeCallingThreadCpuStarted,
        })
      } catch (failure) {
        recordObservationFailure('large HTTP final CPU point', failure)
        if (!largeOperationFailed) {
          largeOperationFailed = true
          largeOperationFailure = failure
        }
      }
    }
    if (largeOperationFailed) {
      const diagnostics = partialMeasurement.largeHttp as Record<
        string,
        unknown
      >
      try {
        diagnostics.elapsedMilliseconds = nativeClock.now() - largeStarted
      } catch (failure) {
        recordObservationFailure('large HTTP failed elapsed', failure)
      }
      try {
        stopLargeObservers()
      } catch {
        /* Each actual failed stop is already mapped separately. */
      }
      Object.assign(diagnostics, {
        frameMeasurement: largeFrameMeasurement,
        responsivenessMeasurement: largeResponsivenessMeasurement,
        phaseMeasurements: largePhaseMeasurements,
      })
      try {
        diagnostics.httpStages = nativeHttpStages()
      } catch (failure) {
        recordObservationFailure('large HTTP failed stages', failure)
      }
      try {
        diagnostics.peakMemoryBytes = Math.max(peakMemoryBytes, heapBytes())
      } catch (failure) {
        recordObservationFailure('large HTTP failed heap', failure)
      }
      stopActiveObservers = () => undefined
      throw largeOperationFailure
    }
    const largeElapsed = nativeClock.now() - largeStarted
    stopLargeObservers()
    const largeDigestMeasurement = digestMeasurements()
    stopActiveObservers = () => undefined
    peakMemoryBytes = Math.max(
      peakMemoryBytes,
      heapBytes(),
      ...nativeHttpStages().flatMap((stage) =>
        stage.heapBytes === undefined ? [] : [stage.heapBytes],
      ),
    )
    await interactionPhase('between-imports')
    const largeUi = calibrationUiWindow(
      largeUiBefore,
      await calibrationUiReport(),
      'large-http',
      largeProbeIdentity,
      largeMountedQueryKey,
      largeDatabaseName,
    )
    completedMeasurements.push({
      operation: 'largeHTTP/resnapshot',
      elapsedMilliseconds: largeElapsed,
      phaseMeasurements: largePhaseMeasurements,
      frameMeasurement: largeFrameMeasurement,
      responsivenessMeasurement: checkpointResponsiveness(
        largeResponsivenessMeasurement,
      ),
      digestMeasurement: largeDigestMeasurement,
    })
    Object.assign(partialMeasurement.largeHttp as Record<string, unknown>, {
      elapsedMilliseconds: largeElapsed,
      frameMeasurement: largeFrameMeasurement,
      responsivenessMeasurement: largeResponsivenessMeasurement,
      httpStages: nativeHttpStages(),
      phaseMeasurements: largePhaseMeasurements,
      digestMeasurement: largeDigestMeasurement,
    })
    await checkpoint('largeHTTP/witness', completedMeasurements)
    const actualLargeCounts = await verifyHttpCatalog(large)
    const largeHttp = {
      ...provenance,
      frameMonitorId: largeFrames.monitorId,
      ui: largeUi,
      schemaFingerprint: large.storage.manifest.fingerprint,
      completeInstall: true,
      baselineMemoryBytes: largeBaselineMemoryBytes,
      peakMemoryBytes,
      actualHttp: true,
      address: largeAddress,
      dataset: 'catalog',
      elapsedMilliseconds: largeElapsed,
      frameMeasurement: largeFrameMeasurement,
      responsivenessMeasurement: largeResponsivenessMeasurement,
      httpStages: nativeHttpStages(),
      phaseMeasurements: largePhaseMeasurements,
      digestMeasurement: largeDigestMeasurement,
      actualCounts: actualLargeCounts,
      serverSnapshotPreparationMilliseconds: Number(
        nativeHttpStages()
          .find((stage) => stage.phase === 'responseAvailable')
          ?.serverTiming?.match(/snapshot;dur=([0-9.]+)/)?.[1],
      ),
      serverSnapshotPreparationBoundary:
        'Server-Timing snapshot preparation measured by PHP hrtime before streamed response body emission',
    }
    Object.assign(largeHttp, {
      diagnosticCallingThreadCpuMilliseconds: (
        partialMeasurement.largeHttp as Record<string, unknown>
      ).diagnosticCallingThreadCpuMilliseconds,
    })
    await largeMount.unmount()
    mounted = undefined
    const batchSync: {
      operations: number
      accepted: number
      milliseconds: number
      actualHttp: boolean
      error?: string
    } = { operations: 100, accepted: 0, milliseconds: 0, actualHttp: true }
    const memoryBudgetBytes = baselineMemoryBytes + 128 * 1024 ** 2
    const detail = {
      seed: fixtureSeed,
      items: itemCount,
      relations: imageCount + 300,
      relationFamilies: ['belongsTo', 'hasMany', 'belongsToMany'],
      importMilliseconds,
      importRowsPerSecond: fixtureRecords / (importMilliseconds / 1000),
      coldReadMilliseconds,
      warmReadMilliseconds,
      databaseBytes: databaseSize,
      baselineMemoryBytes,
      nativeBaselineResidentBytes: nativeBaseline.residentBytes,
      peakMemoryBytes,
      memoryBudgetBytes,
      measuredMemoryKind:
        'Hermes used heap. Runner separately records native process residency',
      frameBudgetMilliseconds,
      refreshRateHertz: 1000 / frameBudgetMilliseconds,
      maximumJavaScriptWorkMilliseconds,
      initialJavaScriptWorkMilliseconds,
      digestMeasurement,
      responsivenessMeasurement,
      frameMeasurement,
      javaScriptMeasurement:
        'Conservative one-shot RuntimeScheduler callback gap after injected yields and native statement continuations throughout verification and ingestion, including scheduling delay',
      subscriptionMilliseconds,
      committedListenerCount: remainingListenerCount,
      remainingListeners: active.storage.owner.listenerCount,
      indexedReadPlans: plans,
      phaseMeasurements,
      storageStatistics,
      ...catalogWitness,
      largeHttp,
      fairReference,
      repeatedImports,
      walLifecycle,
      invalidSnapshotRollback,
      uiInteraction: await interactionReport(),
      batchSync,
      budgets: {
        importMilliseconds: 10000,
        coldReadMilliseconds: 100,
        warmReadMilliseconds: 50,
        databaseBytes: 32 * 1024 ** 2,
      },
    }
    Object.assign(partialMeasurement, detail)
    await checkpoint('batchSync', completedMeasurements)
    try {
      progress(
        'Confirming one hundred pending creates with the real Laravel host',
      )
      synchronizing = await makeExampleClient(syncDatabaseName, address)
      const synchronize = synchronizing
      const batchPrefix = `Batch ${Platform.OS} ${generateIdentity()}`
      await synchronize.transaction(async (transaction) => {
        for (let index = 0; index < 100; index += 1)
          await transaction.models.Item.create({
            title: `${batchPrefix} ${index}`,
          })
      })
      const syncStarted = nativeClock.now()
      await synchronize.sync.flush()
      batchSync.milliseconds = nativeClock.now() - syncStarted
      const receipts = await synchronize.storage.read((executor) =>
        synchronize.storage.pending(executor),
      )
      if (
        receipts.length !== 100 ||
        receipts.some((receipt) => receipt.status !== 'accepted')
      )
        throw new Error(
          'The actual HTTP batch did not confirm all one hundred operation identities.',
        )
      batchSync.operations = receipts.length
      batchSync.accepted = receipts.filter(
        (receipt) => receipt.status === 'accepted',
      ).length
    } catch (failure) {
      batchSync.error = String(failure)
    }
    peakMemoryBytes = Math.max(peakMemoryBytes, heapBytes())
    detail.peakMemoryBytes = peakMemoryBytes
    partialMeasurement.peakMemoryBytes = peakMemoryBytes
    if (batchSync.error) throw new Error(batchSync.error)
    for (const kind of ['synchronous-checksum', 'awaited-timer'] as const) {
      const controlMount = await mountQuery(
        active,
        active.query('Item').orderBy('id').take(25),
      )
      mounted = controlMount
      const queryKey = controlMount.observedQueryKey()
      if (!queryKey)
        throw new Error('Independent control did not mount its actual client.')
      await checkpoint(`control/${kind}`, completedMeasurements)
      pairedTrial.controls.push(
        await runCalibrationNegativeControl(
          kind,
          frameBudgetMilliseconds,
          queryKey,
          request,
          databaseName,
          recordCleanupFailure,
        ),
      )
      await controlMount.unmount()
      mounted = undefined
      if (active.storage.owner.listenerCount)
        throw new Error('Independent control retained a query subscription.')
    }
    if (pairedTrial.pairs.length !== 3 || pairedTrial.controls.length !== 2)
      throw new Error(
        'The complete ordered trial has missing pairs or independent controls.',
      )
    pairedTrial.taskDisk.snapshots.push(
      await calibrationTaskDisk(
        request,
        pairedTrial.taskDisk.registrations.map((entry) => entry.name),
      ),
    )
    pairedTrial.correctness.completedLogicalDuties.push(
      ...originalLogicalDuties,
    )
    pairedTrial.correctness.status = 'complete'
    pairedTrial.operational.status = 'complete'
  } catch (failure) {
    pairedTrial.operational.status = 'failed'
    try {
      const snapshotAdmissionFailure =
        calibrationSnapshotAdmissionFailure(failure)
      if (snapshotAdmissionFailure) {
        pairedTrial.operational.snapshotAdmissionFailure =
          snapshotAdmissionFailure
        const activeArm = partialMeasurement.activePairedArm
        if (
          typeof activeArm === 'object' &&
          activeArm !== null &&
          (activeArm as Readonly<Record<string, unknown>>).completeInstall ===
            false
        )
          Object.assign(activeArm, { snapshotAdmissionFailure })
      }
    } catch {
      // Diagnostic attachment cannot replace the original failure.
    }
    pairedTrial.operational.error = String(failure).slice(0, 4096)
  } finally {
    const cleanup = async (
      name: string,
      callback: () => unknown | Promise<unknown>,
    ) => {
      try {
        await callback()
      } catch (failure) {
        recordCleanupFailure(name, failure)
      }
    }
    await cleanup('observers', () => stopActiveObservers())
    await cleanup('interaction', () => interactionPhase('inactive'))
    await cleanup('mounted query', () => mounted?.unmount())
    for (const [name, owner] of owners)
      await cleanup('client ' + name, () => owner.close())
    for (const name of [
      referenceDatabaseName,
      largeDatabaseName,
      databaseName,
      syncDatabaseName,
    ])
      await cleanup('delete ' + name, () => deleteDatabase(name))
    await cleanup('immutable input', () => fixtureSource?.close())
    if (httpStageResetPerformed) {
      try {
        pairedTrial.memory.nativeHttpStageHeapObservation = {
          sourceWindow:
            'original large HTTP stage reset through owned transport close',
          diagnostics: nativeHttpStageDiagnostics(),
        }
      } catch (failure) {
        recordObservationFailure(
          'original HTTP stage heap diagnostics',
          failure,
        )
        pairedTrial.operational.status = 'failed'
        pairedTrial.operational.error ??= String(failure).slice(0, 4096)
      }
    }
    await cleanup('original HTTP stage samples', () =>
      httpStageSampler?.close(),
    )
    await cleanup('RAF raw samples', () => frameSampler?.close())
    await cleanup('Hermes raw samples', () => heapSampler?.close())
    await cleanup('direct Hermes observation', () =>
      stopDirectHeapObservation?.(),
    )
    pairedTrial.memory.peakHermesUsedHeapBytes = Math.max(
      pairedTrial.memory.peakHermesUsedHeapBytes,
      Number(partialMeasurement.peakMemoryBytes ?? 0),
      pairedTrial.memory.directReadObservation.maximumBytes ?? 0,
      pairedTrial.memory.nativeHttpStageHeapObservation?.diagnostics
        .maximumObservedHeapBytes ?? 0,
    )
    pairedTrial.duties = partialMeasurement
    pairedTrial.operational.cleanupComplete =
      pairedTrial.operational.cleanupFailures.length === 0
    if (!pairedTrial.operational.cleanupComplete) {
      pairedTrial.operational.status = 'failed'
      pairedTrial.operational.error ??=
        'Task-owned application resource cleanup failed.'
    }
  }
  return {
    schema: 'synloquent-native-performance',
    schemaVersion: 2,
    contractVersion: 2,
    purpose: request.purpose,
    excludedFromAcceptance: request.purpose !== 'canonical-fullrun',
    platform: Platform.OS,
    hermes: Boolean(
      (globalThis as typeof globalThis & { HermesInternal?: unknown })
        .HermesInternal,
    ),
    status: pairedTrial.operational.status === 'complete' ? 'passed' : 'failed',
    checks,
    ...(pairedTrial.operational.error
      ? { error: pairedTrial.operational.error }
      : {}),
    startedAt,
    finishedAt: new Date().toISOString(),
    pairedTrial,
  }
}

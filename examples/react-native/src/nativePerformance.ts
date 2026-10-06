import {
  QueryCompiler,
  SynloquentError,
  type CanonicalRecord,
  type SnapshotPhase,
} from '@synloquent/client'
import { Platform } from 'react-native'
import {
  createNativeMemoryComparison,
  type NativeMemoryMode,
} from './nativeMemoryComparison'
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
import { nativeHttpStages, resetNativeHttpStages } from './httpTransport'
import { verifyHttpCatalog } from './nativeHttpOracle'
import { backendSchema } from '../backend.generated'
import {
  deleteDatabase,
  makeExampleClient,
  type MountQuery,
} from './nativeQualification'
import {
  canonicalJson,
  encodeUtf8,
  generateIdentity,
  yieldToApplication,
  nativeClock,
  digestMeasurements,
  resetDigestMeasurements,
  monitorApplicationResponsiveness,
  monitorAnimationFrames,
  setApplicationWorkPhase,
  type ResponsivenessMeasurement,
} from './platform'
import type { NativeSpikeResult } from '../../../packages/client/tests/native/driver-spike'

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

function createPerformanceCheckpoint(provenance: {
  readonly candidateFingerprint: string
  readonly packageArchiveSha256: string
}) {
  let sequence = 0
  return async (
    nextOperation: string,
    completedMeasurements: readonly PerformanceCheckpointMeasurement[],
  ): Promise<void> => {
    const body = JSON.stringify({
      version: 1,
      diagnosticOnly: true,
      candidateFingerprint: provenance.candidateFingerprint,
      packageArchiveSha256: provenance.packageArchiveSha256,
      platform: Platform.OS,
      sequence: sequence + 1,
      nextOperation,
      applicationMonotonicMilliseconds: nativeClock.now(),
      completedMeasurements,
    })
    if (encodeUtf8(body).byteLength > 16384)
      throw new Error('Native performance checkpoint exceeded 16 KiB.')
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 2000)
    try {
      const response = await fetch(
        'http://127.0.0.1:8767/diagnostic/performance-checkpoint',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          signal: controller.signal,
        },
      )
      if (!response.ok)
        throw new Error('Native performance checkpoint was not accepted.')
      const acknowledgement: { accepted?: boolean; sequence?: number } =
        await response.json()
      if (
        acknowledgement.accepted !== true ||
        acknowledgement.sequence !== sequence + 1
      )
        throw new Error('Native performance checkpoint acknowledgement failed.')
      sequence += 1
    } finally {
      clearTimeout(timeout)
    }
  }
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

async function frameCadence(): Promise<number> {
  const durations: number[] = []
  let previous: number | undefined
  for (let frame = 0; frame < 32; frame += 1) {
    const timestamp = await new Promise<number>((resolve) =>
      requestAnimationFrame(resolve),
    )
    if (previous !== undefined) durations.push(timestamp - previous)
    previous = timestamp
  }
  durations.sort((left, right) => left - right)
  return durations[Math.floor(durations.length / 2)]!
}

function heapBytes(): number {
  const measured = nativeClock.memory.usedJSHeapSize
  if (measured === undefined)
    throw new Error('Hermes memory instrumentation is unavailable.')
  return measured
}

export async function runNativePerformance(
  address: string,
  mountQuery: MountQuery,
  progress: (message: string) => void,
  largeAddress: string,
  provenance: {
    readonly candidateFingerprint: string
    readonly packageArchiveSha256: string
    readonly fixtureFingerprint: string
    readonly memoryMode?: NativeMemoryMode
  },
): Promise<NativeSpikeResult> {
  const startedAt = new Date().toISOString()
  const databaseName = `synloquent_performance_${generateIdentity()}.sqlite`
  const syncDatabaseName = `synloquent_batch_sync_${generateIdentity()}.sqlite`
  const referenceDatabaseName = `synloquent_reference_${generateIdentity()}.sqlite`
  const largeDatabaseName = `synloquent_large_http_${generateIdentity()}.sqlite`
  const partialMeasurement: Record<string, unknown> = {
    seed: fixtureSeed,
    items: itemCount,
    relations: imageCount + 300,
  }
  const checks: NativeSpikeResult['checks'][number][] = [
    {
      name: 'synloquent synthetic catalog performance',
      durationMilliseconds: 0,
      detail: partialMeasurement,
    },
  ]
  const checkpoint = createPerformanceCheckpoint(provenance)
  const completedMeasurements: PerformanceCheckpointMeasurement[] = []
  let comparison: ReturnType<typeof createNativeMemoryComparison> | undefined
  let fixtureSource: NativeFixture | undefined
  let active: Awaited<ReturnType<typeof makeExampleClient>> | undefined
  let reference: Awaited<ReturnType<typeof makeExampleClient>> | undefined
  let large: Awaited<ReturnType<typeof makeExampleClient>> | undefined
  let synchronizing: Awaited<ReturnType<typeof makeExampleClient>> | undefined
  let mounted: Awaited<ReturnType<MountQuery>> | undefined
  let stopActiveObservers: () => void = () => undefined
  let memoryTimer: ReturnType<typeof setInterval> | undefined
  const phaseStarts = new Map<SnapshotPhase, number>()
  const phaseMeasurements: {
    phase: SnapshotPhase
    startedMilliseconds: number
    elapsedMilliseconds: number
  }[] = []
  let observingImport = false
  const observeSnapshotPhase = (event: {
    readonly phase: SnapshotPhase
    readonly state: 'begin' | 'end'
  }) => {
    if (event.state === 'begin') setApplicationWorkPhase(event.phase)
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
    const frameBudgetMilliseconds = await frameCadence()
    const baselineMemoryBytes = heapBytes()
    const memoryResponse = await fetch(
      'http://127.0.0.1:8767/measurement/baseline',
    )
    const nativeBaseline: { residentBytes: number | null } =
      await memoryResponse.json()
    if (provenance.memoryMode) {
      comparison = createNativeMemoryComparison(provenance.memoryMode)
      partialMeasurement.memoryComparison = comparison.report()
    }
    progress('Generating the deterministic synthetic catalog')
    fixtureSource = await createNativeFixture(
      `synloquent_fixture_${generateIdentity()}.sqlite`,
      backendSchema,
    )
    const snapshot = fixtureSource
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
        transport: snapshot.transport(() => fixtureGeneration),
        now: () => '2026-10-02T00:00:00.000Z',
        generateIdentity: () =>
          `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`,
      }
    }
    active = await makeExampleClient(
      databaseName,
      address,
      backendSchema,
      comparison
        ? {
            ...benchmarkConfiguration(),
            ...comparison.client('sdk', () =>
              active?.storage.memoryCache.reduceToCurrentBudget(),
            ),
          }
        : benchmarkConfiguration(),
    )
    const expected = await preparePendingCatalog(active, snapshot)
    reference = await makeExampleClient(
      referenceDatabaseName,
      address,
      backendSchema,
      comparison
        ? {
            ...benchmarkConfiguration(),
            ...comparison.client('reference', () =>
              reference?.storage.memoryCache.reduceToCurrentBudget(),
            ),
          }
        : benchmarkConfiguration(),
    )
    const referenceExpected = await preparePendingCatalog(reference, snapshot)
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
    mounted = await mountQuery(
      active,
      active.query('Item').orderBy('id').take(25),
    )
    let peakMemoryBytes = heapBytes()
    memoryTimer = setInterval(() => {
      peakMemoryBytes = Math.max(peakMemoryBytes, heapBytes())
    }, 25)
    await awaitIdleInteraction()
    await checkpoint('sdk/install', completedMeasurements)
    await interactionPhase('sdk-import')
    progress('Importing 17,000 items and 100,001 images through Synloquent')
    resetDigestMeasurements()
    const responsiveness = await monitorApplicationResponsiveness()
    const frames = monitorAnimationFrames(frameBudgetMilliseconds)
    stopActiveObservers = () => {
      responsiveness.stop()
      frames.stop()
    }
    const started = nativeClock.now()
    responsiveness.markContinuation()
    observingImport = true
    const installing = active.sync.resnapshot('catalog')
    const initialJavaScriptWorkMilliseconds = nativeClock.now() - started
    let frameMeasurement
    let responsivenessMeasurement
    try {
      await installing
    } finally {
      responsivenessMeasurement = responsiveness.stop()
      frameMeasurement = frames.stop()
      observingImport = false
      stopActiveObservers = () => undefined
    }
    const importMilliseconds = nativeClock.now() - started
    await interactionPhase('between-imports')
    const digestMeasurement = digestMeasurements()
    Object.assign(partialMeasurement, {
      importMilliseconds,
      frameBudgetMilliseconds,
      initialJavaScriptWorkMilliseconds,
      digestMeasurement,
      responsivenessMeasurement,
      frameMeasurement,
      phaseMeasurements,
    })
    checks[0] = { ...checks[0]!, durationMilliseconds: importMilliseconds }
    completedMeasurements.push({
      operation: 'sdk/install',
      elapsedMilliseconds: importMilliseconds,
      phaseMeasurements: phaseMeasurements.map((measurement) => ({
        ...measurement,
      })),
      frameMeasurement,
      responsivenessMeasurement: checkpointResponsiveness(
        responsivenessMeasurement,
      ),
      digestMeasurement,
    })
    await checkpoint('sdk/witness', completedMeasurements)
    const catalogWitness = await verifyPendingCatalog(active, expected)
    let sdkRollbackBaseline = catalogWitness
    Object.assign(partialMeasurement, catalogWitness)
    const physicalStorage = async (): Promise<{
      sample: { databaseBytes: number; walBytes: number }
      samples: readonly { databaseBytes: number; walBytes: number }[]
    }> => {
      const response = await fetch('http://127.0.0.1:8767/measurement/storage')
      if (!response.ok)
        throw new Error('Physical database telemetry is unavailable.')
      return response.json()
    }
    const beforeCheckpoint = await physicalStorage()
    await checkpoint('sdk/checkpoint', completedMeasurements)
    setApplicationWorkPhase('checkpoint')
    const checkpointStarted = nativeClock.now()
    await active.storage.owner.checkpoint()
    const checkpointMilliseconds = nativeClock.now() - checkpointStarted
    const afterCheckpoint = await physicalStorage()
    const walLifecycle = {
      peakWalBytes: Math.max(
        ...beforeCheckpoint.samples.map((sample) => sample.walBytes),
      ),
      samples: beforeCheckpoint.samples.length,
      afterCheckpointWalBytes: afterCheckpoint.sample.walBytes,
      checkpointMilliseconds,
    }
    completedMeasurements.push({
      operation: 'sdk/checkpoint',
      elapsedMilliseconds: checkpointMilliseconds,
    })
    await checkpoint('reference/install', completedMeasurements)
    await interactionPhase('reference-import')
    const referenceResponsiveness = await monitorApplicationResponsiveness()
    const referenceFrames = monitorAnimationFrames(frameBudgetMilliseconds)
    stopActiveObservers = () => {
      referenceResponsiveness.stop()
      referenceFrames.stop()
    }
    const referenceStarted = nativeClock.now()
    referenceResponsiveness.markContinuation()
    const directReference = await installReferenceSnapshot(reference, snapshot)
    const referenceElapsed = nativeClock.now() - referenceStarted
    const referenceFrameMeasurement = referenceFrames.stop()
    const referenceResponsivenessMeasurement = referenceResponsiveness.stop()
    stopActiveObservers = () => undefined
    await interactionPhase('between-imports')
    Object.assign(partialMeasurement, {
      fairReference: {
        ...directReference,
        elapsedMilliseconds: referenceElapsed,
        phaseMeasurements: directReference.phases,
        frameMeasurement: referenceFrameMeasurement,
        responsivenessMeasurement: referenceResponsivenessMeasurement,
      },
      walLifecycle,
    })
    completedMeasurements.push({
      operation: 'reference/install',
      elapsedMilliseconds: referenceElapsed,
      phaseMeasurements: directReference.phases,
      frameMeasurement: referenceFrameMeasurement,
      responsivenessMeasurement: checkpointResponsiveness(
        referenceResponsivenessMeasurement,
      ),
    })
    await checkpoint('reference/witness', completedMeasurements)
    const referenceWitness = await verifyPendingCatalog(
      reference,
      referenceExpected,
    )
    const fairReference = {
      ...directReference,
      elapsedMilliseconds: referenceElapsed,
      phaseMeasurements: directReference.phases,
      frameMeasurement: referenceFrameMeasurement,
      responsivenessMeasurement: referenceResponsivenessMeasurement,
      ...referenceWitness,
    }
    Object.assign(partialMeasurement, { fairReference, walLifecycle })
    const repeatedImports: RepeatedImportMeasurement[] = []
    Object.assign(partialMeasurement, { repeatedImports })
    for (let repetition = 0; repetition < 2; repetition += 1) {
      await checkpoint(`repeat${repetition}/install`, completedMeasurements)
      const repeatedResponsiveness = await monitorApplicationResponsiveness()
      const repeatedFrames = monitorAnimationFrames(frameBudgetMilliseconds)
      stopActiveObservers = () => {
        repeatedResponsiveness.stop()
        repeatedFrames.stop()
      }
      const repeatedStarted = nativeClock.now()
      repeatedResponsiveness.markContinuation()
      fixtureGeneration = 'native-repeat-' + repetition
      await active.sync.resnapshot('catalog')
      const elapsedMilliseconds = nativeClock.now() - repeatedStarted
      const repeatedFrameMeasurement = repeatedFrames.stop()
      const repeatedResponsivenessMeasurement = repeatedResponsiveness.stop()
      stopActiveObservers = () => undefined
      completedMeasurements.push({
        operation: `repeat${repetition}/install`,
        elapsedMilliseconds,
        frameMeasurement: repeatedFrameMeasurement,
        responsivenessMeasurement: checkpointResponsiveness(
          repeatedResponsivenessMeasurement,
        ),
      })
      const repeatedMeasurement = {
        elapsedMilliseconds,
        frameMeasurement: repeatedFrameMeasurement,
        responsivenessMeasurement: repeatedResponsivenessMeasurement,
      }
      repeatedImports.push(repeatedMeasurement)
      await checkpoint(`repeat${repetition}/witness`, completedMeasurements)
      const repeatedWitness = await verifyPendingCatalog(active, expected)
      sdkRollbackBaseline = repeatedWitness
      Object.assign(repeatedMeasurement, repeatedWitness)
      await checkpoint(`repeat${repetition}/checkpoint`, completedMeasurements)
      const repeatedCheckpointStarted = nativeClock.now()
      await active.storage.owner.checkpoint()
      const repeatedCheckpointMilliseconds =
        nativeClock.now() - repeatedCheckpointStarted
      const files = await physicalStorage()
      Object.assign(repeatedMeasurement, {
        checkpointMilliseconds: repeatedCheckpointMilliseconds,
        walAfterCheckpointBytes: files.sample.walBytes,
        databaseBytes: files.sample.databaseBytes,
      })
      completedMeasurements.push({
        operation: `repeat${repetition}/checkpoint`,
        elapsedMilliseconds: repeatedCheckpointMilliseconds,
      })
    }
    Object.assign(partialMeasurement, { repeatedImports })
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
      canonicalJson(referenceWitness) === canonicalJson(afterInvalidReference)
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
        referenceBaseline: referenceWitness,
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
        ...comparison?.client('largeHTTP', () =>
          large?.storage.memoryCache.reduceToCurrentBudget(),
        ),
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
    const largeMount = await mountQuery(
      large,
      large.query('Item').orderBy('id').take(25),
    )
    mounted = largeMount
    const largeBaselineMemoryBytes = heapBytes()
    resetNativeHttpStages()
    resetDigestMeasurements()
    await checkpoint('largeHTTP/resnapshot', completedMeasurements)
    await interactionPhase('large-http')
    const largeResponsiveness = await monitorApplicationResponsiveness()
    const largeFrames = monitorAnimationFrames(frameBudgetMilliseconds)
    stopActiveObservers = () => {
      largeResponsiveness.stop()
      largeFrames.stop()
    }
    const diagnosticLargeCallingThreadCpuStarted = comparison
      ? comparison.callingThreadCpu()
      : undefined
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
    try {
      try {
        await large.sync.resnapshot('catalog')
      } finally {
        if (comparison) {
          const finished = comparison.callingThreadCpu()
          Object.assign(
            partialMeasurement.largeHttp as Record<string, unknown>,
            {
              diagnosticCallingThreadCpuMilliseconds:
                finished !== undefined &&
                diagnosticLargeCallingThreadCpuStarted !== undefined &&
                finished >= diagnosticLargeCallingThreadCpuStarted
                  ? finished - diagnosticLargeCallingThreadCpuStarted
                  : null,
            },
          )
        }
      }
    } catch (failure) {
      Object.assign(partialMeasurement.largeHttp as Record<string, unknown>, {
        elapsedMilliseconds: nativeClock.now() - largeStarted,
        frameMeasurement: largeFrames.stop(),
        responsivenessMeasurement: largeResponsiveness.stop(),
        httpStages: nativeHttpStages(),
        phaseMeasurements: largePhaseMeasurements,
        peakMemoryBytes: Math.max(peakMemoryBytes, heapBytes()),
      })
      stopActiveObservers = () => undefined
      throw failure
    }
    const largeElapsed = nativeClock.now() - largeStarted
    const largeFrameMeasurement = largeFrames.stop()
    const largeResponsivenessMeasurement = largeResponsiveness.stop()
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
      remainingResponseAvailabilityMilliseconds:
        nativeHttpStages().find((stage) => stage.phase === 'responseAvailable')!
          .elapsedMilliseconds -
        Number(
          nativeHttpStages()
            .find((stage) => stage.phase === 'responseAvailable')
            ?.serverTiming?.match(/snapshot;dur=([0-9.]+)/)?.[1],
        ),
      remainingResponseAvailabilityBoundary:
        'Complete React Native response availability minus snapshot preparation, including server body streaming, transport, native body buffering and scheduling',
    }
    if (comparison)
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
      synchronizing = comparison
        ? await makeExampleClient(
            syncDatabaseName,
            address,
            backendSchema,
            comparison.client('batchSync', () =>
              synchronizing?.storage.memoryCache.reduceToCurrentBudget(),
            ),
          )
        : await makeExampleClient(syncDatabaseName, address)
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
    const failures: string[] = []
    if (batchSync.error) failures.push(batchSync.error)
    if (maximumJavaScriptWorkMilliseconds > frameBudgetMilliseconds)
      failures.push(
        'The conservative application callback gap exceeded one measured frame',
      )
    if (
      frameMeasurement.estimatedMissedFrames ||
      referenceFrameMeasurement.estimatedMissedFrames ||
      largeFrameMeasurement.estimatedMissedFrames ||
      repeatedImports.some(
        (repeat) => repeat.frameMeasurement.estimatedMissedFrames,
      )
    )
      failures.push(
        'The complete actual rendering intervals contain missed frames',
      )
    if (
      largeResponsivenessMeasurement.maximumCallbackGapMilliseconds >
      frameBudgetMilliseconds
    )
      failures.push(
        'The complete large HTTP application callback gap exceeded one measured frame',
      )
    if (importMilliseconds > 10000)
      failures.push('Import exceeded the 10-second budget')
    if (coldReadMilliseconds > 100 || warmReadMilliseconds > 50)
      failures.push('Indexed reads exceeded their budgets')
    if (databaseSize > 32 * 1024 ** 2)
      failures.push('Fixture database exceeded 32 MiB')
    if (peakMemoryBytes > memoryBudgetBytes)
      failures.push('Hermes heap growth exceeded 128 MiB')
    if (failures.length) throw new Error(failures.join('. '))
    return {
      platform: Platform.OS,
      hermes: true,
      status: 'passed',
      checks,
      startedAt,
      finishedAt: new Date().toISOString(),
    }
  } catch (failure) {
    try {
      if (
        failure instanceof SynloquentError &&
        failure.code === 'snapshot_admission_required' &&
        failure.details.reason === 'memory-pressure'
      ) {
        const budget = failure.details.memoryBudget
        const context =
          typeof budget === 'object' && budget !== null
            ? (budget as Readonly<Record<string, unknown>>)
            : undefined
        partialMeasurement.snapshotAdmissionFailure = {
          diagnosticOnly: true,
          code: failure.code,
          reason: 'memory-pressure',
          memoryBudgetContextAvailable: Boolean(context),
          memoryBudget: context
            ? Object.fromEntries(
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
                  return [
                    field,
                    field === 'level' || field === 'reason'
                      ? typeof value === 'string'
                        ? value.slice(0, 64)
                        : null
                      : typeof value === 'number' && Number.isFinite(value)
                        ? value
                        : null,
                  ]
                }),
              )
            : null,
        }
      }
    } catch {
      // Diagnostic context cannot replace the original failure.
    }
    return {
      platform: Platform.OS,
      hermes: Boolean(
        (globalThis as typeof globalThis & { HermesInternal?: unknown })
          .HermesInternal,
      ),
      status: 'failed',
      checks,
      error: String(failure),
      startedAt,
      finishedAt: new Date().toISOString(),
    }
  } finally {
    try {
      if (comparison) await comparison.close()
    } finally {
      try {
        stopActiveObservers()
        await interactionPhase('inactive').catch(() => undefined)
        clearInterval(memoryTimer)
        await mounted?.unmount()
        await reference?.close()
        await large?.close()
        await active?.close()
        await synchronizing?.close()
        deleteDatabase(referenceDatabaseName)
        deleteDatabase(largeDatabaseName)
        deleteDatabase(databaseName)
        deleteDatabase(syncDatabaseName)
      } finally {
        try {
          await fixtureSource?.close()
        } finally {
          if (comparison)
            partialMeasurement.memoryComparison = comparison.report()
        }
      }
    }
  }
}

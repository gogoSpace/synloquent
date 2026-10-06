import type { SnapshotPhase } from '@synloquent/client'
import type { NativeSpikeResult } from '../../../packages/client/tests/native/driver-spike'
import type {
  digestMeasurements,
  monitorAnimationFrames,
  ResponsivenessMeasurement,
} from './platform'
import type { CalibrationDirectHeapObservation } from './nativeCalibrationHeap'
import type { CalibrationHttpStageObservation } from './nativeCalibrationHttpStages'
import type { NativeHttpStageDiagnostics } from './httpTransport'

export type CalibrationPurpose =
  'canonical-fullrun' | 'calibration-pilot' | 'calibration-confirmatory'
export type CalibrationOrder = 'A' | 'B'
export type CalibrationArm = 'sdk' | 'reference'
export type CalibrationStratum = 'cold' | 'warm1' | 'warm2'
export interface CalibrationProvenance {
  readonly candidateFingerprint: string
  readonly runtimeFingerprint: string
  readonly packageArchiveSha256: string
  readonly packageInventorySha256: string
  readonly sourceInventorySha256: string
  readonly buildProvenanceSha256: string
  readonly releaseBundleSha256: string
  readonly fixtureFingerprint: string
  readonly profileSha256: string
  readonly protocolSha256: string
  readonly methodApprovalSha256: string
  readonly device: {
    readonly identity: string
    readonly operatingSystem: string
    readonly kind: 'physical' | 'simulator' | 'emulator'
  }
  readonly sqliteDriver: {
    readonly name: string
    readonly version: string
    readonly sourceSha256: string
  }
  readonly profile: 'fixed-conservative-paired-v2'
  readonly release: true
  readonly hermes: true
}
export type CalibrationAuthorization =
  | { readonly kind: 'canonical-contract'; readonly contractCoreSha256: string }
  | { readonly kind: 'locked-calibration-plan'; readonly planSha256: string }
export interface CalibrationRequest {
  readonly sessionName: string
  readonly authorization: CalibrationAuthorization
  readonly purpose: CalibrationPurpose
  readonly order: CalibrationOrder
  readonly trial: number
  readonly seriesLength: 1 | 4 | 6 | 10
  readonly provenance: CalibrationProvenance
  /** These are command-owned provenance inputs, never app-derived acceptance. */
  readonly externalCorrectnessEvidence: {
    readonly recoverySha256: string
    readonly staleSessionSha256: string
    readonly atomicitySha256: string
    readonly pendingClosureSha256: string
  }
}
export interface CalibrationClockPoint {
  readonly applicationMonotonicMilliseconds: number
  readonly callingThreadCpuMilliseconds: number
  readonly hermesUsedHeapBytes: number
}
export interface CalibrationInterval {
  readonly start: CalibrationClockPoint
  readonly end: CalibrationClockPoint
  readonly wallMilliseconds: number
  readonly callingThreadCpuMilliseconds: number
  readonly cpuBoundary: 'same calling JavaScript thread across awaits, includes intervening work on that thread'
}
export interface CalibrationSqlCounters {
  readonly statements: number
  readonly rejectedStatements: number
  readonly transactions: number
  readonly checkpoints: number
  readonly rejectedCheckpoints: number
  readonly vacuumStatements: number
  readonly rejectedVacuumStatements: number
  readonly maximumParameters: number
  readonly maximumBindingBytes: number
  readonly maximumReturnedRows: number
  readonly maximumActivationPageRows: number
  readonly activationPageStatements: number
  readonly maximumModelInsertRows: number
  readonly actualDriverParameterLimit: number
  readonly nativeSettledStatements: number
  readonly nativeCheckpointStatements: number
  readonly sourceStatements: number
  readonly rejectedSourceStatements: number
  readonly maximumSourceParameters: number
  readonly maximumSourceBindingBytes: number
  readonly maximumSourceReturnedRows: number
  readonly statementCategories: Readonly<Record<string, number>>
}
export interface CalibrationUiWindow {
  readonly correlationSchema: 2
  readonly strictCorrelation: true
  readonly phase: string
  readonly probeIdentity: string
  readonly receiptPath: string
  readonly firstReceiptExclusive: number
  readonly lastReceiptInclusive: number
  readonly firstReceiptByteExclusive: number
  readonly lastReceiptByteInclusive: number
  readonly inputEvents: number
  readonly scrollEvents: number
  readonly mountedQueryKey: string
  readonly mountedDatabaseName: string
  readonly maximumFromCompleteJsonl: 'host validator must project this exact receipt window'
  readonly latencyClock: 'host admission to original host callback receipt, no subtraction from application clocks'
}
export interface CalibrationPhaseInterval {
  readonly phase:
    SnapshotPhase | 'checkpoint' | 'maintenance' | 'commit-and-reclaim'
  readonly start: CalibrationClockPoint
  readonly end: CalibrationClockPoint
  readonly wallMilliseconds: number
  readonly callingThreadCpuMilliseconds: number
  readonly inclusive: true
  readonly parent: string | null
}
export interface CalibrationArmReceipt {
  readonly arm: CalibrationArm
  readonly stratum: CalibrationStratum
  readonly generation: string
  readonly cursor: string
  readonly scopeJson: string
  readonly sessionJson: string
  readonly partition: string
  readonly pendingBeforeJson: string
  readonly fullWitnessJson: string
  readonly source: {
    readonly rawHash: string
    readonly rawBytes: number
    readonly records: 117115
    readonly relationSets: 100
    readonly targets: 300
    readonly partInventoryHash: string
  }
  readonly outsideArmSqlSnapshot: CalibrationSqlCounters
  readonly outsideArmSqlWindow: 'before this arm reset, includes previous oracle when warm, never summed as an exclusive phase'
  readonly ingestionTotal: CalibrationInterval
  readonly publicCall: CalibrationInterval
  readonly initialDispatchMilliseconds: number
  readonly checkpoint: CalibrationInterval
  readonly maintenance: CalibrationInterval
  readonly oracle: CalibrationInterval
  readonly sourceViewCloseIncluded: true
  readonly reclaimRequested: true
  readonly checkpointSettled: true
  readonly freelistPages: 0
  readonly databaseBytes: number
  readonly fileMeasurement: unknown
  readonly sql: CalibrationSqlCounters
  readonly caps: {
    readonly rows: 16
    readonly bindingBytes: 16384
    readonly hashUnits: 16384
    readonly partBytes: 65536
  }
  readonly actualPolicy: {
    readonly level: 'conservative'
    readonly reason: 'startup'
    readonly nativeSampleAttempts: 0
  }
  readonly phases: readonly CalibrationPhaseInterval[]
  readonly frameMonitorId: number
  readonly frameMeasurement: ReturnType<
    ReturnType<typeof monitorAnimationFrames>['stop']
  >
  readonly responsivenessMeasurement: ResponsivenessMeasurement
  readonly digestMeasurement: ReturnType<typeof digestMeasurements>
  readonly hashCapacityEvidence: {
    readonly actualConfiguredHashUnits: 16384
    readonly enforcedBy: 'public native crypto maximumBufferedUnits callback and source hash pieces'
    readonly measuredBufferedUnits: null
    readonly legacyInstrumentationCeiling: 65536
    readonly referenceMaximumYieldedPieceUnits: number | null
  }
  readonly ui: CalibrationUiWindow
}
export interface CalibrationPairReceipt {
  readonly stratum: CalibrationStratum
  readonly order: CalibrationOrder
  readonly sdk: CalibrationArmReceipt
  readonly reference: CalibrationArmReceipt
  readonly fullWitnessEqual: true
  readonly pendingBeforeEqual: true
  readonly sourceAndScopeEqual: true
}
export interface CalibrationNegativeControl {
  readonly kind: 'synchronous-checksum' | 'awaited-timer'
  readonly interval: CalibrationInterval
  readonly checksum: number
  readonly iterations: number
  readonly readinessActionId: number
  readonly completionActionId: number
  readonly frameMonitorId: number
  readonly frameMeasurement: ReturnType<
    ReturnType<typeof monitorAnimationFrames>['stop']
  >
  readonly responsivenessMeasurement: ResponsivenessMeasurement
  readonly ui: CalibrationUiWindow
  readonly outsideMeasuredArms: true
  readonly validation: 'host must prove meaningful CPU blocking and separate low-CPU awaited behavior'
}
export interface CalibrationSnapshotAdmissionFailure {
  readonly diagnosticOnly: true
  readonly acceptedCandidate: false
  readonly code: 'snapshot_admission_required'
  readonly reason: 'memory-pressure'
  readonly memoryBudgetContextAvailable: boolean
  readonly memoryBudget: {
    readonly level: 'reduced' | 'conservative' | 'normal' | null
    readonly reason:
      | 'startup'
      | 'pressure'
      | 'low_headroom'
      | 'unknown'
      | 'invalid_observation'
      | 'invalid_clock'
      | 'stale'
      | 'recovery'
      | 'fresh'
      | 'closed'
      | null
    readonly maximumBatchRows: number | null
    readonly maximumBindingBytes: number | null
    readonly maximumHashBufferUnits: number | null
    readonly maximumCacheBytes: number | null
    readonly maximumCacheEntries: number | null
    readonly maximumPrefetchConcurrency: number | null
    readonly maximumSnapshotConcurrency: number | null
    readonly maximumSnapshotResponseBytes: number | null
  } | null
}
export interface CalibrationTrialReceipt {
  readonly schema: 'synloquent-native-performance'
  readonly schemaVersion: 2
  readonly contractVersion: 2
  readonly purpose: CalibrationPurpose
  readonly excludedFromAcceptance: boolean
  readonly profile: 'fixed-conservative-paired-v2'
  readonly order: CalibrationOrder
  readonly trial: number
  readonly seriesLength: 1 | 4 | 6 | 10
  readonly provenance: CalibrationProvenance
  readonly sessionName: string
  readonly authorization: CalibrationAuthorization
  readonly operational: {
    status: 'incomplete' | 'complete' | 'failed'
    error?: string
    snapshotAdmissionFailure?: CalibrationSnapshotAdmissionFailure
    cleanupFailures: string[]
    cleanupComplete: boolean
  }
  readonly correctness: {
    status: 'incomplete' | 'complete'
    originalLogicalDuties: readonly string[]
    completedLogicalDuties: string[]
    externalEvidence: CalibrationRequest['externalCorrectnessEvidence']
  }
  readonly numericAcceptance: {
    readonly status: 'not-evaluated'
    readonly authority: 'separately approved pure host contract selector and numeric checker'
  }
  readonly pairs: CalibrationPairReceipt[]
  readonly controls: CalibrationNegativeControl[]
  readonly orderedCheckpointManifest: readonly {
    readonly sequence: number
    readonly operation: string
    readonly legacyLogicalDuties: readonly string[]
  }[]
  readonly memory: {
    cadenceObservation: {
      readonly estimator: 'median of 31 consecutive intervals from 32 original RAF callbacks'
      readonly originalRafTimestamps: readonly number[]
      readonly frameBudgetMilliseconds: number
    } | null
    baseline: CalibrationClockPoint | null
    nativeBaselineResidentBytes: number | null
    nativeBaselineAcknowledgement: {
      readonly sessionName: string
      readonly candidateFingerprint: string
      readonly rssSampleSequence: number
      readonly rssRawPath: string
      readonly processIdentitySha256: string
      readonly sampledExactProcess: true
    } | null
    directReadObservation: CalibrationDirectHeapObservation
    nativeHttpStageObservation: CalibrationHttpStageObservation
    nativeHttpStageHeapObservation: {
      readonly sourceWindow: 'original large HTTP stage reset through owned transport close'
      readonly diagnostics: NativeHttpStageDiagnostics
    } | null
    peakHermesUsedHeapBytes: number
    samplingPeriodMilliseconds: 25
    samples: number
    firstSampleMilliseconds: number | null
    lastSampleMilliseconds: number | null
    maximumSampleGapMilliseconds: number
    wholePrefixture: true
    nativeResidencyAuthority: 'all original runner RSS samples with exact PID and prefixture baseline'
    nativeRawSamplesPath: string | null
  }
  readonly taskDisk: {
    readonly policy: 'all task-owned input, target, reference, HTTP and batch main/WAL/SHM files, no subtraction'
    readonly databaseNames: readonly string[]
    registrations: {
      readonly name: string
      readonly path: string
      readonly origin:
        | 'fixture adapter PRAGMA database_list'
        | 'client owner.read PRAGMA database_list'
    }[]
    snapshots: unknown[]
  }
  readonly duties: Record<string, unknown>
}
export type CalibrationTrialResult = NativeSpikeResult & {
  readonly schema: 'synloquent-native-performance'
  readonly schemaVersion: 2
  readonly contractVersion: 2
  readonly purpose: CalibrationPurpose
  readonly excludedFromAcceptance: boolean
  readonly pairedTrial: CalibrationTrialReceipt
}

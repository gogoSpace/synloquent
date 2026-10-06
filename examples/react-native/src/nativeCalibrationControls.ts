import { calibrationHostBinding } from './nativeCalibrationHost'
import type { CalibrationRequest } from './nativeCalibrationReceipts'
import { monitorCalibrationAnimationFrames as monitorAnimationFrames } from './nativeCalibrationAnimationFrames'
import {
  calibrationInterval,
  calibrationPoint,
  calibrationProbeIdentity,
  calibrationUiReport,
  calibrationUiWindow,
} from './nativeCalibrationEvidence'
import { interactionPhase } from './nativeInteraction'
import {
  monitorApplicationResponsiveness,
  setApplicationWorkPhase,
} from './platform'
import type { CalibrationNegativeControl } from './nativeCalibrationReceipts'

/** Fixed work and consumed output, never a loop until a desired measurement. */
export async function runCalibrationNegativeControl(
  kind: CalibrationNegativeControl['kind'],
  cadence: number,
  mountedQueryKey: string,
  request: CalibrationRequest,
  mountedDatabaseName: string,
  recordCleanupFailure: (resource: string, failure: unknown) => void,
): Promise<CalibrationNegativeControl> {
  const before = await calibrationUiReport()
  await interactionPhase('idle')
  const probe = await calibrationProbeIdentity()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 2000)
  let readinessActionId: number
  try {
    const response = await fetch(
      'http://127.0.0.1:8767/diagnostic/calibration/control-ready',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...calibrationHostBinding(request),
          kind,
          phase: 'idle',
          probeIdentity: probe,
        }),
        signal: controller.signal,
      },
    )
    const ready: {
      accepted?: boolean
      correlationSchema?: number
      actionId?: number
      commandStarted?: boolean
      phase?: string
      probeIdentity?: string
    } = await response.json()
    if (
      !response.ok ||
      ready.accepted !== true ||
      ready.correlationSchema !== 2 ||
      !Number.isSafeInteger(ready.actionId) ||
      ready.actionId! < 1 ||
      ready.commandStarted !== true ||
      ready.phase !== 'idle' ||
      ready.probeIdentity !== probe
    )
      throw new Error(
        'Independent UI negative control lacks a real armed physical action.',
      )
    readinessActionId = ready.actionId!
  } finally {
    clearTimeout(timeout)
  }
  setApplicationWorkPhase(kind)
  let responsiveness:
    Awaited<ReturnType<typeof monitorApplicationResponsiveness>> | undefined
  let frames: ReturnType<typeof monitorAnimationFrames> | undefined
  let beginning!: ReturnType<typeof calibrationPoint>
  let iterations!: number
  let checksum!: number
  let ending!: ReturnType<typeof calibrationPoint>
  let frameMeasurement!: ReturnType<
    ReturnType<typeof monitorAnimationFrames>['stop']
  >
  let responsivenessMeasurement!: ReturnType<
    Awaited<ReturnType<typeof monitorApplicationResponsiveness>>['stop']
  >
  let operationFailed = false
  let operationFailure: unknown
  try {
    responsiveness = await monitorApplicationResponsiveness()
    frames = monitorAnimationFrames(cadence)
    beginning = calibrationPoint()
    iterations = kind === 'synchronous-checksum' ? 4194304 : 0
    checksum = 2166136261
    responsiveness.markContinuation()
    if (kind === 'synchronous-checksum') {
      for (let index = 0; index < iterations; index += 1)
        checksum = Math.imul(checksum ^ index, 16777619) >>> 0
    } else {
      await new Promise<void>((resolve) => setTimeout(resolve, 1000))
      checksum = (checksum ^ iterations) >>> 0
    }
    ending = calibrationPoint()
  } catch (failure) {
    operationFailed = true
    operationFailure = failure
  } finally {
    for (const [resource, stop] of [
      [
        'control ' + kind + ' RAF',
        () => {
          if (frames) frameMeasurement = frames.stop()
        },
      ],
      [
        'control ' + kind + ' responsiveness',
        () => {
          if (responsiveness) responsivenessMeasurement = responsiveness.stop()
        },
      ],
    ] as const) {
      try {
        stop()
      } catch (failure) {
        recordCleanupFailure(resource, failure)
        if (!operationFailed) {
          operationFailed = true
          operationFailure = failure
        }
      }
    }
  }
  if (operationFailed) throw operationFailure
  const completionController = new AbortController()
  const completionTimeout = setTimeout(() => completionController.abort(), 2000)
  let completionActionId: number
  try {
    const response = await fetch(
      'http://127.0.0.1:8767/diagnostic/calibration/control-complete',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...calibrationHostBinding(request),
          kind,
          phase: 'idle',
          probeIdentity: probe,
          readinessActionId,
        }),
        signal: completionController.signal,
      },
    )
    const complete: {
      accepted?: boolean
      correlationSchema?: number
      readinessActionId?: number
      completionActionId?: number
      phase?: string
      probeIdentity?: string
      inputCompleted?: boolean
      scrollCompleted?: boolean
      unresolvedAction?: null | object
    } = await response.json()
    if (
      !response.ok ||
      complete.accepted !== true ||
      complete.correlationSchema !== 2 ||
      complete.readinessActionId !== readinessActionId ||
      !Number.isSafeInteger(complete.completionActionId) ||
      complete.completionActionId! < readinessActionId ||
      complete.phase !== 'idle' ||
      complete.probeIdentity !== probe ||
      complete.inputCompleted !== true ||
      complete.scrollCompleted !== true ||
      complete.unresolvedAction !== null
    )
      throw new Error(
        'Independent control has not actually completed strict input and scroll.',
      )
    completionActionId = complete.completionActionId!
  } finally {
    clearTimeout(completionTimeout)
  }
  await interactionPhase('between-imports')
  const after = await calibrationUiReport()
  return {
    kind,
    interval: calibrationInterval(beginning, ending),
    checksum,
    iterations,
    readinessActionId,
    completionActionId,
    frameMonitorId: frames!.monitorId,
    frameMeasurement,
    responsivenessMeasurement,
    ui: calibrationUiWindow(
      before,
      after,
      'idle',
      probe,
      mountedQueryKey,
      mountedDatabaseName,
    ),
    outsideMeasuredArms: true,
    validation:
      'host must prove meaningful CPU blocking and separate low-CPU awaited behavior',
  }
}

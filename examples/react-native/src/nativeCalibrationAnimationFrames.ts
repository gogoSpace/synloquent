import {
  monitorAnimationFrames,
  type NativeAnimationFramePoint,
} from './platform'
import { calibrationHostBinding } from './nativeCalibrationHost'
import { calibrationUtf8Length } from './nativeCalibrationSource'
import type { CalibrationRequest } from './nativeCalibrationReceipts'

interface CalibrationFrameSample extends NativeAnimationFramePoint {
  readonly monitor: number
}
let active: { observe(sample: CalibrationFrameSample): void } | undefined
let nextMonitor = 0

export function monitorCalibrationAnimationFrames(
  frameBudgetMilliseconds: number,
) {
  if (!active)
    throw new Error(
      'Calibration raw RAF stream has not acquired its single owner.',
    )
  const owner = active
  const monitor = ++nextMonitor
  const original = monitorAnimationFrames(frameBudgetMilliseconds, (sample) =>
    owner.observe({ monitor, ...sample }),
  )
  let settled: ReturnType<typeof original.stop> | undefined
  return {
    monitorId: monitor,
    stop() {
      settled ??= original.stop()
      return settled
    },
  }
}

/** One in-flight batch and one accumulating batch of 64 scalar points. */
export function beginCalibrationFrameSamples(request: CalibrationRequest) {
  if (active)
    throw new Error('Calibration raw RAF stream already has an owner.')
  nextMonitor = 0
  let batch: CalibrationFrameSample[] = []
  let pending: Promise<void> | undefined
  let failure: unknown
  let sequence = 0
  let available = true
  const flush = () => {
    if (pending || !batch.length || failure) return
    const own = batch
    batch = []
    const ownSequence = ++sequence
    pending = (async () => {
      const body = JSON.stringify({
        ...calibrationHostBinding(request),
        sequence: ownSequence,
        samples: own,
      })
      if (calibrationUtf8Length(body) > 65536)
        throw new Error('Raw RAF batch exceeds its bounded 64 KiB envelope.')
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 2000)
      try {
        const response = await fetch(
          'http://127.0.0.1:8767/diagnostic/calibration/raf-samples',
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
          throw new Error('Raw calibration RAF samples were not acknowledged.')
      } finally {
        clearTimeout(timeout)
      }
    })()
      .catch((error: unknown) => {
        failure ??= error
      })
      .finally(() => {
        pending = undefined
      })
  }
  const owner = {
    observe(sample: CalibrationFrameSample) {
      try {
        if (!available)
          throw new Error(
            'A RAF callback belongs to a closed calibration stream.',
          )
        if (
          !Number.isSafeInteger(sample.monitor) ||
          sample.monitor < 1 ||
          !['begin', 'callback', 'stop'].includes(sample.edge) ||
          !Number.isFinite(sample.milliseconds) ||
          sample.milliseconds < 0 ||
          !Number.isFinite(sample.frameBudgetMilliseconds) ||
          sample.frameBudgetMilliseconds <= 0
        )
          throw new Error('Raw calibration RAF point is invalid.')
        if (failure) return
        if (batch.length >= 64)
          throw new Error('Bounded raw RAF sample transport overflowed.')
        batch.push(sample)
        if (batch.length === 64) flush()
      } catch (error) {
        failure ??= error
      }
    },
  }
  active = owner
  return {
    async close() {
      available = false
      if (active === owner) active = undefined
      await pending
      flush()
      await pending
      if (failure) throw failure
    },
  }
}

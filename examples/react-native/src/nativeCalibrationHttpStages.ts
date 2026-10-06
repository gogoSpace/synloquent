import {
  observeNativeHttpStages,
  type NativeHttpStageEvent,
} from './httpTransport'
import { calibrationHostBinding } from './nativeCalibrationHost'
import { calibrationUtf8Length } from './nativeCalibrationSource'
import type { CalibrationRequest } from './nativeCalibrationReceipts'

export interface CalibrationHttpStageObservation {
  observedEvents: number
  acknowledgedEvents: number
  batches: number
  maximumBodyBytes: number
}
interface CalibrationHttpStageRecord {
  readonly ordinal: number
  readonly stage: NativeHttpStageEvent
}

/** Existing scalar stage values, with no additional clock, heap or request read. */
export function beginCalibrationHttpStageSamples(
  request: CalibrationRequest,
  observation: CalibrationHttpStageObservation,
) {
  const binding = calibrationHostBinding(request)
  const envelopeBytes = calibrationUtf8Length(
    JSON.stringify({
      ...binding,
      sequence: Number.MAX_SAFE_INTEGER,
      events: [],
    }),
  )
  let batch: CalibrationHttpStageRecord[] = []
  let eventBytes = 0
  let pending: Promise<void> | undefined
  let failure: unknown
  let sequence = 0
  const flush = () => {
    if (pending || !batch.length || failure) return
    const events = batch
    batch = []
    eventBytes = 0
    const ownSequence = ++sequence
    pending = (async () => {
      const body = JSON.stringify({ ...binding, sequence: ownSequence, events })
      const bytes = calibrationUtf8Length(body)
      if (bytes > 65536)
        throw new Error(
          'Original HTTP stage batch exceeds the bounded 64 KiB envelope.',
        )
      observation.maximumBodyBytes = Math.max(
        observation.maximumBodyBytes,
        bytes,
      )
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 2000)
      try {
        const response = await fetch(
          'http://127.0.0.1:8767/diagnostic/calibration/native-http-stages',
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
            'Original native HTTP stages were not actually acknowledged.',
          )
        observation.acknowledgedEvents += events.length
        observation.batches += 1
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
  const unsubscribe = observeNativeHttpStages((stage) => {
    try {
      observation.observedEvents += 1
      if (failure) return
      if (
        typeof stage.kind !== 'string' ||
        !stage.kind ||
        ![
          'responseAvailable',
          'responseText',
          'jsonDecode',
          'shapeValidation',
        ].includes(stage.phase) ||
        !Number.isFinite(stage.elapsedMilliseconds) ||
        stage.elapsedMilliseconds < 0 ||
        (stage.maximumWorkSliceMilliseconds !== undefined &&
          (!Number.isFinite(stage.maximumWorkSliceMilliseconds) ||
            stage.maximumWorkSliceMilliseconds < 0)) ||
        (stage.responseCharacters !== undefined &&
          (!Number.isSafeInteger(stage.responseCharacters) ||
            stage.responseCharacters < 0))
      )
        throw new Error('Original HTTP stage scalar is invalid.')
      const event = { ordinal: observation.observedEvents, stage }
      const bytes = calibrationUtf8Length(JSON.stringify(event))
      if (envelopeBytes + bytes > 65536)
        throw new Error(
          'An original HTTP stage exceeds the bounded raw envelope.',
        )
      if (
        batch.length === 128 ||
        envelopeBytes + eventBytes + bytes + batch.length > 65536
      )
        flush()
      if (
        batch.length === 128 ||
        envelopeBytes + eventBytes + bytes + batch.length > 65536
      )
        throw new Error('Bounded original HTTP stage transport overflowed.')
      batch.push(event)
      eventBytes += bytes
      if (batch.length === 128) flush()
    } catch (error) {
      failure ??= error
    }
  })
  return {
    async close() {
      unsubscribe()
      await pending
      flush()
      await pending
      if (failure) throw failure
      if (observation.observedEvents !== observation.acknowledgedEvents)
        throw new Error('Original HTTP stage stream is incomplete.')
    },
  }
}

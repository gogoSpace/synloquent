export interface CalibrationDirectHeapObservation {
  readonly source: 'same existing calibrationPoint and heapBytes getter values, no additional heap or clock read'
  reads: number
  validReads: number
  unavailableReads: number
  maximumBytes: number | null
}

const observation = {
  current: undefined as CalibrationDirectHeapObservation | undefined,
}

export function beginCalibrationDirectHeapObservation(
  value: CalibrationDirectHeapObservation,
): () => void {
  if (observation.current)
    throw new Error('Only one paired trial may own direct Hermes observations.')
  observation.current = value
  return () => {
    if (observation.current === value) observation.current = undefined
  }
}

export function observeCalibrationHeapValue(value: unknown): void {
  const current = observation.current
  if (!current) return
  current.reads += 1
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    current.unavailableReads += 1
    return
  }
  current.validReads += 1
  current.maximumBytes = Math.max(current.maximumBytes ?? value, value)
}

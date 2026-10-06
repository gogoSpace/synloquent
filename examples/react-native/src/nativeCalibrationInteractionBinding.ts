export interface CalibrationInteractionBinding {
  readonly measurementSchemaVersion: 2
  readonly sessionName: string
}
let binding: CalibrationInteractionBinding | undefined

export function configureCalibrationInteractionBinding(
  value: CalibrationInteractionBinding,
): void {
  if (
    value.measurementSchemaVersion !== 2 ||
    !/^synloquent-native-(ios|android)-[A-Za-z0-9-]{1,128}$/.test(
      value.sessionName,
    )
  )
    throw new Error('Unknown immutable calibration interaction configuration.')
  if (
    binding &&
    (binding.measurementSchemaVersion !== value.measurementSchemaVersion ||
      binding.sessionName !== value.sessionName)
  )
    throw new Error(
      'Calibration interaction session cannot change after configuration.',
    )
  binding = Object.freeze({
    measurementSchemaVersion: 2,
    sessionName: value.sessionName,
  })
}

export function calibrationInteractionBinding():
  CalibrationInteractionBinding | undefined {
  return binding
}

import type { MountQuery } from './nativeQualification'
import { runNativeCalibration } from './nativeCalibration'
import { validateCalibrationRequest } from './nativeCalibrationEvidence'
import type {
  CalibrationRequest,
  CalibrationTrialResult,
} from './nativeCalibrationReceipts'

/** Separate schema2 entry, never an optional flag in the original v1 producer. */
export async function runNativePerformanceV2(
  address: string,
  mountQuery: MountQuery,
  progress: (message: string) => void,
  largeAddress: string,
  request: CalibrationRequest,
): Promise<CalibrationTrialResult> {
  validateCalibrationRequest(request)
  return runNativeCalibration(
    address,
    mountQuery,
    progress,
    largeAddress,
    request,
  )
}

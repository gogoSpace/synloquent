import type { CalibrationRequest } from './nativeCalibrationReceipts'

export function calibrationHostBinding(request: CalibrationRequest) {
  return {
    ...request.provenance,
    sessionName: request.sessionName,
    authorization: request.authorization,
    schemaVersion: 2 as const,
    purpose: request.purpose,
    order: request.order,
    trial: request.trial,
    seriesLength: request.seriesLength,
    candidateFingerprint: request.provenance.candidateFingerprint,
    runtimeFingerprint: request.provenance.runtimeFingerprint,
    packageArchiveSha256: request.provenance.packageArchiveSha256,
    profileSha256: request.provenance.profileSha256,
    fixtureFingerprint: request.provenance.fixtureFingerprint,
  }
}

import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { userInfo } from 'node:os'
import { dirname, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { createNetworkComparisonProxy } from './network-proxy.mjs'
import { createCalibrationNetworkObserver } from './calibration-network-observer.mjs'
import {
  createNativeCalibrationHostCompanion,
  hydrateCalibrationRequest,
  readCalibrationRequestSpecification,
} from './calibration-host-companion.mjs'

const repositoryDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../..',
)
const exampleDirectory = resolve(repositoryDirectory, 'examples/react-native')
const buildArtifactDirectory = resolve(
  repositoryDirectory,
  '.local/test-results/native',
)
const platform = process.argv[2]
if (!['ios', 'android'].includes(platform))
  throw new Error(
    'Usage: node scripts/native/run.mjs ios|android [--skip-build] [--fingerprint=value]',
  )
const skipBuild = process.argv.includes('--skip-build')
const suite =
  process.argv
    .find((argument) => argument.startsWith('--suite='))
    ?.slice('--suite='.length) ?? 'driver'
if (
  !['driver', 'crypto', 'qualification', 'performance', 'calibration'].includes(
    suite,
  )
)
  throw new Error('Unknown native verification suite.')
const performanceSuite = suite === 'performance' || suite === 'calibration'
const performanceCapableBuild = performanceSuite || suite === 'qualification'
if (suite === 'qualification' && skipBuild)
  throw new Error('Qualification requires an original fresh Release build.')
const measurementSchemaText =
  process.argv
    .find((argument) => argument.startsWith('--measurement-schema-version='))
    ?.slice('--measurement-schema-version='.length) ?? '1'
if (!['1', '2'].includes(measurementSchemaText))
  throw new Error('Unknown measurement schema version.')
const measurementSchemaVersion = Number(measurementSchemaText)
const calibrationSpecPath = process.argv
  .find((argument) => argument.startsWith('--calibration-request-spec-path='))
  ?.slice('--calibration-request-spec-path='.length)
const calibrationSpecSha256 = process.argv
  .find((argument) => argument.startsWith('--calibration-request-spec-sha256='))
  ?.slice('--calibration-request-spec-sha256='.length)
if (
  (suite === 'calibration' && measurementSchemaVersion !== 2) ||
  (measurementSchemaVersion === 2 &&
    (!performanceSuite || !calibrationSpecPath || !calibrationSpecSha256)) ||
  (measurementSchemaVersion === 1 &&
    (calibrationSpecPath || calibrationSpecSha256))
)
  throw new Error(
    'Measurement schema dispatch requires the explicit immutable specification.',
  )
const ownedCalibrationSpecification =
  measurementSchemaVersion === 2
    ? readCalibrationRequestSpecification(
        calibrationSpecPath,
        calibrationSpecSha256,
        platform,
        skipBuild,
      )
    : undefined
if (
  ownedCalibrationSpecification &&
  (suite === 'calibration') !==
    (ownedCalibrationSpecification.specification.purpose !==
      'canonical-fullrun')
)
  throw new Error('Suite and approved request purpose disagree.')
const memoryMode = process.argv
  .find((argument) => argument.startsWith('--memory-mode='))
  ?.slice('--memory-mode='.length)
const networkArm = process.argv
  .find((argument) => argument.startsWith('--network-arm='))
  ?.slice('--network-arm='.length)
const suppliedDiagnosticDirectory = process.argv
  .find((argument) => argument.startsWith('--diagnostic-directory='))
  ?.slice('--diagnostic-directory='.length)
const suppliedNetworkDelay = process.argv
  .find((argument) => argument.startsWith('--network-delay-milliseconds='))
  ?.slice('--network-delay-milliseconds='.length)
const diagnosticOnly = memoryMode !== undefined || networkArm !== undefined
if (measurementSchemaVersion === 2 && diagnosticOnly)
  throw new Error('Schema2 cannot inherit legacy diagnostic overrides.')
if (
  memoryMode !== undefined &&
  !['fixed-conservative', 'adaptive'].includes(memoryMode)
)
  throw new Error('Unknown diagnostic memory mode.')
if (networkArm !== undefined && !['single', 'bundle'].includes(networkArm))
  throw new Error('Unknown diagnostic network arm.')
if (networkArm !== undefined && memoryMode !== 'fixed-conservative')
  throw new Error(
    'Network comparison requires the same fixed conservative budget.',
  )
if (diagnosticOnly && (!performanceSuite || !skipBuild))
  throw new Error(
    'Diagnostics require the complete performance suite and a verified existing build.',
  )
if (
  diagnosticOnly !== (suppliedDiagnosticDirectory !== undefined) ||
  (suppliedNetworkDelay !== undefined && networkArm === undefined)
)
  throw new Error(
    'Diagnostic arguments require their explicit comparison mode and directory.',
  )
const controlledDelayMilliseconds = Number(suppliedNetworkDelay ?? 100)
if (
  !Number.isSafeInteger(controlledDelayMilliseconds) ||
  controlledDelayMilliseconds < 0 ||
  controlledDelayMilliseconds > 1000
)
  throw new Error(
    'Controlled request delay must be between zero and 1000 milliseconds.',
  )
const artifactDirectory = ownedCalibrationSpecification
  ? resolve(
      buildArtifactDirectory,
      'calibration',
      ownedCalibrationSpecification.specification.sessionName,
    )
  : suppliedDiagnosticDirectory
    ? resolve(suppliedDiagnosticDirectory)
    : buildArtifactDirectory
if (ownedCalibrationSpecification && existsSync(artifactDirectory))
  throw new Error('The owned schema2 evidence directory must be fresh.')
if (diagnosticOnly) {
  const diagnosticRoot = resolve(buildArtifactDirectory, 'diagnostics')
  if (!artifactDirectory.startsWith(diagnosticRoot + '/'))
    throw new Error(
      'Diagnostic evidence requires a dedicated directory under native/diagnostics.',
    )
  for (
    let directory = artifactDirectory;
    directory.startsWith(buildArtifactDirectory);
    directory = dirname(directory)
  ) {
    if (existsSync(directory) && lstatSync(directory).isSymbolicLink())
      throw new Error(
        'Diagnostic evidence directories cannot use symbolic links.',
      )
  }
  if (existsSync(artifactDirectory) && readdirSync(artifactDirectory).length)
    throw new Error(
      'Diagnostic evidence directory must be empty to preserve earlier evidence.',
    )
}
const suppliedFingerprint = process.argv
  .find((argument) => argument.startsWith('--fingerprint='))
  ?.slice('--fingerprint='.length)
function fingerprintDirectory(directory, hashing) {
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort(
    (left, right) => left.name.localeCompare(right.name),
  )) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) fingerprintDirectory(path, hashing)
    else if (entry.isFile()) hashing.update(path).update(readFileSync(path))
  }
}
function currentSourceFingerprint() {
  const sourceHash = createHash('sha256')
  for (const path of [
    'App.tsx',
    'backend.generated.ts',
    'package.json',
    'package-lock.json',
    'metro.config.js',
    'android/build.gradle',
    'android/settings.gradle',
    'android/gradle.properties',
    'android/app/build.gradle',
    'android/app/proguard-rules.pro',
    'ios/Podfile',
    'ios/Podfile.lock',
    'ios/SynloquentExample.xcodeproj/project.pbxproj',
    'node_modules/@synloquent/client/package.json',
    'node_modules/@synloquent/client/react-native.config.cjs',
    'node_modules/@synloquent/client/SynloquentNativeCrypto.podspec',
    'node_modules/@synloquent/client/native/android/build.gradle',
  ])
    sourceHash
      .update(path)
      .update(readFileSync(resolve(exampleDirectory, path)))
  for (const path of [
    'src',
    'android/app/src/main',
    'ios/SynloquentExample',
    'ios/SynloquentPerformanceUITests',
    'ios/SynloquentExample.xcodeproj/xcshareddata/xcschemes',
    'node_modules/@synloquent/client/dist',
    'node_modules/@synloquent/client/native/ios',
    'node_modules/@synloquent/client/native/android/src',
    'node_modules/@synloquent/client/src/native-crypto/specs',
  ])
    fingerprintDirectory(resolve(exampleDirectory, path), sourceHash)
  sourceHash.update(
    readFileSync(
      resolve(
        repositoryDirectory,
        'packages/client/tests/native/driver-spike.ts',
      ),
    ),
  )
  return sourceHash.digest('hex')
}
const sourceFingerprint = currentSourceFingerprint()
const candidateFingerprint = suppliedFingerprint ?? sourceFingerprint
if (
  ownedCalibrationSpecification &&
  (ownedCalibrationSpecification.specification.provenance
    .candidateFingerprint !== candidateFingerprint ||
    ownedCalibrationSpecification.specification.provenance
      .runtimeFingerprint !== sourceFingerprint)
)
  throw new Error(
    'Approved command source binding differs from the actual frozen program.',
  )
function instrumentationFingerprint() {
  return Object.fromEntries(
    [
      'scripts/native/run.mjs',
      'scripts/native/network-proxy.mjs',
      ...(measurementSchemaVersion === 2
        ? [
            'scripts/native/calibration-host-companion.mjs',
            'scripts/native/calibration-network-observer.mjs',
            'scripts/native/native-application-observation.py',
          ]
        : []),
    ].map((relative) => [
      relative,
      createHash('sha256')
        .update(readFileSync(resolve(repositoryDirectory, relative)))
        .digest('hex'),
    ]),
  )
}
const diagnosticInstrumentationBefore = diagnosticOnly
  ? instrumentationFingerprint()
  : undefined
const largeFixturePath = resolve(
  repositoryDirectory,
  '.local/native-http-fixture.json',
)
function currentLargeFixtureFingerprint() {
  return existsSync(largeFixturePath)
    ? createHash('sha256').update(readFileSync(largeFixturePath)).digest('hex')
    : undefined
}
const largeHttpFixture = existsSync(largeFixturePath)
  ? {
      fingerprint: currentLargeFixtureFingerprint(),
      configuration: JSON.parse(readFileSync(largeFixturePath, 'utf8')),
    }
  : undefined
const packageArchiveWitness = JSON.parse(
  readFileSync(
    resolve(
      repositoryDirectory,
      '.local/test-results/packages/native-package.json',
    ),
    'utf8',
  ),
)
const sessionStartedAtMilliseconds = Date.now()
const sessionName =
  ownedCalibrationSpecification?.specification.sessionName ??
  `synloquent-native-${platform}-${Date.now()}`
const buildLog = resolve(artifactDirectory, `${platform}-build.log`)
const runtimeLog = resolve(artifactDirectory, `${platform}-runtime-log.txt`)
const collectorLog = resolve(
  artifactDirectory,
  `${platform}-collector-log.jsonl`,
)
const progressCheckpointLog = resolve(
  artifactDirectory,
  `${platform}-${suite}-checkpoints.jsonl`,
)
const sessionPath = resolve(artifactDirectory, `${platform}-session.json`)
const resultPath = resolve(
  artifactDirectory,
  `${platform}-${suite}-result.json`,
)
const buildProvenancePath = resolve(
  buildArtifactDirectory,
  `${platform}-build-provenance.json`,
)
const applicationPath =
  platform === 'android'
    ? resolve(
        exampleDirectory,
        'android/app/build/outputs/apk/release/app-release.apk',
      )
    : resolve(
        buildArtifactDirectory,
        'ios-build/Build/Products/Release-iphonesimulator/SynloquentExample.app',
      )
let buildProvenance
let qualificationBuildFacts
function applicationFingerprint() {
  const hashing = createHash('sha256')
  if (platform === 'android') hashing.update(readFileSync(applicationPath))
  else fingerprintDirectory(applicationPath, hashing)
  return hashing.digest('hex')
}

const ownedProcesses = new Set()
const processIdentities = []
const observedDescendants = new Map()
const applicationIdentifier =
  platform === 'android' ? 'com.synloquent.example' : 'com.synloquent.example'
const androidDirectory = resolve(exampleDirectory, 'android')
const androidSdkDirectory =
  process.env.ANDROID_HOME ?? `${process.env.HOME ?? ''}/Library/Android/sdk`
const androidBridge = resolve(androidSdkDirectory, 'platform-tools/adb')
const emulatorBinary = resolve(androidSdkDirectory, 'emulator/emulator')
const androidDevice = 'emulator-5580'
const simulatorIdentifier =
  process.env.SYNLOQUENT_IOS_SIMULATOR ?? 'C2DCABA3-47AC-489B-A361-4755BC5A3A30'
let ownsEmulator = false
let emulatorProcessIdentifier
const emulatorTemporaryFiles = new Map()
let ownsSimulatorBoot = false
let collector
let networkProxy
let calibrationNetworkObserver
let resultTimeout
let nativeResult
let evidence
let primaryFailure
let nativeStartupConfigurationRequests = 0
let nativeStartupLeaseConsumed = false
let nativeStartupInvocationId = null
let nativeStartupFailure
const cleanupFailures = []
let finishingVerification
let packageBefore
const packageBeforePath = resolve(
  artifactDirectory,
  `${platform}-${suite}-package-before.json`,
)
let calibrationHost
let calibrationObservationCoverage
let calibrationRequest
let calibrationHydration
let nativeApplicationIdentity
let nativeApplicationIdentityFailure
let resolveNativeApplicationIdentity
const nativeApplicationIdentityPromise = new Promise((resolveIdentity) => {
  resolveNativeApplicationIdentity = resolveIdentity
})
let nativeTaskStoragePending
let nativeTaskStorageSequence = 0
let calibrationCommandSequence = 0
let calibrationSamplerClosed = false

async function runCalibrationObservation(
  command,
  argumentsList,
  maximumBytes = 65536,
  legacyObservation,
) {
  const sequence = ++calibrationCommandSequence
  const outputPath = resolve(
    artifactDirectory,
    `${suite === 'qualification' ? sessionName + '-qualification' : legacyObservation === undefined ? 'calibration' : sessionName + '-' + suite + '-legacy'}-command-${sequence}.stdout`,
  )
  const errorPath = resolve(
    artifactDirectory,
    `${suite === 'qualification' ? sessionName + '-qualification' : legacyObservation === undefined ? 'calibration' : sessionName + '-' + suite + '-legacy'}-command-${sequence}.stderr`,
  )
  const observation =
    legacyObservation === undefined
      ? undefined
      : {
          sessionName,
          sequence,
          operation: legacyObservation,
          command,
          stdoutPath: outputPath,
          stderrPath: errorPath,
          dispatchStartedAt: new Date().toISOString(),
          dispatchStartedMonotonicMilliseconds: performance.now(),
        }
  const recordObservation = (event, details = {}) => {
    if (observation)
      appendFileSync(
        buildLog,
        JSON.stringify({
          type: 'legacy-host-observation',
          event,
          ...observation,
          ...details,
        }) + '\n',
      )
  }
  recordObservation('dispatch')
  let observationFailure
  let observationFailed = false
  let observationOutput
  let outputCompletion
  let observationChild
  try {
    writeFileSync(outputPath, '', { flag: 'wx' })
    writeFileSync(errorPath, '', { flag: 'wx' })
    await runCommand(
      command,
      argumentsList,
      {
        exactStdoutPath: outputPath,
        exactStderrPath: errorPath,
        maximumOutputBytes: maximumBytes,
      },
      (processIdentifier) => {
        if (legacyObservation !== undefined) {
          const child = ownedProcessGroups.get(processIdentifier)?.child
          if (!child)
            throw new Error('Exact legacy observation lacks its owned command.')
          observationChild = child
          const completePipe = (stream, name) => {
            if (stream.readableEnded) return Promise.resolve()
            return new Promise((resolveCompletion, rejectCompletion) => {
              const finish = (failure) => {
                stream.removeListener('end', ended)
                stream.removeListener('error', failed)
                stream.removeListener('close', closed)
                if (failure) rejectCompletion(failure)
                else resolveCompletion()
              }
              const ended = () => finish()
              const failed = (failure) => finish(failure)
              const closed = () =>
                finish(
                  stream.readableEnded
                    ? undefined
                    : new Error(
                        'Exact legacy observation ' +
                          name +
                          ' closed before readable completion.',
                      ),
                )
              stream.once('end', ended)
              stream.once('error', failed)
              stream.once('close', closed)
              if (stream.readableEnded) ended()
              else if (stream.destroyed) closed()
            })
          }
          outputCompletion = Promise.all([
            completePipe(child.stdout, 'stdout'),
            completePipe(child.stderr, 'stderr'),
          ])
          outputCompletion.catch(() => undefined)
        }
        recordObservation('post-enrollment', {
          processIdentifier,
          callbackAt: new Date().toISOString(),
          callbackMonotonicMilliseconds: performance.now(),
        })
      },
    )
    if (outputCompletion) await outputCompletion
    if (observationChild?.outputEvidenceFailure)
      throw observationChild.outputEvidenceFailure
    if (statSync(errorPath).size !== 0)
      throw new Error('An exact native observation emitted unknown stderr.')
    observationOutput = readFileSync(outputPath)
  } catch (failure) {
    observationFailure = failure
    observationFailed = true
  }
  try {
    recordObservation('owned-completion', {
      completedAt: new Date().toISOString(),
      completedMonotonicMilliseconds: performance.now(),
      status: observationFailed ? 'failed' : 'completed',
      error: observationFailed
        ? String(observationFailure).slice(0, 4096)
        : null,
      errorCharacters: observationFailed
        ? String(observationFailure).length
        : 0,
      errorTruncated: observationFailed
        ? String(observationFailure).length > 4096
        : false,
      cause: observationFailure?.cause
        ? String(observationFailure.cause).slice(0, 4096)
        : null,
      causeCharacters: observationFailure?.cause
        ? String(observationFailure.cause).length
        : 0,
      causeTruncated: observationFailure?.cause
        ? String(observationFailure.cause).length > 4096
        : false,
    })
  } catch (failure) {
    if (observationFailed) {
      try {
        if (
          observationFailure !== null &&
          (typeof observationFailure === 'object' ||
            typeof observationFailure === 'function') &&
          observationFailure.cause == null
        )
          Reflect.set(observationFailure, 'cause', failure)
      } catch {
        // Preserve the primary failure when diagnostic cause attachment fails.
      }
    } else {
      observationFailure = failure
      observationFailed = true
    }
  }
  if (observationFailed) throw observationFailure
  return observationOutput
}

async function discoverCalibrationBuildFacts(device) {
  const driverDirectory = resolve(
    exampleDirectory,
    'node_modules/@op-engineering/op-sqlite',
  )
  const driverPackage = JSON.parse(
    readFileSync(resolve(driverDirectory, 'package.json'), 'utf8'),
  )
  const driverHash = createHash('sha256')
  fingerprintDirectory(driverDirectory, driverHash)
  let bundleBytes
  if (platform === 'android') {
    const listing = (
      await runCalibrationObservation('/usr/bin/unzip', [
        '-Z',
        '-1',
        applicationPath,
      ])
    )
      .toString('utf8')
      .split('\n')
    const bundles = listing.filter((path) =>
      /^assets\/[A-Za-z0-9._-]+\.bundle$/.test(path),
    )
    if (bundles.length !== 1)
      throw new Error(
        'The actual Release APK has no unique packaged JavaScript bundle.',
      )
    bundleBytes = await runCalibrationObservation(
      '/usr/bin/unzip',
      ['-p', applicationPath, bundles[0]],
      128 * 1024 ** 2,
    )
  } else {
    const bundles = readdirSync(applicationPath).filter((name) =>
      name.endsWith('.jsbundle'),
    )
    if (bundles.length !== 1)
      throw new Error(
        'The actual Release application has no unique JavaScript bundle.',
      )
    const path = resolve(applicationPath, bundles[0])
    if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())
      throw new Error('The Release bundle is not a real built file.')
    bundleBytes = readFileSync(path)
  }
  if (!bundleBytes.length)
    throw new Error('The actual Release bundle bytes are empty.')
  return {
    candidateFingerprint,
    runtimeFingerprint: sourceFingerprint,
    sourceInventorySha256: sourceFingerprint,
    packageArchiveSha256: packageArchiveWitness.sha256,
    packageInventorySha256: packageBefore.inventoryFingerprint,
    buildProvenanceSha256: createHash('sha256')
      .update(readFileSync(buildProvenancePath))
      .digest('hex'),
    releaseBundleSha256: createHash('sha256').update(bundleBytes).digest('hex'),
    fixtureFingerprint: currentLargeFixtureFingerprint(),
    device,
    sqliteDriver: {
      name: driverPackage.name,
      version: driverPackage.version,
      sourceSha256: driverHash.digest('hex'),
    },
    release: buildProvenance.buildMode === 'Release',
    hermes: true,
  }
}

async function initializeCalibrationHost(device) {
  calibrationHydration = hydrateCalibrationRequest(
    ownedCalibrationSpecification,
    await discoverCalibrationBuildFacts(device),
  )
  calibrationRequest = calibrationHydration.request
  writeFileSync(
    resolve(artifactDirectory, 'calibration-request-spec.json'),
    ownedCalibrationSpecification.originalBytes,
    { flag: 'wx' },
  )
  writeFileSync(
    resolve(artifactDirectory, 'calibration-request.json'),
    calibrationHydration.requestBytes,
    { flag: 'wx' },
  )
  writeFileSync(
    resolve(artifactDirectory, 'calibration-request-hydration.json'),
    JSON.stringify(
      {
        specificationSha256: calibrationHydration.specificationSha256,
        requestSha256: calibrationHydration.requestSha256,
        actualBuildProvenancePath: buildProvenancePath,
        freshNormalBuild: !skipBuild,
        applicability:
          ownedCalibrationSpecification.specification.applicability,
      },
      null,
      2,
    ) + '\n',
    { flag: 'wx' },
  )
  calibrationHost = createNativeCalibrationHostCompanion({
    request: calibrationRequest,
    platform,
    artifactDirectory,
    sampleResident: sampleCalibrationResident,
    validateNativePath: registerCalibrationNativePath,
    sampleNativeFiles: sampleCalibrationNativeFiles,
    uiReport,
    fail: rejectNativeResult,
  })
  calibrationNetworkObserver = createCalibrationNetworkObserver({
    sessionName,
    appendRecord: (record) => calibrationHost.appendNetworkRecord(record),
    fail: rejectNativeResult,
  })
}

async function sampleCalibrationResident() {
  if (!nativeApplicationIdentity) {
    let deadlineTimer
    try {
      await Promise.race([
        nativeApplicationIdentityPromise,
        new Promise((_resolveReady, rejectReady) => {
          deadlineTimer = setTimeout(
            () =>
              rejectReady(
                new Error(
                  'Actual native application identity was not available before the bounded prefixture gate.',
                ),
              ),
            1900,
          )
        }),
      ])
    } finally {
      clearTimeout(deadlineTimer)
    }
  }
  if (
    nativeApplicationIdentityFailure ||
    !nativeApplicationIdentity ||
    calibrationSamplerClosed
  )
    throw new Error('Exact native application observation is unavailable.')
  if (platform === 'ios') {
    const bytes = await runCalibrationObservation('python3', [
      resolve(
        repositoryDirectory,
        'scripts/native/native-application-observation.py',
      ),
      '--pid',
      String(nativeApplicationIdentity.pid),
      '--expected-executable',
      nativeApplicationIdentity.executablePath,
      '--owner-reader',
      resolve(repositoryDirectory, 'scripts/native/process-owner-reader.py'),
      '--owner-reader-sha256',
      '8f007ac938f5198a5e82e270305a117c38a438486a570abce219e4f3b3131af8',
    ])
    const sample = JSON.parse(bytes.toString('utf8'))
    if (
      JSON.stringify(sample.processIdentity) !==
      JSON.stringify(nativeApplicationIdentity)
    )
      throw new Error(
        'Original iOS application PID/birth changed during whole RSS coverage.',
      )
    return sample
  }
  const before = await androidCalibrationProcessBirth(
    nativeApplicationIdentity.pid,
  )
  const content = (
    await runCalibrationObservation(androidBridge, [
      '-s',
      androidDevice,
      'shell',
      'dumpsys',
      'meminfo',
      String(nativeApplicationIdentity.pid),
    ])
  ).toString('utf8')
  const after = await androidCalibrationProcessBirth(
    nativeApplicationIdentity.pid,
  )
  if (
    JSON.stringify(before) !== JSON.stringify(nativeApplicationIdentity) ||
    JSON.stringify(after) !== JSON.stringify(nativeApplicationIdentity)
  )
    throw new Error(
      'Original Android guest PID/birth changed during whole RSS coverage.',
    )
  const match = content.match(/TOTAL RSS:\s+(\d+)/)
  if (
    !content.includes(
      `MEMINFO in pid ${nativeApplicationIdentity.pid} [${applicationIdentifier}]`,
    ) ||
    !match
  )
    throw new Error('Exact original Android process RSS is unknown.')
  const residentBytes = Number(match[1]) * 1024
  if (!Number.isSafeInteger(residentBytes) || residentBytes <= 0)
    throw new Error('Unknown native RSS cannot become zero.')
  return { residentBytes, processIdentity: nativeApplicationIdentity }
}

async function androidCalibrationProcessBirth(processIdentifier) {
  const bootId = (
    await runCalibrationObservation(androidBridge, [
      '-s',
      androidDevice,
      'shell',
      'cat',
      '/proc/sys/kernel/random/boot_id',
    ])
  )
    .toString('utf8')
    .trim()
  const stat = (
    await runCalibrationObservation(androidBridge, [
      '-s',
      androidDevice,
      'shell',
      'cat',
      `/proc/${processIdentifier}/stat`,
    ])
  )
    .toString('utf8')
    .trim()
  const commandEnd = stat.lastIndexOf(') ')
  const fields = stat.slice(commandEnd + 2).split(/\s+/)
  const startTimeTicks = fields[19]
  if (
    !/^[a-f0-9-]{36}$/.test(bootId) ||
    commandEnd < 0 ||
    Number(stat.slice(0, stat.indexOf(' '))) !== processIdentifier ||
    !/^\d+$/.test(startTimeTicks)
  )
    throw new Error(
      'The original Android guest process birth witness is unknown.',
    )
  return {
    domain: 'android-guest-proc',
    pid: processIdentifier,
    birthWitness: `${bootId}:${startTimeTicks}`,
    bootId,
    startTimeTicks,
    applicationIdentifier,
    deviceIdentity: androidDevice,
  }
}

async function establishCalibrationApplicationIdentity(
  processIdentifier,
  installedExecutable,
) {
  try {
    if (!Number.isSafeInteger(processIdentifier) || processIdentifier <= 0)
      throw new Error(
        'The original native launch did not identify one exact process.',
      )
    if (platform === 'android')
      nativeApplicationIdentity =
        await androidCalibrationProcessBirth(processIdentifier)
    else {
      const sample = JSON.parse(
        (
          await runCalibrationObservation('python3', [
            resolve(
              repositoryDirectory,
              'scripts/native/native-application-observation.py',
            ),
            '--pid',
            String(processIdentifier),
            '--expected-executable',
            installedExecutable,
            '--owner-reader',
            resolve(
              repositoryDirectory,
              'scripts/native/process-owner-reader.py',
            ),
            '--owner-reader-sha256',
            '8f007ac938f5198a5e82e270305a117c38a438486a570abce219e4f3b3131af8',
          ])
        ).toString('utf8'),
      )
      nativeApplicationIdentity = sample.processIdentity
    }
  } catch (error) {
    nativeApplicationIdentityFailure = error
    throw error
  } finally {
    resolveNativeApplicationIdentity()
  }
}

async function requestAndroidTaskStorage(mode, fields) {
  if (nativeTaskStoragePending)
    throw new Error('Overlapping native task storage observation is refused.')
  const requestIdentity = createHash('sha256')
    .update(sessionName + ':' + ++nativeTaskStorageSequence)
    .digest('hex')
    .slice(0, 32)
  const body = { sessionName, requestIdentity, mode, ...fields }
  let resolveReceipt
  let rejectReceipt
  const receipt = new Promise((resolveResult, rejectResult) => {
    resolveReceipt = resolveResult
    rejectReceipt = rejectResult
  })
  nativeTaskStoragePending = {
    sessionName,
    requestIdentity,
    resolveReceipt,
    rejectReceipt,
    received: false,
  }
  let timer
  const deadline = new Promise((_resolveDeadline, rejectDeadline) => {
    timer = setTimeout(
      () =>
        rejectDeadline(
          new Error('Actual native task storage receipt did not arrive.'),
        ),
      1900,
    )
  })
  const command = runCommand(androidBridge, [
    '-s',
    androidDevice,
    'shell',
    'am',
    'broadcast',
    '-n',
    applicationIdentifier + '/.StorageMeasurementReceiver',
    '--es',
    'measurementMode',
    'task-disk-v2',
    '--es',
    'payloadBase64',
    Buffer.from(JSON.stringify(body)).toString('base64'),
  ])
  try {
    return await Promise.race([
      Promise.all([receipt, command]).then(([result]) => result),
      deadline,
    ])
  } finally {
    clearTimeout(timer)
    // A timed out broadcast still belongs to the existing command owner and cleanup.
    try {
      await command
    } finally {
      nativeTaskStoragePending?.rejectReceipt(
        new Error('Native task observation scope closed.'),
      )
      nativeTaskStoragePending = undefined
    }
  }
}

async function iosCalibrationContainer() {
  const container = (
    await runCalibrationObservation('xcrun', [
      'simctl',
      'get_app_container',
      simulatorIdentifier,
      applicationIdentifier,
      'data',
    ])
  )
    .toString('utf8')
    .trim()
  if (
    !container.startsWith('/') ||
    !lstatSync(container).isDirectory() ||
    lstatSync(container).isSymbolicLink()
  )
    throw new Error('The actual owned iOS data container is unknown.')
  return container
}
function assertIOSCalibrationPath(container, path) {
  if (
    typeof path !== 'string' ||
    path !== resolve(path) ||
    !path.startsWith(container + '/')
  )
    throw new Error(
      'Actual PRAGMA path lies outside the owned iOS app container.',
    )
  for (
    let parent = dirname(path);
    parent !== container;
    parent = dirname(parent)
  ) {
    const status = lstatSync(parent)
    if (!status.isDirectory() || status.isSymbolicLink())
      throw new Error(
        'Native task database parent path is not an actual owned directory.',
      )
  }
}
async function registerCalibrationNativePath(registration) {
  if (platform === 'android') {
    const result = await requestAndroidTaskStorage('register', { registration })
    if (
      result.accepted !== true ||
      result.name !== registration.name ||
      result.path !== registration.path
    )
      throw new Error(
        'The app receiver refused actual PRAGMA path registration.',
      )
    return
  }
  const container = await iosCalibrationContainer()
  assertIOSCalibrationPath(container, registration.path)
  if (
    !lstatSync(registration.path).isFile() ||
    lstatSync(registration.path).isSymbolicLink()
  )
    throw new Error('Original PRAGMA main database path is unknown.')
}
async function sampleCalibrationNativeFiles(registrations) {
  if (platform === 'android') {
    const result = await requestAndroidTaskStorage('sample', {
      names: registrations.map((entry) => entry.name),
    })
    if (result.accepted !== true)
      throw new Error(
        'The app receiver refused physical task file observation.',
      )
    return result.files
  }
  const container = await iosCalibrationContainer()
  const files = []
  for (const registration of registrations)
    for (const [kind, suffix] of [
      ['main', ''],
      ['wal', '-wal'],
      ['shm', '-shm'],
    ]) {
      const path = registration.path + suffix
      assertIOSCalibrationPath(container, path)
      try {
        const status = lstatSync(path)
        if (
          !status.isFile() ||
          status.isSymbolicLink() ||
          !Number.isSafeInteger(status.size) ||
          status.size < 0
        )
          throw new Error('Unknown physical task file kind or byte size.')
        files.push({
          name: registration.name,
          kind,
          status: 'present',
          bytes: status.size,
        })
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
        files.push({
          name: registration.name,
          kind,
          status: 'absent',
          bytes: null,
        })
      }
    }
  return files
}

let memoryEvidence
let memoryTimer
let residentMemorySamplingInFlight
let descendantCaptureInFlight
let legacyHostObservationClosing = false
let applicationProcessIdentifier
const memorySamples = []
const storageSamples = []
let nativeDatabasePath
let uiDriver
let uiState = { phase: 'inactive', finished: false }
const uiPhases = {}
let currentUIAction
let uiActionSequence = 0
let progressCheckpointReceiver
function createPerformanceCheckpointReceiver(configuration) {
  const stages = [
    ['sdk/install', 0],
    ['sdk/witness', 1],
    ['sdk/checkpoint', 1],
    ['reference/install', 2],
    ['reference/witness', 3],
    ['repeat0/install', 3],
    ['repeat0/witness', 4],
    ['repeat0/checkpoint', 4],
    ['repeat1/install', 5],
    ['repeat1/witness', 6],
    ['repeat1/checkpoint', 6],
    ['invalid/prepare', 7],
    ['invalidSDK/install', 7],
    ['invalidReference/install', 7],
    ['invalidSDK/witness', 7],
    ['invalidReference/witness', 7],
    ['catalog/read-and-subscription', 7],
    ['largeHTTP/prepare', 7],
    ['largeHTTP/resnapshot', 7],
    ['largeHTTP/witness', 8],
    ['batchSync', 8],
  ]
  const completedOperations = [
    'sdk/install',
    'sdk/checkpoint',
    'reference/install',
    'repeat0/install',
    'repeat0/checkpoint',
    'repeat1/install',
    'repeat1/checkpoint',
    'largeHTTP/resnapshot',
  ]
  const snapshotPhases = [
    'validation',
    'digest',
    'staging',
    'records',
    'relationSets',
    'integrity',
    'commit',
    'checkpoint',
  ]
  const checkpoints = []
  const failures = []
  const finiteNumber = (value) =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0
  const exactKeys = (value, required, optional = []) =>
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => [...required, ...optional].includes(key))
  const finiteObject = (value, keys) =>
    exactKeys(value, keys) && keys.every((key) => finiteNumber(value[key]))
  function validMeasurement(measurement, index) {
    if (
      !exactKeys(
        measurement,
        ['operation', 'elapsedMilliseconds'],
        [
          'phaseMeasurements',
          'frameMeasurement',
          'responsivenessMeasurement',
          'digestMeasurement',
        ],
      ) ||
      measurement.operation !== completedOperations[index] ||
      !finiteNumber(measurement.elapsedMilliseconds)
    )
      return false
    if (
      (measurement.operation.endsWith('/install') ||
        measurement.operation === 'largeHTTP/resnapshot') &&
      (!Object.hasOwn(measurement, 'frameMeasurement') ||
        !Object.hasOwn(measurement, 'responsivenessMeasurement'))
    )
      return false
    if (
      ['sdk/install', 'reference/install', 'largeHTTP/resnapshot'].includes(
        measurement.operation,
      ) &&
      !Object.hasOwn(measurement, 'phaseMeasurements')
    )
      return false
    if (
      ['sdk/install', 'largeHTTP/resnapshot'].includes(measurement.operation) &&
      !Object.hasOwn(measurement, 'digestMeasurement')
    )
      return false
    const phases = measurement.phaseMeasurements
    if (
      phases !== undefined &&
      (!Array.isArray(phases) ||
        phases.length > 16 ||
        !phases.every(
          (phase) =>
            exactKeys(
              phase,
              ['phase', 'elapsedMilliseconds'],
              ['startedMilliseconds'],
            ) &&
            snapshotPhases.includes(phase.phase) &&
            finiteNumber(phase.elapsedMilliseconds) &&
            (phase.startedMilliseconds === undefined ||
              finiteNumber(phase.startedMilliseconds)),
        ))
    )
      return false
    const frames = measurement.frameMeasurement
    const frameNumbers = [
      'frames',
      'maximumFrameGapMilliseconds',
      'estimatedMissedFrames',
      'elapsedMilliseconds',
      'finalFrameGapMilliseconds',
      'callbackCoverageRatio',
    ]
    if (
      frames !== undefined &&
      (!exactKeys(frames, [...frameNumbers, 'firstFrameGapMilliseconds']) ||
        !frameNumbers.every((key) => finiteNumber(frames[key])) ||
        (frames.firstFrameGapMilliseconds !== null &&
          !finiteNumber(frames.firstFrameGapMilliseconds)))
    )
      return false
    const responsiveness = measurement.responsivenessMeasurement
    const responsivenessNumbers = [
      'maximumCallbackGapMilliseconds',
      'maximumCallingThreadCpuMilliseconds',
      'callbacks',
      'armedBoundaries',
    ]
    if (
      responsiveness !== undefined &&
      (!exactKeys(responsiveness, [
        ...responsivenessNumbers,
        'phaseMaximumGaps',
      ]) ||
        !responsivenessNumbers.every((key) =>
          finiteNumber(responsiveness[key]),
        ) ||
        !Array.isArray(responsiveness.phaseMaximumGaps) ||
        responsiveness.phaseMaximumGaps.length > 16 ||
        !responsiveness.phaseMaximumGaps.every(
          (gap) =>
            exactKeys(gap, [
              'phase',
              'wallMilliseconds',
              'callingThreadCpuMilliseconds',
            ]) &&
            typeof gap.phase === 'string' &&
            gap.phase.length <= 64 &&
            finiteNumber(gap.wallMilliseconds) &&
            finiteNumber(gap.callingThreadCpuMilliseconds),
        ))
    )
      return false
    const digest = measurement.digestMeasurement
    const digestNumbers = [
      'maximumDigestSliceMilliseconds',
      'maximumIteratorDispatchMilliseconds',
      'maximumIteratorAwaitMilliseconds',
      'iteratorAwaitMilliseconds',
      'hashingMilliseconds',
      'nativeHashCpuMilliseconds',
      'nativeHashWallMilliseconds',
      'nativeHashBytes',
      'nativeHashChunks',
      'maximumBufferedUtf16Units',
    ]
    if (
      digest !== undefined &&
      (!exactKeys(digest, [...digestNumbers, 'implementation']) ||
        !finiteObject(
          Object.fromEntries(digestNumbers.map((key) => [key, digest[key]])),
          digestNumbers,
        ) ||
        digest.implementation !== 'system SHA256 on a serial native worker' ||
        digest.maximumBufferedUtf16Units !== 65536)
    )
      return false
    return true
  }
  return {
    async receive(request, response) {
      if (request.url !== '/diagnostic/performance-checkpoint') return false
      const reply = (value, status) =>
        response
          .writeHead(status, { 'Content-Type': 'application/json' })
          .end(JSON.stringify(value))
      if (request.method !== 'POST') {
        reply({ error: 'Performance checkpoints require POST.' }, 405)
        return true
      }
      let persisting = false
      try {
        const chunks = []
        let bytes = 0
        for await (const chunk of request) {
          bytes += chunk.length
          if (bytes > 16384)
            throw new Error('Native performance checkpoint exceeded 16 KiB.')
          chunks.push(chunk)
        }
        const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        const expectedStage = stages[checkpoints.length]
        const previous = checkpoints.at(-1)?.payload
        if (
          !exactKeys(payload, [
            'version',
            'diagnosticOnly',
            'candidateFingerprint',
            'packageArchiveSha256',
            'platform',
            'sequence',
            'nextOperation',
            'applicationMonotonicMilliseconds',
            'completedMeasurements',
          ]) ||
          payload.version !== 1 ||
          payload.diagnosticOnly !== true ||
          payload.candidateFingerprint !== configuration.candidateFingerprint ||
          payload.packageArchiveSha256 !== configuration.packageArchiveSha256 ||
          payload.platform !== configuration.platform ||
          payload.sequence !== checkpoints.length + 1 ||
          !expectedStage ||
          payload.nextOperation !== expectedStage[0] ||
          !finiteNumber(payload.applicationMonotonicMilliseconds) ||
          (previous &&
            payload.applicationMonotonicMilliseconds <
              previous.applicationMonotonicMilliseconds) ||
          !Array.isArray(payload.completedMeasurements) ||
          payload.completedMeasurements.length !== expectedStage[1] ||
          !payload.completedMeasurements.every(validMeasurement) ||
          (previous &&
            JSON.stringify(
              payload.completedMeasurements.slice(
                0,
                previous.completedMeasurements.length,
              ),
            ) !== JSON.stringify(previous.completedMeasurements))
        )
          throw new Error(
            'Invalid native performance checkpoint ownership or measurements.',
          )
        const checkpoint = {
          receivedAt: new Date().toISOString(),
          candidateFingerprint: configuration.candidateFingerprint,
          sourceFingerprint: configuration.sourceFingerprint,
          packageArchiveSha256: configuration.packageArchiveSha256,
          platform: configuration.platform,
          sessionName: configuration.sessionName,
          sequence: payload.sequence,
          payload,
        }
        persisting = true
        appendFileSync(configuration.logPath, JSON.stringify(checkpoint) + '\n')
        checkpoints.push(checkpoint)
        reply({ accepted: true, sequence: payload.sequence }, 200)
      } catch (failure) {
        failures.push({
          receivedAt: new Date().toISOString(),
          error: String(failure),
          operation: persisting
            ? 'checkpoint persistence'
            : 'checkpoint validation',
        })
        reply({ error: String(failure) }, persisting ? 500 : 400)
      }
      return true
    },
    evidence() {
      return {
        diagnosticOnly: true,
        logPath: configuration.logPath,
        checkpoints,
        failures,
      }
    },
  }
}
function createAndroidUIControl() {
  let activeAction
  let closed = false
  let waitingOffer
  let receiptBytes = 0
  let receiptCount = 0
  const receiptPath = resolve(artifactDirectory, 'android-ui-receipts.jsonl')
  const eligiblePhases = [
    'idle',
    'sdk-import',
    'reference-import',
    'large-http',
    ...(measurementSchemaVersion === 2 ? ['catalog-read'] : []),
  ]
  function record(kind, fields) {
    const line =
      JSON.stringify({ kind, hostTimestamp: Date.now(), ...fields }) + '\n'
    const bytes = Buffer.byteLength(line)
    if (bytes > 4096 || receiptBytes + bytes > 32 * 1024 ** 2) {
      const failure = new Error('Bounded native UI receipt stream exceeded.')
      rejectNativeResult(failure)
      throw failure
    }
    try {
      appendFileSync(receiptPath, line)
    } catch (failure) {
      rejectNativeResult(failure)
      throw failure
    }
    receiptBytes += bytes
    receiptCount += 1
    if (measurementSchemaVersion === 2) calibrationHost?.observeUI(line)
  }
  function sameContext(value, action = activeAction) {
    return Boolean(
      action &&
      value.phase === action.phase &&
      value.probeIdentity === action.probeIdentity &&
      value.actionId === action.id,
    )
  }
  function scalar(value) {
    return typeof value === 'number' && Number.isFinite(value)
  }
  function closeOffer(reason) {
    if (!waitingOffer) return
    const offer = waitingOffer
    waitingOffer = undefined
    offer.response.off('close', offer.closed)
    if (!offer.response.destroyed)
      offer.response
        .writeHead(409, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ accepted: false, reason }))
  }
  function closeAction(action) {
    if (!action || activeAction !== action || !action.commandSettled) return
    if (
      !action.discardReason &&
      (!action.delivered || (action.type === 'scroll' && !action.ended))
    )
      return
    record('action-closed', {
      actionId: action.id,
      phase: action.phase,
      probeIdentity: action.probeIdentity,
      type: action.type,
      disposition: action.discardReason ?? 'delivered',
      commandSucceeded: action.commandSucceeded,
    })
    activeAction = undefined
    action.resolveCompletion({
      delivered: Boolean(action.delivered),
      discarded: action.discardReason ?? null,
    })
  }
  function discard(reason) {
    const action = activeAction
    if (!action || action.discardReason) return
    action.discardReason = reason
    action.resolveArmed(false)
    if (!action.commandStarted) action.commandSettled = true
    record('action-discarded', {
      actionId: action.id,
      phase: action.phase,
      probeIdentity: action.probeIdentity,
      type: action.type,
      reason,
    })
    closeAction(action)
  }
  function deliver(action, value) {
    if (
      action.delivered ||
      action.discardReason ||
      activeAction !== action ||
      !action.commandSettled ||
      action.commandSucceeded !== true ||
      uiState.phase !== action.phase ||
      uiState.probeIdentity !== action.probeIdentity
    )
      return false
    const deliveredAt = value.hostReceivedAt
    const deliveryMilliseconds = deliveredAt - action.startedAt
    const phase = (uiPhases[action.phase] ??= {
      inputEvents: 0,
      scrollEvents: 0,
      maximumActionDeliveryMilliseconds: 0,
      actions: [],
      omittedActionReceipts: 0,
    })
    const retained = {
      id: action.id,
      phase: action.phase,
      type: action.type,
      probeIdentity: action.probeIdentity,
      startedAt: action.startedAt,
      deliveredAt,
      applicationReceivedAt: value.applicationReceivedAt,
      deliveryMilliseconds,
    }
    record('action-delivered', {
      ...retained,
      validatedAt: Date.now(),
      nativeTimestamp: value.nativeTimestamp ?? null,
      eventCount: value.eventCount ?? null,
      target: value.target,
    })
    phase[action.type === 'input' ? 'inputEvents' : 'scrollEvents'] += 1
    phase.maximumActionDeliveryMilliseconds = Math.max(
      phase.maximumActionDeliveryMilliseconds,
      deliveryMilliseconds,
    )
    if (phase.actions.length < 256) phase.actions.push(retained)
    else phase.omittedActionReceipts += 1
    action.delivered = true
    closeAction(action)
    return true
  }
  function attemptDelivery(action) {
    if (!action || activeAction !== action || action.discardReason) return false
    if (action.type === 'input')
      return action.pendingInput ? deliver(action, action.pendingInput) : false
    const value = action.pendingScroll
    if (
      !value ||
      !action.ended ||
      !scalar(value.nativeTimestamp) ||
      value.gestureStartedNativeMilliseconds !==
        action.ended.startedNativeMilliseconds ||
      value.target !== action.ended.target ||
      value.nativeTimestamp <= action.ended.startedNativeMilliseconds ||
      value.nativeTimestamp > action.ended.nativeTimestamp
    )
      return false
    return deliver(action, value)
  }
  function offerAction() {
    if (
      !waitingOffer ||
      !activeAction ||
      activeAction.offered ||
      activeAction.discardReason
    )
      return
    const offer = waitingOffer
    const action = activeAction
    if (
      offer.phase !== action.phase ||
      offer.probeIdentity !== action.probeIdentity
    )
      return
    waitingOffer = undefined
    offer.response.off('close', offer.closed)
    action.offered = true
    offer.response.writeHead(200, { 'Content-Type': 'application/json' }).end(
      JSON.stringify({
        id: action.id,
        phase: action.phase,
        type: action.type,
        probeIdentity: action.probeIdentity,
        token: action.token,
      }),
    )
    record('action-offered', {
      actionId: action.id,
      phase: action.phase,
      probeIdentity: action.probeIdentity,
      type: action.type,
      token: action.token,
    })
  }
  return {
    initialize() {
      writeFileSync(receiptPath, '')
    },
    setPhase(value) {
      if (
        measurementSchemaVersion === 2 &&
        (!calibrationRequest ||
          value.measurementSchemaVersion !== 2 ||
          value.sessionName !== sessionName ||
          ![
            'inactive',
            'idle',
            'sdk-import',
            'reference-import',
            'large-http',
            'catalog-read',
            'between-imports',
          ].includes(value.phase))
      )
        throw new Error('Phase lacks its immutable known schema2 session.')
      if (
        typeof value.phase !== 'string' ||
        value.phase.length > 64 ||
        (eligiblePhases.includes(value.phase) &&
          (typeof value.probeIdentity !== 'string' ||
            !/^probe-[0-9]{1,12}$/.test(value.probeIdentity)))
      )
        throw new Error(
          'Missing bounded Android phase or actual probe identity.',
        )
      if (
        uiState.phase !== value.phase ||
        uiState.probeIdentity !== value.probeIdentity
      ) {
        discard('phase-or-probe-changed')
        closeOffer('phase-or-probe-changed')
      }
      uiState = {
        phase: value.phase,
        probeIdentity: value.probeIdentity ?? null,
        finished: value.phase === 'inactive',
      }
      record('phase', uiState)
    },
    next(value, response) {
      if (
        closed ||
        uiState.phase !== value.phase ||
        uiState.probeIdentity !== value.probeIdentity ||
        !eligiblePhases.includes(value.phase) ||
        waitingOffer
      )
        throw new Error('Stale or duplicate Android action receiver.')
      const offer = {
        phase: value.phase,
        probeIdentity: value.probeIdentity,
        response,
        closed: () => {
          if (waitingOffer === offer) waitingOffer = undefined
        },
      }
      waitingOffer = offer
      response.once('close', offer.closed)
      offerAction()
    },
    begin(type) {
      if (
        closed ||
        activeAction ||
        !eligiblePhases.includes(uiState.phase) ||
        !uiState.probeIdentity
      )
        throw new Error('An unresolved native action cannot be replaced.')
      let resolveArmed
      let resolveCompletion
      const armed = new Promise((resolve) => {
        resolveArmed = resolve
      })
      const completion = new Promise((resolve) => {
        resolveCompletion = resolve
      })
      const action = {
        id: ++uiActionSequence,
        phase: uiState.phase,
        probeIdentity: uiState.probeIdentity,
        type,
        token: 'u' + uiActionSequence.toString(36) + 'z',
        startedAt: Date.now(),
        armed,
        completion,
        resolveArmed,
        resolveCompletion,
        commandStarted: false,
        commandSettled: false,
        commandSucceeded: false,
      }
      if (action.token.length > 14)
        throw new Error('Bounded input nonce exhausted.')
      activeAction = action
      record('action-admitted', {
        actionId: action.id,
        phase: action.phase,
        probeIdentity: action.probeIdentity,
        type,
        token: action.token,
        startedAt: action.startedAt,
      })
      offerAction()
      return action
    },
    arm(value) {
      if (
        !sameContext(value) ||
        activeAction.discardReason ||
        !activeAction.offered
      )
        return { accepted: false, reason: 'stale-action' }
      activeAction.resolveArmed(true)
      record('action-armed', {
        actionId: value.actionId,
        phase: value.phase,
        probeIdentity: value.probeIdentity,
      })
      return { accepted: true }
    },
    startCommand(action) {
      if (
        activeAction !== action ||
        action.discardReason ||
        uiState.phase !== action.phase ||
        uiState.probeIdentity !== action.probeIdentity
      )
        return false
      action.commandStarted = true
      return true
    },
    commandSettled(action, succeeded, failure) {
      action.commandSettled = true
      action.commandSucceeded = succeeded
      record('physical-command-closed', {
        actionId: action.id,
        phase: action.phase,
        probeIdentity: action.probeIdentity,
        succeeded,
        error: failure ? String(failure).slice(0, 256) : null,
      })
      if (!succeeded) discard('physical-command-failed')
      else attemptDelivery(action)
      closeAction(action)
    },
    event(value) {
      const observation = value.scrollObservation
      const diagnosticObservation =
        value.type === 'scroll' &&
        value.acceptedCandidate === false &&
        [
          'native-drag-begin-observation',
          'unassociated-drag-begin',
          'native-touch-end',
          'closed-probe',
        ].includes(value.reason) &&
        observation &&
        typeof observation === 'object' &&
        !Array.isArray(observation)
      const fields = {
        hostReceivedAt: Date.now(),
        actionId: Number.isSafeInteger(value.actionId) ? value.actionId : null,
        probeIdentity:
          typeof value.probeIdentity === 'string'
            ? value.probeIdentity.slice(0, 32)
            : null,
        phase:
          typeof value.phase === 'string' ? value.phase.slice(0, 64) : null,
        type:
          value.type === 'input' || value.type === 'scroll' ? value.type : null,
        reason:
          typeof value.reason === 'string' ? value.reason.slice(0, 64) : null,
        applicationReceivedAt: scalar(value.applicationReceivedAt)
          ? value.applicationReceivedAt
          : null,
        nativeTimestamp: scalar(value.nativeTimestamp)
          ? value.nativeTimestamp
          : null,
        gestureStartedNativeMilliseconds: scalar(
          value.gestureStartedNativeMilliseconds,
        )
          ? value.gestureStartedNativeMilliseconds
          : null,
        text:
          typeof value.text === 'string' && value.text.length <= 32
            ? value.text
            : null,
        textUnits: Number.isSafeInteger(value.textUnits)
          ? value.textUnits
          : null,
        eventCount: Number.isSafeInteger(value.eventCount)
          ? value.eventCount
          : null,
        target: Number.isSafeInteger(value.target) ? value.target : null,
        offsetX: scalar(value.offsetX) ? value.offsetX : null,
        offsetY: scalar(value.offsetY) ? value.offsetY : null,
        ...(diagnosticObservation
          ? {
              scrollObservation: {
                disposition: [
                  'associated',
                  'closed',
                  'unarmed',
                  'non-scroll-action',
                  'phase-mismatch',
                  'missing-timestamp',
                  'missing-target',
                  'not-after-touch-end',
                  'not-after-current-scroll',
                  'touch-end',
                ].includes(observation.disposition)
                  ? observation.disposition
                  : null,
                armedActionId:
                  Number.isSafeInteger(observation.armedActionId) &&
                  observation.armedActionId > 0
                    ? observation.armedActionId
                    : null,
                armedType: ['input', 'scroll'].includes(observation.armedType)
                  ? observation.armedType
                  : null,
                armedPhase:
                  typeof observation.armedPhase === 'string' &&
                  observation.armedPhase.length <= 64
                    ? observation.armedPhase
                    : null,
                currentActionId:
                  Number.isSafeInteger(observation.currentActionId) &&
                  observation.currentActionId > 0
                    ? observation.currentActionId
                    : null,
                currentPhase:
                  typeof observation.currentPhase === 'string' &&
                  observation.currentPhase.length <= 64
                    ? observation.currentPhase
                    : null,
                currentStartedNativeMilliseconds: scalar(
                  observation.currentStartedNativeMilliseconds,
                )
                  ? observation.currentStartedNativeMilliseconds
                  : null,
                currentEndedNativeMilliseconds: scalar(
                  observation.currentEndedNativeMilliseconds,
                )
                  ? observation.currentEndedNativeMilliseconds
                  : null,
                lastTouchEndNativeMilliseconds: scalar(
                  observation.lastTouchEndNativeMilliseconds,
                )
                  ? observation.lastTouchEndNativeMilliseconds
                  : null,
                closed:
                  typeof observation.closed === 'boolean'
                    ? observation.closed
                    : null,
              },
            }
          : {}),
      }
      if (value.reason === 'bounded-receipt-overflow') {
        record('native-event', {
          ...fields,
          accepted: false,
          pending: false,
          rejection: 'bounded-receipt-overflow',
        })
        const failure = new Error(
          'Android native UI receipt producer exceeded bounded in-flight capacity.',
        )
        rejectNativeResult(failure)
        return { accepted: false, reason: 'bounded-receipt-overflow' }
      }
      const action = activeAction
      const valid =
        sameContext(value) &&
        value.type === action.type &&
        uiState.phase === action.phase &&
        uiState.probeIdentity === action.probeIdentity &&
        action.commandStarted &&
        !action.discardReason &&
        !action.delivered &&
        value.acceptedCandidate === true &&
        Number.isSafeInteger(value.target) &&
        value.target > 0
      let provisional = false
      if (
        valid &&
        action.type === 'input' &&
        value.text === action.token &&
        value.textUnits === action.token.length &&
        Number.isSafeInteger(value.eventCount) &&
        value.eventCount >= 0
      ) {
        action.pendingInput ??= fields
        provisional = true
      } else if (
        valid &&
        action.type === 'scroll' &&
        scalar(value.nativeTimestamp) &&
        scalar(value.gestureStartedNativeMilliseconds) &&
        value.nativeTimestamp > value.gestureStartedNativeMilliseconds
      ) {
        action.pendingScroll ??= fields
        provisional = true
      }
      // Preserve each raw callback before any strict coverage promotion.
      record('native-event', {
        ...fields,
        accepted: false,
        provisional,
        pending: provisional,
        rejection: provisional ? null : 'uncorrelated-or-stale-event',
      })
      const accepted = provisional ? attemptDelivery(action) : false
      const pending = provisional && !action.delivered && !action.discardReason
      return { accepted, pending }
    },
    ended(value) {
      if (
        !sameContext(value) ||
        activeAction.type !== 'scroll' ||
        activeAction.discardReason ||
        !activeAction.commandStarted ||
        !scalar(value.nativeTimestamp) ||
        !scalar(value.gestureStartedNativeMilliseconds) ||
        !Number.isSafeInteger(value.target) ||
        value.nativeTimestamp <= value.gestureStartedNativeMilliseconds
      )
        return { accepted: false, reason: 'stale-or-invalid-drag-end' }
      const action = activeAction
      action.ended ??= {
        nativeTimestamp: value.nativeTimestamp,
        startedNativeMilliseconds: value.gestureStartedNativeMilliseconds,
        target: value.target,
      }
      record('native-drag-end', {
        actionId: value.actionId,
        phase: value.phase,
        probeIdentity: value.probeIdentity,
        ...action.ended,
      })
      attemptDelivery(action)
      closeAction(action)
      return { accepted: true }
    },
    close(reason) {
      closed = true
      try {
        discard(reason)
      } finally {
        closeOffer(reason)
      }
      record('ui-owner-closed', { reason })
    },
    record,
    report() {
      return {
        correlationSchema: 2,
        strictCorrelation: true,
        closed,
        receiptPath,
        receiptBytes,
        receiptCount,
        retainedActionsPerPhase: 256,
        receiptLimitBytes: 32 * 1024 ** 2,
        inputTokenMaximumUnits: 14,
        textInputMaximumUnits: 32,
        unresolvedAction: activeAction
          ? {
              actionId: activeAction.id,
              phase: activeAction.phase,
              type: activeAction.type,
              probeIdentity: activeAction.probeIdentity,
            }
          : null,
      }
    },
  }
}
const androidUIControl = createAndroidUIControl()

function createIOSUIControl() {
  let activeAction
  let closed = false
  let waitingOffer
  let receiptBytes = 0
  let receiptCount = 0
  let latestCompletion
  let focusedTarget = null
  const receiptPath = resolve(artifactDirectory, 'ios-ui-receipts.jsonl')
  const eligiblePhases = [
    'idle',
    'sdk-import',
    'reference-import',
    'large-http',
    ...(measurementSchemaVersion === 2 ? ['catalog-read'] : []),
  ]
  function record(kind, fields) {
    const line =
      JSON.stringify({ kind, hostTimestamp: Date.now(), ...fields }) + '\n'
    const bytes = Buffer.byteLength(line)
    if (bytes > 4096 || receiptBytes + bytes > 32 * 1024 ** 2) {
      const failure = new Error('Bounded native UI receipt stream exceeded.')
      rejectNativeResult(failure)
      throw failure
    }
    try {
      appendFileSync(receiptPath, line)
    } catch (failure) {
      rejectNativeResult(failure)
      throw failure
    }
    receiptBytes += bytes
    receiptCount += 1
    if (measurementSchemaVersion === 2) calibrationHost?.observeUI(line)
  }
  function sameContext(value, action = activeAction) {
    return Boolean(
      action &&
      value.phase === action.phase &&
      value.probeIdentity === action.probeIdentity &&
      value.actionId === action.id,
    )
  }
  function scalar(value) {
    return typeof value === 'number' && Number.isFinite(value)
  }
  function closeOffer(reason) {
    if (!waitingOffer) return
    const offer = waitingOffer
    waitingOffer = undefined
    offer.response.off('close', offer.closed)
    if (!offer.response.destroyed)
      offer.response
        .writeHead(409, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ accepted: false, reason }))
  }
  function closeAction(action) {
    if (!action || activeAction !== action || !action.commandSettled) return
    if (
      !action.discardReason &&
      (!action.delivered || (action.type === 'scroll' && !action.ended))
    )
      return
    record('action-closed', {
      actionId: action.id,
      phase: action.phase,
      probeIdentity: action.probeIdentity,
      type: action.type,
      disposition: action.discardReason ?? 'delivered',
      commandSucceeded: action.commandSucceeded,
    })
    activeAction = undefined
    latestCompletion = {
      actionId: action.id,
      phase: action.phase,
      probeIdentity: action.probeIdentity,
      completed: true,
      delivered: Boolean(action.delivered),
      discarded: action.discardReason ?? null,
    }
    action.resolveCompletion(latestCompletion)
  }
  function discard(reason) {
    const action = activeAction
    if (!action || action.discardReason) return
    action.discardReason = reason
    action.resolveArmed(false)
    if (!action.commandStarted) action.commandSettled = true
    record('action-discarded', {
      actionId: action.id,
      phase: action.phase,
      probeIdentity: action.probeIdentity,
      type: action.type,
      reason,
    })
    closeAction(action)
  }
  function deliver(action, value) {
    if (
      action.delivered ||
      action.discardReason ||
      activeAction !== action ||
      !action.commandSettled ||
      action.commandSucceeded !== true ||
      uiState.phase !== action.phase ||
      uiState.probeIdentity !== action.probeIdentity ||
      !validDriverWindow(action, value)
    )
      return false
    const deliveredAt = value.hostReceivedAt
    const deliveryMilliseconds = deliveredAt - action.startedAt
    const phase = (uiPhases[action.phase] ??= {
      inputEvents: 0,
      scrollEvents: 0,
      maximumActionDeliveryMilliseconds: 0,
      actions: [],
      omittedActionReceipts: 0,
    })
    const retained = {
      id: action.id,
      phase: action.phase,
      type: action.type,
      probeIdentity: action.probeIdentity,
      startedAt: action.startedAt,
      deliveredAt,
      applicationReceivedAt: value.applicationReceivedAt,
      deliveryMilliseconds,
    }
    record('action-delivered', {
      ...retained,
      validatedAt: Date.now(),
      nativeTimestamp: value.nativeTimestamp ?? null,
      eventCount: value.eventCount ?? null,
      target: value.target,
    })
    phase[action.type === 'input' ? 'inputEvents' : 'scrollEvents'] += 1
    phase.maximumActionDeliveryMilliseconds = Math.max(
      phase.maximumActionDeliveryMilliseconds,
      deliveryMilliseconds,
    )
    if (phase.actions.length < 256) phase.actions.push(retained)
    else phase.omittedActionReceipts += 1
    action.delivered = true
    closeAction(action)
    return true
  }
  function attemptDelivery(action) {
    if (!action || activeAction !== action || action.discardReason) return false
    if (action.type === 'input')
      return action.pendingInput ? deliver(action, action.pendingInput) : false
    const value = action.pendingScroll
    if (
      !value ||
      !action.ended ||
      !scalar(value.nativeTimestamp) ||
      value.gestureStartedNativeMilliseconds !==
        action.ended.startedNativeMilliseconds ||
      value.target !== action.ended.target ||
      value.nativeTimestamp <= action.ended.startedNativeMilliseconds ||
      value.nativeTimestamp > action.ended.nativeTimestamp
    )
      return false
    return deliver(action, value)
  }
  function validDriverWindow(action, value) {
    const start = action.driverStartedNativeMilliseconds
    const end = action.driverFinishedNativeMilliseconds
    if (
      !scalar(start) ||
      !scalar(end) ||
      end < start ||
      value.target !== action.nativeTarget
    )
      return false
    if (action.type === 'input')
      return value.targetSource === 'native-payload' && value.focused === true
    return (
      value.targetSource === 'current-target-public-ref' &&
      value.currentTargetMatches === true &&
      scalar(value.nativeTimestamp) &&
      scalar(value.gestureStartedNativeMilliseconds) &&
      value.gestureStartedNativeMilliseconds >= start &&
      value.nativeTimestamp <= end &&
      action.ended?.nativeTimestamp <= end &&
      action.ended?.startedNativeMilliseconds >= start
    )
  }
  function matchingDriver(value) {
    return (
      !closed &&
      sameContext(value) &&
      typeof value.phase === 'string' &&
      uiState.phase === value.phase &&
      uiState.probeIdentity === value.probeIdentity
    )
  }
  function boundedTargets(value) {
    const frame = value.frame
    const visible = value.visibleFrame
    const valid = (entry) =>
      entry &&
      ['x', 'y', 'width', 'height'].every(
        (key) => scalar(entry[key]) && Math.abs(entry[key]) <= 1000000,
      ) &&
      entry.width > 0 &&
      entry.height > 0
    return (
      valid(frame) &&
      valid(visible) &&
      value.hittable === true &&
      value.identifier ===
        (value.type === 'input' ? 'performance-input' : 'performance-scroll') &&
      visible.x >= frame.x &&
      visible.y >= frame.y &&
      visible.x + visible.width <= frame.x + frame.width &&
      visible.y + visible.height <= frame.y + frame.height &&
      (value.type !== 'scroll' || visible.height >= 48)
    )
  }
  function offerAction() {
    if (
      !waitingOffer ||
      !activeAction ||
      activeAction.offered ||
      activeAction.discardReason
    )
      return
    const offer = waitingOffer
    const action = activeAction
    if (
      offer.phase !== action.phase ||
      offer.probeIdentity !== action.probeIdentity
    )
      return
    waitingOffer = undefined
    offer.response.off('close', offer.closed)
    action.offered = true
    offer.response.writeHead(200, { 'Content-Type': 'application/json' }).end(
      JSON.stringify({
        id: action.id,
        phase: action.phase,
        type: action.type,
        probeIdentity: action.probeIdentity,
        token: action.token,
      }),
    )
    record('action-offered', {
      actionId: action.id,
      phase: action.phase,
      probeIdentity: action.probeIdentity,
      type: action.type,
      token: action.token,
    })
  }
  return {
    initialize() {
      writeFileSync(receiptPath, '')
    },
    setPhase(value) {
      if (
        measurementSchemaVersion === 2 &&
        (!calibrationRequest ||
          value.measurementSchemaVersion !== 2 ||
          value.sessionName !== sessionName ||
          ![
            'inactive',
            'idle',
            'sdk-import',
            'reference-import',
            'large-http',
            'catalog-read',
            'between-imports',
          ].includes(value.phase))
      )
        throw new Error('Phase lacks its immutable known schema2 session.')
      if (
        typeof value.phase !== 'string' ||
        value.phase.length > 64 ||
        (eligiblePhases.includes(value.phase) &&
          (typeof value.probeIdentity !== 'string' ||
            !/^probe-[0-9]{1,12}$/.test(value.probeIdentity)))
      )
        throw new Error('Missing bounded iOS phase or actual probe identity.')
      if (
        uiState.phase !== value.phase ||
        uiState.probeIdentity !== value.probeIdentity
      ) {
        discard('phase-or-probe-changed')
        closeOffer('phase-or-probe-changed')
        if (uiState.probeIdentity !== value.probeIdentity) focusedTarget = null
      }
      uiState = {
        phase: value.phase,
        probeIdentity: value.probeIdentity ?? null,
        finished: value.phase === 'inactive',
      }
      record('phase', uiState)
    },
    next(value, response) {
      if (
        closed ||
        uiState.phase !== value.phase ||
        uiState.probeIdentity !== value.probeIdentity ||
        !eligiblePhases.includes(value.phase) ||
        waitingOffer
      )
        throw new Error('Stale or duplicate iOS action receiver.')
      const offer = {
        phase: value.phase,
        probeIdentity: value.probeIdentity,
        response,
        closed: () => {
          if (waitingOffer === offer) waitingOffer = undefined
        },
      }
      waitingOffer = offer
      response.once('close', offer.closed)
      offerAction()
    },
    begin(type) {
      if (
        closed ||
        activeAction ||
        !eligiblePhases.includes(uiState.phase) ||
        !uiState.probeIdentity
      )
        throw new Error('An unresolved native action cannot be replaced.')
      let resolveArmed
      let resolveCompletion
      const armed = new Promise((resolve) => {
        resolveArmed = resolve
      })
      const completion = new Promise((resolve) => {
        resolveCompletion = resolve
      })
      const action = {
        id: ++uiActionSequence,
        phase: uiState.phase,
        probeIdentity: uiState.probeIdentity,
        type,
        token: 'u' + uiActionSequence.toString(36) + 'z',
        startedAt: Date.now(),
        armed,
        completion,
        resolveArmed,
        resolveCompletion,
        commandStarted: false,
        commandSettled: false,
        commandSucceeded: false,
      }
      if (action.token.length > 14)
        throw new Error('Bounded input nonce exhausted.')
      activeAction = action
      record('action-admitted', {
        actionId: action.id,
        phase: action.phase,
        probeIdentity: action.probeIdentity,
        type,
        token: action.token,
        startedAt: action.startedAt,
      })
      offerAction()
      return action
    },
    arm(value) {
      if (
        !sameContext(value) ||
        activeAction.discardReason ||
        !activeAction.offered
      )
        return { accepted: false, reason: 'stale-action' }
      if (
        !Number.isSafeInteger(value.target) ||
        value.target <= 0 ||
        (activeAction.type === 'input' &&
          (value.focused !== true ||
            value.targetSource !== 'native-payload' ||
            value.target !== focusedTarget)) ||
        (activeAction.type === 'scroll' &&
          value.targetSource !== 'current-target-public-ref')
      )
        return {
          accepted: false,
          reason: 'unproven-current-native-target-or-focus',
        }
      activeAction.nativeTarget = value.target
      activeAction.armedAccepted = true
      activeAction.resolveArmed(true)
      record('action-armed', {
        actionId: value.actionId,
        phase: value.phase,
        probeIdentity: value.probeIdentity,
        nativeTarget: value.target,
        targetSource: value.targetSource,
      })
      return { accepted: true }
    },
    startCommand(action) {
      if (
        activeAction !== action ||
        action.discardReason ||
        uiState.phase !== action.phase ||
        uiState.probeIdentity !== action.probeIdentity
      )
        return false
      action.commandStarted = true
      return true
    },
    commandSettled(action, succeeded, failure) {
      action.commandSettled = true
      action.commandSucceeded = succeeded
      record('physical-command-closed', {
        actionId: action.id,
        phase: action.phase,
        probeIdentity: action.probeIdentity,
        succeeded,
        error: failure ? String(failure).slice(0, 256) : null,
      })
      if (!succeeded) discard('physical-command-failed')
      else attemptDelivery(action)
      closeAction(action)
    },
    event(value) {
      const fields = {
        hostReceivedAt: Date.now(),
        actionId: Number.isSafeInteger(value.actionId) ? value.actionId : null,
        probeIdentity:
          typeof value.probeIdentity === 'string'
            ? value.probeIdentity.slice(0, 32)
            : null,
        phase:
          typeof value.phase === 'string' ? value.phase.slice(0, 64) : null,
        type:
          value.type === 'input' || value.type === 'scroll' ? value.type : null,
        reason:
          typeof value.reason === 'string' ? value.reason.slice(0, 64) : null,
        applicationReceivedAt: scalar(value.applicationReceivedAt)
          ? value.applicationReceivedAt
          : null,
        nativeTimestamp: scalar(value.nativeTimestamp)
          ? value.nativeTimestamp
          : null,
        gestureStartedNativeMilliseconds: scalar(
          value.gestureStartedNativeMilliseconds,
        )
          ? value.gestureStartedNativeMilliseconds
          : null,
        text:
          typeof value.text === 'string' && value.text.length <= 32
            ? value.text
            : null,
        textUnits: Number.isSafeInteger(value.textUnits)
          ? value.textUnits
          : null,
        eventCount: Number.isSafeInteger(value.eventCount)
          ? value.eventCount
          : null,
        target: Number.isSafeInteger(value.target) ? value.target : null,
        targetSource:
          value.targetSource === 'native-payload' ||
          value.targetSource === 'current-target-public-ref'
            ? value.targetSource
            : null,
        currentTargetMatches: value.currentTargetMatches === true,
        focused: value.focused === true,
        offsetX: scalar(value.offsetX) ? value.offsetX : null,
        offsetY: scalar(value.offsetY) ? value.offsetY : null,
      }
      if (value.reason === 'bounded-receipt-overflow') {
        record('native-event', {
          ...fields,
          accepted: false,
          pending: false,
          rejection: 'bounded-receipt-overflow',
        })
        const failure = new Error(
          'iOS native UI receipt producer exceeded bounded in-flight capacity.',
        )
        rejectNativeResult(failure)
        return { accepted: false, reason: 'bounded-receipt-overflow' }
      }
      const action = activeAction
      const valid =
        sameContext(value) &&
        value.type === action.type &&
        uiState.phase === action.phase &&
        uiState.probeIdentity === action.probeIdentity &&
        action.commandStarted &&
        !action.discardReason &&
        !action.delivered &&
        value.acceptedCandidate === true &&
        Number.isSafeInteger(value.target) &&
        value.target > 0 &&
        value.target === action.nativeTarget &&
        (action.type === 'input'
          ? value.targetSource === 'native-payload' && value.focused === true
          : value.targetSource === 'current-target-public-ref' &&
            value.currentTargetMatches === true &&
            scalar(value.gestureStartedNativeMilliseconds) &&
            value.gestureStartedNativeMilliseconds >=
              action.driverStartedNativeMilliseconds)
      let provisional = false
      if (
        valid &&
        action.type === 'input' &&
        value.text === action.token &&
        value.textUnits === action.token.length &&
        Number.isSafeInteger(value.eventCount) &&
        value.eventCount >= 0
      ) {
        action.pendingInput ??= fields
        provisional = true
      } else if (
        valid &&
        action.type === 'scroll' &&
        scalar(value.nativeTimestamp) &&
        scalar(value.gestureStartedNativeMilliseconds) &&
        value.nativeTimestamp > value.gestureStartedNativeMilliseconds
      ) {
        action.pendingScroll ??= fields
        provisional = true
      }
      // Preserve each raw callback before any strict coverage promotion.
      record('native-event', {
        ...fields,
        accepted: false,
        provisional,
        pending: provisional,
        rejection: provisional ? null : 'uncorrelated-or-stale-event',
      })
      const accepted = provisional ? attemptDelivery(action) : false
      const pending = provisional && !action.delivered && !action.discardReason
      return { accepted, pending }
    },
    ended(value) {
      if (
        !sameContext(value) ||
        activeAction.type !== 'scroll' ||
        activeAction.discardReason ||
        !activeAction.commandStarted ||
        value.target !== activeAction.nativeTarget ||
        !scalar(value.gestureStartedNativeMilliseconds) ||
        value.gestureStartedNativeMilliseconds <
          activeAction.driverStartedNativeMilliseconds ||
        !scalar(value.nativeTimestamp) ||
        !scalar(value.gestureStartedNativeMilliseconds) ||
        !Number.isSafeInteger(value.target) ||
        value.nativeTimestamp <= value.gestureStartedNativeMilliseconds
      )
        return { accepted: false, reason: 'stale-or-invalid-drag-end' }
      const action = activeAction
      action.ended ??= {
        nativeTimestamp: value.nativeTimestamp,
        startedNativeMilliseconds: value.gestureStartedNativeMilliseconds,
        target: value.target,
      }
      record('native-drag-end', {
        actionId: value.actionId,
        phase: value.phase,
        probeIdentity: value.probeIdentity,
        ...action.ended,
      })
      attemptDelivery(action)
      closeAction(action)
      return { accepted: true }
    },
    beginFromDriver(value) {
      if (
        uiState.phase !== value.phase ||
        uiState.probeIdentity !== value.probeIdentity ||
        !['input', 'scroll'].includes(value.type) ||
        !boundedTargets(value)
      )
        throw new Error(
          'The current iOS public target geometry or phase is unproven.',
        )
      record('ios-current-target', {
        phase: value.phase,
        probeIdentity: value.probeIdentity,
        type: value.type,
        identifier: value.identifier,
        frame: value.frame,
        visibleFrame: value.visibleFrame,
        hittable: true,
      })
      const action = this.begin(value.type)
      return {
        id: action.id,
        phase: action.phase,
        probeIdentity: action.probeIdentity,
        type: action.type,
        token: action.token,
      }
    },
    startFromDriver(value) {
      if (
        !matchingDriver(value) ||
        value.type !== activeAction.type ||
        activeAction.armedAccepted !== true ||
        activeAction.commandStarted ||
        !scalar(value.nativeMilliseconds) ||
        value.nativeMilliseconds <= 0 ||
        !boundedTargets(value)
      )
        return {
          accepted: false,
          reason: 'stale-or-unarmed-ios-physical-command',
        }
      activeAction.driverStartedNativeMilliseconds = value.nativeMilliseconds
      record('ios-physical-command-start', {
        actionId: value.actionId,
        phase: value.phase,
        probeIdentity: value.probeIdentity,
        nativeMilliseconds: value.nativeMilliseconds,
        identifier: value.identifier,
        frame: value.frame,
        visibleFrame: value.visibleFrame,
        hittable: true,
      })
      return { accepted: this.startCommand(activeAction) }
    },
    finishFromDriver(value) {
      const action = activeAction
      if (
        !sameContext(value) ||
        !action.commandStarted ||
        action.commandSettled ||
        !scalar(value.nativeMilliseconds) ||
        value.nativeMilliseconds < action.driverStartedNativeMilliseconds ||
        typeof value.succeeded !== 'boolean' ||
        typeof value.issueOverflow !== 'boolean' ||
        !Number.isSafeInteger(value.issuesBefore) ||
        !Number.isSafeInteger(value.issuesAfter) ||
        value.issuesBefore < 0 ||
        value.issuesAfter < value.issuesBefore ||
        value.issuesAfter > 65536 ||
        (value.succeeded &&
          (value.issuesAfter !== value.issuesBefore ||
            value.issueOverflow !== false))
      )
        return { accepted: false, reason: 'unproven-ios-command-completion' }
      const inputValueObservation = value.inputValueObservation
      if (
        inputValueObservation !== undefined &&
        (action.type !== 'input' ||
          !inputValueObservation ||
          typeof inputValueObservation !== 'object' ||
          Array.isArray(inputValueObservation) ||
          Object.keys(inputValueObservation).length !== 3 ||
          inputValueObservation.source !== 'XCUIElement.value' ||
          !['value', 'null', 'unavailable', 'exceeds-bound'].includes(
            inputValueObservation.state,
          ) ||
          (inputValueObservation.state === 'value'
            ? typeof inputValueObservation.value !== 'string' ||
              inputValueObservation.value.length > 256
            : inputValueObservation.value !== null))
      )
        return {
          accepted: false,
          reason: 'invalid-ios-input-value-observation',
        }
      action.driverFinishedNativeMilliseconds = value.nativeMilliseconds
      record('ios-physical-command-result', {
        actionId: value.actionId,
        phase: value.phase,
        probeIdentity: value.probeIdentity,
        nativeMilliseconds: value.nativeMilliseconds,
        succeeded: value.succeeded,
        issuesBefore: value.issuesBefore,
        issuesAfter: value.issuesAfter,
        issueOverflow: value.issueOverflow,
        ...(inputValueObservation === undefined
          ? {}
          : {
              inputValueObservation: {
                source: inputValueObservation.source,
                state: inputValueObservation.state,
                value: inputValueObservation.value,
              },
            }),
      })
      this.commandSettled(
        action,
        value.succeeded,
        value.succeeded
          ? undefined
          : new Error(
              'XCTest physical operation did not complete successfully.',
            ),
      )
      return { accepted: true }
    },
    status(value) {
      if (sameContext(value))
        return {
          actionId: activeAction.id,
          phase: activeAction.phase,
          probeIdentity: activeAction.probeIdentity,
          armed: activeAction.armedAccepted === true,
          commandStarted: activeAction.commandStarted,
          commandSettled: activeAction.commandSettled,
          completed: false,
          delivered: activeAction.delivered === true,
        }
      if (
        latestCompletion &&
        value.actionId === latestCompletion.actionId &&
        value.phase === latestCompletion.phase &&
        value.probeIdentity === latestCompletion.probeIdentity
      )
        return latestCompletion
      return { accepted: false, reason: 'unknown-or-retired-ios-action' }
    },
    focus(value) {
      const valid =
        !closed &&
        uiState.phase === value.phase &&
        uiState.probeIdentity === value.probeIdentity &&
        Number.isSafeInteger(value.target) &&
        value.target > 0 &&
        typeof value.focused === 'boolean' &&
        value.targetSource === 'native-payload'
      record('ios-native-focus', {
        phase:
          typeof value.phase === 'string' ? value.phase.slice(0, 64) : null,
        probeIdentity:
          typeof value.probeIdentity === 'string'
            ? value.probeIdentity.slice(0, 32)
            : null,
        target: Number.isSafeInteger(value.target) ? value.target : null,
        focused: value.focused === true,
        accepted: valid,
      })
      if (valid) focusedTarget = value.focused ? value.target : null
      return { accepted: valid }
    },
    operation(value) {
      if (
        closed ||
        uiState.phase !== value.phase ||
        uiState.probeIdentity !== value.probeIdentity ||
        value.operation !== 'focus-tap' ||
        !['start', 'finish'].includes(value.stage) ||
        !scalar(value.nativeMilliseconds) ||
        !boundedTargets({ ...value, type: 'input' })
      )
        return { accepted: false, reason: 'stale-ios-focus-operation' }
      record('ios-focus-physical-command', {
        phase: value.phase,
        probeIdentity: value.probeIdentity,
        operation: value.operation,
        stage: value.stage,
        nativeMilliseconds: value.nativeMilliseconds,
        identifier: value.identifier,
        frame: value.frame,
        visibleFrame: value.visibleFrame,
        succeeded: value.succeeded === true,
        acceptedAsActionEvidence: false,
      })
      return { accepted: true }
    },
    close(reason) {
      closed = true
      try {
        discard(reason)
      } finally {
        closeOffer(reason)
      }
      record('ui-owner-closed', { reason })
    },
    record,
    report() {
      return {
        correlationSchema: 2,
        strictCorrelation: true,
        closed,
        receiptPath,
        receiptBytes,
        receiptCount,
        retainedActionsPerPhase: 256,
        receiptLimitBytes: 32 * 1024 ** 2,
        inputTokenMaximumUnits: 14,
        textInputMaximumUnits: 32,
        nativeClock: 'CACurrentMediaTime in simulator processes, milliseconds',
        latencyClock:
          'host Date.now admission to original host callback receipt, milliseconds',
        unresolvedAction: activeAction
          ? {
              actionId: activeAction.id,
              phase: activeAction.phase,
              type: activeAction.type,
              probeIdentity: activeAction.probeIdentity,
            }
          : null,
      }
    },
  }
}
const iosUIControl = createIOSUIControl()

function beginUIAction(phase, type) {
  currentUIAction = {
    id: ++uiActionSequence,
    phase,
    type,
    startedAt: Date.now(),
  }
  return currentUIAction
}
function uiReport() {
  return {
    driver:
      platform === 'ios' ? 'XCUITest native events' : 'adb native input events',
    boundary:
      'Driver admission to actual application event delivered to local collector',
    phases: uiPhases,
    correlation:
      platform === 'android'
        ? androidUIControl.report()
        : iosUIControl.report(),
  }
}
const nativeStorageTokenPattern = /^storage-[a-f0-9]{32}-[1-9][0-9]{0,8}$/
const nativeStorageRecordLimit = 128
const nativeStoragePathUnits = 512
const nativeStorageTokenUnits = 64
const nativeStorageControlRecords = []
let nativeStorageControlRecordCount = 0
let nativeStorageControlRejectionCount = 0
let nativeStorageControlOmittedCount = 0
let nativeStorageControlPersistenceFailure
let nativeStorageReceiverFailureCount = 0
let nativeStorageReceiverUnprovenCount = 0
let firstNativeStorageReceiverFailure
const nativeStorageReceiverLineBytes = 8192
let nativeStorageReceiverCarry = Buffer.alloc(0)
let nativeStorageReceiverDiscardingLine = false
const nativeStorageSessionToken =
  'storage-' +
  createHash('sha256').update(sessionName).digest('hex').slice(0, 32) +
  '-'
let nativeStorageIssuedOrdinal = 0
let nativeStorageMeasurementOrdinal = 0
let nativeStorageOwnerClosed = false
let pendingStorageMeasurement
let lastSettledStorageMeasurement

function nativeStorageControlFailure(reason, message) {
  const failure = new Error(message ?? reason)
  failure.nativeStorageReason = reason
  return failure
}

function nativeStorageControlReason(failure) {
  return typeof failure?.nativeStorageReason === 'string'
    ? failure.nativeStorageReason
    : failure instanceof SyntaxError
      ? 'invalid-storage-json'
      : 'storage-control-failure'
}

function recordNativeStorageControl(kind, status, reason, value, identity) {
  const limitedString = (input, maximumUnits) =>
    typeof input === 'string' ? input.slice(0, maximumUnits) : null
  const limitedNumber = (input) =>
    typeof input === 'number' && Number.isFinite(input) ? input : null
  const valueType = (input) =>
    typeof input === 'number' && !Number.isFinite(input)
      ? 'nonfinite-number'
      : input === null
        ? 'null'
        : typeof input
  nativeStorageControlRecordCount = Math.min(
    Number.MAX_SAFE_INTEGER,
    nativeStorageControlRecordCount + 1,
  )
  if (status >= 400)
    nativeStorageControlRejectionCount = Math.min(
      Number.MAX_SAFE_INTEGER,
      nativeStorageControlRejectionCount + 1,
    )
  if (nativeStorageControlRecords.length >= nativeStorageRecordLimit) {
    nativeStorageControlOmittedCount = Math.min(
      Number.MAX_SAFE_INTEGER,
      nativeStorageControlOmittedCount + 1,
    )
    return
  }
  const record = {
    kind,
    status,
    reason: limitedString(reason, 128),
    expectedPath: limitedString(
      identity?.requestedPath,
      nativeStoragePathUnits,
    ),
    receivedPath: limitedString(value?.path, nativeStoragePathUnits),
    expectedPathTruncated:
      typeof identity?.requestedPath === 'string' &&
      identity.requestedPath.length > nativeStoragePathUnits,
    receivedPathTruncated:
      typeof value?.path === 'string' &&
      value.path.length > nativeStoragePathUnits,
    expectedMeasurementId: limitedString(
      identity?.measurementId,
      nativeStorageTokenUnits,
    ),
    receivedMeasurementId: limitedString(
      value?.measurementId,
      nativeStorageTokenUnits,
    ),
    receivedMeasurementIdTruncated:
      typeof value?.measurementId === 'string' &&
      value.measurementId.length > nativeStorageTokenUnits,
    databaseBytes: limitedNumber(value?.databaseBytes),
    databaseBytesType: valueType(value?.databaseBytes),
    walBytes: limitedNumber(value?.walBytes),
    walBytesType: valueType(value?.walBytes),
    bodyBytes: limitedNumber(value?.bodyBytes),
  }
  nativeStorageControlRecords.push(record)
  try {
    appendFileSync(
      collectorLog,
      JSON.stringify({ nativeStorageControl: record }) + '\n',
    )
  } catch (failure) {
    nativeStorageControlPersistenceFailure ??= String(failure).slice(0, 512)
    process.exitCode = 1
    rejectNativeResult(
      new Error('Native storage control evidence could not be preserved.'),
    )
  }
}

function nativeStorageControlReport() {
  return {
    schemaVersion: 1,
    maximumRetainedRecords: nativeStorageRecordLimit,
    maximumPathUnits: nativeStoragePathUnits,
    maximumTokenUnits: nativeStorageTokenUnits,
    recordCount: nativeStorageControlRecordCount,
    rejectionCount: nativeStorageControlRejectionCount,
    omittedRecords: nativeStorageControlOmittedCount,
    persistenceFailure: nativeStorageControlPersistenceFailure ?? null,
    receiverFailureCount: nativeStorageReceiverFailureCount,
    receiverUnprovenCount: nativeStorageReceiverUnprovenCount,
    firstReceiverFailure: firstNativeStorageReceiverFailure ?? null,
    maximumReceiverLineBytes: nativeStorageReceiverLineBytes,
    receiverFailureEvidence: runtimeLog,
    records: [...nativeStorageControlRecords],
  }
}

function unprovenNativeStorageReceiverMarker(reason) {
  nativeStorageReceiverUnprovenCount = Math.min(
    Number.MAX_SAFE_INTEGER,
    nativeStorageReceiverUnprovenCount + 1,
  )
  recordNativeStorageControl('receiver-marker-unproven', null, reason)
}

function receiveNativeStorageReceiverLine(bytes) {
  const text = bytes.toString('utf8').replace(/\r$/, '')
  if (!text.includes('Synloquent native storage callback failure ')) return
  if (!Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes)) {
    unprovenNativeStorageReceiverMarker('receiver-marker-invalid-utf8')
    return
  }
  const match =
    /^\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\s+[1-9]\d*\s+[1-9]\d*\s+E\s+ReactNativeJS\s*:\s*Synloquent native storage callback failure (\{.*\})$/.exec(
      text,
    )
  let value
  try {
    if (!match) throw new Error('invalid-receiver-marker-tag')
    value = JSON.parse(match[1])
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).sort().join(',') !==
        'measurementId,path,pathTruncated,reason,responseBody,responseCode,schema,schemaVersion' ||
      value.schema !== 'synloquent-native-storage-callback-failure' ||
      value.schemaVersion !== 1 ||
      typeof value.measurementId !== 'string' ||
      !nativeStorageTokenPattern.test(value.measurementId) ||
      !value.measurementId.startsWith(nativeStorageSessionToken) ||
      Number(value.measurementId.slice(nativeStorageSessionToken.length)) >
        nativeStorageIssuedOrdinal ||
      typeof value.path !== 'string' ||
      value.path.length > nativeStoragePathUnits ||
      typeof value.pathTruncated !== 'boolean' ||
      typeof value.reason !== 'string' ||
      !value.reason ||
      value.reason.length > 192 ||
      typeof value.responseBody !== 'string' ||
      value.responseBody.length > 192 ||
      !(
        value.responseCode === null ||
        value.responseCode === -1 ||
        (Number.isSafeInteger(value.responseCode) &&
          value.responseCode >= 100 &&
          value.responseCode <= 599)
      )
    )
      throw new Error('invalid-or-unissued-receiver-marker')
  } catch {
    unprovenNativeStorageReceiverMarker(
      'receiver-marker-not-owned-valid-evidence',
    )
    return
  }
  const identity = [
    pendingStorageMeasurement?.identity,
    lastSettledStorageMeasurement?.identity,
  ].find((entry) => entry?.measurementId === value.measurementId)
  if (
    identity &&
    (value.path !== identity.requestedPath.slice(0, nativeStoragePathUnits) ||
      value.pathTruncated !==
        identity.requestedPath.length > nativeStoragePathUnits)
  ) {
    unprovenNativeStorageReceiverMarker('receiver-marker-known-path-mismatch')
    return
  }
  nativeStorageReceiverFailureCount = Math.min(
    Number.MAX_SAFE_INTEGER,
    nativeStorageReceiverFailureCount + 1,
  )
  const firstFailure = firstNativeStorageReceiverFailure === undefined
  firstNativeStorageReceiverFailure ??= Object.freeze({ ...value })
  recordNativeStorageControl(
    'receiver-failure',
    value.responseCode,
    'issued-receiver-callback-failure',
    value,
    identity,
  )
  if (firstFailure)
    rejectNativeResult(
      new Error('Native storage receiver reported an owned callback failure.'),
    )
}

function observeNativeStorageReceiverOutput(content) {
  let offset = 0
  while (offset < content.length) {
    const newline = content.indexOf(10, offset)
    const finish = newline === -1 ? content.length : newline
    const piece = content.subarray(offset, finish)
    if (!nativeStorageReceiverDiscardingLine) {
      if (
        nativeStorageReceiverCarry.length + piece.length >
        nativeStorageReceiverLineBytes
      ) {
        const prefix = Buffer.concat([
          nativeStorageReceiverCarry,
          piece.subarray(
            0,
            nativeStorageReceiverLineBytes - nativeStorageReceiverCarry.length,
          ),
        ])
        if (
          prefix.includes(
            Buffer.from('Synloquent native storage callback failure '),
          )
        )
          unprovenNativeStorageReceiverMarker('receiver-marker-line-too-large')
        nativeStorageReceiverCarry = Buffer.alloc(0)
        nativeStorageReceiverDiscardingLine = true
      } else
        nativeStorageReceiverCarry = Buffer.concat([
          nativeStorageReceiverCarry,
          piece,
        ])
    }
    if (newline === -1) return
    if (!nativeStorageReceiverDiscardingLine)
      receiveNativeStorageReceiverLine(nativeStorageReceiverCarry)
    nativeStorageReceiverCarry = Buffer.alloc(0)
    nativeStorageReceiverDiscardingLine = false
    offset = newline + 1
  }
}

function closeNativeStorageReceiverOutput() {
  if (nativeStorageReceiverCarry.length && !nativeStorageReceiverDiscardingLine)
    receiveNativeStorageReceiverLine(nativeStorageReceiverCarry)
  nativeStorageReceiverCarry = Buffer.alloc(0)
  nativeStorageReceiverDiscardingLine = false
}

function closeNativeStorageMeasurement() {
  nativeStorageOwnerClosed = true
  const pending = pendingStorageMeasurement
  if (!pending || pending.state.measurementSettled) return
  pending.state.acceptingCallback = false
  pending.state.cancel?.(
    nativeStorageControlFailure(
      'storage-owner-closed',
      'Native physical storage measurement owner has closed.',
    ),
  )
}

async function sampleDatabaseStorage() {
  const requestedPath = nativeDatabasePath
  if (!requestedPath) return undefined
  if (measurementSchemaVersion === 2) {
    const sample =
      await calibrationHost.sampleSelectedTarget(nativeDatabasePath)
    storageSamples.push(sample)
    return sample
  }
  if (nativeStorageOwnerClosed)
    throw nativeStorageControlFailure('storage-owner-closed')
  if (platform === 'android') {
    if (pendingStorageMeasurement) {
      if (pendingStorageMeasurement.identity.requestedPath !== requestedPath)
        throw nativeStorageControlFailure('pending-storage-path-conflict')
      if (
        pendingStorageMeasurement.state.measurementSettled ||
        !pendingStorageMeasurement.state.acceptingCallback
      )
        throw nativeStorageControlFailure(
          'pending-storage-measurement-inactive',
        )
      return pendingStorageMeasurement.promise
    }
    if (nativeStorageMeasurementOrdinal >= 999999999)
      throw nativeStorageControlFailure(
        'storage-measurement-identity-exhausted',
      )
    const identity = Object.freeze({
      requestedPath,
      measurementId:
        nativeStorageSessionToken + ++nativeStorageMeasurementOrdinal,
    })
    const state = {
      acceptingCallback: true,
      commandSettled: false,
      callbackSettled: false,
      measurementSettled: false,
      resolveSample: undefined,
      rejectSample: undefined,
      cancel: undefined,
    }
    let timeout
    const releasePendingMeasurement = () => {
      if (
        state.commandSettled &&
        state.measurementSettled &&
        pendingStorageMeasurement?.identity === identity
      ) {
        lastSettledStorageMeasurement = Object.freeze({
          identity,
          callbackSettled: state.callbackSettled,
        })
        pendingStorageMeasurement = undefined
      }
    }
    const sampleReceived = new Promise((resolveSample, rejectSample) => {
      state.resolveSample = resolveSample
      state.rejectSample = rejectSample
    })
    const deadline = new Promise((_resolveDeadline, rejectDeadline) => {
      state.cancel = (failure) => {
        state.acceptingCallback = false
        state.rejectSample?.(failure)
        rejectDeadline(failure)
      }
      timeout = setTimeout(
        () =>
          state.cancel?.(
            nativeStorageControlFailure(
              'storage-measurement-timeout',
              'Native physical storage measurement did not arrive.',
            ),
          ),
        5000,
      )
    })
    const commandCompleted = Promise.resolve()
      .then(() => {
        if (nativeStorageOwnerClosed || !state.acceptingCallback)
          throw nativeStorageControlFailure('storage-owner-closed')
        nativeStorageIssuedOrdinal = nativeStorageMeasurementOrdinal
        return runCommand(androidBridge, [
          '-s',
          androidDevice,
          'shell',
          'am',
          'broadcast',
          '-n',
          applicationIdentifier + '/.StorageMeasurementReceiver',
          '--es',
          'path',
          identity.requestedPath,
          '--es',
          'measurementId',
          identity.measurementId,
        ])
      })
      .catch((failure) => {
        state.acceptingCallback = false
        const commandFailure = nativeStorageControlFailure(
          'storage-measurement-command-failed',
          String(failure),
        )
        commandFailure.cause = failure
        state.rejectSample?.(commandFailure)
        throw commandFailure
      })
      .finally(() => {
        state.commandSettled = true
        releasePendingMeasurement()
      })
    const measurement = Promise.race([
      Promise.all([sampleReceived, commandCompleted]).then(
        ([sample]) => sample,
      ),
      deadline,
    ]).finally(() => {
      state.measurementSettled = true
      state.acceptingCallback = false
      clearTimeout(timeout)
      state.resolveSample = undefined
      state.rejectSample = undefined
      state.cancel = undefined
      releasePendingMeasurement()
    })
    measurement.catch(() => undefined)
    pendingStorageMeasurement = Object.freeze({
      identity,
      state,
      promise: measurement,
    })
    return measurement
  }
  const size = (path) => (existsSync(path) ? statSync(path).size : 0)
  const sample = {
    timestamp: Date.now(),
    databaseBytes: size(requestedPath),
    walBytes: size(requestedPath + '-wal'),
  }
  storageSamples.push(sample)
  return sample
}

function receiveNativeStorageMeasurement(value) {
  if (platform !== 'android')
    throw nativeStorageControlFailure('native-storage-requires-android')
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw nativeStorageControlFailure('invalid-native-storage-object')
  if (
    typeof value.measurementId !== 'string' ||
    !nativeStorageTokenPattern.test(value.measurementId)
  )
    throw nativeStorageControlFailure('invalid-storage-measurement-identity')
  const pending = pendingStorageMeasurement
  if (!pending) {
    if (
      lastSettledStorageMeasurement?.identity.measurementId ===
      value.measurementId
    )
      throw nativeStorageControlFailure(
        lastSettledStorageMeasurement.callbackSettled
          ? 'duplicate-storage-callback'
          : 'late-storage-callback',
      )
    throw nativeStorageControlFailure('unsolicited-storage-callback')
  }
  if (
    nativeStorageOwnerClosed ||
    pending.state.measurementSettled ||
    !pending.state.acceptingCallback
  )
    throw nativeStorageControlFailure('inactive-storage-callback-owner')
  if (value.measurementId !== pending.identity.measurementId)
    throw nativeStorageControlFailure('storage-callback-owner-mismatch')
  if (
    value.path !== pending.identity.requestedPath ||
    nativeDatabasePath !== pending.identity.requestedPath
  )
    throw nativeStorageControlFailure('storage-callback-path-mismatch')
  if (pending.state.callbackSettled)
    throw nativeStorageControlFailure('duplicate-storage-callback')
  if (!Number.isSafeInteger(value.databaseBytes) || value.databaseBytes <= 0)
    throw nativeStorageControlFailure('invalid-physical-database-bytes')
  if (!Number.isSafeInteger(value.walBytes) || value.walBytes < 0)
    throw nativeStorageControlFailure('invalid-physical-wal-bytes')
  const sample = {
    timestamp: Date.now(),
    databaseBytes: value.databaseBytes,
    walBytes: value.walBytes,
  }
  pending.state.callbackSettled = true
  storageSamples.push(sample)
  pending.state.resolveSample(sample)
  pending.state.resolveSample = undefined
  return sample
}

async function registerNativeDatabasePath(value) {
  if (
    !value ||
    typeof value.path !== 'string' ||
    !value.path.includes('synloquent_performance_') ||
    value.path.includes('..') ||
    !value.path.endsWith('.sqlite') ||
    !/^[/A-Za-z0-9._-]+$/.test(value.path)
  )
    throw nativeStorageControlFailure(
      'invalid-task-owned-database-path',
      'Invalid task-owned native database path.',
    )
  if (platform === 'ios') {
    const container = commandOutput('xcrun', [
      'simctl',
      'get_app_container',
      simulatorIdentifier,
      applicationIdentifier,
      'data',
    ]).trim()
    if (!value.path.startsWith(container + '/'))
      throw nativeStorageControlFailure(
        'database-outside-task-container',
        'The database is outside the task application container.',
      )
  } else if (
    !value.path.startsWith('/data/user/0/' + applicationIdentifier + '/') &&
    !value.path.startsWith('/data/data/' + applicationIdentifier + '/')
  )
    throw nativeStorageControlFailure(
      'database-outside-task-container',
      'The database is outside the task application container.',
    )
  if (nativeStorageOwnerClosed)
    throw nativeStorageControlFailure('storage-owner-closed')
  const pending = platform === 'android' ? pendingStorageMeasurement : undefined
  if (pending) {
    if (pending.identity.requestedPath !== value.path)
      throw nativeStorageControlFailure('pending-storage-path-conflict')
    if (pending.state.measurementSettled || !pending.state.acceptingCallback)
      throw nativeStorageControlFailure('pending-storage-measurement-inactive')
  }
  nativeDatabasePath = value.path
  const receiving = sampleDatabaseStorage()
  const identity = pendingStorageMeasurement?.identity
  const sample = await receiving
  return { sample, identity, shared: pending !== undefined }
}

async function driveAndroidUI() {
  const initialReadinessDeadline = Date.now() + 60000
  await waitFor(() => uiState.phase === 'idle', 60000, 'actual UI idle phase')
  const hierarchyPath = '/sdcard/synloquent-native-performance.xml'
  const hierarchyOutputPath = resolve(
    artifactDirectory,
    'android-ui-hierarchy-current.txt',
  )
  let upward = true
  let scrollProbeIdentity
  let focusedIdentity
  let scrollBounds
  let initialTargetsPending = true
  let lastReadinessHierarchy
  let firstHierarchyCaptured = false
  let failureHierarchyCaptured = false
  const firstHierarchyPath = resolve(
    artifactDirectory,
    sessionName + '-android-ui-hierarchy-first.xml',
  )
  const failureHierarchyPath = resolve(
    artifactDirectory,
    sessionName + '-android-ui-hierarchy-failure.xml',
  )
  function preserveFailedHierarchy(hierarchy, failure) {
    if (failureHierarchyCaptured || Buffer.byteLength(hierarchy) >= 65536)
      return
    try {
      writeFileSync(failureHierarchyPath, hierarchy, { flag: 'wx' })
      failureHierarchyCaptured = true
      androidUIControl.record('hierarchy', {
        bytes: Buffer.byteLength(hierarchy),
        sha256: createHash('sha256').update(hierarchy).digest('hex'),
        phase: uiState.phase,
        probeIdentity: uiState.probeIdentity ?? null,
        retainedFilePath: failureHierarchyPath,
        diagnosticOnly: true,
        failure: String(failure).slice(0, 256),
      })
    } catch (captureFailure) {
      console.error(
        'Bounded failing hierarchy preservation failed',
        String(captureFailure).slice(0, 256),
      )
    }
  }
  async function command(argumentsList, purpose, action) {
    const startedAt = Date.now()
    let commandProcessIdentifier = null
    androidUIControl.record('host-command-start', {
      purpose,
      phase: uiState.phase,
      probeIdentity: uiState.probeIdentity ?? null,
      argumentsList,
    })
    try {
      await runCommand(
        androidBridge,
        ['-s', androidDevice, ...argumentsList],
        {
          outputPath: hierarchyOutputPath,
          maximumOutputBytes: 65536,
        },
        (processIdentifier) => {
          if (!Number.isInteger(processIdentifier) || processIdentifier <= 0)
            throw new Error(
              'The UI command has no actual host process identifier.',
            )
          commandProcessIdentifier = processIdentifier
          androidUIControl.record('host-command-owned', {
            purpose,
            commandProcessIdentifier,
            ...(measurementSchemaVersion === 2 && action
              ? {
                  actionId: action.id,
                  phase: action.phase,
                  probeIdentity: action.probeIdentity,
                }
              : {}),
          })
        },
      )
      androidUIControl.record('host-command-end', {
        purpose,
        startedAt,
        commandProcessIdentifier,
        succeeded: true,
      })
    } catch (failure) {
      androidUIControl.record('host-command-end', {
        purpose,
        startedAt,
        commandProcessIdentifier,
        succeeded: false,
        error: String(failure).slice(0, 256),
      })
      throw failure
    }
  }
  async function readHierarchy() {
    try {
      writeFileSync(hierarchyOutputPath, '')
      await command(
        ['shell', 'uiautomator', 'dump', hierarchyPath],
        'hierarchy-dump',
      )
      writeFileSync(hierarchyOutputPath, '')
      await command(['shell', 'cat', hierarchyPath], 'hierarchy-read')
      const hierarchy = readFileSync(hierarchyOutputPath, 'utf8')
      if (Buffer.byteLength(hierarchy) >= 65536)
        throw new Error('Native hierarchy exceeded bounded capture.')
      let retainedFilePath
      if (!firstHierarchyCaptured) {
        writeFileSync(firstHierarchyPath, hierarchy, { flag: 'wx' })
        firstHierarchyCaptured = true
        retainedFilePath = firstHierarchyPath
      }
      androidUIControl.record('hierarchy', {
        bytes: Buffer.byteLength(hierarchy),
        sha256: createHash('sha256').update(hierarchy).digest('hex'),
        phase: uiState.phase,
        probeIdentity: uiState.probeIdentity ?? null,
        ...(retainedFilePath ? { retainedFilePath, diagnosticOnly: true } : {}),
      })
      return hierarchy
    } finally {
      writeFileSync(hierarchyOutputPath, '')
      await command(['shell', 'rm', hierarchyPath], 'hierarchy-remove')
    }
  }
  function nativeNode(hierarchy, identifier) {
    return hierarchy.match(
      new RegExp(
        '<node[^>]*(?:resource-id="[^" ]*' +
          identifier +
          '"|content-desc="Native performance ' +
          identifier.replace('performance-', '') +
          '")[^>]*>',
      ),
    )?.[0]
  }
  function bounds(hierarchy, identifier, requireFocus = false) {
    try {
      const node = nativeNode(hierarchy, identifier)
      const coordinates = node?.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/)
      if (
        !coordinates ||
        !node.includes('package="' + applicationIdentifier + '"') ||
        !node.includes('enabled="true"') ||
        (requireFocus && !node.includes('focused="true"'))
      )
        throw new Error(
          'The current public native hierarchy has no enabled owned ' +
            identifier +
            (requireFocus ? ' focus.' : ' bounds.'),
        )
      const result = coordinates.slice(1).map(Number)
      if (
        result[2] <= result[0] ||
        result[3] <= result[1] ||
        (identifier === 'performance-scroll' && result[3] - result[1] < 48)
      )
        throw new Error(
          'The current native target has no usable visible bounds.',
        )
      return result
    } catch (failure) {
      preserveFailedHierarchy(hierarchy, failure)
      throw failure
    }
  }
  function current(identity) {
    return (
      !uiState.finished &&
      identity === uiState.phase + '/' + uiState.probeIdentity
    )
  }
  async function perform(type, argumentsList) {
    const action = androidUIControl.begin(type)
    if (!(await action.armed)) return action.completion
    let succeeded = false
    let failure
    try {
      if (type === 'input') {
        const identity = action.phase + '/' + action.probeIdentity
        const beforeClear = await readHierarchy()
        if (!current(identity)) return action.completion
        bounds(beforeClear, 'performance-input', true)
        const nativeText = nativeNode(beforeClear, 'performance-input').match(
          /\btext="([0-9a-z]{0,32})"/,
        )
        if (!nativeText)
          throw new Error('The owned native input has no bounded nonce text.')
        await command(
          [
            'shell',
            'input',
            'keyevent',
            'KEYCODE_MOVE_END',
            ...Array.from(
              { length: nativeText[1].length },
              () => 'KEYCODE_DEL',
            ),
          ],
          'clear-input',
          action,
        )
        if (!current(identity)) return action.completion
        const afterClear = await readHierarchy()
        if (!current(identity)) return action.completion
        bounds(afterClear, 'performance-input', true)
        if (!/\btext=""/.test(nativeNode(afterClear, 'performance-input')))
          throw new Error('The owned native input did not actually clear.')
        androidUIControl.record('input-clear-confirmed', {
          actionId: action.id,
          phase: action.phase,
          probeIdentity: action.probeIdentity,
          previousTextUnits: nativeText[1].length,
          keyEvents: nativeText[1].length + 1,
          focused: true,
          empty: true,
          hierarchySha256: createHash('sha256')
            .update(afterClear)
            .digest('hex'),
        })
      }
      if (!androidUIControl.startCommand(action)) return action.completion
      writeFileSync(hierarchyOutputPath, '')
      await command(
        type === 'input'
          ? ['shell', 'input', 'text', action.token]
          : argumentsList,
        type,
        action,
      )
      succeeded = true
    } catch (caught) {
      failure = caught
    }
    androidUIControl.commandSettled(action, succeeded, failure)
    if (failure) throw failure
    return action.completion
  }
  try {
    while (!uiState.finished) {
      if (initialTargetsPending && Date.now() >= initialReadinessDeadline) {
        const failure = new Error(
          'Timed out waiting for the first owned native UI targets.',
        )
        if (lastReadinessHierarchy)
          preserveFailedHierarchy(lastReadinessHierarchy, failure)
        throw failure
      }
      if (
        ![
          'idle',
          'sdk-import',
          'reference-import',
          'large-http',
          ...(measurementSchemaVersion === 2 ? ['catalog-read'] : []),
        ].includes(uiState.phase)
      ) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 50))
        continue
      }
      const identity = uiState.phase + '/' + uiState.probeIdentity
      if (scrollProbeIdentity !== uiState.probeIdentity) {
        upward = true
        scrollProbeIdentity = uiState.probeIdentity
      }
      if (focusedIdentity !== identity) {
        const hierarchy = await readHierarchy()
        if (!current(identity)) continue
        if (initialTargetsPending) {
          const inputNode = nativeNode(hierarchy, 'performance-input')
          const scrollNode = nativeNode(hierarchy, 'performance-scroll')
          if (inputNode) bounds(hierarchy, 'performance-input')
          if (scrollNode) bounds(hierarchy, 'performance-scroll')
          if (!inputNode || !scrollNode) {
            lastReadinessHierarchy = hierarchy
            if (Date.now() >= initialReadinessDeadline) {
              const failure = new Error(
                'Timed out waiting for the first owned native UI targets.',
              )
              preserveFailedHierarchy(hierarchy, failure)
              throw failure
            }
            continue
          }
          if (Date.now() >= initialReadinessDeadline) {
            const failure = new Error(
              'Timed out waiting for the first owned native UI targets.',
            )
            preserveFailedHierarchy(hierarchy, failure)
            throw failure
          }
        }
        const input = bounds(hierarchy, 'performance-input')
        let focusedHierarchy = hierarchy
        if (
          !nativeNode(hierarchy, 'performance-input').includes('focused="true"')
        ) {
          writeFileSync(hierarchyOutputPath, '')
          await command(
            [
              'shell',
              'input',
              'tap',
              String(Math.round((input[0] + input[2]) / 2)),
              String(Math.round((input[1] + input[3]) / 2)),
            ],
            'focus-input',
          )
          if (!current(identity)) continue
          focusedHierarchy = await readHierarchy()
          if (!current(identity)) continue
        }
        if (initialTargetsPending && Date.now() >= initialReadinessDeadline) {
          const failure = new Error(
            'Timed out waiting for the first owned native UI targets.',
          )
          preserveFailedHierarchy(focusedHierarchy, failure)
          throw failure
        }
        bounds(focusedHierarchy, 'performance-input', true)
        scrollBounds = bounds(focusedHierarchy, 'performance-scroll')
        androidUIControl.record('targets', {
          phase: uiState.phase,
          probeIdentity: uiState.probeIdentity,
          inputBounds: input,
          scrollBounds,
          focused: true,
        })
        focusedIdentity = identity
        initialTargetsPending = false
        lastReadinessHierarchy = undefined
      }
      await perform('input')
      if (!current(identity)) continue
      const horizontal = String(
        Math.round((scrollBounds[0] + scrollBounds[2]) / 2),
      )
      const top = String(scrollBounds[1] + 20)
      const bottom = String(scrollBounds[3] - 20)
      await perform('scroll', [
        'shell',
        'input',
        'swipe',
        horizontal,
        upward ? bottom : top,
        horizontal,
        upward ? top : bottom,
        '180',
      ])
      upward = !upward
    }
  } finally {
    if (existsSync(hierarchyOutputPath)) unlinkSync(hierarchyOutputPath)
  }
}

function sampleResidentMemory() {
  if (residentMemorySamplingInFlight) return residentMemorySamplingInFlight
  if (
    legacyHostObservationClosing ||
    taskProcessCleanupStarted ||
    processOwnerClosing
  )
    return Promise.resolve()
  residentMemorySamplingInFlight = (async () => {
    try {
      let residentBytes
      if (platform === 'android') {
        const content = (
          await runCalibrationObservation(
            androidBridge,
            [
              '-s',
              androidDevice,
              'shell',
              'dumpsys',
              'meminfo',
              applicationIdentifier,
            ],
            undefined,
            'resident-memory',
          )
        ).toString('utf8')
        const match = content.match(/TOTAL RSS:\s+(\d+)/)
        if (match) residentBytes = Number(match[1]) * 1024
      } else if (applicationProcessIdentifier) {
        const content = (
          await runCalibrationObservation(
            'ps',
            ['-o', 'rss=', '-p', String(applicationProcessIdentifier)],
            undefined,
            'resident-memory',
          )
        ).toString('utf8')
        residentBytes = Number(content.trim()) * 1024
      }
      if (taskProcessCleanupStarted || processOwnerClosing) return
      if (residentBytes && Number.isSafeInteger(residentBytes))
        memorySamples.push({
          timestamp: new Date().toISOString(),
          residentBytes,
        })
    } catch {
      // The process can finish between the status read and the sample.
    }
  })().finally(() => {
    residentMemorySamplingInFlight = undefined
  })
  return residentMemorySamplingInFlight
}
function beginMemorySampling() {
  if (measurementSchemaVersion === 2) {
    calibrationHost.startSampling()
    return
  }
  void sampleResidentMemory()
  memoryTimer = setInterval(() => {
    void sampleResidentMemory()
    void sampleDatabaseStorage().catch(rejectNativeResult)
  }, 1000)
}
let resolveNativeResult
let rejectNativeResult
const nativeResultPromise = new Promise((resolveResult, rejectResult) => {
  resolveNativeResult = resolveResult
  rejectNativeResult = rejectResult
})
// The listener is attached before a native result can arrive.
nativeResultPromise.catch(() => undefined)

mkdirSync(artifactDirectory, { recursive: true })
writeFileSync(buildLog, '')
const calibrationProgramBefore =
  measurementSchemaVersion === 2
    ? {
        sourceFingerprint,
        instrumentation: instrumentationFingerprint(),
        requestSpecificationSha256:
          ownedCalibrationSpecification.specificationSha256,
      }
    : undefined
if (calibrationProgramBefore)
  writeFileSync(
    resolve(artifactDirectory, 'program-before.json'),
    JSON.stringify(calibrationProgramBefore) + '\n',
    { flag: 'wx' },
  )
if (existsSync(resultPath)) unlinkSync(resultPath)
function checkpointSession(state) {
  writeFileSync(
    sessionPath,
    JSON.stringify(
      {
        sessionName,
        state,
        platform,
        sourceFingerprint,
        candidateFingerprint,
        processIdentities,
        processOwnerAudit,
        observedDescendants: [...observedDescendants.values()],
        emulatorTemporaryFiles: [...emulatorTemporaryFiles.values()],
        cleanupFailures,
        simulatorIdentifier,
        androidDevice,
        artifactDirectory,
      },
      null,
      2,
    ) + '\n',
  )
}

function recordCleanupFailure(operation, failure) {
  cleanupFailures.push({
    operation,
    error: String(failure),
    time: new Date().toISOString(),
  })
  process.exitCode = 1
  console.error(`Native cleanup failed during ${operation}: ${String(failure)}`)
}

async function cleanupStep(operation, callback) {
  try {
    await callback()
  } catch (failure) {
    recordCleanupFailure(operation, failure)
  }
}

async function processSnapshot() {
  const content = await runCalibrationObservation(
    'ps',
    ['-axo', 'pid,ppid,pgid,command'],
    maximumOwnershipPacketBytes,
    'descendant-snapshot',
  )
  return content
    .toString('utf8')
    .split('\n')
    .slice(1)
    .flatMap((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/)
      return match
        ? [
            {
              processIdentifier: Number(match[1]),
              parentIdentifier: Number(match[2]),
              processGroupIdentifier: Number(match[3]),
              command: match[4],
            },
          ]
        : []
    })
}

function captureEmulatorTemporaryFiles() {
  if (!ownsEmulator || !emulatorProcessIdentifier) return
  const handles = spawnSync(
    'lsof',
    ['-p', String(emulatorProcessIdentifier), '-Fn'],
    { encoding: 'utf8', timeout: 3000 },
  )
  if (handles.status !== 0) return
  const temporaryDirectory = `/private/tmp/android-${userInfo().username}`
  for (const line of handles.stdout.split('\n')) {
    if (!line.startsWith('n' + temporaryDirectory + '/emulator-')) continue
    const path = line.slice(1)
    if (!existsSync(path)) continue
    let identity
    try {
      identity = statSync(path)
    } catch (failure) {
      if (failure.code === 'ENOENT') continue
      throw failure
    }
    if (
      !identity.isFile() ||
      identity.birthtimeMs <
        (measurementSchemaVersion === 2
          ? sessionStartedAtMilliseconds
          : Number(sessionName.split('-').at(-1)))
    )
      continue
    emulatorTemporaryFiles.set(path, {
      path,
      inode: identity.ino,
      birthtimeMilliseconds: identity.birthtimeMs,
      observedOpenByProcessIdentifier: emulatorProcessIdentifier,
      removed: false,
    })
  }
}

async function removeEmulatorTemporaryFiles() {
  for (const file of emulatorTemporaryFiles.values()) {
    await cleanupStep(`emulator temporary file ${file.path}`, () => {
      let identity
      try {
        identity = statSync(file.path)
      } catch (failure) {
        if (failure.code !== 'ENOENT') throw failure
        file.removed = true
        return
      }
      if (
        identity.ino !== file.inode ||
        identity.birthtimeMs !== file.birthtimeMilliseconds
      )
        throw new Error('The task emulator temporary file identity changed.')
      const handles = spawnSync('lsof', [file.path], {
        encoding: 'utf8',
        timeout: 3000,
      })
      if (handles.status !== 1 || handles.stdout)
        throw new Error(
          'A task emulator temporary file still has open handles.',
        )
      unlinkSync(file.path)
      file.removed = true
    })
  }
}

function captureDescendants() {
  if (descendantCaptureInFlight) return descendantCaptureInFlight
  if (taskProcessCleanupStarted || processOwnerClosing) return Promise.resolve()
  descendantCaptureInFlight = (async () => {
    const processes = await processSnapshot()
    if (taskProcessCleanupStarted || processOwnerClosing)
      throw new Error(
        'Legacy descendant snapshot completed after cleanup started.',
      )
    if (platform === 'ios' && performanceSuite)
      for (const observed of processes)
        if (
          observed.command.includes(simulatorIdentifier + '/') &&
          observed.command.includes('/SynloquentPerformanceUITests-Runner.app/')
        )
          observedDescendants.set(observed.processIdentifier, observed)
    const parents = new Set([...ownedProcesses].map((child) => child.pid))
    let added = true
    while (added) {
      added = false
      for (const observed of processes) {
        if (
          !parents.has(observed.processIdentifier) &&
          parents.has(observed.parentIdentifier)
        ) {
          parents.add(observed.processIdentifier)
          observedDescendants.set(observed.processIdentifier, observed)
          added = true
        }
      }
    }
    await discoverOwnedProcessGroups()
  })().finally(() => {
    descendantCaptureInFlight = undefined
  })
  return descendantCaptureInFlight
}

async function drainLegacyHostObservations() {
  legacyHostObservationClosing = true
  clearInterval(memoryTimer)
  clearInterval(descendantMonitor)
  const completion = (async () => {
    await cleanupStep(
      'legacy resident memory sampling drainage',
      () => residentMemorySamplingInFlight,
    )
    await cleanupStep(
      'legacy descendant sampling drainage',
      () => descendantCaptureInFlight,
    )
    if (taskProcessCleanupStarted || processOwnerClosing)
      throw new Error(
        'Final descendant capture could not run before cleanup started.',
      )
    await cleanupStep('capture task descendants', captureDescendants)
  })()
  let timeout
  try {
    await Promise.race([
      completion,
      new Promise((_resolveCompletion, rejectCompletion) => {
        timeout = setTimeout(
          () =>
            rejectCompletion(
              new Error(
                'Task command completion did not settle during cleanup.',
              ),
            ),
          5000,
        )
      }),
    ])
  } catch (failure) {
    recordCleanupFailure('legacy host observation drainage', failure)
  } finally {
    clearTimeout(timeout)
  }
}
async function closeObservedDescendants() {
  const identifiers = [...observedDescendants.keys()]
  for (let attempt = 0; attempt < 6; attempt += 1) {
    let remaining = false
    for (const processIdentifier of identifiers) {
      const current = await guardObservedProcess(processIdentifier)
      if (current.state !== 'closed') remaining = true
    }
    if (!remaining) return
    await new Promise((resolveWait) => setTimeout(resolveWait, 500))
  }
  for (const processIdentifier of identifiers)
    await guardObservedProcess(processIdentifier, 'SIGTERM')
  await new Promise((resolveWait) => setTimeout(resolveWait, 500))
  for (const processIdentifier of identifiers)
    await guardObservedProcess(processIdentifier, 'SIGKILL')
}

const descendantMonitor = setInterval(() => {
  if (
    legacyHostObservationClosing ||
    taskProcessCleanupStarted ||
    processOwnerClosing ||
    descendantCaptureInFlight
  )
    return
  void captureDescendants().catch((failure) =>
    recordCleanupFailure('capture task descendants', failure),
  )
}, 500)
descendantMonitor.unref()

function commandOutput(command, argumentsList) {
  const execution = spawnSync(command, argumentsList, {
    cwd: exampleDirectory,
    encoding: 'utf8',
  })
  if (execution.status !== 0)
    throw new Error(
      `${command} failed: ${execution.stderr || execution.stdout}`,
    )
  return execution.stdout
}
function freeDiskBytes() {
  const output = commandOutput('df', ['-k', repositoryDirectory])
    .trim()
    .split('\n')
    .at(-1)
    .trim()
    .split(/\s+/)
  return Number(output[3]) * 1024
}
const maximumOwnershipPacketBytes = 1024 * 1024
const maximumOwnershipRequests = 65536
let processOwnerReader
let processOwnerReady
let processOwnerSequence = 0
let processOwnerClosing = false
let taskProcessCleanupStarted = false
let targetedEnrollmentInFlight
const taskCommandCompletions = new Set()
const ownedProcessGroups = new Map()
const processOwnerAudit = {
  ready: false,
  closed: false,
  requests: 0,
  refusals: 0,
}

function requestProcessOwnership(operation, values = {}) {
  if (
    !processOwnerReader ||
    processOwnerReader.protocolFailure ||
    (processOwnerClosing && operation !== 'shutdown')
  )
    return Promise.reject(
      new Error('The task process owner reader is unavailable.'),
    )
  if (processOwnerReader.pending.size >= 128)
    return Promise.reject(
      new Error('Task process owner pending requests exceeded their bound.'),
    )
  if (++processOwnerSequence > maximumOwnershipRequests)
    return Promise.reject(
      new Error('Task process owner requests exceeded their bound.'),
    )
  const sequence = processOwnerSequence
  const content = JSON.stringify({ sequence, operation, ...values }) + '\n'
  if (Buffer.byteLength(content) > maximumOwnershipPacketBytes)
    return Promise.reject(
      new Error('Task process owner request exceeded its byte bound.'),
    )
  processOwnerAudit.requests += 1
  return new Promise((resolveResponse, rejectResponse) => {
    const timeout = setTimeout(() => {
      processOwnerReader.pending.delete(sequence)
      const failure = new Error(
        'Task process owner reply did not arrive within 5000 ms.',
      )
      failProcessOwnerReader(failure)
      rejectResponse(failure)
    }, 5000)
    processOwnerReader.pending.set(sequence, {
      resolve: resolveResponse,
      reject: rejectResponse,
      timeout,
    })
    processOwnerReader.child.stdin.write(content, (failure) => {
      if (!failure) return
      const pending = processOwnerReader.pending.get(sequence)
      if (!pending) return
      processOwnerReader.pending.delete(sequence)
      clearTimeout(pending.timeout)
      pending.reject(failure)
      failProcessOwnerReader(failure)
    })
  })
}

function rejectOwnershipReplies(failure) {
  if (!processOwnerReader) return
  for (const pending of processOwnerReader.pending.values()) {
    clearTimeout(pending.timeout)
    pending.reject(failure)
  }
  processOwnerReader.pending.clear()
}

function failProcessOwnerReader(failure) {
  if (!processOwnerReader) return
  processOwnerReader.protocolFailure ??= failure
  processOwnerAudit.protocolFailure = String(failure)
  rejectOwnershipReplies(failure)
  if (
    !processOwnerReader.child.stdin.destroyed &&
    !processOwnerReader.child.stdin.writableEnded
  )
    processOwnerReader.child.stdin.end()
}

async function ensureProcessOwnerReader() {
  if (processOwnerReady) return processOwnerReady
  processOwnerReady = (async () => {
    const readerPath = resolve(
      repositoryDirectory,
      'scripts/native/process-owner-reader.py',
    )
    const readerLaunchMicroseconds = Date.now() * 1000
    const argumentsList = [readerPath, '--owner-pid', String(process.pid)]
    const child = spawn('python3', argumentsList, {
      cwd: repositoryDirectory,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const pending = new Map()
    let responseText = ''
    let stderrBytes = 0
    const completed = new Promise((resolveExit, rejectExit) => {
      child.once('error', rejectExit)
      child.once('close', (exitCode, exitSignal) =>
        resolveExit({ exitCode, exitSignal }),
      )
    })
    completed.catch(() => undefined)
    processOwnerReader = { child, pending, completed }
    processOwnerAudit.readerPid = child.pid
    const record = {
      processIdentifier: child.pid,
      command: 'python3',
      argumentsList,
      cwd: repositoryDirectory,
      purpose: 'persistent targeted process owner reader',
    }
    processIdentities.push(record)
    checkpointSession('running')
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (content) => {
      responseText += content
      if (Buffer.byteLength(responseText) > maximumOwnershipPacketBytes) {
        failProcessOwnerReader(
          new Error('Task process owner reply exceeded its byte bound.'),
        )
        return
      }
      let newline
      while ((newline = responseText.indexOf('\n')) >= 0) {
        const line = responseText.slice(0, newline)
        responseText = responseText.slice(newline + 1)
        let response
        try {
          response = JSON.parse(line)
          if (
            response.version !== 1 ||
            !Number.isSafeInteger(response.sequence) ||
            typeof response.ok !== 'boolean'
          )
            throw new Error('Invalid task process owner reply.')
          const waiting = pending.get(response.sequence)
          if (!waiting)
            throw new Error('Unbound or late task process owner reply.')
          pending.delete(response.sequence)
          clearTimeout(waiting.timeout)
          if (response.ok) waiting.resolve(response.result)
          else {
            processOwnerAudit.refusals += 1
            waiting.reject(
              new Error('Task process ownership refused: ' + response.error),
            )
          }
        } catch (failure) {
          failProcessOwnerReader(failure)
        }
      }
    })
    child.stderr.on('data', (content) => {
      const remaining = maximumOwnershipPacketBytes - stderrBytes
      if (remaining <= 0) return
      const bounded = content.subarray(0, remaining)
      stderrBytes += bounded.length
      appendFileSync(buildLog, bounded)
    })
    child.on('error', failProcessOwnerReader)
    child.stdin.on('error', failProcessOwnerReader)
    child.stdout.once('end', () => {
      if (responseText.length || pending.size || !processOwnerClosing)
        failProcessOwnerReader(
          new Error('Task process owner partial or unexpected EOF.'),
        )
    })
    const hello = await requestProcessOwnership('hello')
    if (
      hello.state !== 'ready' ||
      hello.readerIdentity?.pid !== child.pid ||
      hello.readerIdentity?.parentPid !== process.pid ||
      hello.readerIdentity?.pgid !== child.pid ||
      hello.ownerIdentity?.pid !== process.pid ||
      hello.readerIdentity?.userId !== hello.ownerIdentity?.userId ||
      !Number.isSafeInteger(hello.readerIdentity?.birthMicroseconds) ||
      hello.readerIdentity.birthMicroseconds < readerLaunchMicroseconds ||
      typeof hello.readerIdentity?.executablePath !== 'string' ||
      !hello.readerIdentity.executablePath ||
      !Array.isArray(hello.readerIdentity?.argv) ||
      hello.readerIdentity.argv.length !== 4 ||
      hello.readerIdentity.argv[1] !== readerPath ||
      hello.readerIdentity.argv[2] !== '--owner-pid' ||
      hello.readerIdentity.argv[3] !== String(process.pid)
    ) {
      const failure = new Error(
        'Persistent task reader bootstrap identity is not bound.',
      )
      failProcessOwnerReader(failure)
      throw failure
    }
    record.kernelIdentity = hello.readerIdentity
    processOwnerAudit.readerIdentity = hello.readerIdentity
    processOwnerAudit.ownerIdentity = hello.ownerIdentity
    processOwnerAudit.ready = true
    return processOwnerReader
  })()
  return processOwnerReady
}

async function discoverOwnedProcessGroups() {
  if (!processOwnerReady || !ownedProcessGroups.size) return
  if (targetedEnrollmentInFlight) return targetedEnrollmentInFlight
  targetedEnrollmentInFlight = (async () => {
    for (const [leaderPid, entry] of ownedProcessGroups) {
      if (entry.closedAndReaped) continue
      const result = await requestProcessOwnership('discover', { leaderPid })
      entry.closedAndReaped =
        result.state === 'closed' &&
        (entry.child.exitCode !== null || entry.child.signalCode !== null)
    }
  })().finally(() => {
    targetedEnrollmentInFlight = undefined
  })
  return targetedEnrollmentInFlight
}

async function terminateProcessGroup(processIdentifier, signal = 'SIGTERM') {
  if (!processIdentifier) return
  if (!ownedProcessGroups.has(processIdentifier))
    throw new Error('Task group lacks its immutable launch record.')
  return requestProcessOwnership('signal-group', {
    leaderPid: processIdentifier,
    signal,
  })
}

async function guardObservedProcess(processIdentifier, signal) {
  await ensureProcessOwnerReader()
  return requestProcessOwnership(
    signal ? 'signal-observed' : 'probe-observed',
    { pid: processIdentifier, ...(signal ? { signal } : {}) },
  )
}

async function settleTaskCommands() {
  const completions = [
    ...[...ownedProcessGroups.values()].map((record) =>
      record.child.completed.catch(() => undefined),
    ),
    ...[...taskCommandCompletions].map((completion) =>
      completion.catch(() => undefined),
    ),
  ]
  let timeout
  try {
    await Promise.race([
      Promise.all(completions),
      new Promise((_resolveCompletion, rejectCompletion) => {
        timeout = setTimeout(
          () =>
            rejectCompletion(
              new Error(
                'Task command completion did not settle during cleanup.',
              ),
            ),
          5000,
        )
      }),
    ])
  } finally {
    clearTimeout(timeout)
  }
}

async function closeProcessOwnerReader() {
  if (!processOwnerReader) {
    processOwnerAudit.closed = true
    return
  }
  let failure = processOwnerReader.protocolFailure
  try {
    if (targetedEnrollmentInFlight) await targetedEnrollmentInFlight
    processOwnerClosing = true
    if (failure) throw failure
    const shutdown = await requestProcessOwnership('shutdown')
    if (shutdown.state !== 'closed')
      throw new Error(
        'Task process owner shutdown has no complete closed verdict.',
      )
    processOwnerAudit.enrollmentHistory = shutdown.enrollmentHistory
  } catch (error) {
    failure = error
  } finally {
    if (
      !processOwnerReader.child.stdin.destroyed &&
      !processOwnerReader.child.stdin.writableEnded
    )
      processOwnerReader.child.stdin.end()
  }
  let timeout
  try {
    const completion = await Promise.race([
      processOwnerReader.completed,
      new Promise((_resolveExit, rejectExit) => {
        timeout = setTimeout(
          () =>
            rejectExit(
              new Error('Task process owner reader did not exit after EOF.'),
            ),
          5000,
        )
      }),
    ])
    failure ??= processOwnerReader.protocolFailure
    processOwnerAudit.readerExitObserved = true
    processOwnerAudit.readerReaped = true
    processOwnerAudit.exitCode = completion.exitCode
    processOwnerAudit.exitSignal = completion.exitSignal
    processOwnerAudit.closed =
      !failure && completion.exitCode === 0 && completion.exitSignal === null
    if (!processOwnerAudit.closed)
      failure ??= new Error('Task process owner reader failed during shutdown.')
  } catch (error) {
    failure ??= error
  } finally {
    clearTimeout(timeout)
    rejectOwnershipReplies(
      failure ?? new Error('Task process owner reader has closed.'),
    )
    processOwnerReader.child.stdin.destroy()
    processOwnerReader.child.stdout.destroy()
    processOwnerReader.child.stderr.destroy()
    processOwnerReader.child.unref()
  }
  if (failure) throw failure
}

async function classifyClosedTaskCommandAfterReap(child, record, failure) {
  if (
    child.closeObserved !== true ||
    (child.exitCode === null && child.signalCode === null)
  )
    return false
  try {
    const entry = ownedProcessGroups.get(child.pid)
    if (
      entry?.child !== child ||
      entry.record !== record ||
      record.processIdentifier !== child.pid
    )
      throw new Error('Closed task command lacks its exact launch entry.', {
        cause: failure,
      })
    const closure = await requestProcessOwnership('discover', {
      leaderPid: child.pid,
    })
    if (
      closure.state !== 'closed' ||
      closure.leaderPid !== child.pid ||
      !Array.isArray(closure.members) ||
      closure.members.length !== 0 ||
      ownedProcessGroups.get(child.pid) !== entry ||
      child.closeObserved !== true ||
      (child.exitCode === null && child.signalCode === null)
    )
      throw new Error('Reaped task command lacks exact empty-group closure.', {
        cause: failure,
      })
    record.kernelEnrollment = {
      state: 'closed-after-reap',
      leaderPid: child.pid,
      members: [],
      originalEnrollmentRefusal: record.ownershipEnrollmentRefusal,
    }
    entry.closedAndReaped = true
    return true
  } catch (closureFailure) {
    record.closedAfterReapClassificationFailure = String(closureFailure).slice(
      0,
      4096,
    )
    return false
  }
}

async function startProcess(
  command,
  argumentsList,
  options = {},
  deferEnrollmentFailure = false,
) {
  await ensureProcessOwnerReader()
  if (taskProcessCleanupStarted || processOwnerClosing)
    throw new Error(
      'A new task process cannot launch after cleanup has started.',
    )
  const launchedMicroseconds = Date.now() * 1000
  const child = spawn(command, argumentsList, {
    cwd: options.cwd ?? exampleDirectory,
    env: { ...process.env, ...options.env },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  ownedProcesses.add(child)
  child.completed = new Promise((resolveExit, rejectExit) => {
    child.once('error', (failure) => {
      ownedProcesses.delete(child)
      rejectExit(failure)
    })
    child.once('close', (exitCode) => {
      child.closeObserved = true
      ownedProcesses.delete(child)
      resolveExit(exitCode)
    })
  })
  child.completed.catch(() => undefined)
  const record = {
    processIdentifier: child.pid,
    command,
    argumentsList,
    cwd: options.cwd ?? exampleDirectory,
  }
  processIdentities.push(record)
  if (child.pid) ownedProcessGroups.set(child.pid, { child, record })
  checkpointSession('running')
  let writtenBytes = 0
  const recordOutput = (content) => {
    const remainingBytes =
      (options.maximumOutputBytes ?? Infinity) - writtenBytes
    if (remainingBytes <= 0) return
    const boundedContent = content.subarray(0, remainingBytes)
    writtenBytes += boundedContent.length
    if (options.outputPath === runtimeLog)
      observeNativeStorageReceiverOutput(boundedContent)
    appendFileSync(options.outputPath ?? buildLog, boundedContent)
  }
  if (options.exactStdoutPath) {
    const retain = (path, content) => {
      writtenBytes += content.length
      if (writtenBytes > options.maximumOutputBytes) {
        child.outputEvidenceFailure ??= new Error(
          'Exact owned command output exceeded its explicit byte bound.',
        )
        return
      }
      appendFileSync(path, content)
    }
    child.stdout.on('data', (content) =>
      retain(options.exactStdoutPath, content),
    )
    child.stderr.on('data', (content) =>
      retain(options.exactStderrPath, content),
    )
  } else {
    child.stdout.on('data', recordOutput)
    child.stderr.on('data', recordOutput)
  }
  if (!child.pid) {
    await child.completed
    throw new Error('Task command has no actual host process identifier.')
  }
  try {
    const enrollment = await requestProcessOwnership('enroll', {
      pid: child.pid,
      launchedMicroseconds,
    })
    record.kernelEnrollment = enrollment
  } catch (failure) {
    const refusalMessage = String(failure)
    record.ownershipEnrollmentRefusal = {
      message: refusalMessage.slice(0, 4096),
      messageCharacters: refusalMessage.length,
      messageTruncated: refusalMessage.length > 4096,
    }
    let closedAfterReap = false
    if (
      !deferEnrollmentFailure &&
      child.closeObserved === true &&
      (child.exitCode !== null || child.signalCode !== null)
    ) {
      try {
        await child.completed
        closedAfterReap = await classifyClosedTaskCommandAfterReap(
          child,
          record,
          failure,
        )
      } catch (closureFailure) {
        record.closedAfterReapClassificationFailure = String(
          closureFailure,
        ).slice(0, 4096)
      }
    }
    if (!closedAfterReap) {
      child.ownershipEnrollmentFailure = failure
      if (deferEnrollmentFailure) child.ownershipEnrollmentRecord = record
      else {
        recordCleanupFailure('task command enrollment ' + child.pid, failure)
        throw failure
      }
    }
  } finally {
    checkpointSession('running')
  }
  return child
}

async function runCommand(command, argumentsList, options, processStarted) {
  const completion = (async () => {
    console.log('Running ' + command + ' ' + argumentsList.join(' '))
    const child = await startProcess(command, argumentsList, options, true)
    let observerFailure
    try {
      processStarted?.(child.pid)
    } catch (failure) {
      observerFailure = failure
    }
    let exitCode
    let completionFailure
    try {
      exitCode = await child.completed
    } catch (failure) {
      completionFailure = failure
    }
    let closureFailure = child.ownershipEnrollmentFailure
    if (child.ownershipEnrollmentRecord) {
      const closedAfterReap =
        !completionFailure &&
        (await classifyClosedTaskCommandAfterReap(
          child,
          child.ownershipEnrollmentRecord,
          closureFailure,
        ))
      if (closedAfterReap) closureFailure = undefined
      else
        recordCleanupFailure(
          'task command enrollment ' + child.pid,
          closureFailure,
        )
    }
    try {
      const entry = ownedProcessGroups.get(child.pid)
      if (entry?.child !== child || entry.closedAndReaped !== true)
        await terminateProcessGroup(child.pid)
    } catch (failure) {
      closureFailure ??= failure
      recordCleanupFailure('task command group ' + child.pid, failure)
    }
    if (completionFailure) {
      if (closureFailure) completionFailure.cause ??= closureFailure
      throw completionFailure
    }
    if (exitCode !== 0) {
      const failure = new Error(
        'Command exited ' + exitCode + '. Inspect ' + buildLog,
      )
      if (closureFailure) failure.cause = closureFailure
      throw failure
    }
    if (closureFailure) throw closureFailure
    if (observerFailure) throw observerFailure
    if (child.outputEvidenceFailure) throw child.outputEvidenceFailure
  })()
  taskCommandCompletions.add(completion)
  try {
    return await completion
  } finally {
    taskCommandCompletions.delete(completion)
  }
}

const waitFor = async (predicate, timeoutMilliseconds, label) => {
  const started = Date.now()
  while (Date.now() - started < timeoutMilliseconds) {
    if (await predicate()) return
    await new Promise((resolveWait) => setTimeout(resolveWait, 1000))
  }
  throw new Error(`Timed out waiting for ${label}.`)
}
function androidDeviceConnected() {
  const devices = spawnSync(androidBridge, ['devices'], {
    encoding: 'utf8',
    timeout: 3000,
  })
  return (
    devices.status === 0 && devices.stdout.includes(androidDevice + '\tdevice')
  )
}
async function waitForOwnedEmulatorGracefulClosure() {
  const entry = ownedProcessGroups.get(emulatorProcessIdentifier)
  if (
    !entry ||
    entry.child.pid !== emulatorProcessIdentifier ||
    entry.record.processIdentifier !== emulatorProcessIdentifier ||
    entry.record.kernelEnrollment?.state !== 'enrolled' ||
    entry.record.kernelEnrollment.leaderPid !== emulatorProcessIdentifier
  )
    throw new Error('The owned emulator lacks its immutable launch enrollment.')
  const deadline = performance.now() + 5000
  for (let attempt = 0; attempt < 51; attempt += 1) {
    if (attempt > 0 && performance.now() >= deadline) return false
    const result = await requestProcessOwnership('discover', {
      leaderPid: emulatorProcessIdentifier,
    })
    entry.closedAndReaped =
      result.state === 'closed' &&
      (entry.child.exitCode !== null || entry.child.signalCode !== null)
    if (entry.closedAndReaped) return true
    const remainingMilliseconds = deadline - performance.now()
    if (remainingMilliseconds <= 0 || attempt === 50) return false
    await new Promise((resolveWait) =>
      setTimeout(resolveWait, Math.min(100, remainingMilliseconds)),
    )
  }
  return false
}

async function cleanup() {
  let ownedEmulatorClosedAndReaped = false
  taskProcessCleanupStarted = true
  closeNativeStorageMeasurement()
  clearInterval(memoryTimer)
  clearInterval(descendantMonitor)
  clearTimeout(resultTimeout)
  if (performanceSuite && platform === 'android')
    await cleanupStep('Android UI action owner', () =>
      androidUIControl.close('runner-cleanup'),
    )
  if (performanceSuite && platform === 'ios')
    await cleanupStep('iOS UI action owner', () =>
      iosUIControl.close('runner-cleanup'),
    )
  if (networkProxy)
    await cleanupStep('diagnostic network proxy', () => networkProxy.close())
  await cleanupStep(
    'capture emulator temporary files',
    captureEmulatorTemporaryFiles,
  )
  if (platform === 'android' && androidDeviceConnected()) {
    for (const port of ['8767', '8765', '8766']) {
      await cleanupStep(`Android reverse port ${port}`, () =>
        spawnSync(
          androidBridge,
          ['-s', androidDevice, 'reverse', '--remove', `tcp:${port}`],
          { encoding: 'utf8' },
        ),
      )
    }
    await cleanupStep('Android application stop', () =>
      spawnSync(
        androidBridge,
        [
          '-s',
          androidDevice,
          'shell',
          'am',
          'force-stop',
          applicationIdentifier,
        ],
        { encoding: 'utf8' },
      ),
    )
    await cleanupStep('Android application uninstall', () =>
      spawnSync(
        androidBridge,
        ['-s', androidDevice, 'uninstall', applicationIdentifier],
        { encoding: 'utf8' },
      ),
    )
    if (ownsEmulator) {
      await cleanupStep('Android owned emulator', () =>
        spawnSync(androidBridge, ['-s', androidDevice, 'emu', 'kill'], {
          encoding: 'utf8',
        }),
      )
      await cleanupStep('Android owned emulator graceful closure', async () => {
        ownedEmulatorClosedAndReaped =
          await waitForOwnedEmulatorGracefulClosure()
      })
    }
  } else if (platform === 'ios') {
    for (const operation of ['terminate', 'uninstall'])
      await cleanupStep(`iOS application ${operation}`, () =>
        spawnSync(
          'xcrun',
          ['simctl', operation, simulatorIdentifier, applicationIdentifier],
          { encoding: 'utf8' },
        ),
      )
    const runnerInformationPath = resolve(
      buildArtifactDirectory,
      'ios-build/Build/Products/Release-iphonesimulator/SynloquentPerformanceUITests-Runner.app/Info.plist',
    )
    if (performanceSuite && existsSync(runnerInformationPath))
      await cleanupStep('iOS UI runner', () => {
        const runnerIdentifier = commandOutput('/usr/libexec/PlistBuddy', [
          '-c',
          'Print :CFBundleIdentifier',
          runnerInformationPath,
        ]).trim()
        if (
          runnerIdentifier !==
          'com.synloquent.example.performanceuitests.xctrunner'
        )
          throw new Error('The native UI runner bundle identity is unexpected.')
        for (const operation of ['terminate', 'uninstall'])
          spawnSync(
            'xcrun',
            ['simctl', operation, simulatorIdentifier, runnerIdentifier],
            { encoding: 'utf8' },
          )
      })
    if (ownsSimulatorBoot)
      await cleanupStep('iOS owned simulator shutdown', () =>
        spawnSync('xcrun', ['simctl', 'shutdown', simulatorIdentifier], {
          encoding: 'utf8',
        }),
      )
  }
  if (collector)
    await cleanupStep(
      'result collector',
      () => new Promise((resolveClose) => collector.close(resolveClose)),
    )
  for (const { child } of ownedProcessGroups.values()) {
    if (ownedEmulatorClosedAndReaped && child.pid === emulatorProcessIdentifier)
      continue
    await cleanupStep(`task process group ${child.pid} SIGTERM`, () =>
      terminateProcessGroup(child.pid),
    )
  }
  await new Promise((resolveWait) => setTimeout(resolveWait, 500))
  for (const { child } of ownedProcessGroups.values()) {
    if (ownedEmulatorClosedAndReaped && child.pid === emulatorProcessIdentifier)
      continue
    await cleanupStep(`task process group ${child.pid} SIGKILL`, () =>
      terminateProcessGroup(child.pid, 'SIGKILL'),
    )
  }
  await cleanupStep('task descendants', closeObservedDescendants)
  await removeEmulatorTemporaryFiles()
  await cleanupStep('task command completion', settleTaskCommands)
  await cleanupStep('task process owner reader', closeProcessOwnerReader)
  if (cleanupFailures.length)
    for (const child of ownedProcesses) {
      child.stdout.destroy()
      child.stderr.destroy()
      child.unref()
    }
  await cleanupStep('session checkpoint', () =>
    checkpointSession(cleanupFailures.length ? 'cleanup-failed' : 'closed'),
  )
}

function finishVerification() {
  finishingVerification ??= completeVerification()
  return finishingVerification
}

async function completeVerification() {
  if (calibrationNetworkObserver)
    await cleanupStep('schema2 transparent network observer closure', () =>
      calibrationNetworkObserver.close(),
    )
  if (calibrationHost)
    await cleanupStep('schema2 host observation closure', async () => {
      calibrationObservationCoverage = await calibrationHost.stop()
      calibrationSamplerClosed = true
    })
  await drainLegacyHostObservations()
  await cleanup()
  if (!evidence)
    evidence = {
      platform,
      suite,
      candidateFingerprint,
      sourceFingerprint,
      sessionName,
      exitStatus: 1,
      command: process.argv,
      buildLog,
      time: new Date().toISOString(),
      packageInventoryBefore: packageBefore,
      packageArchiveWitness,
      nativeResult: nativeResult ?? {
        platform,
        fingerprint: candidateFingerprint,
        status: 'failed',
        hermes: false,
        checks: [],
      },
    }
  if (primaryFailure) evidence.error = String(primaryFailure)
  evidence.nativeStartup = {
    configurationRequests: nativeStartupConfigurationRequests,
    configurationLeaseConsumed: nativeStartupLeaseConsumed,
    firstInvocationId: nativeStartupInvocationId,
    invocationIdentitySource:
      'application process-local effect ordinal, not kernel identity',
    duplicateConfigurationRefused: nativeStartupFailure !== undefined,
    failure: nativeStartupFailure?.message ?? null,
    actualRemountTrigger: 'unknown',
  }
  if (nativeStartupFailure) evidence.exitStatus = 1
  evidence.cleanupFailures = cleanupFailures
  closeNativeStorageReceiverOutput()
  evidence.nativeStorageControl = nativeStorageControlReport()
  if (
    evidence.nativeStorageControl.rejectionCount ||
    evidence.nativeStorageControl.persistenceFailure ||
    evidence.nativeStorageControl.receiverFailureCount
  )
    evidence.exitStatus = 1
  if (diagnosticOnly) {
    evidence.diagnosticOnly = true
    evidence.excludedFromAcceptance = true
    evidence.comparison = {
      memoryMode,
      networkArm: networkArm ?? null,
      controlledDelayMilliseconds:
        networkArm === undefined ? null : controlledDelayMilliseconds,
      networkMetrics: networkProxy?.metrics() ?? null,
      networkLog:
        networkArm === undefined
          ? null
          : resolve(artifactDirectory, `${platform}-network-requests.jsonl`),
      instrumentationBefore: diagnosticInstrumentationBefore,
      instrumentationAfter: instrumentationFingerprint(),
    }
    const measurement = Array.isArray(nativeResult?.checks)
      ? nativeResult.checks.find(
          (check) => check?.name === 'synloquent synthetic catalog performance',
        )?.detail
      : undefined
    const owners = Array.isArray(measurement?.memoryComparison?.owners)
      ? measurement.memoryComparison.owners
      : []
    if (
      measurement?.memoryComparison?.mode !== memoryMode ||
      measurement.memoryComparison.closed !== true ||
      owners.length !== 4 ||
      owners.some(
        (owner) =>
          owner?.closed !== true || owner?.pendingOwnedRefresh !== false,
      )
    ) {
      evidence.exitStatus = 1
      evidence.diagnosticFailure =
        'The requested memory comparison did not finish with closed owners.'
    }
    if (
      JSON.stringify(evidence.comparison.instrumentationBefore) !==
      JSON.stringify(evidence.comparison.instrumentationAfter)
    ) {
      evidence.exitStatus = 1
      evidence.diagnosticFailure =
        'Diagnostic instrumentation changed during comparison.'
    }
    try {
      evidence.completedApplicationFingerprint = applicationFingerprint()
      if (
        evidence.completedApplicationFingerprint !==
        buildProvenance?.artifactSha256
      ) {
        evidence.exitStatus = 1
        evidence.diagnosticFailure =
          'The verified native build changed during comparison.'
      }
    } catch (failure) {
      evidence.exitStatus = 1
      evidence.diagnosticFailure = String(failure)
    }
    if (
      networkProxy &&
      (evidence.comparison.networkMetrics.activeRequests !== 0 ||
        evidence.comparison.networkMetrics.activeTimers !== 0 ||
        evidence.comparison.networkMetrics.upstreamSockets !== 0 ||
        evidence.comparison.networkMetrics.failed !== 0 ||
        evidence.comparison.networkMetrics.cancelled !== 0)
    ) {
      evidence.exitStatus = 1
      evidence.diagnosticFailure =
        'The controlled network comparison failed or retained owned work.'
    }
  }
  if (typeof progressCheckpointReceiver !== 'undefined') {
    evidence.diagnosticProgress = progressCheckpointReceiver.evidence()
    if (evidence.diagnosticProgress.failures.length) evidence.exitStatus = 1
  }
  if (packageBefore) {
    try {
      const packageAfter = JSON.parse(
        commandOutput('python3', [
          resolve(repositoryDirectory, 'scripts/native/verify_package.py'),
          '--before',
          packageBeforePath,
          '--cleanup-generated',
        ]),
      )
      writeFileSync(
        resolve(artifactDirectory, `${platform}-${suite}-package-after.json`),
        JSON.stringify(packageAfter, null, 2) + '\n',
      )
      if (
        packageAfter.sha256 !== packageBefore.sha256 ||
        packageAfter.inventoryFingerprint !== packageBefore.inventoryFingerprint
      )
        throw new Error(
          'The distribution archive or complete installed inventory changed during the native run.',
        )
      evidence.packageInventoryAfter = packageAfter
    } catch (failure) {
      process.exitCode = 1
      evidence.packageProvenanceFailure = String(failure)
      console.error(failure)
    }
  }
  if (process.exitCode || cleanupFailures.length) evidence.exitStatus = 1
  try {
    evidence.completedSourceFingerprint = currentSourceFingerprint()
    if (evidence.completedSourceFingerprint !== sourceFingerprint)
      evidence.exitStatus = 1
  } catch (failure) {
    evidence.exitStatus = 1
    evidence.sourceProvenanceFailure = String(failure)
  }
  if (evidence.exitStatus !== 0) process.exitCode = 1
  if (calibrationHost) {
    const programBefore = resolve(artifactDirectory, 'program-before.json')
    const programAfter = resolve(artifactDirectory, 'program-after.json')
    if (!existsSync(programBefore))
      throw new Error('The immutable original program inventory is missing.')
    writeFileSync(
      programAfter,
      JSON.stringify({
        sourceFingerprint: evidence.completedSourceFingerprint,
        instrumentation: instrumentationFingerprint(),
        requestSha256: calibrationHydration.requestSha256,
      }) + '\n',
    )
    const references = {
      ui: uiReport().correlation.receiptPath,
      session: sessionPath,
      'build-provenance': buildProvenancePath,
      'package-before': packageBeforePath,
      'package-after': resolve(
        artifactDirectory,
        `${platform}-${suite}-package-after.json`,
      ),
      'program-before': programBefore,
      'program-after': programAfter,
    }
    if (calibrationObservationCoverage)
      evidence.hostObservationCoverage = calibrationObservationCoverage
    const pending = calibrationHost.prepareEnvelope(references, {
      complete:
        cleanupFailures.length === 0 && uiReport().correlation.closed === true,
      cleanupFailures,
      nativeUI: uiReport().correlation,
      sessionPath,
    })
    writeFileSync(
      resolve(artifactDirectory, 'native-host-receipt.pending.json'),
      JSON.stringify(pending, null, 2) + '\n',
    )
    evidence.nativeHostReceipt = {
      path: resolve(artifactDirectory, 'native-host-receipt.pending.json'),
      schemaVersion: 2,
      processClosureFinalized: false,
      numericalAcceptance: 'not-evaluated',
    }
  }
  writeFileSync(resultPath, JSON.stringify(evidence, null, 2) + '\n')
  console.log(
    JSON.stringify({
      platform,
      status: evidence.nativeResult.status,
      hermes: evidence.nativeResult.hermes,
      checks: evidence.nativeResult.checks.length,
      exitStatus: evidence.exitStatus,
      artifact: resultPath,
    }),
  )
}
let interrupted = false
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    if (interrupted) return
    interrupted = true
    primaryFailure ??= new Error(
      `Native verification interrupted by ${signal}.`,
    )
    process.exitCode = 130
    await finishVerification()
    process.exit(130)
  })
}

const diskBeforeBytes = freeDiskBytes()
if (diskBeforeBytes < 5 * 1024 ** 3)
  throw new Error('The native build requires at least 5 GiB of free disk.')
try {
  packageBefore = JSON.parse(
    commandOutput('python3', [
      resolve(repositoryDirectory, 'scripts/native/verify_package.py'),
    ]),
  )
  writeFileSync(
    packageBeforePath,
    JSON.stringify(packageBefore, null, 2) + '\n',
  )
  if (packageBefore.sha256 !== packageArchiveWitness.sha256)
    throw new Error(
      'The verified archive differs from the native declaration at runner startup.',
    )
  if (!skipBuild) {
    if (platform === 'android') {
      writeFileSync(
        resolve(androidDirectory, 'local.properties'),
        `sdk.dir=${androidSdkDirectory}\n`,
      )
      await runCommand(
        './gradlew',
        [
          '--no-daemon',
          '--max-workers=2',
          '-PreactNativeArchitectures=arm64-v8a',
          ':app:assembleRelease',
        ],
        { cwd: androidDirectory },
      )
    } else {
      if (!existsSync(resolve(exampleDirectory, 'ios/Pods/Manifest.lock')))
        throw new Error(
          'Install the locked CocoaPods graph before the iOS build.',
        )
      await runCommand(
        'xcodebuild',
        [
          '-workspace',
          'SynloquentExample.xcworkspace',
          '-scheme',
          performanceCapableBuild
            ? 'SynloquentNativePerformance'
            : 'SynloquentExample',
          '-configuration',
          'Release',
          '-sdk',
          'iphonesimulator',
          '-destination',
          'generic/platform=iOS Simulator',
          '-derivedDataPath',
          resolve(buildArtifactDirectory, 'ios-build'),
          '-jobs',
          '2',
          'CODE_SIGNING_ALLOWED=NO',
          performanceCapableBuild ? 'build-for-testing' : 'build',
        ],
        { cwd: resolve(exampleDirectory, 'ios') },
      )
    }
  }

  const afterBuildSourceFingerprint = currentSourceFingerprint()
  if (afterBuildSourceFingerprint !== sourceFingerprint)
    throw new Error(
      'Native source changed during the build. Rebuild the frozen candidate.',
    )
  const artifactSha256 = applicationFingerprint()
  if (skipBuild) {
    if (!existsSync(buildProvenancePath))
      throw new Error(
        'An existing native build has no recorded source provenance.',
      )
    buildProvenance = JSON.parse(readFileSync(buildProvenancePath, 'utf8'))
    if (
      buildProvenance.sourceFingerprint !== sourceFingerprint ||
      buildProvenance.artifactSha256 !== artifactSha256 ||
      (platform === 'ios' &&
        performanceSuite &&
        buildProvenance.includesNativeUITestDriver !== true)
    )
      throw new Error(
        'The existing native build does not match current source and installed package.',
      )
  } else {
    buildProvenance = {
      sourceFingerprint,
      artifactSha256,
      applicationPath,
      platform,
      buildMode: 'Release',
      includesNativeUITestDriver:
        platform === 'android' || performanceCapableBuild,
      builtAt: new Date().toISOString(),
    }
    writeFileSync(
      buildProvenancePath,
      JSON.stringify(buildProvenance, null, 2) + '\n',
    )
  }

  writeFileSync(collectorLog, '')
  if (performanceSuite) {
    writeFileSync(progressCheckpointLog, '')
    if (platform === 'android') androidUIControl.initialize()
    if (platform === 'ios') iosUIControl.initialize()
    if (measurementSchemaVersion === 1)
      progressCheckpointReceiver = createPerformanceCheckpointReceiver({
        candidateFingerprint,
        sourceFingerprint,
        packageArchiveSha256: packageArchiveWitness.sha256,
        platform,
        sessionName,
        logPath: progressCheckpointLog,
      })
  }
  if (networkArm) {
    const networkLog = resolve(
      artifactDirectory,
      `${platform}-network-requests.jsonl`,
    )
    writeFileSync(networkLog, '')
    networkProxy = createNetworkComparisonProxy({
      upstreamOrigin: 'http://127.0.0.1:8766',
      arm: networkArm,
      controlledDelayMilliseconds,
      platform,
      runIdentity: sessionName,
      appendLog: (measurement) =>
        appendFileSync(networkLog, JSON.stringify(measurement) + '\n'),
    })
  }
  collector = createServer(async (request, response) => {
    if (
      calibrationNetworkObserver &&
      (await calibrationNetworkObserver.handle(request, response))
    )
      return
    if (calibrationHost && (await calibrationHost.handle(request, response)))
      return
    if (networkProxy && (await networkProxy.handle(request, response))) return
    appendFileSync(
      collectorLog,
      JSON.stringify({
        time: new Date().toISOString(),
        method: request.method,
        path: request.url,
      }) + '\n',
    )
    const originalReceipt = {
      hostReceivedAtUtc: new Date().toISOString(),
      hostReceivedAtMonotonicMilliseconds: performance.now(),
    }
    let originalRequestBody = ''
    const json = (value, status = 200) => {
      const responseBody = JSON.stringify(value)
      calibrationHost?.recordCollectorExchange({
        method: request.method,
        path: request.url,
        headers: request.headers,
        requestBody: originalRequestBody,
        responseBody,
        responseStatus: status,
        received: originalReceipt,
      })
      return response
        .writeHead(status, { 'Content-Type': 'application/json' })
        .end(responseBody)
    }
    if (request.url === '/diagnostic/performance-checkpoint') {
      if (progressCheckpointReceiver)
        await progressCheckpointReceiver.receive(request, response)
      else json({ error: 'Performance diagnostics are unavailable.' }, 404)
      return
    }
    if (request.method === 'GET' && request.url === '/ui/state') {
      json(uiState)
      return
    }
    if (request.method === 'GET' && request.url === '/ui/report') {
      json(uiReport())
      return
    }
    if (request.method === 'GET' && request.url === '/measurement/storage') {
      let identity = pendingStorageMeasurement?.identity
      try {
        const receiving = sampleDatabaseStorage()
        identity = pendingStorageMeasurement?.identity ?? identity
        json({ sample: await receiving, samples: storageSamples })
      } catch (failure) {
        json({ error: String(failure) }, 400)
        recordNativeStorageControl(
          'sample',
          400,
          nativeStorageControlReason(failure),
          undefined,
          identity ?? pendingStorageMeasurement?.identity,
        )
      }
      return
    }
    if (
      request.method === 'POST' &&
      [
        '/ui/state',
        '/ui/action',
        '/ui/action/next',
        '/ui/action/armed',
        '/ui/action/ended',
        '/ui/action/start',
        '/ui/action/finish',
        '/ui/action/status',
        '/ui/ios/focus',
        '/ui/ios/operation',
        '/ui/event',
        '/measurement/storage',
        '/measurement/native-storage',
        ...(measurementSchemaVersion === 2
          ? ['/measurement/native-task-disk']
          : []),
      ].includes(request.url)
    ) {
      const buffers = []
      let bytes = 0
      for await (const chunk of request) {
        bytes += chunk.length
        if (bytes > 16384) {
          json({ error: 'Bounded native control exceeded' }, 413)
          if (
            request.url === '/measurement/storage' ||
            request.url === '/measurement/native-storage'
          )
            recordNativeStorageControl(
              request.url === '/measurement/storage'
                ? 'registration'
                : 'callback',
              413,
              'storage-control-body-too-large',
              { bodyBytes: bytes },
              pendingStorageMeasurement?.identity,
            )
          return
        }
        buffers.push(chunk)
      }
      let value
      let storageIdentity =
        pendingStorageMeasurement?.identity ??
        lastSettledStorageMeasurement?.identity
      try {
        originalRequestBody = Buffer.concat(buffers).toString('utf8')
        value = JSON.parse(originalRequestBody)
        if (request.url === '/measurement/native-task-disk') {
          if (
            platform !== 'android' ||
            !nativeTaskStoragePending ||
            nativeTaskStoragePending.received ||
            value.sessionName !== nativeTaskStoragePending.sessionName ||
            value.requestIdentity !== nativeTaskStoragePending.requestIdentity
          )
            throw new Error('Stale native task disk response.')
          nativeTaskStoragePending.received = true
          if (value.accepted === true)
            nativeTaskStoragePending.resolveReceipt(value)
          else
            nativeTaskStoragePending.rejectReceipt(
              new Error(
                value.error ?? 'Actual native task disk observation failed.',
              ),
            )
          json({ accepted: true })
        } else if (request.url === '/measurement/native-storage') {
          receiveNativeStorageMeasurement(value)
          json({ accepted: true })
          recordNativeStorageControl(
            'callback',
            200,
            'accepted-owned-storage-callback',
            value,
            storageIdentity,
          )
        } else if (request.url === '/measurement/storage') {
          const receiving = registerNativeDatabasePath(value)
          storageIdentity =
            pendingStorageMeasurement?.identity ?? storageIdentity
          const registration = await receiving
          storageIdentity = registration.identity
          json({ sample: registration.sample, samples: storageSamples })
          recordNativeStorageControl(
            'registration',
            200,
            registration.shared
              ? 'shared-active-storage-measurement'
              : 'registered-and-measured-storage',
            {
              path: value.path,
              databaseBytes: registration.sample?.databaseBytes,
              walBytes: registration.sample?.walBytes,
            },
            storageIdentity,
          )
        } else if (platform === 'ios' && request.url === '/ui/state') {
          iosUIControl.setPhase(value)
          json(uiState)
        } else if (platform === 'ios' && request.url === '/ui/action') {
          json(iosUIControl.beginFromDriver(value))
        } else if (platform === 'ios' && request.url === '/ui/action/next') {
          iosUIControl.next(value, response)
        } else if (platform === 'ios' && request.url === '/ui/action/armed') {
          json(iosUIControl.arm(value))
        } else if (platform === 'ios' && request.url === '/ui/action/ended') {
          json(iosUIControl.ended(value))
        } else if (platform === 'ios' && request.url === '/ui/action/start') {
          json(iosUIControl.startFromDriver(value))
        } else if (platform === 'ios' && request.url === '/ui/action/finish') {
          json(iosUIControl.finishFromDriver(value))
        } else if (platform === 'ios' && request.url === '/ui/action/status') {
          json(iosUIControl.status(value))
        } else if (platform === 'ios' && request.url === '/ui/ios/focus') {
          json(iosUIControl.focus(value))
        } else if (platform === 'ios' && request.url === '/ui/ios/operation') {
          json(iosUIControl.operation(value))
        } else if (platform === 'ios' && request.url === '/ui/event') {
          json(iosUIControl.event(value))
        } else if (
          platform !== 'ios' &&
          [
            '/ui/action/start',
            '/ui/action/finish',
            '/ui/action/status',
            '/ui/ios/focus',
            '/ui/ios/operation',
          ].includes(request.url)
        ) {
          json(
            {
              accepted: false,
              reason: 'Strict iOS command requests require iOS.',
            },
            409,
          )
        } else if (request.url === '/ui/state' && platform === 'android') {
          androidUIControl.setPhase(value)
          json(uiState)
        } else if (
          request.url === '/ui/action/next' &&
          platform === 'android'
        ) {
          androidUIControl.next(value, response)
        } else if (
          request.url === '/ui/action/armed' &&
          platform === 'android'
        ) {
          json(androidUIControl.arm(value))
        } else if (
          request.url === '/ui/action/ended' &&
          platform === 'android'
        ) {
          json(androidUIControl.ended(value))
        } else if (request.url === '/ui/event' && platform === 'android') {
          json(androidUIControl.event(value))
        } else if (request.url === '/ui/action' && platform === 'android') {
          json(
            {
              accepted: false,
              reason: 'Android requires an immutable offered action.',
            },
            409,
          )
        } else if (request.url === '/ui/state') {
          if (typeof value.phase !== 'string')
            throw new Error('Missing native interaction phase.')
          uiState = { phase: value.phase, finished: value.phase === 'inactive' }
          json(uiState)
        } else if (request.url === '/ui/action') {
          if (
            uiState.phase !== value.phase ||
            !['input', 'scroll'].includes(value.type)
          )
            throw new Error('Stale or invalid native action.')
          json(beginUIAction(value.phase, value.type))
        } else {
          const action = currentUIAction
          if (
            action &&
            value.phase === action.phase &&
            value.type === action.type
          ) {
            const phase = (uiPhases[action.phase] ??= {
              inputEvents: 0,
              scrollEvents: 0,
              maximumActionDeliveryMilliseconds: 0,
              actions: [],
            })
            phase[action.type === 'input' ? 'inputEvents' : 'scrollEvents'] += 1
            const delivery = Date.now() - action.startedAt
            phase.maximumActionDeliveryMilliseconds = Math.max(
              phase.maximumActionDeliveryMilliseconds,
              delivery,
            )
            phase.actions.push({
              ...action,
              deliveredAt: Date.now(),
              applicationReceivedAt: value.applicationReceivedAt,
              deliveryMilliseconds: delivery,
            })
            currentUIAction = undefined
          }
          json({ accepted: true })
        }
      } catch (failure) {
        json({ error: String(failure) }, 400)
        if (
          request.url === '/measurement/storage' ||
          request.url === '/measurement/native-storage'
        )
          recordNativeStorageControl(
            request.url === '/measurement/storage'
              ? 'registration'
              : 'callback',
            400,
            nativeStorageControlReason(failure),
            value,
            storageIdentity ?? pendingStorageMeasurement?.identity,
          )
      }
      return
    }
    if (request.method === 'GET' && request.url === '/measurement/baseline') {
      if (measurementSchemaVersion === 2) {
        try {
          const responseBody = await calibrationHost.baseline(request)
          response
            .writeHead(200, { 'Content-Type': 'application/json' })
            .end(responseBody)
        } catch (error) {
          json({ accepted: false, error: String(error) }, 400)
          rejectNativeResult(error)
        }
        return
      }
      await sampleResidentMemory()
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(
        JSON.stringify({
          residentBytes: memorySamples.at(-1)?.residentBytes ?? null,
        }),
      )
      return
    }
    if (request.method === 'GET' && request.url === '/configuration') {
      nativeStartupConfigurationRequests += 1
      const invocationHeader =
        request.headers['x-synloquent-verification-invocation']
      const invocationId =
        typeof invocationHeader === 'string' &&
        /^app-effect-[1-9][0-9]{0,15}$/.test(invocationHeader) &&
        Number.isSafeInteger(
          Number(invocationHeader.slice('app-effect-'.length)),
        )
          ? invocationHeader
          : null
      const refused = nativeStartupLeaseConsumed
      if (!refused) {
        nativeStartupLeaseConsumed = true
        nativeStartupInvocationId = invocationId
      }
      appendFileSync(
        collectorLog,
        JSON.stringify({
          kind: 'native-startup-lease',
          sessionName,
          platform,
          suite,
          configurationRequestOrdinal: nativeStartupConfigurationRequests,
          invocationId,
          invocationIdAvailable: invocationId !== null,
          configurationGranted: !refused,
          reason: refused ? 'duplicate-configuration' : 'first-configuration',
          acceptedCandidate: false,
        }) + '\n',
      )
      if (refused) {
        nativeStartupFailure ??= new Error(
          'Duplicate native verification configuration request.',
        )
        primaryFailure ??= nativeStartupFailure
        process.exitCode = 1
        rejectNativeResult(nativeStartupFailure)
        json({ error: nativeStartupFailure.message }, 409)
        return
      }
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(
        JSON.stringify({
          suite,
          fingerprint: candidateFingerprint,
          packageArchiveSha256: packageArchiveWitness.sha256,
          largeFixtureFingerprint: largeHttpFixture?.fingerprint ?? null,
          backendAddress:
            measurementSchemaVersion === 2
              ? 'http://127.0.0.1:8767/calibration-backend'
              : 'http://127.0.0.1:8765',
          largeBackendAddress:
            measurementSchemaVersion === 2
              ? 'http://127.0.0.1:8767/calibration-large'
              : networkArm
                ? 'http://127.0.0.1:8767/network-proxy'
                : (process.env.SYNLOQUENT_LARGE_BACKEND_ADDRESS ??
                  'http://127.0.0.1:8766'),
          ...(memoryMode ? { memoryMode } : {}),
          ...(measurementSchemaVersion === 2
            ? { measurementSchemaVersion: 2, calibrationRequest }
            : {}),
        }),
      )
      return
    }
    if (request.method !== 'POST' || request.url !== '/result') {
      response.writeHead(404).end()
      return
    }
    const chunks = []
    let length = 0
    for await (const chunk of request) {
      length += chunk.length
      if (length > 2 * 1024 * 1024) {
        response.writeHead(413).end()
        rejectNativeResult(new Error('Native result exceeded 2 MiB.'))
        return
      }
      chunks.push(chunk)
    }
    try {
      if (nativeStartupFailure) {
        json({ error: nativeStartupFailure.message }, 409)
        return
      }
      const originalResultBody = Buffer.concat(chunks).toString('utf8')
      nativeResult =
        measurementSchemaVersion === 2
          ? calibrationHost.acceptResult(originalResultBody)
          : JSON.parse(originalResultBody)
      response
        .writeHead(200, { 'Content-Type': 'application/json' })
        .end('{"accepted":true}')
      resolveNativeResult(nativeResult)
    } catch (error) {
      response.writeHead(400).end()
      rejectNativeResult(error)
    }
  })
  await new Promise((resolveListen, rejectListen) => {
    collector.once('error', rejectListen)
    collector.listen(8767, '127.0.0.1', resolveListen)
  })
  const armResultTimeout = () => {
    const timeoutMilliseconds = performanceSuite ? 900000 : 180000
    resultTimeout = setTimeout(
      () =>
        rejectNativeResult(
          new Error(
            `The native app did not return evidence within ${timeoutMilliseconds / 1000} seconds of launch.`,
          ),
        ),
      timeoutMilliseconds,
    )
  }

  if (platform === 'android') {
    const devices = commandOutput(androidBridge, ['devices'])
    if (!devices.includes(androidDevice)) {
      ownsEmulator = true
      const emulatorProcess = await startProcess(emulatorBinary, [
        '-avd',
        'Pixel_9',
        '-port',
        '5580',
        '-no-window',
        '-no-audio',
        '-no-snapshot',
        '-read-only',
      ])
      emulatorProcessIdentifier = emulatorProcess.pid
      await waitFor(
        () => {
          const execution = spawnSync(
            androidBridge,
            ['-s', androidDevice, 'shell', 'getprop', 'sys.boot_completed'],
            { encoding: 'utf8' },
          )
          return execution.status === 0 && execution.stdout.trim() === '1'
        },
        120000,
        'the task-owned Android emulator',
      )
      captureEmulatorTemporaryFiles()
    }
    await runCommand(androidBridge, [
      '-s',
      androidDevice,
      'reverse',
      'tcp:8767',
      'tcp:8767',
    ])
    await runCommand(androidBridge, [
      '-s',
      androidDevice,
      'reverse',
      'tcp:8765',
      'tcp:8765',
    ])
    if (performanceSuite)
      await runCommand(androidBridge, [
        '-s',
        androidDevice,
        'reverse',
        'tcp:8766',
        'tcp:8766',
      ])
    await runCommand(androidBridge, [
      '-s',
      androidDevice,
      'install',
      '-r',
      resolve(
        androidDirectory,
        'app/build/outputs/apk/release/app-release.apk',
      ),
    ])
    writeFileSync(runtimeLog, '')
    await startProcess(
      androidBridge,
      [
        '-s',
        androidDevice,
        'logcat',
        '-v',
        'threadtime',
        'ReactNativeJS:V',
        'AndroidRuntime:E',
        'libc:E',
        '*:W',
      ],
      {
        outputPath: runtimeLog,
        maximumOutputBytes: 8 * 1024 * 1024,
      },
    )
    if (measurementSchemaVersion === 2 || suite === 'qualification') {
      const operatingSystem = (
        await runCalibrationObservation(androidBridge, [
          '-s',
          androidDevice,
          'shell',
          'getprop',
          'ro.build.version.release',
        ])
      )
        .toString('utf8')
        .trim()
      const device = {
        identity: androidDevice,
        operatingSystem: 'Android ' + operatingSystem,
        kind: 'emulator',
      }
      if (measurementSchemaVersion === 2)
        await initializeCalibrationHost(device)
      else
        qualificationBuildFacts = {
          schema: 'synloquent-native-qualification-build-facts',
          schemaVersion: 2,
          freshNormalBuild: !skipBuild,
          ...(await discoverCalibrationBuildFacts(device)),
        }
    }
    armResultTimeout()
    await runCommand(androidBridge, [
      '-s',
      androidDevice,
      'shell',
      'am',
      'start',
      '-n',
      `${applicationIdentifier}/.MainActivity`,
    ])
    if (measurementSchemaVersion === 2) {
      const processText = (
        await runCalibrationObservation(androidBridge, [
          '-s',
          androidDevice,
          'shell',
          'pidof',
          applicationIdentifier,
        ])
      )
        .toString('utf8')
        .trim()
      if (!/^[1-9][0-9]*$/.test(processText))
        throw new Error(
          'The owned Android app has no unique original guest PID.',
        )
      applicationProcessIdentifier = Number(processText)
      await establishCalibrationApplicationIdentity(
        applicationProcessIdentifier,
      )
    }
    beginMemorySampling()
    if (performanceSuite) {
      uiDriver = driveAndroidUI()
      uiDriver.catch(rejectNativeResult)
    }
    await nativeResultPromise
    if (uiDriver) await uiDriver
    memoryEvidence = commandOutput(androidBridge, [
      '-s',
      androidDevice,
      'shell',
      'dumpsys',
      'meminfo',
      applicationIdentifier,
    ])
  } else {
    const devices = JSON.parse(
      commandOutput('xcrun', ['simctl', 'list', 'devices', '--json']),
    )
    const simulator = Object.values(devices.devices)
      .flat()
      .find((device) => device.udid === simulatorIdentifier)
    if (!simulator)
      throw new Error('The configured iOS simulator is unavailable.')
    if (simulator.state !== 'Booted') {
      ownsSimulatorBoot = true
      await runCommand('xcrun', ['simctl', 'boot', simulatorIdentifier])
      await runCommand('xcrun', [
        'simctl',
        'bootstatus',
        simulatorIdentifier,
        '-b',
      ])
    }
    await runCommand('xcrun', [
      'simctl',
      'install',
      simulatorIdentifier,
      resolve(
        buildArtifactDirectory,
        'ios-build/Build/Products/Release-iphonesimulator/SynloquentExample.app',
      ),
    ])
    let calibrationInstalledExecutable
    if (suite === 'qualification') {
      const runtimeIdentity = Object.entries(devices.devices).find(
        ([, entries]) =>
          entries.some((device) => device.udid === simulatorIdentifier),
      )?.[0]
      if (!runtimeIdentity)
        throw new Error('Actual iOS simulator runtime identity is unknown.')
      qualificationBuildFacts = {
        schema: 'synloquent-native-qualification-build-facts',
        schemaVersion: 2,
        freshNormalBuild: !skipBuild,
        ...(await discoverCalibrationBuildFacts({
          identity: simulatorIdentifier,
          operatingSystem: runtimeIdentity,
          kind: 'simulator',
        })),
      }
    }
    if (measurementSchemaVersion === 2) {
      const runtimeIdentity = Object.entries(devices.devices).find(
        ([, entries]) =>
          entries.some((device) => device.udid === simulatorIdentifier),
      )?.[0]
      if (!runtimeIdentity)
        throw new Error('Actual iOS simulator runtime identity is unknown.')
      await initializeCalibrationHost({
        identity: simulatorIdentifier,
        operatingSystem: runtimeIdentity,
        kind: 'simulator',
      })
      const installedContainer = (
        await runCalibrationObservation('xcrun', [
          'simctl',
          'get_app_container',
          simulatorIdentifier,
          applicationIdentifier,
          'app',
        ])
      )
        .toString('utf8')
        .trim()
      calibrationInstalledExecutable = resolve(
        installedContainer,
        'SynloquentExample',
      )
    }
    armResultTimeout()
    const launchOutput = commandOutput('xcrun', [
      'simctl',
      'launch',
      simulatorIdentifier,
      applicationIdentifier,
    ])
    appendFileSync(buildLog, launchOutput)
    const applicationProcess = Number(launchOutput.trim().split(':').at(-1))
    applicationProcessIdentifier = applicationProcess
    processIdentities.push({
      processIdentifier: applicationProcess,
      command: 'SynloquentExample',
      simulatorIdentifier,
    })
    if (measurementSchemaVersion === 2)
      await establishCalibrationApplicationIdentity(
        applicationProcessIdentifier,
        calibrationInstalledExecutable,
      )
    beginMemorySampling()
    if (performanceSuite) {
      uiDriver = runCommand(
        'xcodebuild',
        [
          '-workspace',
          'SynloquentExample.xcworkspace',
          '-scheme',
          'SynloquentNativePerformance',
          '-configuration',
          'Release',
          '-destination',
          'platform=iOS Simulator,id=' + simulatorIdentifier,
          '-derivedDataPath',
          resolve(buildArtifactDirectory, 'ios-build'),
          '-parallel-testing-enabled',
          'NO',
          'CODE_SIGNING_ALLOWED=NO',
          ...(diagnosticOnly
            ? [
                '-resultBundlePath',
                resolve(artifactDirectory, 'ios-ui-result.xcresult'),
              ]
            : []),
          'test-without-building',
        ],
        { cwd: resolve(exampleDirectory, 'ios') },
      )
      uiDriver.catch(rejectNativeResult)
    }
    await nativeResultPromise
    if (uiDriver) await uiDriver
    memoryEvidence = commandOutput('ps', [
      '-o',
      'pid,rss,%cpu,command',
      '-p',
      String(applicationProcess),
    ])
  }
  writeFileSync(
    resolve(artifactDirectory, `${platform}-memory.txt`),
    memoryEvidence,
  )
  evidence = {
    command: `node scripts/native/run.mjs ${process.argv.slice(2).join(' ')}`,
    candidateFingerprint,
    sourceFingerprint,
    completedSourceFingerprint: currentSourceFingerprint(),
    completedLargeFixtureFingerprint: currentLargeFixtureFingerprint(),
    buildProvenance,
    ...(suite === 'qualification' ? { qualificationBuildFacts } : {}),
    sessionName,
    platform,
    suite,
    exitStatus:
      nativeResult.status === 'passed' &&
      nativeResult.hermes &&
      nativeResult.fingerprint === candidateFingerprint &&
      currentSourceFingerprint() === sourceFingerprint &&
      (!performanceSuite ||
        currentLargeFixtureFingerprint() === largeHttpFixture?.fingerprint)
        ? 0
        : 1,
    environment: {
      macOS: commandOutput('sw_vers', ['-productVersion']).trim(),
      hardware: commandOutput('sysctl', ['-n', 'hw.model']).trim(),
      node: process.version,
      buildMode: 'Release',
      hermes: nativeResult.hermes,
    },
    diskBeforeBytes,
    diskAfterBytes: freeDiskBytes(),
    buildLog,
    memoryArtifact: resolve(artifactDirectory, `${platform}-memory.txt`),
    largeHttpFixture,
    physicalStorage: storageSamples,
    nativeUI: uiReport(),
    nativeMemory: {
      measurement:
        platform === 'android'
          ? 'Android dumpsys TOTAL RSS'
          : 'iOS simulator process RSS from ps',
      samplingIntervalMilliseconds: 1000,
      baselineResidentBytes: memorySamples[0]?.residentBytes ?? null,
      peakResidentBytes: memorySamples.length
        ? Math.max(...memorySamples.map((sample) => sample.residentBytes))
        : null,
      samples: memorySamples,
    },
    installedClient: JSON.parse(
      readFileSync(
        resolve(
          exampleDirectory,
          'node_modules/@synloquent/client/package.json',
        ),
        'utf8',
      ),
    ),
    packageInventoryBefore: packageBefore,
    packageArchiveWitness: existsSync(
      resolve(
        repositoryDirectory,
        '.local/test-results/packages/native-package.json',
      ),
    )
      ? JSON.parse(
          readFileSync(
            resolve(
              repositoryDirectory,
              '.local/test-results/packages/native-package.json',
            ),
            'utf8',
          ),
        )
      : null,
    nativeResult,
  }
  if (evidence.exitStatus !== 0)
    throw new Error(
      nativeResult.error ??
        'Native verification failed or the candidate changed during execution.',
    )
} catch (error) {
  primaryFailure ??= error
  if (platform === 'android' && androidDeviceConnected()) {
    const logs = spawnSync(
      androidBridge,
      [
        '-s',
        androidDevice,
        'logcat',
        '-d',
        '-t',
        '2000',
        'ReactNativeJS:V',
        'AndroidRuntime:E',
        'NetworkSecurityConfig:D',
        '*:S',
      ],
      { encoding: 'utf8', timeout: 10000 },
    )
    writeFileSync(
      resolve(artifactDirectory, 'android-native-log.txt'),
      logs.stdout + logs.stderr,
    )
  }
  writeFileSync(
    resolve(artifactDirectory, `${platform}-failure.json`),
    JSON.stringify(
      {
        platform,
        candidateFingerprint,
        sourceFingerprint,
        command: process.argv,
        error: String(error),
        buildLog,
        time: new Date().toISOString(),
      },
      null,
      2,
    ) + '\n',
  )
  console.error(error)
  process.exitCode = 1
} finally {
  await finishVerification()
}

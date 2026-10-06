"""Exercise production progress routes with owned temporary Node collectors."""
import json
import pathlib
import subprocess
import tempfile
import unittest


REPOSITORY = pathlib.Path(__file__).resolve().parents[2]
PRODUCTION_ROUTE_CONTROL = r"""
import assert from 'node:assert/strict'
import { readFileSync, appendFileSync, writeFileSync, existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { Script, createContext } from 'node:vm'
import typescript from 'typescript'

const directory = process.argv[2]
const source = readFileSync('scripts/native/run.mjs', 'utf8')
const applicationSource = readFileSync('examples/react-native/src/nativePerformance.ts', 'utf8')
const platformSource = readFileSync('examples/react-native/src/platform.ts', 'utf8')
function section(text, beginMarker, endMarker) {
  const begin = text.indexOf(beginMarker)
  const end = text.indexOf(endMarker, begin)
  assert(begin >= 0 && end > begin, 'Production source boundary is missing')
  return text.slice(begin, end)
}
const receiverImplementation = section(source, 'function createPerformanceCheckpointReceiver(', 'function beginUIAction(')
const routeImplementation = section(source, '    const json = (value, status = 200) =>', "    if (request.method === 'GET' && request.url === '/ui/state')")
const reportImplementation = section(source, 'async function completeVerification()', 'let interrupted = false')
const senderImplementation = typescript.transpileModule(
  section(applicationSource, 'function createPerformanceCheckpoint(', 'function checkpointResponsiveness('),
  {compilerOptions: {target: typescript.ScriptTarget.ES2022}},
).outputText
const encodingImplementation = typescript.transpileModule(
  section(platformSource, 'function encodeUtf8(', 'let maximumDigestSliceMilliseconds'),
  {compilerOptions: {target: typescript.ScriptTarget.ES2022}},
).outputText
const identity = {
  candidateFingerprint: '1'.repeat(64), sourceFingerprint: '2'.repeat(64),
  packageArchiveSha256: '3'.repeat(64), platform: 'ios', sessionName: 'owned-checkpoint-control',
}
const stages = [
  ['sdk/install', 0], ['sdk/witness', 1], ['sdk/checkpoint', 1],
  ['reference/install', 2], ['reference/witness', 3],
  ['repeat0/install', 3], ['repeat0/witness', 4], ['repeat0/checkpoint', 4],
  ['repeat1/install', 5], ['repeat1/witness', 6], ['repeat1/checkpoint', 6],
  ['invalid/prepare', 7], ['invalidSDK/install', 7], ['invalidReference/install', 7],
  ['invalidSDK/witness', 7], ['invalidReference/witness', 7],
  ['catalog/read-and-subscription', 7], ['largeHTTP/prepare', 7],
  ['largeHTTP/resnapshot', 7], ['largeHTTP/witness', 8], ['batchSync', 8],
]
const operations = [
  'sdk/install', 'sdk/checkpoint', 'reference/install', 'repeat0/install',
  'repeat0/checkpoint', 'repeat1/install', 'repeat1/checkpoint', 'largeHTTP/resnapshot',
]
const frames = {
  frames: 60, maximumFrameGapMilliseconds: 17, estimatedMissedFrames: 0,
  elapsedMilliseconds: 1000, firstFrameGapMilliseconds: 16,
  finalFrameGapMilliseconds: 16, callbackCoverageRatio: 1,
}
const responsiveness = {
  maximumCallbackGapMilliseconds: 12, maximumCallingThreadCpuMilliseconds: 8,
  callbacks: 64, armedBoundaries: 64,
  phaseMaximumGaps: [{phase: 'records', wallMilliseconds: 12, callingThreadCpuMilliseconds: 8}],
}
const digest = {
  maximumDigestSliceMilliseconds: 4, maximumIteratorDispatchMilliseconds: 1,
  maximumIteratorAwaitMilliseconds: 2, iteratorAwaitMilliseconds: 3,
  hashingMilliseconds: 10, nativeHashCpuMilliseconds: 5,
  nativeHashWallMilliseconds: 7, nativeHashBytes: 4096, nativeHashChunks: 1,
  maximumBufferedUtf16Units: 65536,
  implementation: 'system SHA256 on a serial native worker',
}
const measurements = operations.map((operation) => {
  const measurement = {operation, elapsedMilliseconds: 1000}
  if (operation.endsWith('/install') || operation === 'largeHTTP/resnapshot') {
    measurement.frameMeasurement = frames
    measurement.responsivenessMeasurement = responsiveness
  }
  if (['sdk/install', 'reference/install', 'largeHTTP/resnapshot'].includes(operation))
    measurement.phaseMeasurements = ['validation', 'digest', 'records', 'relationSets', 'integrity', 'staging', 'commit'].map((phase) => ({phase, elapsedMilliseconds: 100}))
  if (operation !== 'reference/install')
    for (const phase of measurement.phaseMeasurements ?? []) phase.startedMilliseconds = 10
  if (['sdk/install', 'largeHTTP/resnapshot'].includes(operation)) measurement.digestMeasurement = digest
  return measurement
})
function payload(index) {
  return JSON.parse(JSON.stringify({
    version: 1, diagnosticOnly: true,
    candidateFingerprint: identity.candidateFingerprint,
    packageArchiveSha256: identity.packageArchiveSha256,
    platform: identity.platform, sequence: index + 1, nextOperation: stages[index][0],
    applicationMonotonicMilliseconds: 100 + index,
    completedMeasurements: measurements.slice(0, stages[index][1]),
  }))
}
const servers = []
const observations = []
let callingThreadClock = 0
const context = createContext({
  Buffer, Date, appendFileSync, writeFileSync, AbortController, setTimeout, clearTimeout,
  Platform: {OS: 'ios'}, nativeClock: {now: () => ++callingThreadClock},
  fetch, console: {log() {}},
})
new Script(receiverImplementation).runInContext(context)
new Script(encodingImplementation).runInContext(context)
new Script(senderImplementation).runInContext(context)
async function collector(logPath) {
  const receiver = context.createPerformanceCheckpointReceiver({...identity, logPath})
  const routeContext = createContext({progressCheckpointReceiver: receiver})
  const route = new Script('(async function(request, response) {' + routeImplementation + '})').runInContext(routeContext)
  const server = createServer(async (request, response) => {
    await route(request, response)
    if (!response.writableEnded) response.writeHead(404).end()
  })
  servers.push(server)
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  return {receiver, address: 'http://127.0.0.1:' + server.address().port, logPath}
}
async function send(target, body, method = 'POST', path = '/diagnostic/performance-checkpoint') {
  const response = await fetch(target.address + path, {
    method, ...(method === 'GET' ? {} : {headers: {'Content-Type': 'application/json'}, body: typeof body === 'string' ? body : JSON.stringify(body)}),
  })
  const text = await response.text()
  return {status: response.status, value: text ? JSON.parse(text) : undefined}
}
try {
  const target = await collector(resolve(directory, 'progress.jsonl'))
  assert.equal((await send(target, payload(0))).status, 200)
  let stored = readFileSync(target.logPath, 'utf8').trim().split('\n').map(JSON.parse)
  assert.equal(stored.length, 1, 'Acknowledgement must follow durable checkpoint write')
  assert.deepEqual(stored[0].payload, payload(0))
  assert.equal(stored[0].candidateFingerprint, identity.candidateFingerprint)
  assert.equal(stored[0].sourceFingerprint, identity.sourceFingerprint)
  assert.equal(stored[0].platform, 'ios')
  assert.match(stored[0].receivedAt, /^\d{4}-\d{2}-\d{2}T.*Z$/)
  observations.push('persist-before-ack')

  const negatives = [
    ['candidate', (value) => { value.candidateFingerprint = '4'.repeat(64) }],
    ['archive', (value) => { value.packageArchiveSha256 = '4'.repeat(64) }],
    ['platform', (value) => { value.platform = 'android' }],
    ['version', (value) => { value.version = 2 }],
    ['diagnostic-only', (value) => { value.diagnosticOnly = false }],
    ['sequence-replay', (value) => { value.sequence = 1 }],
    ['sequence-skip', (value) => { value.sequence = 3 }],
    ['stage-skip', (value) => { value.nextOperation = 'reference/witness' }],
    ['backwards-clock', (value) => { value.applicationMonotonicMilliseconds = 99 }],
    ['nonfinite-clock', (value) => { value.applicationMonotonicMilliseconds = null }],
    ['missing-completed-metrics', (value) => { value.completedMeasurements = [] }],
    ['nonfinite-phase', (value) => { value.completedMeasurements[0].phaseMeasurements[0].elapsedMilliseconds = null }],
    ['unknown-phase', (value) => { value.completedMeasurements[0].phaseMeasurements[0].phase = 'unknown' }],
    ['missing-phase-array', (value) => { delete value.completedMeasurements[0].phaseMeasurements }],
    ['nonfinite-frame', (value) => { value.completedMeasurements[0].frameMeasurement.maximumFrameGapMilliseconds = null }],
    ['nonfinite-callback', (value) => { value.completedMeasurements[0].responsivenessMeasurement.phaseMaximumGaps[0].wallMilliseconds = null }],
    ['nonfinite-digest', (value) => { value.completedMeasurements[0].digestMeasurement.nativeHashCpuMilliseconds = null }],
    ['snapshot-prohibited', (value) => { value.completedMeasurements[0].snapshot = {records: []} }],
    ['records-prohibited', (value) => { value.records = [] }],
  ]
  for (const [name, mutate] of negatives) {
    const altered = payload(1)
    mutate(altered)
    assert.equal((await send(target, altered)).status, 400, name)
    assert.equal(readFileSync(target.logPath, 'utf8').trim().split('\n').length, 1, name + ' changed accepted sequence')
    observations.push('reject:' + name)
  }
  const infinity = JSON.stringify(payload(1)).replace('"elapsedMilliseconds":1000', '"elapsedMilliseconds":1e999')
  assert.equal((await send(target, infinity)).status, 400)
  const oversized = {...payload(1), padding: '雪'.repeat(6000)}
  assert(JSON.stringify(oversized).length < 16384)
  const capacity = await send(target, oversized)
  assert.equal(capacity.status, 400)
  assert.match(capacity.value.error, /exceeded 16 KiB/)
  assert.equal((await send(target, '{')).status, 400)
  assert.equal((await send(target, undefined, 'GET')).status, 405)
  assert.equal((await send(target, payload(1), 'POST', '/unowned-route')).status, 404)
  observations.push('reject:nonfinite-number', 'reject:utf8-capacity', 'reject:malformed-json', 'reject:method-and-route')

  assert.equal((await send(target, payload(1))).status, 200)
  const changedCompleted = payload(2)
  changedCompleted.completedMeasurements[0].elapsedMilliseconds += 1
  assert.equal((await send(target, changedCompleted)).status, 400)
  observations.push('reject:changed-completed-metric')
  for (let index = 2; index < stages.length; index += 1)
    assert.equal((await send(target, payload(index))).status, 200, stages[index][0])
  stored = readFileSync(target.logPath, 'utf8').trim().split('\n').map(JSON.parse)
  assert.equal(stored.length, stages.length)
  assert.deepEqual(stored.at(-1).payload.completedMeasurements, measurements)
  observations.push('complete-stage-sequence')

  const unavailable = await collector(resolve(directory, 'missing-directory/progress.jsonl'))
  const unavailableResponse = await send(unavailable, payload(0))
  assert.equal(unavailableResponse.status, 500)
  assert.equal(unavailable.receiver.evidence().checkpoints.length, 0)
  assert.equal(unavailable.receiver.evidence().failures[0].operation, 'checkpoint persistence')
  assert(!existsSync(unavailable.logPath))
  observations.push('reject:persistence-failure')

  const senderTarget = await collector(resolve(directory, 'sender.jsonl'))
  context.fetch = (address, options) => fetch(senderTarget.address + '/diagnostic/performance-checkpoint', options)
  const sender = context.createPerformanceCheckpoint(identity)
  await sender('sdk/install', [])
  await sender('sdk/witness', [measurements[0]])
  assert.equal(senderTarget.receiver.evidence().checkpoints.length, 2)
  assert.deepEqual(JSON.parse(JSON.stringify(senderTarget.receiver.evidence().checkpoints[1].payload.completedMeasurements)), [measurements[0]])
  observations.push('production-app-sender')
  const boundedUnicodeMeasurements = JSON.parse(JSON.stringify(measurements))
  for (const measurement of boundedUnicodeMeasurements)
    if (measurement.responsivenessMeasurement)
      measurement.responsivenessMeasurement.phaseMaximumGaps = Array.from({length: 16}, () => ({phase: '雪'.repeat(64), wallMilliseconds: 12, callingThreadCpuMilliseconds: 8}))
  const unicodeBody = JSON.stringify({...payload(20), completedMeasurements: boundedUnicodeMeasurements})
  assert(unicodeBody.length < 16384)
  assert(Buffer.byteLength(unicodeBody, 'utf8') > 16384)
  await assert.rejects(sender('batchSync', boundedUnicodeMeasurements), /exceeded 16 KiB/)
  assert.equal(senderTarget.receiver.evidence().checkpoints.length, 2)
  observations.push('reject:app-byte-accurate-unicode-capacity')

  const rejectedAcknowledgement = createServer((request, response) => {
    request.resume()
    response.writeHead(200, {'Content-Type': 'application/json'}).end('{"accepted":true,"sequence":999}')
  })
  servers.push(rejectedAcknowledgement)
  await new Promise((resolveListen) => rejectedAcknowledgement.listen(0, '127.0.0.1', resolveListen))
  context.fetch = (address, options) => fetch('http://127.0.0.1:' + rejectedAcknowledgement.address().port, options)
  await assert.rejects(context.createPerformanceCheckpoint(identity)('sdk/install', []), /acknowledgement failed/)
  context.fetch = (address, options) => fetch(unavailable.address + '/diagnostic/performance-checkpoint', options)
  await assert.rejects(context.createPerformanceCheckpoint(identity)('sdk/install', []), /was not accepted/)
  observations.push('reject:app-fail-closed')

  const hangingCollector = createServer((request) => request.resume())
  servers.push(hangingCollector)
  await new Promise((resolveListen) => hangingCollector.listen(0, '127.0.0.1', resolveListen))
  context.fetch = (address, options) => fetch('http://127.0.0.1:' + hangingCollector.address().port, options)
  const timeoutStarted = performance.now()
  await assert.rejects(context.createPerformanceCheckpoint(identity)('sdk/install', []), (failure) => failure.name === 'AbortError')
  const timeoutElapsed = performance.now() - timeoutStarted
  assert(timeoutElapsed >= 1900 && timeoutElapsed < 3500, 'Production sender must fail closed at its 2s checkpoint deadline')
  observations.push('reject:app-two-second-timeout')

  const resultPath = resolve(directory, 'result.json')
  const reportContext = createContext({
    cleanup: async () => {}, evidence: undefined, nativeResult: undefined,
    platform: 'ios', suite: 'performance', ...identity,
    process: {argv: ['node', 'owned-control'], exitCode: 1},
    sourceFingerprint: identity.sourceFingerprint, buildLog: 'owned-build.log',
    packageBefore: undefined, packageArchiveWitness: {sha256: identity.packageArchiveSha256},
    primaryFailure: new Error('primary native SQL timeout'),
    cleanupFailures: [{operation: 'owned cleanup', error: 'separate cleanup failure'}],
    diagnosticOnly: false,
    progressCheckpointReceiver: target.receiver,
    currentSourceFingerprint: () => identity.sourceFingerprint,
    writeFileSync, resultPath, console: {log() {}},
  })
  new Script(reportImplementation).runInContext(reportContext)
  await reportContext.completeVerification()
  const report = JSON.parse(readFileSync(resultPath, 'utf8'))
  assert.equal(report.exitStatus, 1)
  assert.equal(report.error, 'Error: primary native SQL timeout')
  assert.equal(report.cleanupFailures[0].error, 'separate cleanup failure')
  assert.equal(report.nativeResult.status, 'failed')
  assert.deepEqual(report.nativeResult.checks, [])
  assert.equal(report.diagnosticProgress.diagnosticOnly, true)
  assert.equal(report.diagnosticProgress.checkpoints.length, stages.length)
  assert.deepEqual(report.diagnosticProgress.checkpoints.at(-1).payload.completedMeasurements, measurements)
  observations.push('failed-evidence-linkage-primary-preserved')
  reportContext.primaryFailure = undefined
  reportContext.cleanupFailures = []
  reportContext.process.exitCode = 0
  reportContext.evidence = {exitStatus: 0, nativeResult: {status: 'passed', hermes: true, checks: []}}
  await reportContext.completeVerification()
  assert.equal(JSON.parse(readFileSync(resultPath, 'utf8')).exitStatus, 1)
  assert.equal(reportContext.process.exitCode, 1)
  observations.push('diagnostic-failure-cannot-pass-runner')

  const position = (marker) => {
    const index = applicationSource.indexOf(marker)
    assert(index >= 0, marker)
    return index
  }
  assert(position("await checkpoint('sdk/install'") < position('const started = nativeClock.now()'))
  assert(position('const importMilliseconds = nativeClock.now() - started') < position("await checkpoint('sdk/witness'"))
  assert(position('const referenceElapsed = nativeClock.now() - referenceStarted') < position("await checkpoint('reference/witness'"))
  assert(position('const repeatedResponsivenessMeasurement = repeatedResponsiveness.stop()') < position('await checkpoint(`repeat${repetition}/witness`'))
  assert(position('await checkpoint(`repeat${repetition}/checkpoint`') < position('const repeatedCheckpointStarted = nativeClock.now()'))
  assert(position("await checkpoint('largeHTTP/resnapshot'") < position('const largeStarted = nativeClock.now()'))
  assert(position('const largeElapsed = nativeClock.now() - largeStarted') < position("await checkpoint('largeHTTP/witness'"))
  assert(source.includes('900000'))
  observations.push('checkpoint-calls-outside-measured-operations')
  console.log(JSON.stringify({observations, checkpointCount: stored.length, timeoutElapsed, ownedProcessIdentifier: process.pid}))
} finally {
  await Promise.all(servers.map((server) => new Promise((resolveClose) => {
    server.closeAllConnections()
    server.close(resolveClose)
  })))
}
"""


class PerformanceCheckpointTests(unittest.TestCase):
    def test_performance_checkpoint_route_preserves_metrics_and_rejects_invalid_ownership(self):
        with tempfile.TemporaryDirectory(prefix='synloquent-progress-checkpoint-') as directory:
            execution = subprocess.run(
                ['node', '--input-type=module', '-', directory],
                input=PRODUCTION_ROUTE_CONTROL, cwd=REPOSITORY,
                text=True, capture_output=True, timeout=20,
            )
            self.assertEqual(execution.returncode, 0, execution.stderr)
            proof = json.loads(execution.stdout)
            self.assertEqual(proof['checkpointCount'], 21)
            self.assertIn('persist-before-ack', proof['observations'])
            self.assertIn('failed-evidence-linkage-primary-preserved', proof['observations'])
            self.assertIn('checkpoint-calls-outside-measured-operations', proof['observations'])
            self.assertGreaterEqual(len(proof['observations']), 30)
        self.assertFalse(pathlib.Path(directory).exists())


if __name__ == '__main__':
    unittest.main()

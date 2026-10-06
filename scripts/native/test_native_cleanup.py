"""Exercise the actual runner cleanup functions with isolated system-call stubs."""
import json
import pathlib
import subprocess
import unittest


REPOSITORY = pathlib.Path(__file__).resolve().parents[2]
SOURCE_FUNCTION_CONTROL = r"""
import { readFileSync } from 'node:fs'
import { Script, createContext } from 'node:vm'
const mode = process.argv[2]
const source = readFileSync('scripts/native/run.mjs', 'utf8')
function section(beginMarker, endMarker) {
  const begin = source.indexOf(beginMarker)
  const end = source.indexOf(endMarker, begin)
  if (begin < 0 || end < 0) throw new Error('Missing actual runner function')
  return source.slice(begin, end)
}
const implementation = [
  section('function recordCleanupFailure(', 'function processSnapshot('),
  section('function captureEmulatorTemporaryFiles()', 'function captureDescendants()'),
  section('async function cleanup()', 'const diskBeforeBytes ='),
].join('\n')
const observed = []
const writes = new Map()
const cleanupFailures = []
const handlers = new Map()
const packageInventory = {sha256: 'archive-proof', inventoryFingerprint: 'inventory-proof', files: ['exact-file']}
const files = new Map([
  ['owned-mismatch', {path: 'owned-mismatch', inode: 1, birthtimeMilliseconds: 100, removed: false}],
  ['owned-unchanged', {path: 'owned-unchanged', inode: 2, birthtimeMilliseconds: 200, removed: false}],
])
let collectorRelease
const nativeWitness = {status: 'passed', hermes: true, checks: [{name: 'actual-native-witness'}]}
const primaryFailure = new Error('primary SQL failure')
const context = createContext({
  process: {
    argv: ['node', 'actual-runner', 'ios'], exitCode: 1,
    on(signal, callback) { handlers.set(signal, callback) },
    exit(code) { observed.push('process.exit:' + code) },
  },
  console: {
    error(value) { observed.push('diagnostic:' + String(value)) },
    log() {},
  },
  cleanupFailures, finishingVerification: undefined, diagnosticOnly: false,
  networkProxy: mode.startsWith('network-proxy-') ? {
    async close() {
      observed.push('network-proxy.close')
      if (mode === 'network-proxy-failure') throw new Error('isolated proxy cleanup failure')
    },
  } : undefined,
  primaryFailure,
  clearTimeout() {}, clearInterval() {},
  storageTimeout: undefined, memoryTimer: undefined, descendantMonitor: undefined, resultTimeout: undefined,
  captureDescendants() {}, platform: 'ios', suite: 'performance',
  ownsEmulator: false, emulatorProcessIdentifier: undefined,
  emulatorTemporaryFiles: mode === 'temporary-identity-failure' ? files : new Map(),
  androidDeviceConnected() { return false }, androidBridge: 'never-called',
  applicationIdentifier: 'com.synloquent.example', simulatorIdentifier: 'owned-simulator',
  spawnSync(command, argumentsList) {
    observed.push(command + ' ' + argumentsList.join(' '))
    return command === 'lsof' ? {status: 1, stdout: '', stderr: ''} : {status: 0, stdout: '', stderr: ''}
  },
  resolve(...parts) { return parts.join('/') }, artifactDirectory: 'owned-artifacts', buildArtifactDirectory: 'owned-artifacts',
  existsSync() { return true },
  statSync(path) { return path === 'owned-mismatch' ? {ino: 999, birthtimeMs: 100} : {ino: 2, birthtimeMs: 200} },
  unlinkSync(path) { observed.push('unlink:' + path) },
  commandOutput(command) {
    if (command === 'python3') {
      observed.push('package-after')
      return JSON.stringify(packageInventory)
    }
    if (mode === 'plist-read-failure') throw new Error('isolated plist read failure')
    return mode === 'unexpected-runner-identity' ? 'unowned.runner' : 'com.synloquent.example.performanceuitests.xctrunner'
  },
  ownsSimulatorBoot: true,
  collector: {
    close(callback) {
      observed.push('collector.close')
      if (mode === 'signal-concurrent-finally') collectorRelease = callback
      else callback()
    },
  },
  ownedProcesses: [{pid: 123456789}],
  terminateProcessGroup() { observed.push('owned-process-termination') },
  setTimeout(callback) { callback() },
  closeObservedDescendants() { observed.push('descendant-closure') },
  checkpointSession(state) { observed.push('session:' + state) },
  evidence: mode === 'initial-failure' ? undefined : {exitStatus: 1, nativeResult: nativeWitness},
  nativeResult: mode === 'initial-failure' ? undefined : nativeWitness,
  candidateFingerprint: 'candidate-proof', sourceFingerprint: 'source-proof', sessionName: 'owned-session',
  buildLog: 'owned-build.log', packageBefore: packageInventory, packageArchiveWitness: {sha256: 'archive-proof'},
  repositoryDirectory: 'repository', packageBeforePath: 'owned-package-before.json',
  currentSourceFingerprint() { return 'source-proof' }, resultPath: 'owned-result.json',
  writeFileSync(path, value) { observed.push('write:' + path); writes.set(path, JSON.parse(value)) },
})
new Script(implementation).runInContext(context)
const completion = context.finishVerification()
let signalCompletion
if (mode === 'signal-concurrent-finally') {
  for (let attempt = 0; attempt < 100 && !collectorRelease; attempt += 1) await Promise.resolve()
  if (!collectorRelease) throw new Error('Actual collector cleanup did not start')
  signalCompletion = handlers.get('SIGTERM')()
  collectorRelease()
}
await completion
if (signalCompletion) await signalCompletion
console.log(JSON.stringify({
  mode, observed, cleanupFailures, files: [...files.values()],
  result: writes.get('owned-result.json'), exitCode: context.process.exitCode,
  packageAfter: writes.get('owned-artifacts/ios-performance-package-after.json'),
}))
"""


class NativeCleanupTests(unittest.TestCase):
    def run_control(self, mode):
        execution = subprocess.run(
            ['node', '--input-type=module', '-', mode], input=SOURCE_FUNCTION_CONTROL,
            cwd=REPOSITORY, text=True, capture_output=True, timeout=10,
        )
        self.assertEqual(execution.returncode, 0, execution.stderr)
        return json.loads(execution.stdout)

    def assert_completed_failure(self, proof):
        self.assertEqual(proof['exitCode'], 1)
        self.assertEqual(proof['result']['exitStatus'], 1)
        self.assertEqual(proof['result']['error'], 'Error: primary SQL failure')
        self.assertIn('collector.close', proof['observed'])
        self.assertIn('owned-process-termination', proof['observed'])
        self.assertIn('descendant-closure', proof['observed'])
        self.assertIn('xcrun simctl shutdown owned-simulator', proof['observed'])
        self.assertIn('package-after', proof['observed'])
        self.assertEqual(proof['result']['packageInventoryAfter'], proof['packageAfter'])

    def test_plist_read_failure_preserves_primary_and_finishes_other_cleanup(self):
        proof = self.run_control('plist-read-failure')
        self.assert_completed_failure(proof)
        self.assertEqual(proof['cleanupFailures'][0]['operation'], 'iOS UI runner')
        self.assertIn('session:cleanup-failed', proof['observed'])

    def test_unexpected_runner_identity_is_never_signalled(self):
        proof = self.run_control('unexpected-runner-identity')
        self.assert_completed_failure(proof)
        self.assertFalse(any('unowned.runner' in operation for operation in proof['observed']))
        self.assertEqual(proof['cleanupFailures'][0]['operation'], 'iOS UI runner')

    def test_changed_temporary_file_does_not_skip_verified_file_or_report(self):
        proof = self.run_control('temporary-identity-failure')
        self.assert_completed_failure(proof)
        self.assertNotIn('unlink:owned-mismatch', proof['observed'])
        self.assertIn('unlink:owned-unchanged', proof['observed'])
        self.assertFalse(proof['files'][0]['removed'])
        self.assertTrue(proof['files'][1]['removed'])
        self.assertIn('session:cleanup-failed', proof['observed'])

    def test_signal_and_finally_share_one_cleanup_and_report(self):
        proof = self.run_control('signal-concurrent-finally')
        self.assertEqual(proof['result']['error'], 'Error: primary SQL failure')
        self.assertEqual(proof['result']['exitStatus'], 1)
        self.assertEqual(proof['observed'].count('collector.close'), 1)
        self.assertEqual(proof['observed'].count('package-after'), 1)
        self.assertEqual(proof['observed'].count('write:owned-result.json'), 1)
        self.assertIn('process.exit:130', proof['observed'])

    def test_initial_failure_still_writes_failed_result_and_package_after(self):
        proof = self.run_control('initial-failure')
        self.assert_completed_failure(proof)
        self.assertEqual(proof['result']['nativeResult']['status'], 'failed')
        self.assertFalse(proof['result']['nativeResult']['hermes'])
        self.assertEqual(proof['result']['nativeResult']['checks'], [])

    def test_owned_proxy_drains_before_collector_and_other_cleanup(self):
        proof = self.run_control('network-proxy-closed')
        self.assert_completed_failure(proof)
        self.assertEqual(proof['observed'].count('network-proxy.close'), 1)
        self.assertLess(proof['observed'].index('network-proxy.close'), proof['observed'].index('collector.close'))
        self.assertEqual(proof['cleanupFailures'], [])

    def test_proxy_cleanup_failure_preserves_primary_and_closes_collector(self):
        proof = self.run_control('network-proxy-failure')
        self.assert_completed_failure(proof)
        self.assertEqual(proof['cleanupFailures'][0]['operation'], 'diagnostic network proxy')
        self.assertIn('session:cleanup-failed', proof['observed'])


if __name__ == '__main__':
    unittest.main()

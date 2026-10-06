"""Exercise actual diagnostic argument handling without launching native work."""
import json
import pathlib
import subprocess
import tempfile
import unittest


REPOSITORY = pathlib.Path(__file__).resolve().parents[2]
CONTROL = r"""
import { readFileSync, existsSync, readdirSync, lstatSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { Script, createContext } from 'node:vm'
const source = readFileSync('scripts/native/run.mjs', 'utf8')
const begin = source.indexOf('const platform = process.argv[2]')
const end = source.indexOf('const suppliedFingerprint = process.argv', begin)
if (begin < 0 || end <= begin) throw new Error('Actual argument boundary is missing')
const context = createContext({
  process: {argv: ['node', 'owned-runner', ...JSON.parse(process.argv[3])]},
  buildArtifactDirectory: process.argv[2],
  resolve, dirname, existsSync, readdirSync, lstatSync,
})
try {
  const result = new Script(source.slice(begin, end) +
    '; JSON.stringify({platform, suite, skipBuild, diagnosticOnly, memoryMode, networkArm, controlledDelayMilliseconds, artifactDirectory})').runInContext(context)
  console.log(JSON.stringify({accepted: true, result: JSON.parse(result)}))
} catch (failure) {
  console.log(JSON.stringify({accepted: false, error: String(failure)}))
}
"""
REPORT_CONTROL = r"""
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Script, createContext } from 'node:vm'
const source = readFileSync('scripts/native/run.mjs', 'utf8')
const begin = source.indexOf('async function completeVerification()')
const end = source.indexOf('let interrupted = false', begin)
if (begin < 0 || end <= begin) throw new Error('Actual report boundary is missing')
const fault = process.argv[2]
const memoryMode = fault.startsWith('network-') ? 'fixed-conservative' : 'adaptive'
const comparison = {
  mode: fault === 'wrong-mode' ? 'fixed-conservative' : memoryMode,
  closed: true,
  owners: fault === 'malformed-owner' ? [null, null, null, null] : Array.from({length: fault === 'missing-owner' ? 3 : 4}, () => ({closed: true, pendingOwnedRefresh: fault === 'pending-owner'})),
}
const nativeResult = {status: 'passed', hermes: true, checks: fault === 'malformed-checks' ? {} : [{name: 'synloquent synthetic catalog performance', detail: {memoryComparison: comparison}}]}
let report
const context = createContext({
  cleanup: async () => {}, diagnosticOnly: true, platform: 'ios', suite: 'performance',
  memoryMode, networkArm: fault.startsWith('network-') ? 'single' : undefined,
  controlledDelayMilliseconds: 100, artifactDirectory: 'owned-diagnostics',
  evidence: {exitStatus: 0, nativeResult}, nativeResult,
  cleanupFailures: [], primaryFailure: undefined, packageBefore: undefined,
  diagnosticInstrumentationBefore: {runner: 'unchanged'},
  instrumentationFingerprint: () => ({runner: fault === 'changed-instrumentation' ? 'changed' : 'unchanged'}),
  applicationFingerprint: () => fault === 'changed-build' ? 'changed' : 'unchanged-build',
  buildProvenance: {artifactSha256: 'unchanged-build'},
  networkProxy: fault.startsWith('network-') ? {metrics: () => ({activeRequests: fault === 'network-retained-work' ? 1 : 0, activeTimers: 0, upstreamSockets: 0, failed: 0, cancelled: 0})} : undefined,
  sourceFingerprint: 'unchanged-source', currentSourceFingerprint: () => 'unchanged-source',
  resolve, process: {argv: ['node', 'owned-report-control'], exitCode: 0},
  resultPath: 'owned-result.json', writeFileSync(_path, value) {report = JSON.parse(value)},
  console: {log() {}},
})
new Script(source.slice(begin, end)).runInContext(context)
await context.completeVerification()
console.log(JSON.stringify({report, exitCode: context.process.exitCode}))
"""


class DiagnosticRunnerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='synloquent-diagnostic-arguments-')
        self.addCleanup(self.temporary.cleanup)
        self.directory = pathlib.Path(self.temporary.name)
        self.native_directory = self.directory / 'native'
        self.native_directory.mkdir()

    def control(self, arguments):
        before = sorted(str(path.relative_to(self.directory)) for path in self.directory.rglob('*'))
        execution = subprocess.run(
            ['node', '--input-type=module', '-', str(self.native_directory), json.dumps(arguments)],
            input=CONTROL, cwd=REPOSITORY, text=True, capture_output=True, timeout=10,
        )
        self.assertEqual(execution.returncode, 0, execution.stderr)
        self.assertEqual(before, sorted(str(path.relative_to(self.directory)) for path in self.directory.rglob('*')))
        return json.loads(execution.stdout)

    def arguments(self, *additional):
        return ['ios', '--suite=performance', '--skip-build',
                '--diagnostic-directory=' + str(self.native_directory / 'diagnostics' / 'owned-run'), *additional]

    def test_ordinary_performance_keeps_canonical_directory_and_build_support(self):
        proof = self.control(['android', '--suite=performance'])
        self.assertTrue(proof['accepted'])
        self.assertFalse(proof['result']['diagnosticOnly'])
        self.assertFalse(proof['result']['skipBuild'])
        self.assertEqual(proof['result']['artifactDirectory'], str(self.native_directory))
        self.assertNotIn('memoryMode', proof['result'])

    def test_memory_modes_reuse_verified_build_and_isolate_evidence(self):
        for mode in ['fixed-conservative', 'adaptive']:
            with self.subTest(mode=mode):
                proof = self.control(self.arguments('--memory-mode=' + mode))
                self.assertTrue(proof['accepted'])
                self.assertTrue(proof['result']['diagnosticOnly'])
                self.assertTrue(proof['result']['skipBuild'])
                self.assertEqual(proof['result']['memoryMode'], mode)
                self.assertEqual(proof['result']['artifactDirectory'], str(self.native_directory / 'diagnostics' / 'owned-run'))

    def test_network_arms_require_same_fixed_budget_and_keep_delay_explicit(self):
        for arm in ['single', 'bundle']:
            proof = self.control(self.arguments('--memory-mode=fixed-conservative', '--network-arm=' + arm))
            self.assertTrue(proof['accepted'])
            self.assertEqual(proof['result']['controlledDelayMilliseconds'], 100)
        rejected = self.control(self.arguments('--memory-mode=adaptive', '--network-arm=single'))
        self.assertFalse(rejected['accepted'])

    def test_invalid_or_incomplete_diagnostics_fail_before_any_writes(self):
        cases = [
            ['ios', '--suite=performance', '--memory-mode=adaptive'],
            ['ios', '--suite=performance', '--skip-build', '--diagnostic-directory=' + str(self.directory / 'outside'), '--memory-mode=adaptive'],
            self.arguments('--memory-mode=unknown'),
            self.arguments('--memory-mode=fixed-conservative', '--network-arm=unknown'),
            self.arguments('--memory-mode=fixed-conservative', '--network-arm=single', '--network-delay-milliseconds=NaN'),
            self.arguments('--memory-mode=fixed-conservative', '--network-arm=single', '--network-delay-milliseconds=1001'),
            self.arguments('--memory-mode=adaptive', '--network-delay-milliseconds=100'),
            [argument for argument in self.arguments('--memory-mode=adaptive') if argument != '--skip-build'],
            ['ios', '--suite=qualification', '--skip-build', '--memory-mode=adaptive', '--diagnostic-directory=' + str(self.native_directory / 'diagnostics' / 'owned-run')],
        ]
        for arguments in cases:
            with self.subTest(arguments=arguments):
                self.assertFalse(self.control(arguments)['accepted'])

    def test_existing_evidence_and_symlinked_parent_are_rejected(self):
        diagnostic_directory = self.native_directory / 'diagnostics' / 'owned-run'
        diagnostic_directory.mkdir(parents=True)
        retained = diagnostic_directory / 'retained.json'
        retained.write_text('immutable evidence')
        self.assertFalse(self.control(self.arguments('--memory-mode=adaptive'))['accepted'])
        self.assertEqual(retained.read_text(), 'immutable evidence')
        retained.unlink()
        diagnostic_directory.rmdir()
        (self.native_directory / 'diagnostics').rmdir()
        target = self.directory / 'owned-target'
        target.mkdir()
        (self.native_directory / 'diagnostics').symlink_to(target, target_is_directory=True)
        self.assertFalse(self.control(self.arguments('--memory-mode=adaptive'))['accepted'])
        self.assertEqual(list(target.iterdir()), [])

    def report_control(self, fault):
        execution = subprocess.run(
            ['node', '--input-type=module', '-', fault], input=REPORT_CONTROL,
            cwd=REPOSITORY, text=True, capture_output=True, timeout=10,
        )
        self.assertEqual(execution.returncode, 0, execution.stderr)
        return json.loads(execution.stdout)

    def test_complete_diagnostic_reports_are_always_excluded_from_acceptance(self):
        for mode in ['memory-success', 'network-success']:
            proof = self.report_control(mode)
            self.assertTrue(proof['report']['diagnosticOnly'])
            self.assertTrue(proof['report']['excludedFromAcceptance'])
            self.assertEqual(proof['report']['exitStatus'], 0)
            self.assertEqual(proof['exitCode'], 0)
            self.assertEqual(proof['report']['completedApplicationFingerprint'], 'unchanged-build')

    def test_incomplete_cleanup_or_changed_provenance_cannot_report_success(self):
        for fault in ['wrong-mode', 'missing-owner', 'pending-owner', 'malformed-owner', 'malformed-checks', 'changed-instrumentation', 'changed-build', 'network-retained-work']:
            with self.subTest(fault=fault):
                proof = self.report_control(fault)
                self.assertEqual(proof['report']['exitStatus'], 1)
                self.assertEqual(proof['exitCode'], 1)
                self.assertIn('diagnosticFailure', proof['report'])


if __name__ == '__main__':
    unittest.main()

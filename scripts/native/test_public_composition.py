"""Actual public runtime source with async platform boundary and SQLite controls."""
import json
import pathlib
import subprocess
import unittest
import xml.etree.ElementTree as ElementTree

REPOSITORY = pathlib.Path(__file__).resolve().parents[2]


class PublicCompositionTests(unittest.TestCase):
    def test_snapshot_row_capacity_cache_preserves_sql_values_errors_and_invocation_lifecycle(self):
        execution = subprocess.run(
            ['node', '--test', '--test-reporter=junit', 'packages/client/tests/native/snapshot-row-capacity.test.mjs'],
            cwd=REPOSITORY, text=True, capture_output=True, timeout=45,
        )
        self.assertEqual(execution.returncode, 0, execution.stderr)
        report = ElementTree.fromstring(execution.stdout)
        self.assertEqual(len(list(report.iter('testcase'))), 39)
        self.assertFalse(list(report.iter('failure')))
        self.assertFalse(list(report.iter('error')))
        self.assertFalse(list(report.iter('skipped')))

    def test_native_scalar_row_normalization_preserves_values_lifetime_and_transactions(self):
        execution = subprocess.run(
            ['node', '--test', '--test-reporter=junit', 'packages/client/tests/native/sqlite-row-normalization.test.mjs'],
            cwd=REPOSITORY, text=True, capture_output=True, timeout=45,
        )
        self.assertEqual(execution.returncode, 0, execution.stderr)
        report = ElementTree.fromstring(execution.stdout)
        self.assertGreaterEqual(len(list(report.iter('testcase'))), 12)
        self.assertFalse(list(report.iter('failure')))
        self.assertFalse(list(report.iter('error')))
        self.assertFalse(list(report.iter('skipped')))

    def test_http_cooperative_host_turns_preserve_frames_cancellation_and_deadline(self):
        execution = subprocess.run(
            ['node', '--test', '--test-reporter=junit', 'packages/client/tests/native/http-host-turn.test.mjs'],
            cwd=REPOSITORY, text=True, capture_output=True, timeout=45,
        )
        self.assertEqual(execution.returncode, 0, execution.stderr)
        report = ElementTree.fromstring(execution.stdout)
        self.assertEqual(len(list(report.iter('testcase'))), 10)
        self.assertFalse(list(report.iter('failure')))
        self.assertFalse(list(report.iter('error')))
        self.assertFalse(list(report.iter('skipped')))

    def test_public_rn_composition_auth_session_cancellation_and_resource_lifecycle(self):
        execution = subprocess.run(
            ['node', 'packages/client/tests/native/react-native-composition.test.mjs'],
            cwd=REPOSITORY, text=True, capture_output=True, timeout=45,
        )
        self.assertEqual(execution.returncode, 0, execution.stderr)
        proof = json.loads(execution.stdout)
        self.assertGreaterEqual(len(proof['observations']), 15)
        self.assertGreater(proof['deliveredCallbacks'], 0)
        self.assertEqual(proof['openedConnections'], proof['closedConnections'])
        self.assertTrue(all(value == 0 for value in proof['cleanup'].values()))
        self.assertIn('stuck-auth-cancellation-closes-without-provider-completion', proof['observations'])
        self.assertIn('raw-client-lifecycle-routes-and-nested-scope-bypass-rejection', proof['observations'])
        self.assertFalse(proof['nativePerformanceClaim'])


if __name__ == '__main__':
    unittest.main()

"""Test fixture ownership boundaries using exact helpers and isolated owned processes."""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import native_http_fixture
from http_process_metrics import process_identity, same_running_process, terminate_verified_processes


class NativeHttpFixtureTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='synloquent-fixture-control-')
        self.addCleanup(temporary.cleanup)
        self.repository = Path(temporary.name)
        self.registry = self.repository / '.local/processes.json'
        self.registry.parent.mkdir()
        self.connection = ['-h', '127.0.0.1', '-p', '55432', '-U', 'synloquent',
                           'synloquent_native_catalog_' + str(os.getpid())]

    def create_process_fixture(self, worker_count=1):
        source = '\n'.join([
            'import json, subprocess, sys',
            'workers = []',
            'for index in range(' + str(worker_count) + '):',
            "    workers.append(subprocess.Popen([sys.executable, '-c', 'import time\\ntime.sleep(120)'], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))",
            'print(json.dumps([worker.pid for worker in workers]), flush=True)',
            'sys.stdin.readline()',
        ])
        parent = subprocess.Popen([sys.executable, '-u', '-c', source], stdin=subprocess.PIPE,
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                                  start_new_session=True)
        workers = json.loads(parent.stdout.readline())
        identities = [process_identity(parent.pid), *(process_identity(worker) for worker in workers)]

        def cleanup():
            terminate_verified_processes(identities, timeout_seconds=1)
            parent.wait(timeout=5)
            parent.stdin.close()
            parent.stdout.close()
            parent.stderr.close()
        self.addCleanup(cleanup)
        configuration = {'ownerProcess': os.getpid(), 'hostProcess': parent.pid,
                         'database': self.connection[-1], 'address': 'http://127.0.0.1:8766'}
        self.registry.write_text(json.dumps({'fixture': {**configuration, 'active': True}}))
        return parent, identities, configuration

    def perform_cleanup(self, parent, identities, configuration, *, registry_registered=True):
        return native_http_fixture.cleanup_fixture(
            parent, identities, database_created=True, connection=self.connection,
            configuration=configuration, registry_registered=registry_registered,
            processes_path=self.registry, registry_key='fixture',
        )

    def test_createdb_failure_never_drops_existing_database_or_registry(self):
        original = {'fixture': {'database': self.connection[-1], 'active': True, 'ownerProcess': 99999}}
        self.registry.write_text(json.dumps(original))
        failure = subprocess.CalledProcessError(1, ['createdb', self.connection[-1]])
        with patch.object(native_http_fixture.subprocess, 'run', side_effect=failure) as database_command:
            with patch.object(native_http_fixture, 'drop_owned_database') as database_cleanup:
                status = native_http_fixture.main(['--port=0'], repository=self.repository)
        self.assertEqual(status, 1)
        self.assertEqual(database_command.call_count, 1)
        self.assertTrue(database_command.call_args.args[0][0].endswith('/createdb'))
        database_cleanup.assert_not_called()
        self.assertEqual(json.loads(self.registry.read_text()), original)
        report = json.loads((self.repository / '.local/test-results/native-http/fixture-lifecycle.json').read_text())
        self.assertEqual(report['failureReason'], str(failure))
        self.assertFalse(report['cleanupEvidence']['databaseCreated'])
        self.assertFalse(report['cleanupEvidence']['databaseRemoved'])
        self.assertFalse(report['ready'])

    def test_migration_primary_failure_survives_database_cleanup_failure(self):
        with patch.object(native_http_fixture.subprocess, 'run',
                          side_effect=[subprocess.CompletedProcess(['createdb'], 0), RuntimeError('migration primary failure')]):
            with patch.object(native_http_fixture, 'drop_owned_database', side_effect=OSError('cleanup unavailable')):
                status = native_http_fixture.main(['--port=0'], repository=self.repository)
        report = json.loads((self.repository / '.local/test-results/native-http/fixture-lifecycle.json').read_text())
        self.assertEqual(status, 1)
        self.assertEqual(report['failureReason'], 'migration primary failure')
        self.assertEqual(report['cleanupFailures'], ['Database cleanup failed: cleanup unavailable'])
        self.assertTrue(report['cleanupEvidence']['databaseCreated'])
        self.assertFalse(report['cleanupEvidence']['databaseRemoved'])

    def test_unexpected_parent_never_publishes_readiness_or_signals_process(self):
        parent, _, configuration = self.create_process_fixture()
        identities = []
        with self.assertRaisesRegex(ValueError, 'parent identity is unexpected'):
            native_http_fixture.capture_host_identities(parent, configuration, identities)
        self.assertEqual(identities, [])
        with patch('http_process_metrics.os.kill') as signalling:
            with patch.object(native_http_fixture, 'drop_owned_database') as database_cleanup:
                evidence, failures = self.perform_cleanup(parent, identities, configuration,
                                                          registry_registered=False)
            signalling.assert_not_called()
        database_cleanup.assert_not_called()
        self.assertIsNone(parent.poll())
        self.assertFalse(evidence['hostStopped'])
        self.assertTrue(failures)

    def test_changed_start_identity_prevents_signal_drop_and_inactive_registry(self):
        parent, identities, configuration = self.create_process_fixture()
        changed = [{**identities[0], 'startedAt': 'different immutable start'}, *identities[1:]]
        original = self.registry.read_text()
        with patch('http_process_metrics.os.kill') as signalling:
            with patch.object(native_http_fixture, 'drop_owned_database') as database_cleanup:
                evidence, failures = self.perform_cleanup(parent, changed, configuration)
            signalling.assert_not_called()
        database_cleanup.assert_not_called()
        self.assertIsNone(parent.poll())
        self.assertFalse(evidence['registryInactive'])
        self.assertFalse(evidence['cleanupCompleted'])
        self.assertEqual(self.registry.read_text(), original)
        self.assertTrue(any('identity changed' in failure for failure in failures))

    def test_unverified_group_member_prevents_all_signals_and_database_drop(self):
        parent, identities, configuration = self.create_process_fixture(worker_count=2)
        original = self.registry.read_text()
        with patch('http_process_metrics.os.kill') as signalling:
            with patch.object(native_http_fixture, 'drop_owned_database') as database_cleanup:
                evidence, failures = self.perform_cleanup(parent, identities[:2], configuration)
            signalling.assert_not_called()
        database_cleanup.assert_not_called()
        self.assertIsNone(parent.poll())
        self.assertIsNotNone(same_running_process(identities[2]))
        self.assertFalse(evidence['registryInactive'])
        self.assertEqual(self.registry.read_text(), original)
        self.assertTrue(any('unverified process' in failure for failure in failures))

    def test_registry_owner_host_database_and_address_mismatch_never_mutates_entry(self):
        for key, value in [('ownerProcess', 999999), ('hostProcess', 999999),
                           ('database', 'unowned_database'), ('address', 'http://127.0.0.1:9999')]:
            with self.subTest(key=key):
                parent, identities, configuration = self.create_process_fixture()
                foreign_entry = {'fixture': {**configuration, key: value, 'active': True}}
                self.registry.write_text(json.dumps(foreign_entry))
                with patch.object(native_http_fixture, 'drop_owned_database') as database_cleanup:
                    evidence, failures = self.perform_cleanup(parent, identities, configuration)
                database_cleanup.assert_called_once_with(self.connection)
                self.assertTrue(evidence['hostStopped'])
                self.assertTrue(evidence['databaseRemoved'])
                self.assertFalse(evidence['registryInactive'])
                self.assertEqual(json.loads(self.registry.read_text()), foreign_entry)
                self.assertTrue(any('registry identity changed' in failure for failure in failures))

    def test_reparented_verified_worker_cleanup_finishes_before_database_and_registry(self):
        parent, identities, configuration = self.create_process_fixture()
        parent.stdin.write('\n')
        parent.stdin.flush()
        parent.wait(timeout=5)
        self.assertNotEqual(process_identity(identities[1]['processId'])['parentProcessId'], parent.pid)

        def database_cleanup(connection):
            self.assertEqual(connection, self.connection)
            self.assertTrue(all(same_running_process(identity) is None for identity in identities))
        with patch.object(native_http_fixture, 'drop_owned_database', side_effect=database_cleanup):
            evidence, failures = self.perform_cleanup(parent, identities, configuration)
        self.assertEqual(failures, [])
        self.assertTrue(evidence['hostStopped'])
        self.assertTrue(evidence['databaseRemoved'])
        self.assertTrue(evidence['registryInactive'])
        self.assertTrue(evidence['cleanupCompleted'])
        self.assertFalse(json.loads(self.registry.read_text())['fixture']['active'])
        self.assertIn(identities[1]['processId'], evidence['processTermination']['reparentedProcessIds'])


if __name__ == '__main__':
    unittest.main()

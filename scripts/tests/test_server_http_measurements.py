"""Reject incomplete lifecycle or conflated cold/warm HTTP evidence."""

import copy
import contextlib
import json
import os
import signal
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server_http_performance
from server_http_measurements import validate_sample


class ServerHttpMeasurementTests(unittest.TestCase):
    def setUp(self):
        self.sample = {'fingerprint': 'candidate', 'finishedFingerprint': 'candidate',
                       'independentOracle': {'independentContentMatches': True,
                                             'records': 117115, 'relationSets': 51128, 'relationTargets': 600}}
        for key in ('measurement', 'authenticatedDownload'):
            self.sample[key] = {
                'elapsedMilliseconds': 1200,
                'matchesSnapshot': True,
                'wholeLifecycle': {'status': 200, 'memoryLimit': '128M',
                                   'elapsedLifecycleSeconds': 1.1, 'logicalPeakBytes': 100,
                                   'allocatedPeakBytes': 200,
                                   'profile': {'seconds': 1.0, 'phases': {
                                       'snapshot.catalogReadback': {'seconds': 0.1, 'calls': 1},
                                       'snapshot.contentPersistence': {'seconds': 0.1, 'calls': 1},
                                   }}},
                'workerMemory': {'processId': 100, 'sampleCount': 20,
                                 'baselineRssBytes': 1000, 'maximumObservedRssBytes': 2000},
            }

    def test_http_cold_and_warm_paths_require_distinct_cache_provenance(self):
        self.assertEqual(len(validate_sample(self.sample, 'cold', 'candidate')), 2)
        with self.assertRaises(ValueError):
            validate_sample(self.sample, 'warm', 'candidate')
        changed = copy.deepcopy(self.sample)
        changed['measurement']['wholeLifecycle']['profile']['phases']['snapshot.contentCacheHit'] = {'seconds': 0, 'calls': 1}
        self.assertEqual(len(validate_sample(changed, 'warm', 'candidate')), 2)
        with self.assertRaises(ValueError):
            validate_sample(changed, 'cold', 'candidate')

    def test_http_whole_lifecycle_memory_and_phase_clocks_are_required(self):
        for mutation in ('missing-lifecycle', 'larger-memory-limit', 'one-sample', 'fractional-pid',
                         'nonfinite-phase', 'controller-after-lifecycle', 'lifecycle-after-http'):
            changed = copy.deepcopy(self.sample)
            measurement = changed['measurement']
            if mutation == 'missing-lifecycle':
                measurement['wholeLifecycle'] = None
            elif mutation == 'larger-memory-limit':
                measurement['wholeLifecycle']['memoryLimit'] = '512M'
            elif mutation == 'one-sample':
                measurement['workerMemory']['sampleCount'] = 1
            elif mutation == 'fractional-pid':
                measurement['workerMemory']['processId'] = 100.5
            elif mutation == 'nonfinite-phase':
                measurement['wholeLifecycle']['profile']['phases']['snapshot.catalogReadback']['seconds'] = float('nan')
            elif mutation == 'controller-after-lifecycle':
                measurement['wholeLifecycle']['profile']['seconds'] = 1.2
            else:
                measurement['elapsedMilliseconds'] = 500
            with self.assertRaises(ValueError, msg=mutation):
                validate_sample(changed, 'cold', 'candidate')

    def test_http_changed_candidate_or_download_content_cannot_pass(self):
        changed = copy.deepcopy(self.sample)
        changed['finishedFingerprint'] = 'changed'
        with self.assertRaises(ValueError):
            validate_sample(changed, 'cold', 'candidate')
        changed = copy.deepcopy(self.sample)
        changed['authenticatedDownload']['matchesSnapshot'] = False
        with self.assertRaises(ValueError):
            validate_sample(changed, 'cold', 'candidate')

    def test_http_wrapper_registry_identity_requires_address_and_preserves_other_entries(self):
        cases = [(None, None), ('ownerProcess', 999999), ('hostProcess', 999999),
                 ('database', 'unowned_database'), ('address', 'http://127.0.0.1:9999')]
        executable = server_http_performance.running_python_executable()
        for changed_key, changed_value in cases:
            with self.subTest(changed_key=changed_key):
                with tempfile.TemporaryDirectory(prefix='synloquent-http-wrapper-control-') as temporary:
                    repository = Path(temporary)
                    artifacts = repository / '.local/test-results/server-http-performance'
                    registry_path = repository / '.local/processes.json'
                    configuration = {'ownerProcess': 123401, 'hostProcess': 123402,
                                     'database': 'synloquent_native_catalog_123401'}
                    foreign_entry = {'active': True, 'marker': 'preserve', 'ownerProcess': 999998,
                                     'nested': {'values': ['exact', 7, None]}}
                    launch_commands = []
                    registry_entry = None

                    class Fixture:
                        pid = 123401
                        returncode = None

                        def poll(self):
                            return self.returncode

                        def wait(self, timeout):
                            if timeout > 30 or self.returncode is None:
                                raise AssertionError('Unexpected fixture wait')
                            return self.returncode

                        def send_signal(self, supplied_signal):
                            if supplied_signal != signal.SIGINT:
                                raise AssertionError('Unexpected fixture signal')
                            self.returncode = 0

                    fixture = Fixture()

                    def launch(command, **options):
                        nonlocal registry_entry
                        launch_commands.append(command)
                        configuration['address'] = 'http://127.0.0.1:' + command[command.index('--port') + 1]
                        destination = Path(command[command.index('--configuration') + 1])
                        destination.write_text(json.dumps(configuration))
                        registry_entry = {**configuration, 'active': True}
                        if changed_key is not None:
                            registry_entry[changed_key] = changed_value
                        registry_path.write_text(json.dumps({
                            'serverHttpPerformance': registry_entry, 'foreignEntry': foreign_entry,
                        }))
                        return fixture

                    def identity(process_identifier):
                        if process_identifier == fixture.pid:
                            return {'processId': fixture.pid, 'parentProcessId': os.getpid(),
                                    'processGroupId': fixture.pid, 'startedAt': 'owned wrapper control',
                                    'arguments': launch_commands[0]}
                        if process_identifier != configuration['hostProcess']:
                            raise AssertionError('Unexpected process identity lookup')
                        return {'processId': process_identifier, 'parentProcessId': fixture.pid,
                                'processGroupId': process_identifier, 'startedAt': 'owned wrapper control',
                                'arguments': ['php', 'artisan', 'serve', '--host=127.0.0.1',
                                              '--port=' + configuration['address'].rsplit(':', 1)[1], '--tries=1']}

                    def execute(command, **options):
                        if not command[1].endswith('/scripts/probe_native_http.py'):
                            raise AssertionError('Unexpected external command')
                        phase = command[command.index('--label') + 1]
                        sample = copy.deepcopy(self.sample)
                        sample.update({'snapshotHash': 'owned snapshot', 'canonicalBytes': 7, 'scope': 'catalog'})
                        if phase == 'warm':
                            sample['measurement']['wholeLifecycle']['profile']['phases']['snapshot.contentCacheHit'] = {
                                'seconds': 0, 'calls': 1,
                            }
                        (artifacts / (phase + '.json')).write_text(json.dumps(sample))
                        return subprocess.CompletedProcess(command, 0)

                    def database_presence(command, **options):
                        if not command[0].endswith('/psql') or configuration['database'] not in command[-1]:
                            raise AssertionError('Unexpected database presence query')
                        return ''

                    with contextlib.ExitStack() as stack:
                        stack.enter_context(patch.object(server_http_performance, '__file__',
                                                        str(repository / 'scripts/server_http_performance.py')))
                        stack.enter_context(patch.dict(os.environ, {'SYNLOQUENT_CANDIDATE_FINGERPRINT': 'candidate'}))
                        stack.enter_context(patch.object(server_http_performance, 'fingerprint', return_value='candidate'))
                        stack.enter_context(patch.object(server_http_performance.subprocess, 'Popen', side_effect=launch))
                        stack.enter_context(patch.object(server_http_performance.subprocess, 'run', side_effect=execute))
                        stack.enter_context(patch.object(server_http_performance.subprocess, 'check_output', side_effect=database_presence))
                        stack.enter_context(patch.object(server_http_performance, 'running_python_executable', return_value=executable))
                        stack.enter_context(patch.object(server_http_performance.socket, 'create_connection',
                                                        return_value=contextlib.nullcontext()))
                        stack.enter_context(patch.object(server_http_performance, 'process_identity', side_effect=identity))
                        stack.enter_context(patch.object(server_http_performance, 'same_running_process',
                                                        side_effect=lambda original: original if fixture.poll() is None else None))
                        stack.enter_context(patch.object(server_http_performance, 'worker_identity', return_value={
                            'processId': 123403, 'parentProcessId': 123402, 'processGroupId': 123402,
                            'startedAt': 'owned wrapper control', 'arguments': ['php', '-S', 'owned'],
                        }))
                        stack.enter_context(patch.object(server_http_performance, 'verified_group_members', return_value=[]))
                        status = server_http_performance.main()
                    report = json.loads((artifacts / 'result.json').read_text())
                    registry = json.loads(registry_path.read_text())
                    self.assertEqual(registry['foreignEntry'], foreign_entry)
                    self.assertEqual(report['failureReason'], None)
                    if changed_key is None:
                        self.assertEqual(status, 0)
                        self.assertEqual(report['exitStatus'], 0)
                        self.assertFalse(registry['serverHttpPerformance']['active'])
                        self.assertTrue(report['cleanupEvidence']['completed'])
                        self.assertEqual(report['cleanupFailures'], [])
                    else:
                        self.assertEqual(status, 1)
                        self.assertEqual(report['exitStatus'], 1)
                        self.assertEqual(registry['serverHttpPerformance'], registry_entry)
                        self.assertTrue(registry['serverHttpPerformance']['active'])
                        self.assertTrue(any('registry identity changed' in failure for failure in report['cleanupFailures']))
                        self.assertNotIn('completed', report['cleanupEvidence'])

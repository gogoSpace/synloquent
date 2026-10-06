#!/usr/bin/env python3
"""Prove cold creation and warm reuse over the entire owned PHP HTTP lifecycle."""

import json
import os
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path

from test_support import fingerprint
from http_process_metrics import (
    process_identity,
    running_python_executable,
    same_running_process,
    terminate_verified_processes,
    verified_group_members,
    worker_identity,
)
from server_http_measurements import validate_sample


def main():
    repository = Path(__file__).resolve().parents[1]
    artifacts = repository / '.local/test-results/server-http-performance'
    artifacts.mkdir(parents=True, exist_ok=True)
    configuration_path = artifacts / 'fixture.json'
    configuration_path.unlink(missing_ok=True)
    candidate = os.environ.get('SYNLOQUENT_CANDIDATE_FINGERPRINT') or fingerprint()
    with socket.socket() as reservation:
        reservation.bind(('127.0.0.1', 0))
        port = reservation.getsockname()[1]

    fixture = None
    fixture_identity = None
    configuration = None
    configuration_verified = False
    owned_host_identities = []
    scenarios = []
    samples = []
    exit_status = 1
    failure_reason = None
    cleanup_failures = []
    cleanup_evidence = {}
    try:
        interpreter_executable = running_python_executable()
        with (artifacts / 'fixture.log').open('w') as fixture_log:
            fixture = subprocess.Popen([
                interpreter_executable, str(repository / 'scripts/native_http_fixture.py'),
                '--port', str(port), '--configuration', str(configuration_path),
                '--artifacts', str(artifacts), '--registry-key', 'serverHttpPerformance',
                '--lifecycle-profiles', str(artifacts / 'lifecycles'),
            ], cwd=repository, stdout=fixture_log, stderr=subprocess.STDOUT)
            fixture_identity = process_identity(fixture.pid)
            deadline = time.monotonic() + 120
            while True:
                if fixture.poll() is not None or time.monotonic() >= deadline:
                    raise RuntimeError('Owned fresh HTTP fixture did not start')
                if configuration_path.exists():
                    try:
                        with socket.create_connection(('127.0.0.1', port), timeout=0.2):
                            break
                    except OSError:
                        pass
                time.sleep(0.1)
            configuration = json.loads(configuration_path.read_text())
            if (configuration.get('ownerProcess') != fixture.pid
                    or configuration.get('database') != 'synloquent_native_catalog_' + str(fixture.pid)
                    or configuration.get('address') != 'http://127.0.0.1:' + str(port)):
                raise ValueError('Fresh fixture configuration has an unverified identity')
            host_identity = process_identity(configuration['hostProcess'])
            if (host_identity['parentProcessId'] != fixture.pid
                    or host_identity['processGroupId'] != configuration['hostProcess']
                    or Path(host_identity['arguments'][0]).name != 'php'
                    or host_identity['arguments'][1:] != [
                        'artisan', 'serve', '--host=127.0.0.1', '--port=' + str(port), '--tries=1']):
                raise ValueError('Fresh PHP host is not the expected owned process')
            owned_host_identities = [host_identity, worker_identity(configuration)]
            verified_group_members(owned_host_identities)
            configuration_verified = True
            for phase in ('cold', 'warm'):
                with (artifacts / (phase + '.log')).open('w') as probe_log:
                    subprocess.run([
                        interpreter_executable, str(repository / 'scripts/probe_native_http.py'),
                        '--label', phase, '--configuration', str(configuration_path),
                        '--artifacts', str(artifacts),
                    ], cwd=repository, stdout=probe_log, stderr=subprocess.STDOUT,
                        check=True, timeout=300)
                sample = json.loads((artifacts / (phase + '.json')).read_text())
                samples.append(sample)
                scenarios.extend(validate_sample(sample, phase, candidate))
            for key in ('snapshotHash', 'canonicalBytes', 'scope'):
                if samples[0].get(key) != samples[1].get(key):
                    raise ValueError('Cold and warm catalog content or authorization differs: ' + key)
            exit_status = 0
    except (OSError, ValueError, RuntimeError, KeyError, TypeError, IndexError, AttributeError, subprocess.SubprocessError, KeyboardInterrupt) as failure:
        failure_reason = str(failure)
        print(failure_reason, file=sys.stderr)
    finally:
        try:
            if fixture is not None:
                if fixture.poll() is None:
                    if fixture_identity is None or same_running_process(fixture_identity) is None:
                        raise ValueError('Fixture cleanup cannot verify the original owner process')
                    fixture.send_signal(signal.SIGINT)
                    try:
                        fixture.wait(timeout=30)
                    except subprocess.TimeoutExpired:
                        cleanup_failures.append('Owned HTTP fixture graceful cleanup timed out')
                        exit_status = 1
                        current_configuration = json.loads(configuration_path.read_text())
                        if (not configuration_verified or configuration is None or current_configuration != configuration
                                or configuration.get('ownerProcess') != fixture.pid
                                or configuration.get('database') != 'synloquent_native_catalog_' + str(fixture.pid)
                                or not owned_host_identities):
                            raise ValueError('Cleanup recovery cannot verify the original fixture configuration')
                        cleanup_evidence['phpRecovery'] = terminate_verified_processes(owned_host_identities)
                        if same_running_process(fixture_identity) is not None:
                            fixture.kill()
                        fixture.wait(timeout=5)
                        subprocess.run([
                            str(Path(os.environ.get('SYNLOQUENT_POSTGRES_BIN', '')) / 'dropdb'), '-h', '127.0.0.1',
                            '-p', '55432', '-U', 'synloquent', '--if-exists', '--force',
                            configuration['database'],
                        ], check=True, timeout=30)
                if fixture.poll() is None:
                    raise RuntimeError('The owned fixture process is still running')
                if owned_host_identities and verified_group_members(owned_host_identities):
                    raise RuntimeError('The owned PHP processes are still running after cleanup')
                if configuration is not None:
                    if not configuration_verified:
                        raise ValueError('Database and registry cleanup require the verified startup configuration')
                    database_presence = subprocess.check_output([
                        str(Path(os.environ.get('SYNLOQUENT_POSTGRES_BIN', '')) / 'psql'), '-h', '127.0.0.1',
                        '-p', '55432', '-U', 'synloquent', '-d', 'postgres', '-At', '-c',
                        "SELECT 1 FROM pg_database WHERE datname = '" + configuration['database'] + "'",
                    ], text=True, timeout=10).strip()
                    if database_presence:
                        raise RuntimeError('The owned fixture database still exists after cleanup')
                    processes_path = repository / '.local/processes.json'
                    processes = json.loads(processes_path.read_text())
                    registered = processes.get('serverHttpPerformance', {})
                    if any(registered.get(key) != configuration.get(key)
                           for key in ('ownerProcess', 'hostProcess', 'database', 'address')):
                        raise ValueError('Fixture registry identity changed before cleanup finished')
                    registered['active'] = False
                    registered['cleanupCompletedAt'] = time.time()
                    processes_path.write_text(json.dumps(processes, indent=2) + '\n')
                    cleanup_evidence['completed'] = True
                if fixture.returncode:
                    raise RuntimeError('Owned fixture process exited unsuccessfully: ' + str(fixture.returncode))
        except (OSError, ValueError, RuntimeError, KeyError, TypeError, IndexError, AttributeError, subprocess.SubprocessError, KeyboardInterrupt) as cleanup_failure:
            cleanup_failures.append(str(cleanup_failure))
            exit_status = 1
        try:
            finished_candidate = fingerprint()
        except (OSError, ValueError, RuntimeError) as fingerprint_failure:
            finished_candidate = None
            cleanup_failures.append('Final candidate fingerprint failed: ' + str(fingerprint_failure))
            exit_status = 1
        candidate_changed = finished_candidate != candidate
        if candidate_changed:
            if failure_reason is None:
                failure_reason = 'Candidate changed before whole HTTP performance cleanup finished'
            exit_status = 1
        report = {
            'fingerprint': candidate, 'finishedFingerprint': finished_candidate,
            'exitStatus': exit_status, 'scenarios': scenarios, 'samples': samples,
            'failureReason': failure_reason, 'cleanupFailures': cleanup_failures,
            'cleanupEvidence': cleanup_evidence, 'candidateChanged': candidate_changed,
            'ownedFixtureProcessIdentity': fixture_identity,
            'ownedPhpProcessIdentities': owned_host_identities,
            'limitations': 'Loopback HTTP and Python decode. Independent seed oracle and payload comparisons are outside HTTP timers. PHP termination captures response sending. RSS is externally sampled, not an exact OS peak. No Hermes timing claim.',
        }
        (artifacts / 'result.json').write_text(json.dumps(report, indent=2) + '\n')
    return exit_status


if __name__ == '__main__':
    raise SystemExit(main())

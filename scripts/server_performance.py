#!/usr/bin/env python3
"""Qualify actual PostgreSQL polling latency without accepting a documentation-only limit."""
import hashlib
import json
import math
import os
import platform
import subprocess
from pathlib import Path
from test_support import fingerprint, utc_time

def measured_number(value: object, minimum: float = 0) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= minimum


def validate_measurements(measurements: dict[str, object], budgets: dict[str, float]) -> list[dict[str, object]]:
    samples = measurements.get('samples')
    if not isinstance(samples, list) or len(samples) != 2:
        raise ValueError('The server witness must contain both exact catalog scales')
    actual_scales = {(sample.get('items'), sample.get('children')) for sample in samples if isinstance(sample, dict)}
    if actual_scales != {(1000, 6000), (17000, 100000)}:
        raise ValueError('The server witness omitted a required catalog scale')
    for sample in samples:
        snapshot = sample.get('snapshot')
        if not isinstance(snapshot, dict) or snapshot.get('recordCount') != sample['items'] + sample['children']:
            raise ValueError('Actual snapshot record count does not match the required seeded catalog')
    scenarios = []
    for name, key, budget_key, expected_changes in [
        ('server-unchanged-pull', 'unchangedPull', 'unchangedSeconds', None),
        ('server-small-delta-pull', 'singleEditPull', 'singleEditSeconds', 1),
        ('server-batch-delta-pull', 'hundredEditPull', 'hundredEditSeconds', 100),
    ]:
        failures = []
        for sample in samples:
            measured = sample.get(key)
            scale = str(sample['items']) + ' items'
            if not isinstance(measured, dict):
                failures.append(scale + ' lacks ' + key + ' measurements')
                continue
            elapsed = measured.get('seconds')
            if not measured_number(elapsed) or elapsed > budgets[budget_key]:
                failures.append(scale + ' lacks passing latency evidence for ' + key)
            allocation_growth = measured.get('peakGrowthBytes')
            if not measured_number(allocation_growth) or allocation_growth > budgets['peakGrowthBytes']:
                failures.append(scale + ' lacks bounded allocation growth evidence')
            if not measured_number(measured.get('sqlQueries'), 1):
                failures.append(scale + ' lacks actual SQL count evidence')
            if any(not measured_number(measured.get(metric), 1) for metric in ['rssBytes', 'baselineRssBytes', 'maximumRssBytes']):
                failures.append(scale + ' lacks actual process resident-memory measurements')
            held = measured.get('streamLockHeldSeconds')
            if not measured_number(held) or measured_number(elapsed) and held > elapsed + 0.005:
                failures.append(scale + ' lacks measured bounded stream-lock hold time')
            if not isinstance(measured.get('sqlProfile'), list) or not measured['sqlProfile']:
                failures.append(scale + ' lacks an actual SQL work profile')
            if expected_changes is not None and (not isinstance(measured.get('plans'), dict) or not {'synloquent_projection_memberships', 'items'}.issubset(measured['plans'])):
                failures.append(scale + ' lacks actual membership and resource execution plans')
            if expected_changes is not None and (measured.get('changeCount') != expected_changes or not measured_number(measured.get('responseBytes'), 1)):
                failures.append(scale + ' lacks the exact changed-row and response-byte witness')
        scenarios.append({'name': name, 'status': 'fail' if failures else 'pass', 'failures': failures})
    failures = []
    for sample in samples:
        concurrent = sample.get('concurrentWriterPull')
        if not isinstance(concurrent, dict):
            failures.append(str(sample['items']) + ' items lacks an actual concurrent writer measurement')
            continue
        wait = concurrent.get('writerLockWaitSeconds')
        if not measured_number(wait) or wait > budgets['writerWaitSeconds'] or concurrent.get('tailPreserved') is not True:
            failures.append(str(sample['items']) + ' items lacks passing lock wait and preserved committed tail evidence')
    scenarios.append({'name': 'server-concurrent-writer', 'status': 'fail' if failures else 'pass', 'failures': failures})
    return scenarios


def main() -> None:
    repository = Path(__file__).resolve().parents[1]
    artifacts = repository / '.local/test-results/server-performance'
    artifacts.mkdir(parents=True, exist_ok=True)
    database = 'synloquent_performance_' + str(os.getpid())
    postgres = (os.environ.get('SYNLOQUENT_POSTGRES_BIN', '').rstrip('/') + '/' if os.environ.get('SYNLOQUENT_POSTGRES_BIN') else '')
    connection = ['-h', '127.0.0.1', '-p', '55432', '-U', 'synloquent', database]
    candidate = fingerprint()
    started = utc_time()
    command = ['php', 'packages/laravel/tests/Fixtures/performance.php']
    budgets = {'unchangedSeconds': 0.25, 'singleEditSeconds': 0.5, 'hundredEditSeconds': 1.0, 'writerWaitSeconds': 0.1, 'peakGrowthBytes': 128 * 1024 * 1024}
    subprocess.run([postgres + 'createdb', *connection], check=True)
    try:
        with (artifacts / 'stderr.log').open('w') as errors:
            result = subprocess.run(command, cwd=repository, env={**os.environ, 'SYNLOQUENT_TEST_DATABASE': database}, text=True, stdout=subprocess.PIPE, stderr=errors, timeout=600, check=False)
        if result.returncode:
            raise RuntimeError('Actual server benchmark failed, inspect server-performance/stderr.log')
        measurements = json.loads(result.stdout)
        (artifacts / 'measurements.json').write_text(json.dumps(measurements, indent=2) + '\n')
        scenarios = validate_measurements(measurements, budgets)
        unchanged_candidate = fingerprint() == candidate
        if not unchanged_candidate:
            for scenario in scenarios:
                scenario['status'] = 'fail'
                scenario['failures'].append('Source candidate changed during server performance qualification')
        report = {'fingerprint': candidate, 'startedAt': started, 'finishedAt': utc_time(), 'command': command, 'exitStatus': 0 if unchanged_candidate and all(scenario['status'] == 'pass' for scenario in scenarios) else 1, 'scenarios': scenarios, 'budgets': budgets, 'environment': {'platform': platform.platform(), 'machine': platform.machine()}, 'measurements': measurements, 'fixtureHash': hashlib.sha256((repository / command[1]).read_bytes()).hexdigest()}
        (repository / '.local/test-results/server-performance.json').write_text(json.dumps(report, indent=2) + '\n')
        print(json.dumps({'scenarios': scenarios, 'budgets': budgets}, indent=2))
        raise SystemExit(report['exitStatus'])
    finally:
        subprocess.run([postgres + 'dropdb', '--if-exists', '--force', *connection], check=True)


if __name__ == '__main__':
    main()

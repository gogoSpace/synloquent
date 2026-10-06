#!/usr/bin/env python3
"""Serve an isolated deterministic large catalog for end-to-end native timing."""

import argparse
import json
import os
import socket
import subprocess
import sys
import time
from pathlib import Path

from http_process_metrics import (
    process_identity,
    same_running_process,
    terminate_verified_processes,
    verified_group_members,
    worker_identity,
)
from native_http_oracle import EXPECTED_RECORD_COUNTS, EXPECTED_RELATION_COUNTS

postgres = (os.environ.get('SYNLOQUENT_POSTGRES_BIN', '').rstrip('/') + '/' if os.environ.get('SYNLOQUENT_POSTGRES_BIN') else '')

catalog = '''
INSERT INTO users (id, tenant_id, name) VALUES (1, 1, 'Native HTTP catalog actor');
INSERT INTO categories (id, tenant_id, title)
SELECT sequence, 1, 'Category ' || sequence FROM generate_series(1, 50) AS sequence;
INSERT INTO tags (id, tenant_id, title)
SELECT sequence, 1, 'Tag ' || sequence FROM generate_series(1, 64) AS sequence;
INSERT INTO items (id, tenant_id, category_id, title, price, active, quantity, metadata)
SELECT sequence, 1, (sequence % 50) + 1, 'Synthetic item ' || lpad(sequence::text, 5, '0'),
       ((sequence % 10000)::text || '.' || lpad((sequence % 100)::text, 2, '0'))::numeric,
       sequence % 7 <> 0, sequence % 20, NULL
FROM generate_series(1, 17000) AS sequence;
INSERT INTO images (id, tenant_id, item_id, url)
SELECT sequence, 1, (sequence % 17000) + 1, 'image-20261002-' || sequence || '.jpg'
FROM generate_series(1, 100001) AS sequence;
INSERT INTO item_tag (item_id, tag_id, position)
SELECT parent, ((parent + position) % 64) + 1, position
FROM generate_series(1, 100) AS parent CROSS JOIN generate_series(0, 2) AS position;
SELECT setval(pg_get_serial_sequence('users', 'id'), 1, true);
SELECT setval(pg_get_serial_sequence('categories', 'id'), 50, true);
SELECT setval(pg_get_serial_sequence('tags', 'id'), 64, true);
SELECT setval(pg_get_serial_sequence('items', 'id'), 17000, true);
SELECT setval(pg_get_serial_sequence('images', 'id'), 100001, true);
'''
invalidate = r'''require 'vendor/autoload.php';
$application = require 'bootstrap/app.php';
$application->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();
$actor = new Synloquent\Laravel\Sync\ActorContext('1', '1', 'native-http-epoch', '1', App\Models\User::findOrFail(1), 'native-http-device');
$application->make(Synloquent\Laravel\Sync\WriteGateway::class)->transaction($actor, function (Synloquent\Laravel\Sync\WriteContext $context): void { $context->invalidateAuthorization(); });
'''

def capture_host_identities(server, configuration, identities, timeout_seconds=30):
    """Record the launched parent and exact HTTP worker before publishing readiness."""
    parent = process_identity(server.pid)
    expected_arguments = ['artisan', 'serve', '--host=127.0.0.1',
                          '--port=' + str(configuration['address'].rsplit(':', 1)[1]), '--tries=1']
    if (parent['parentProcessId'] != configuration['ownerProcess']
            or parent['processGroupId'] != server.pid
            or Path(parent['arguments'][0]).name != 'php'
            or parent['arguments'][1:] != expected_arguments):
        raise ValueError('Fixture PHP parent identity is unexpected')
    identities.append(parent)
    deadline = time.monotonic() + timeout_seconds
    while True:
        if server.poll() is not None or same_running_process(parent) is None:
            raise RuntimeError('Fixture PHP parent exited before verified readiness')
        try:
            worker = worker_identity(configuration)
        except ValueError:
            if time.monotonic() >= deadline:
                raise RuntimeError('Fixture PHP worker did not reach verified readiness')
            time.sleep(0.05)
            continue
        identities.append(worker)
        verified_group_members(identities)
        return


def drop_owned_database(connection):
    subprocess.run([postgres + 'dropdb', '--if-exists', '--force', *connection],
                   check=True, timeout=30)
    database = connection[-1]
    presence = subprocess.check_output([
        postgres + 'psql', *connection[:-1], '-d', 'postgres', '-At', '-c',
        "SELECT 1 FROM pg_database WHERE datname = '" + database + "'",
    ], text=True, timeout=10).strip()
    if presence:
        raise RuntimeError('The owned fixture database still exists after cleanup')


def cleanup_fixture(server, identities, *, database_created, connection,
                    configuration, registry_registered, processes_path, registry_key):
    failures = []
    evidence = {'hostStopped': server is None, 'databaseCreated': database_created,
                'databaseRemoved': False, 'registryInactive': False}
    if server is not None:
        try:
            if not identities:
                raise ValueError('Fixture host cleanup has no verified immutable process identities')
            evidence['processTermination'] = terminate_verified_processes(identities)
            server.wait(timeout=5)
            if verified_group_members(identities):
                raise RuntimeError('The owned fixture PHP processes are still running')
            evidence['hostStopped'] = True
        except (OSError, ValueError, RuntimeError, KeyError, TypeError, IndexError,
                AttributeError, subprocess.SubprocessError, KeyboardInterrupt) as failure:
            failures.append('Host cleanup failed: ' + str(failure))
    if database_created and evidence['hostStopped']:
        try:
            drop_owned_database(connection)
            evidence['databaseRemoved'] = True
        except (OSError, ValueError, RuntimeError, subprocess.SubprocessError,
                KeyboardInterrupt) as failure:
            failures.append('Database cleanup failed: ' + str(failure))
    elif database_created:
        failures.append('Database retained because owned host shutdown is not verified')
    if registry_registered:
        try:
            processes = json.loads(processes_path.read_text())
            registered = processes.get(registry_key, {})
            if configuration is None or any(
                    registered.get(key) != configuration.get(key)
                    for key in ('ownerProcess', 'hostProcess', 'database', 'address')):
                raise ValueError('Fixture registry identity changed before cleanup')
            if not database_created:
                raise ValueError('Registry cleanup has no proven database creation ownership')
            if evidence['hostStopped'] and evidence['databaseRemoved']:
                registered['active'] = False
                registered['cleanupCompletedAt'] = time.time()
                processes_path.write_text(json.dumps(processes, indent=2) + '\n')
                evidence['registryInactive'] = True
        except (OSError, ValueError, RuntimeError, KeyError, TypeError,
                AttributeError, KeyboardInterrupt) as failure:
            failures.append('Registry cleanup failed: ' + str(failure))
    evidence['cleanupCompleted'] = not failures and evidence['hostStopped'] and (
        not database_created or evidence['databaseRemoved']) and (
        not registry_registered or evidence['registryInactive'])
    return evidence, failures


def main(argument_list=None, *, repository=None):
    repository = repository or Path(__file__).resolve().parents[1]
    host = repository / 'examples/laravel'
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=8766)
    parser.add_argument('--configuration', type=Path, default=repository / '.local/native-http-fixture.json')
    parser.add_argument('--artifacts', type=Path, default=repository / '.local/test-results/native-http')
    parser.add_argument('--registry-key', default='nativeCatalogHttp')
    parser.add_argument('--lifecycle-profiles', type=Path)
    arguments = parser.parse_args(argument_list)
    artifacts = arguments.artifacts
    artifacts.mkdir(parents=True, exist_ok=True)
    database = 'synloquent_native_catalog_' + str(os.getpid())
    connection = ['-h', '127.0.0.1', '-p', '55432', '-U', 'synloquent', database]
    environment = {**os.environ, 'DB_CONNECTION': 'pgsql', 'DB_DATABASE': database,
                   'DB_HOST': '127.0.0.1', 'DB_PORT': '55432', 'DB_USERNAME': 'synloquent', 'DB_PASSWORD': ''}
    if arguments.lifecycle_profiles:
        arguments.lifecycle_profiles.mkdir(parents=True, exist_ok=True)
        environment['SYNLOQUENT_PROFILE_DIRECTORY'] = str(arguments.lifecycle_profiles)
    configuration_path = arguments.configuration
    processes_path = repository / '.local/processes.json'
    port = arguments.port
    server = None
    identities = []
    database_created = False
    registry_registered = False
    configuration = None
    ready = False
    failure_reason = None
    exit_status = 1
    try:
        with socket.socket() as reservation:
            reservation.bind(('127.0.0.1', port))
        subprocess.run([postgres + 'createdb', *connection], check=True)
        database_created = True
        subprocess.run(['php', 'artisan', 'migrate', '--force'], cwd=host, env=environment, check=True, stdout=subprocess.DEVNULL)
        subprocess.run([postgres + 'psql', *connection, '-v', 'ON_ERROR_STOP=1'], input=catalog, text=True, check=True, stdout=subprocess.DEVNULL)
        subprocess.run(['php', '-r', invalidate], cwd=host, env=environment, check=True)
        counts = {name: int(subprocess.check_output([postgres + 'psql', *connection, '-At', '-c', 'SELECT count(*) FROM ' + table], text=True).strip())
                  for name, table in [('Category', 'categories'), ('Tag', 'tags'), ('Item', 'items'), ('Image', 'images')]}
        with (artifacts / 'laravel.log').open('w') as log:
            server = subprocess.Popen(['php', 'artisan', 'serve', '--host=127.0.0.1', '--port=' + str(port), '--tries=1'], cwd=host, env=environment, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
            configuration = {'address': 'http://127.0.0.1:' + str(port), 'database': database,
                             'recordCounts': counts, 'records': sum(counts.values()), 'pivotRows': 300,
                             'expectedRecordCounts': EXPECTED_RECORD_COUNTS,
                             'expectedRelationCounts': EXPECTED_RELATION_COUNTS,
                             'lifecycleProfiles': str(arguments.lifecycle_profiles) if arguments.lifecycle_profiles else None,
                             'fixtureSeed': 20261002, 'hostProcess': server.pid, 'ownerProcess': os.getpid()}
            capture_host_identities(server, configuration, identities)
            configuration['ownedHostProcessIdentities'] = identities
            processes = json.loads(processes_path.read_text()) if processes_path.exists() else {}
            processes[arguments.registry_key] = {**configuration, 'active': True, 'log': str(artifacts / 'laravel.log')}
            processes_path.parent.mkdir(parents=True, exist_ok=True)
            processes_path.write_text(json.dumps(processes, indent=2) + '\n')
            registry_registered = True
            configuration_path.parent.mkdir(parents=True, exist_ok=True)
            configuration_path.write_text(json.dumps(configuration, indent=2) + '\n')
            ready = True
            print(json.dumps(configuration), flush=True)
            return_code = server.wait()
            if return_code != 0:
                raise RuntimeError('Fixture PHP host exited unsuccessfully: ' + str(return_code))
            exit_status = 0
    except KeyboardInterrupt:
        if ready:
            exit_status = 0
        else:
            failure_reason = 'Fixture interrupted before verified readiness'
    except (OSError, ValueError, RuntimeError, KeyError, TypeError, IndexError,
            AttributeError, subprocess.SubprocessError) as failure:
        failure_reason = str(failure)
        print(failure_reason, file=sys.stderr)
    finally:
        cleanup_evidence, cleanup_failures = cleanup_fixture(
            server, identities, database_created=database_created,
            connection=connection, configuration=configuration,
            registry_registered=registry_registered, processes_path=processes_path,
            registry_key=arguments.registry_key,
        )
        if cleanup_failures:
            exit_status = 1
            print('\n'.join(cleanup_failures), file=sys.stderr)
        report = {'exitStatus': exit_status, 'failureReason': failure_reason,
                  'cleanupFailures': cleanup_failures, 'cleanupEvidence': cleanup_evidence,
                  'ready': ready, 'configuration': configuration,
                  'ownedHostProcessIdentities': identities}
        (artifacts / 'fixture-lifecycle.json').write_text(json.dumps(report, indent=2) + '\n')
    return exit_status


if __name__ == '__main__':
    raise SystemExit(main())

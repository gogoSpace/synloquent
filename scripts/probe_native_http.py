#!/usr/bin/env python3
"""Measure the real large Laravel HTTP response separately from native decoding."""

import argparse
import json
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

from test_support import fingerprint
from native_http_oracle import validate_catalog
from http_process_metrics import RequestMemorySampler, lifecycle_profile, worker_identity

repository = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('--label', default='development-baseline')
parser.add_argument('--configuration', type=Path, default=repository / '.local/native-http-fixture.json')
parser.add_argument('--artifacts', type=Path, default=repository / '.local/test-results/native-http')
arguments = parser.parse_args()
configuration = json.loads(arguments.configuration.read_text())
arguments.artifacts.mkdir(parents=True, exist_ok=True)
session = {'accountId': '1', 'tenantId': '1', 'deviceId': 'native-http-device', 'deviceEpoch': 'native-http-epoch', 'generation': 0}
candidate = fingerprint()
worker_process = worker_identity(configuration)


def request(kind, payload, schema_fingerprint):
    envelope = {'protocolVersion': 1, 'requestId': str(uuid.uuid4()), 'kind': kind,
                'schemaFingerprint': schema_fingerprint, 'session': session, 'payload': payload}
    body = json.dumps(envelope).encode()
    profile_identity = str(uuid.uuid4())
    headers = {'Content-Type': 'application/json', 'Accept': 'application/json',
               'Authorization': 'Bearer synthetic-actor-1', 'X-Synloquent-Device': session['deviceId'],
               'X-Synloquent-Device-Epoch': session['deviceEpoch'],
               'X-Synloquent-Profile-Id': profile_identity}
    memory_sampler = RequestMemorySampler(worker_process).start()
    started = time.perf_counter()
    try:
        with urllib.request.urlopen(urllib.request.Request(configuration['address'] + '/synloquent/v1/protocol', data=body, headers=headers), timeout=180) as response:
            first_byte = time.perf_counter()
            contents = response.read()
            read_finished = time.perf_counter()
            response_headers = dict(response.headers)
    except urllib.error.HTTPError as failure:
        report = arguments.artifacts / (arguments.label + '.json')
        report.write_text(json.dumps({'fingerprint': candidate, 'status': 'fail', 'kind': kind,
                                     'httpStatus': failure.code, 'elapsedMilliseconds': (time.perf_counter() - started) * 1000,
                                     'responseBytes': len(failure.read()), 'expectedRecords': configuration['records'],
                                     'serverLog': '.local/test-results/native-http/laravel.log'}, indent=2) + '\n')
        raise
    else:
        decode_started = time.perf_counter()
        decoded = json.loads(contents)
        decoded_at = time.perf_counter()
        lifecycle = lifecycle_profile(configuration, profile_identity) if 'X-Synloquent-Profile' in response_headers else None
    finally:
        memory = memory_sampler.finish()
    if decoded.get('requestId') != envelope['requestId'] or decoded.get('session') != session or decoded.get('kind') != kind:
        raise RuntimeError('HTTP envelope identity changed')
    return decoded['payload'], {'elapsedMilliseconds': (decoded_at - started) * 1000,
                                'responseHeadersMilliseconds': (first_byte - started) * 1000,
                                'bodyReadMilliseconds': (read_finished - first_byte) * 1000,
                                'pythonDecodeMilliseconds': (decoded_at - decode_started) * 1000,
                                'responseBytes': len(contents), 'responseHeaders': response_headers,
                                'wholeLifecycle': lifecycle, 'workerMemory': memory}


manifest, _ = request('manifest', {}, 'boot')
snapshot, measurement = request('snapshot', {'dataset': 'catalog'}, manifest['fingerprint'])
oracle = validate_catalog(snapshot)
download_url = urllib.parse.urljoin(configuration['address'], snapshot['downloadUrl'])
download_headers = {'Accept': 'application/json', 'Authorization': 'Bearer synthetic-actor-1',
                    'X-Synloquent-Device': session['deviceId'], 'X-Synloquent-Device-Epoch': session['deviceEpoch']}
download_profile_identity = str(uuid.uuid4())
download_headers['X-Synloquent-Profile-Id'] = download_profile_identity
download_sampler = RequestMemorySampler(worker_process).start()
download_started = time.perf_counter()
try:
    with urllib.request.urlopen(urllib.request.Request(download_url, headers=download_headers), timeout=180) as response:
        download_headers_at = time.perf_counter()
        download_contents = response.read()
        download_read_at = time.perf_counter()
        download_response_headers = dict(response.headers)
    download_decode_started = time.perf_counter()
    downloaded = json.loads(download_contents)
    download_decoded_at = time.perf_counter()
    download_milliseconds = (time.perf_counter() - download_started) * 1000
    download_lifecycle = lifecycle_profile(configuration, download_profile_identity)
finally:
    download_memory = download_sampler.finish()
if downloaded != snapshot:
    raise RuntimeError('Immutable authenticated download differs from its exact snapshot')
counts = {model: sum(record['model'] == model for record in snapshot['records']) for model in manifest['models']}
for model, expected in configuration['recordCounts'].items():
    if counts[model] != expected:
        raise RuntimeError('Unexpected committed HTTP record count ' + model)
result = {'fingerprint': candidate, 'finishedFingerprint': fingerprint(), 'measurement': measurement,
          'recordCounts': counts, 'records': len(snapshot['records']), 'relationSets': len(snapshot['relationSets']),
          'snapshotHash': snapshot['hash'], 'canonicalBytes': snapshot['byteSize'], 'scope': snapshot['scope'],
          'independentOracle': oracle,
          'authenticatedDownload': {'elapsedMilliseconds': download_milliseconds, 'matchesSnapshot': True, 'responseHeaders': download_response_headers,
                                    'responseHeadersMilliseconds': (download_headers_at - download_started) * 1000,
                                    'bodyReadMilliseconds': (download_read_at - download_headers_at) * 1000,
                                    'pythonDecodeMilliseconds': (download_decoded_at - download_decode_started) * 1000,
                                    'wholeLifecycle': download_lifecycle, 'workerMemory': download_memory},
          'limitations': 'Loopback Python probe. responseHeaders ends when urllib exposes complete headers, not the first body byte. elapsed includes body read and Python decode, excludes independent oracle and payload comparison. Python decode does not establish Hermes or native performance.'}
report = arguments.artifacts / (arguments.label + '.json')
report.write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps({key: result[key] for key in ['measurement', 'records', 'relationSets', 'canonicalBytes']}, indent=2))

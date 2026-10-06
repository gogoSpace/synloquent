"""Keep every actual driver and domain qualification check independently visible."""
import hashlib
import math
import re

NATIVE_QUALIFICATION_CHECKS = frozenset({
    'native SQLite and persistence configuration',
    'generated JSON columns preserve exact overlays and foreign keys',
    'local data and outbox rollback together',
    'foreign key failures roll back their transaction',
    'nested savepoint and scoped handle',
    'parallel callers serialize transaction ownership',
    'unfinished nested work cannot escape rollback',
    'WAL-aware immutable snapshot retains pending work',
    'async native bulk import and timer responsiveness',
    'native secure identities and UTF8 snapshot hashing',
    'system native SHA256 streaming lifecycle',
    'client close and account switch cancel stuck native digest',
    'mounted React query retains remote and partial execution',
    'close drains accepted work and reopen preserves durability',
    'synloquent offline parent-child and identity aliases',
    'synloquent HTTP sync and reactive updates',
    'synloquent HTTP conflict recovery and registered command',
    'synloquent exact integer and query comparison semantics',
    'synloquent unmount account-switch schema-update listeners',
    'native-public-composition',
    'synloquent nested transaction and scoped handle',
    'synloquent close drains domain work and preserves durability',
})


def validate_current_memory_evidence(value: object, platform: str | None = None) -> None:
    if not isinstance(value, dict) or value.get('platform') not in ('ios', 'android') or (platform is not None and value['platform'] != platform):
        raise ValueError('Native current-memory evidence has an invalid platform')
    required_true = ('actualNativeSample', 'generatedEventSubscription', 'lifecycleResampled', 'closeIdempotent')
    required_false = ('syntheticPressure', 'pressureDeliveryGuaranteed', 'systemAvailabilityIsApplicationHeadroom')
    if any(value.get(field) is not True for field in required_true) or any(value.get(field) is not False for field in required_false):
        raise ValueError('Native current-memory evidence lacks actual lifecycle wiring')
    if type(value.get('sampleCount')) is not int or value['sampleCount'] != 2 or type(value.get('rateLimitedRequests')) is not int or value['rateLimitedRequests'] != 8:
        raise ValueError('Native current-memory sampling is incomplete')
    def finite_number(number: object) -> bool:
        return type(number) in (int, float) and 0 <= number <= 9007199254740991 and math.isfinite(number)
    if any(not finite_number(value.get(field)) for field in ('elapsedMilliseconds', 'cpuMilliseconds')):
        raise ValueError('Native current-memory timing is invalid')
    for field in ('firstObservation', 'lastObservation'):
        observation = value.get(field)
        if not isinstance(observation, dict) or observation.get('validity') != 'valid' or not finite_number(observation.get('observedAtMilliseconds')):
            if not isinstance(observation, dict) or observation.get('validity') != 'unavailable' or not finite_number(observation.get('observedAtMilliseconds')):
                raise ValueError('Native current-memory observation is unavailable')
            if value['platform'] != 'ios' or observation.get('pressure') != 'normal' or 'processHeadroomBytes' in observation or 'systemAvailableBytes' in observation:
                raise ValueError('Native current-memory unavailable fallback is malformed')
            budget = value.get('firstWorkBudget' if field == 'firstObservation' else 'lastWorkBudget')
            if not isinstance(budget, dict) or budget.get('level') not in ('conservative', 'reduced') or not (budget.get('reason') == 'unknown' or (budget.get('reason') == 'pressure' and budget['level'] == 'reduced')):
                raise ValueError('Native current-memory unavailable fallback lacks a live conservative budget')
            reduced = budget['level'] == 'reduced'
            expected_limits = {
                'maximumBatchRows': 4 if reduced else 16,
                'maximumBindingBytes': 8192 if reduced else 16384,
                'maximumHashBufferUnits': 16384,
                'maximumCacheBytes': 0 if reduced else 524288,
                'maximumCacheEntries': 0 if reduced else 64,
                'maximumPrefetchConcurrency': 0,
                'maximumSnapshotConcurrency': 0 if reduced else 1,
                'maximumSnapshotResponseBytes': 65536,
            }
            if any(type(budget.get(name)) is not int or budget[name] != limit for name, limit in expected_limits.items()):
                raise ValueError('Native current-memory unavailable fallback has unsafe work limits')
            continue
        if observation.get('pressure') not in ('normal', 'warning', 'critical', 'unknown'):
            raise ValueError('Native current-memory pressure is malformed')
        if value['platform'] == 'ios':
            headroom = observation.get('processHeadroomBytes')
            if not finite_number(headroom) or headroom <= 0 or 'systemAvailableBytes' in observation:
                raise ValueError('iOS current-memory evidence lacks application headroom')
        elif not finite_number(observation.get('systemAvailableBytes')) or 'processHeadroomBytes' in observation:
            raise ValueError('Android system memory is not application headroom')


def qualification_fields(value: object, required: tuple[str, ...], location: str) -> dict:
    if type(value) is not dict or set(value) != set(required):
        raise ValueError(location + ' has missing or unknown fields')
    return value


def qualification_scalar(value: object, location: str) -> float | int:
    if type(value) not in (int, float) or not 0 <= value <= 9007199254740991 or not math.isfinite(value):
        raise ValueError(location + ' must be a finite nonnegative scalar')
    return value


def validate_calling_thread_cpu_control(value: object) -> dict:
    control = qualification_fields(value, ('busyWallMilliseconds', 'busyCpuMilliseconds',
        'idleCpuMilliseconds', 'busyIterations', 'busyChecksum'), 'Native calling-thread clock control')
    for field in ('busyWallMilliseconds', 'busyCpuMilliseconds', 'idleCpuMilliseconds'):
        qualification_scalar(control[field], 'Native clock ' + field)
    if type(control['busyIterations']) is not int or control['busyIterations'] != 1048576 or type(control['busyChecksum']) is not int or control['busyChecksum'] != 724344261:
        raise ValueError('Native clock original iteration count or checksum differs')
    if not (control['busyCpuMilliseconds'] >= 1 and
            control['busyCpuMilliseconds'] <= control['busyWallMilliseconds'] * 1.5 and
            control['idleCpuMilliseconds'] < control['busyCpuMilliseconds'] * 0.5):
        raise ValueError('Native clock original busy and awaited-idle predicates fail')
    return dict(control)


def validate_secure_unicode_detail(value: object) -> dict:
    detail = qualification_fields(value, ('knownHash', 'splitSurrogate', 'uniqueIdentities', 'actualDigest', 'actualSplitSurrogateDigest', 'identities'), 'Native Unicode and secure identity detail')
    expected_hash = hashlib.sha256('Žluťoučký 🧭'.encode('utf-8')).hexdigest()
    if detail['knownHash'] != expected_hash or detail['actualDigest'] != expected_hash or detail['actualSplitSurrogateDigest'] != expected_hash or detail['splitSurrogate'] is not True or type(detail['uniqueIdentities']) is not int or detail['uniqueIdentities'] != 100:
        raise ValueError('Native actual Unicode hashes, split surrogate or original100 UUIDv4 witness differs')
    identities = detail['identities']
    if type(identities) is not list or len(identities) != 100 or any(type(identity) is not str or re.fullmatch(r'[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}', identity) is None for identity in identities) or len(set(identities)) != 100:
        raise ValueError('Native original identities are not100 exact unique UUIDv4 values')
    return {**detail, 'identities': list(identities)}


def validate_sqlite_qualification_detail(value: object) -> dict:
    detail = qualification_fields(value, ('version', 'journal', 'foreignKeys', 'jsonSupported', 'driverCapabilities'), 'Native SQLite qualification detail')
    version = detail['version']
    if type(version) is not str or not 1 <= len(version) <= 64 or len(version.split('.')) != 3 or any(not item.isascii() or not item.isdigit() or len(item) > 10 for item in version.split('.')):
        raise ValueError('Native sqlite_version is malformed')
    journal = qualification_fields(detail['journal'], ('journal_mode',), 'Native SQLite journal row')
    foreign_keys = qualification_fields(detail['foreignKeys'], ('foreign_keys',), 'Native SQLite foreign key row')
    if journal['journal_mode'] != 'wal' or type(foreign_keys['foreign_keys']) is not int or foreign_keys['foreign_keys'] != 1 or type(detail['jsonSupported']) is not int or detail['jsonSupported'] != 1:
        raise ValueError('Native original WAL, FK or JSON support differs')
    capabilities = qualification_fields(detail['driverCapabilities'], ('asynchronous', 'transactions', 'savepoints', 'json', 'maximumParameters'), 'Native public driver capabilities')
    if any(capabilities[field] is not True for field in ('asynchronous', 'transactions', 'savepoints', 'json')) or type(capabilities['maximumParameters']) is not int or capabilities['maximumParameters'] != 999:
        raise ValueError('Native public driver capabilities are unsupported')
    return {**detail, 'journal': dict(journal), 'foreignKeys': dict(foreign_keys), 'driverCapabilities': dict(capabilities)}


def replay_qualification_details(checks: object, platform: str | None = None) -> dict:
    observed = validate_qualification_checks(checks, platform)
    by_name = {check['name']: check for check in checks}
    crypto = by_name['system native SHA256 streaming lifecycle']['detail']
    return {'checks': sorted(observed), 'callingThreadCpuControl': validate_calling_thread_cpu_control(crypto.get('callingThreadCpuControl')),
        'unicodeAndSecureIdentities': validate_secure_unicode_detail(by_name['native secure identities and UTF8 snapshot hashing'].get('detail')),
        'sqlite': validate_sqlite_qualification_detail(by_name['native SQLite and persistence configuration'].get('detail'))}


def validate_qualification_checks(checks: object, platform: str | None = None) -> frozenset[str]:
    if not isinstance(checks, list) or any(
        not isinstance(check, dict) or not isinstance(check.get('name'), str)
        or not check['name'].strip() for check in checks
    ):
        raise ValueError('Native qualification checks are malformed')
    names = [check['name'] for check in checks]
    observed = frozenset(names)
    if len(names) != len(observed):
        raise ValueError('Native qualification checks contain duplicate names')
    missing = NATIVE_QUALIFICATION_CHECKS - observed
    if missing:
        raise ValueError('Native qualification checks are missing: ' + ', '.join(sorted(missing)))
    memory_check = next(check for check in checks if check['name'] == 'system native SHA256 streaming lifecycle')
    detail = memory_check.get('detail')
    validate_current_memory_evidence(detail.get('currentMemory') if isinstance(detail, dict) else None, platform)
    if type(detail.get('vectors')) is not int or detail['vectors'] != 5 or detail.get('splitSurrogate') is not True:
        raise ValueError('Native original Unicode vector count or split surrogate differs')
    validate_calling_thread_cpu_control(detail.get('callingThreadCpuControl'))
    secure_check = next(check for check in checks if check['name'] == 'native secure identities and UTF8 snapshot hashing')
    validate_secure_unicode_detail(secure_check.get('detail'))
    sqlite_check = next(check for check in checks if check['name'] == 'native SQLite and persistence configuration')
    validate_sqlite_qualification_detail(sqlite_check.get('detail'))
    return observed

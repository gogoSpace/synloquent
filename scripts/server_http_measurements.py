"""Validate full lifecycle evidence before qualifying large HTTP measurements."""

import math


def positive(value):
    return type(value) in (int, float) and math.isfinite(value) and value > 0


def validate_sample(sample, phase, candidate):
    if phase not in ('cold', 'warm'):
        raise ValueError('Unknown HTTP cache phase')
    if sample.get('fingerprint') != candidate or sample.get('finishedFingerprint') != candidate:
        raise ValueError('HTTP measurement source changed')
    oracle = sample.get('independentOracle', {})
    if oracle.get('independentContentMatches') is not True or (oracle.get('records'), oracle.get('relationSets'), oracle.get('relationTargets')) != (117115, 51128, 600):
        raise ValueError('Independent full catalog content witness is missing')
    outcomes = []
    for kind, measurement in [('snapshot', sample['measurement']), ('authenticated-download', sample['authenticatedDownload'])]:
        lifecycle = measurement.get('wholeLifecycle') or {}
        memory = measurement.get('workerMemory') or {}
        if lifecycle.get('status') != 200 or lifecycle.get('memoryLimit') != '128M' or not positive(lifecycle.get('elapsedLifecycleSeconds')):
            raise ValueError('Whole HTTP lifecycle or default memory limit witness is missing')
        if any(not positive(lifecycle.get(key)) or lifecycle[key] >= 128 * 1024 * 1024 for key in ('logicalPeakBytes', 'allocatedPeakBytes')):
            raise ValueError('HTTP PHP peak exceeds its default memory guard')
        if any(not positive(memory.get(key)) for key in ('baselineRssBytes', 'maximumObservedRssBytes')) or type(memory.get('sampleCount')) is not int or memory['sampleCount'] < 2 or type(memory.get('processId')) is not int or memory['processId'] <= 0 or memory['maximumObservedRssBytes'] < memory['baselineRssBytes']:
            raise ValueError('Whole request owned-worker RSS witness is missing')
        if not positive(measurement.get('elapsedMilliseconds')):
            raise ValueError('Actual HTTP timing is missing')
        profile = lifecycle.get('profile') or {}
        phases = profile.get('phases') or {}
        if not positive(profile.get('seconds')) or not phases or profile['seconds'] > lifecycle['elapsedLifecycleSeconds'] or lifecycle['elapsedLifecycleSeconds'] > measurement['elapsedMilliseconds'] / 1000 + 0.25:
            raise ValueError('Controller, whole lifecycle and HTTP clocks are inconsistent')
        for definition in phases.values():
            if not isinstance(definition, dict) or type(definition.get('seconds')) not in (int, float) or not math.isfinite(definition['seconds']) or definition['seconds'] < 0 or definition['seconds'] > lifecycle['elapsedLifecycleSeconds'] or type(definition.get('calls')) is not int or definition['calls'] <= 0:
                raise ValueError('HTTP phase profile is missing or nonfinite')
        if kind == 'snapshot':
            cache_hit = 'snapshot.contentCacheHit' in phases
            if cache_hit != (phase == 'warm'):
                raise ValueError('Cold creation and warm content reuse are conflated')
            if phase == 'cold' and not {'snapshot.catalogReadback', 'snapshot.contentPersistence'} <= set(phases):
                raise ValueError('Cold content materialization and persistence are not measured')
        elif measurement.get('matchesSnapshot') is not True:
            raise ValueError('Authenticated download differs from the committed snapshot')
        outcomes.append({'name': 'server-http-' + phase + '-' + kind, 'status': 'pass',
                         'elapsedMilliseconds': measurement['elapsedMilliseconds'],
                         'wholeLifecycle': lifecycle, 'workerMemory': memory})
    return outcomes

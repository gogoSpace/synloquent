"""Reject incomplete or synthetic replacements of required current-memory evidence."""
import copy
import math
import unittest
from qualification_contract import NATIVE_QUALIFICATION_CHECKS, validate_qualification_checks


def complete_checks(platform):
    observation = {'validity': 'valid', 'pressure': 'normal', 'observedAtMilliseconds': 1,
                   'processHeadroomBytes' if platform == 'ios' else 'systemAvailableBytes': 134217728}
    memory = {'platform': platform, 'actualNativeSample': True, 'generatedEventSubscription': True,
              'lifecycleResampled': True, 'closeIdempotent': True, 'syntheticPressure': False,
              'pressureDeliveryGuaranteed': False, 'systemAvailabilityIsApplicationHeadroom': False,
              'sampleCount': 2, 'rateLimitedRequests': 8, 'elapsedMilliseconds': 2, 'cpuMilliseconds': 1,
              'firstObservation': observation, 'lastObservation': copy.deepcopy(observation)}
    checks = [{'name': name} for name in sorted(NATIVE_QUALIFICATION_CHECKS)]
    crypto_detail = {'currentMemory': memory, 'vectors': 5, 'splitSurrogate': True,
        'callingThreadCpuControl': {'busyWallMilliseconds': 110.4399169999997,
            'busyCpuMilliseconds': 44.081503999999995, 'idleCpuMilliseconds': 10.704161999999997,
            'busyIterations': 1048576, 'busyChecksum': 724344261}}
    next(check for check in checks if check['name'] == 'system native SHA256 streaming lifecycle')['detail'] = crypto_detail
    next(check for check in checks if check['name'] == 'native secure identities and UTF8 snapshot hashing')['detail'] = {
        'knownHash': 'a17a209398270f3520aa7254cdc26406e26d8464d47e3a741caf4a34d2d221d5',
        'splitSurrogate': True, 'uniqueIdentities': 100,
        'actualDigest': 'a17a209398270f3520aa7254cdc26406e26d8464d47e3a741caf4a34d2d221d5',
        'actualSplitSurrogateDigest': 'a17a209398270f3520aa7254cdc26406e26d8464d47e3a741caf4a34d2d221d5',
        'identities': ['00000000-0000-4000-8000-' + format(ordinal, '012x') for ordinal in range(100)]}
    next(check for check in checks if check['name'] == 'native SQLite and persistence configuration')['detail'] = {
        'version': '3.53.4', 'journal': {'journal_mode': 'wal'}, 'foreignKeys': {'foreign_keys': 1},
        'jsonSupported': 1, 'driverCapabilities': {'asynchronous': True, 'transactions': True,
            'savepoints': True, 'json': True, 'maximumParameters': 999}}
    return checks, memory


class QualificationContractTests(unittest.TestCase):
    def test_both_actual_platform_shapes_preserve_all_original_checks(self):
        self.assertEqual(len(NATIVE_QUALIFICATION_CHECKS), 22)
        for platform in ('ios', 'android'):
            checks, _ = complete_checks(platform)
            self.assertEqual(validate_qualification_checks(checks, platform), NATIVE_QUALIFICATION_CHECKS)

    def test_native_memory_names_without_actual_evidence_are_rejected(self):
        with self.assertRaisesRegex(ValueError, 'current-memory'):
            validate_qualification_checks([{'name': name} for name in NATIVE_QUALIFICATION_CHECKS], 'ios')

    def test_platform_lifecycle_sampling_and_timing_cannot_be_forged(self):
        mutations = [('platform', 'android'), ('actualNativeSample', False), ('generatedEventSubscription', False),
                     ('syntheticPressure', True), ('pressureDeliveryGuaranteed', True),
                     ('systemAvailabilityIsApplicationHeadroom', True), ('sampleCount', 1),
                     ('sampleCount', True), ('rateLimitedRequests', 0), ('lifecycleResampled', False),
                     ('closeIdempotent', False), ('elapsedMilliseconds', math.inf), ('cpuMilliseconds', -1),
                     ('cpuMilliseconds', True), ('firstObservation', None), ('lastObservation', {})]
        for field, value in mutations:
            checks, memory = complete_checks('ios')
            memory[field] = value
            with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                validate_qualification_checks(checks, 'ios')

    def test_unavailable_or_cross_platform_headroom_is_rejected(self):
        for platform in ('ios', 'android'):
            for field, value in [('validity', 'unavailable'), ('pressure', 'invalid'), ('observedAtMilliseconds', -1),
                                 ('processHeadroomBytes' if platform == 'ios' else 'systemAvailableBytes', -1),
                                 ('systemAvailableBytes' if platform == 'ios' else 'processHeadroomBytes', 134217728)]:
                checks, memory = complete_checks(platform)
                memory['firstObservation'][field] = value
                with self.subTest(platform=platform, field=field), self.assertRaises(ValueError):
                    validate_qualification_checks(checks, platform)

    def test_original_missing_and_duplicate_checks_remain_rejected(self):
        checks, _ = complete_checks('ios')
        for name in NATIVE_QUALIFICATION_CHECKS:
            with self.subTest(name=name), self.assertRaises(ValueError):
                validate_qualification_checks([check for check in checks if check['name'] != name], 'ios')
        with self.assertRaises(ValueError):
            validate_qualification_checks([*checks, checks[0]], 'ios')


class UnavailableQualificationContractTests(unittest.TestCase):
    def fallback_checks(self, reduced=False):
        checks, memory = complete_checks('ios')
        budget = {
            'level': 'reduced' if reduced else 'conservative', 'reason': 'pressure' if reduced else 'unknown',
            'maximumBatchRows': 4 if reduced else 16, 'maximumBindingBytes': 8192 if reduced else 16384,
            'maximumHashBufferUnits': 16384, 'maximumCacheBytes': 0 if reduced else 524288,
            'maximumCacheEntries': 0 if reduced else 64, 'maximumPrefetchConcurrency': 0,
            'maximumSnapshotConcurrency': 0 if reduced else 1, 'maximumSnapshotResponseBytes': 65536,
        }
        for field, budget_field in (('firstObservation', 'firstWorkBudget'), ('lastObservation', 'lastWorkBudget')):
            memory[field] = {'validity': 'unavailable', 'pressure': 'normal', 'observedAtMilliseconds': 1}
            memory[budget_field] = copy.deepcopy(budget)
        return checks, memory

    def test_both_unavailable_samples_require_live_safe_budgets(self):
        for reduced in (False, True):
            checks, _ = self.fallback_checks(reduced)
            self.assertEqual(validate_qualification_checks(checks, 'ios'), NATIVE_QUALIFICATION_CHECKS)

    def test_each_unavailable_observation_independently_requires_coherent_evidence(self):
        for field, budget_field in (('firstObservation', 'firstWorkBudget'), ('lastObservation', 'lastWorkBudget')):
            for mutation in ('missing_budget', 'closed_budget', 'normal_budget', 'recovery_budget', 'unsafe_caps', 'boolean_caps', 'numeric_headroom', 'numeric_system', 'unknown_pressure', 'invalid_time'):
                checks, memory = self.fallback_checks()
                if mutation == 'missing_budget':
                    del memory[budget_field]
                elif mutation == 'closed_budget':
                    memory[budget_field]['level'] = 'reduced'
                    memory[budget_field]['reason'] = 'closed'
                elif mutation == 'normal_budget':
                    memory[budget_field]['level'] = 'normal'
                elif mutation == 'recovery_budget':
                    memory[budget_field]['reason'] = 'recovery'
                elif mutation == 'unsafe_caps':
                    memory[budget_field]['maximumSnapshotResponseBytes'] = 67108864
                elif mutation == 'boolean_caps':
                    memory[budget_field]['maximumSnapshotConcurrency'] = True
                elif mutation == 'numeric_headroom':
                    memory[field]['processHeadroomBytes'] = 134217728
                elif mutation == 'numeric_system':
                    memory[field]['systemAvailableBytes'] = 134217728
                elif mutation == 'unknown_pressure':
                    memory[field]['pressure'] = 'unknown'
                else:
                    memory[field]['observedAtMilliseconds'] = -1
                with self.subTest(field=field, mutation=mutation), self.assertRaises(ValueError):
                    validate_qualification_checks(checks, 'ios')

    def test_android_still_requires_actual_system_availability(self):
        checks, memory = self.fallback_checks()
        memory['platform'] = 'android'
        with self.assertRaises(ValueError):
            validate_qualification_checks(checks, 'android')

    def test_valid_and_unavailable_samples_can_differ_without_fabricating_capacity(self):
        for unavailable_field, budget_field in (('firstObservation', 'firstWorkBudget'), ('lastObservation', 'lastWorkBudget')):
            checks, memory = complete_checks('ios')
            _, fallback = self.fallback_checks()
            memory[unavailable_field] = fallback[unavailable_field]
            memory[budget_field] = fallback[budget_field]
            self.assertEqual(validate_qualification_checks(checks, 'ios'), NATIVE_QUALIFICATION_CHECKS)


if __name__ == '__main__':
    unittest.main()

"""Reject incomplete actual performance evidence before qualifying polling."""
import copy
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server_performance import validate_measurements


class ServerPerformanceEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.budgets = {'unchangedSeconds': 0.25, 'singleEditSeconds': 0.5, 'hundredEditSeconds': 1.0, 'writerWaitSeconds': 0.1, 'peakGrowthBytes': 128 * 1024 * 1024}
        self.measurements = {'samples': []}
        for items, children in [(1000, 6000), (17000, 100000)]:
            self.measurements['samples'].append({
                'items': items, 'children': children,
                'snapshot': {'recordCount': items + children},
                'unchangedPull': {'seconds': 0.002, 'peakGrowthBytes': 0, 'sqlQueries': 5},
                'singleEditPull': {'seconds': 0.051, 'peakGrowthBytes': 0, 'sqlQueries': 20, 'changeCount': 1, 'responseBytes': 1844},
                'hundredEditPull': {'seconds': 0.097, 'peakGrowthBytes': 0, 'sqlQueries': 20, 'changeCount': 100, 'responseBytes': 100000},
                'concurrentWriterPull': {'writerLockWaitSeconds': 0.055, 'tailPreserved': True},
            })

        for sample in self.measurements['samples']:
            for key in ['unchangedPull', 'singleEditPull', 'hundredEditPull']:
                sample[key].update({'rssBytes': 1000000, 'baselineRssBytes': 1000000, 'maximumRssBytes': 1000000, 'streamLockHeldSeconds': sample[key]['seconds'] * 0.9, 'sqlProfile': [{'sql': 'select authorized records', 'milliseconds': 0.1}], 'plans': {'synloquent_projection_memberships': [{}], 'items': [{}]}})

    def test_required_server_catalog_scales_and_actual_rows_are_enforced(self):
        self.assertTrue(all(scenario['status'] == 'pass' for scenario in validate_measurements(self.measurements, self.budgets)))
        for mutation in ['omit-scale', 'false-count']:
            changed = copy.deepcopy(self.measurements)
            if mutation == 'omit-scale':
                changed['samples'].pop()
            else:
                changed['samples'][1]['snapshot']['recordCount'] = 7000
            with self.assertRaises(ValueError):
                validate_measurements(changed, self.budgets)

    def test_incomplete_or_nonfinite_server_polling_metrics_fail(self):
        for key, value in [('seconds', float('nan')), ('seconds', -1), ('seconds', True), ('peakGrowthBytes', None), ('sqlQueries', 0), ('changeCount', 0), ('responseBytes', 0), ('rssBytes', None), ('streamLockHeldSeconds', None), ('sqlProfile', []), ('plans', {})]:
            changed = copy.deepcopy(self.measurements)
            changed['samples'][1]['singleEditPull'][key] = value
            outcome = next(scenario for scenario in validate_measurements(changed, self.budgets) if scenario['name'] == 'server-small-delta-pull')
            self.assertEqual(outcome['status'], 'fail', key)
        changed = copy.deepcopy(self.measurements)
        del changed['samples'][1]['hundredEditPull']
        outcome = next(scenario for scenario in validate_measurements(changed, self.budgets) if scenario['name'] == 'server-batch-delta-pull')
        self.assertEqual(outcome['status'], 'fail')

    def test_concurrent_writer_requires_measured_wait_and_committed_tail(self):
        for key, value in [('writerLockWaitSeconds', None), ('writerLockWaitSeconds', 0.101), ('tailPreserved', False)]:
            changed = copy.deepcopy(self.measurements)
            changed['samples'][1]['concurrentWriterPull'][key] = value
            self.assertEqual(validate_measurements(changed, self.budgets)[-1]['status'], 'fail')


if __name__ == '__main__':
    unittest.main()

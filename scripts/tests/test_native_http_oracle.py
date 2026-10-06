"""Reject intact-looking large HTTP catalogs with missing or altered content."""

import hashlib
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from native_http_oracle import (
    EXPECTED_RECORD_COUNTS, EXPECTED_RELATION_COUNTS,
    expected_attributes, expected_targets, validate_catalog,
)


def with_integrity(snapshot):
    content = json.dumps({'records': snapshot['records'], 'relationSets': snapshot['relationSets']},
                         sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()
    return {**snapshot, 'hash': hashlib.sha256(content).hexdigest(), 'byteSize': len(content)}


class NativeHttpOracleTests(unittest.TestCase):
    @classmethod
    def setUpClass(test_class):
        records = [{'model': model, 'id': str(identity), 'revision': '0',
                    'attributes': expected_attributes(model, identity)}
                   for model, count in EXPECTED_RECORD_COUNTS.items()
                   for identity in range(1, count + 1)]
        relation_sets = []
        for group in EXPECTED_RELATION_COUNTS:
            model, relation = group.split('.')
            relation_sets.extend({'model': model, 'relation': relation,
                                  'parentId': str(identity), 'revision': '0',
                                  'completeness': 'complete',
                                  'targets': expected_targets(model, relation, identity)}
                                 for identity in range(1, EXPECTED_RECORD_COUNTS[model] + 1))
        test_class.snapshot = with_integrity({'records': records, 'relationSets': relation_sets})

    def test_complete_large_http_content_matches_independent_seed(self):
        result = validate_catalog(self.snapshot)
        self.assertEqual((result['records'], result['relationSets'], result['relationTargets']),
                         (117115, 51128, 600))
        self.assertEqual(expected_targets('Item', 'tags', 63), [
            {'id': '1', 'attributes': {'position': 1}},
            {'id': '2', 'attributes': {'position': 2}},
            {'id': '64', 'attributes': {'position': 0}},
        ])
        self.assertEqual(expected_attributes('Item', 10000)['price'], '0.00')
        self.assertEqual(expected_attributes('Image', 17000)['item_id'], 1)

    def test_large_http_missing_empty_relation_fails_with_valid_integrity(self):
        changed = with_integrity({**self.snapshot, 'relationSets': self.snapshot['relationSets'][:-1]})
        with self.assertRaisesRegex(ValueError, 'families are incomplete'):
            validate_catalog(changed)

    def test_large_http_changed_pivot_fails_with_exact_counts_and_valid_integrity(self):
        relation_sets = list(self.snapshot['relationSets'])
        index = next(index for index, relation in enumerate(relation_sets) if relation['targets'])
        original = relation_sets[index]
        targets = list(original['targets'])
        targets[0] = {**targets[0], 'attributes': {'position': 99}}
        relation_sets[index] = {**original, 'targets': targets}
        changed = with_integrity({**self.snapshot, 'relationSets': relation_sets})
        with self.assertRaisesRegex(ValueError, 'Fixture targets differ'):
            validate_catalog(changed)

    def test_large_http_changed_record_fails_with_exact_counts_and_valid_integrity(self):
        records = list(self.snapshot['records'])
        original = records[0]
        records[0] = {**original, 'attributes': {**original['attributes'], 'title': 'Wrong category'}}
        changed = with_integrity({**self.snapshot, 'records': records})
        with self.assertRaisesRegex(ValueError, 'Fixture attributes differ'):
            validate_catalog(changed)

    def test_large_http_integrity_is_checked_after_content(self):
        with self.assertRaisesRegex(ValueError, 'Canonical snapshot integrity differs'):
            validate_catalog({**self.snapshot, 'hash': '0' * 64})


if __name__ == '__main__':
    unittest.main()

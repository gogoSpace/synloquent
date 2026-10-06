"""Actual SQLite and installed public SDK witness for retained deleted pivots."""
import json
import pathlib
import subprocess
import unittest

REPOSITORY = pathlib.Path(__file__).resolve().parents[2]


class PendingDeletePublicTests(unittest.TestCase):
    def test_pending_delete_public_relations_cancel_and_rollback_preserve_catalog(self):
        execution = subprocess.run(
            ['node', 'examples/react-native/tests/nativeReference.test.mjs'],
            cwd=REPOSITORY, text=True, capture_output=True, timeout=30,
        )
        self.assertEqual(execution.returncode, 0, execution.stderr)
        proof = json.loads(execution.stdout)
        self.assertEqual(proof['actualCatalog']['relationSets'], 100)
        self.assertEqual(proof['actualCatalog']['pivotRows'], 300)
        self.assertEqual(proof['publicWitness']['hiddenPublicState']['tagIds'], [])
        self.assertEqual(proof['publicWitness']['hiddenPublicState']['inverseWithCount'], 0)
        self.assertEqual(proof['publicWitness']['restoredPublicState']['imageCount'], 6)
        self.assertEqual(proof['publicWitness']['restoredPublicState']['tagIds'], ['4', '5', '6'])
        self.assertEqual(proof['publicWitness']['restoredPublicState']['inverseCount'], 1)
        self.assertGreaterEqual(len(proof['observations']), 9)
        self.assertFalse(proof['nativePerformanceClaim'])


if __name__ == '__main__':
    unittest.main()

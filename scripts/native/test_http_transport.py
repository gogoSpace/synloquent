"""Differential grammar and lifecycle controls for the actual example helpers."""
import json
import pathlib
import subprocess
import unittest

REPOSITORY = pathlib.Path(__file__).resolve().parents[2]


class HttpTransportTests(unittest.TestCase):
    def test_http_decode_and_shape_preserve_json_semantics_and_application_progress(self):
        execution = subprocess.run(
            ['node', 'examples/react-native/tests/httpTransport.test.mjs'],
            cwd=REPOSITORY, text=True, capture_output=True, timeout=90,
        )
        self.assertEqual(execution.returncode, 0, execution.stderr)
        proof = json.loads(execution.stdout)
        self.assertGreaterEqual(len(proof['observations']), 13)
        self.assertGreater(proof['deliveredCallbacks'], 100)
        self.assertLessEqual(proof['maximumNumberConversionCharacters'], 2048)
        self.assertLessEqual(proof['maximumNativeParseCharacters'], 2048)
        self.assertLessEqual(proof['maximumSliceCharacters'], 2048)
        self.assertIn('actual-transport-application-progress-and-whole-elapsed-preserved', proof['observations'])
        self.assertIn('transport-abort-malformed-http-error-finally-timer-cleanup', proof['observations'])
        self.assertGreaterEqual(len(proof['sourceHashes']), 6)
        self.assertTrue(any(path.endswith('/react-native/http/json.ts') for path in proof['sourceHashes']))
        self.assertFalse(proof['nativePerformanceClaim'])


if __name__ == '__main__':
    unittest.main()

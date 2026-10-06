"""Exercise identity rejection and reparenting using isolated task-owned processes."""
import json
import os
import signal
import subprocess
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from http_process_metrics import process_identity, running_python_executable, same_running_process, terminate_verified_processes


class HttpProcessCleanupTests(unittest.TestCase):
    def test_current_python_binary_has_stable_spawn_identity(self):
        executable = running_python_executable()
        parent = subprocess.Popen(
            [executable, '-u', '-c', 'import sys\nprint("ready", flush=True)\nsys.stdin.readline()'],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, start_new_session=True,
        )
        try:
            original = process_identity(parent.pid)
            self.assertEqual(parent.stdout.readline().strip(), 'ready')
            self.assertEqual(same_running_process(original), original)
            self.assertEqual(Path(original['arguments'][0]).resolve(), Path(executable))
            proof = terminate_verified_processes([original], timeout_seconds=1)
            self.assertEqual(proof['remainingProcessIds'], [])
        finally:
            parent.stdin.close()
            parent.wait(timeout=5)
            parent.stdout.close()
            parent.stderr.close()

    def create_fixture(self, worker_count=1):
        source = '\n'.join([
            'import json, subprocess, sys',
            'workers = []',
            'for index in range(' + str(worker_count) + '):',
            "    workers.append(subprocess.Popen([sys.executable, '-c', 'import time\\ntime.sleep(120)'], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))",
            'print(json.dumps([worker.pid for worker in workers]), flush=True)',
            'sys.stdin.readline()',
        ])
        parent = subprocess.Popen([sys.executable, '-u', '-c', source],
                                  stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                  stderr=subprocess.PIPE, text=True, start_new_session=True)
        workers = json.loads(parent.stdout.readline())
        identities = [process_identity(parent.pid), *(process_identity(worker) for worker in workers)]

        def cleanup():
            try:
                terminate_verified_processes(identities, timeout_seconds=1)
            finally:
                for identity in reversed(identities):
                    if same_running_process(identity) is not None:
                        try:
                            os.kill(identity['processId'], signal.SIGKILL)
                        except ProcessLookupError:
                            pass
                parent.wait(timeout=5)
                parent.stdin.close()
                parent.stdout.close()
                parent.stderr.close()
        self.addCleanup(cleanup)
        return parent, identities

    def test_changed_start_identity_rejects_before_any_signal(self):
        parent, identities = self.create_fixture()
        changed = [{**identities[0], 'startedAt': 'unverified start time'}, identities[1]]
        with patch('http_process_metrics.os.kill') as signalling:
            with self.assertRaises(ValueError):
                terminate_verified_processes(changed, timeout_seconds=0.1)
            signalling.assert_not_called()
        self.assertIsNone(parent.poll())
        self.assertIsNotNone(same_running_process(identities[1]))

    def test_new_group_member_rejects_before_any_signal(self):
        parent, identities = self.create_fixture(worker_count=2)
        with patch('http_process_metrics.os.kill') as signalling:
            with self.assertRaises(ValueError):
                terminate_verified_processes(identities[:2], timeout_seconds=0.1)
            signalling.assert_not_called()
        self.assertIsNone(parent.poll())
        self.assertIsNotNone(same_running_process(identities[2]))

    def test_known_reparented_worker_keeps_exact_identity_and_exits(self):
        parent, identities = self.create_fixture()
        parent.stdin.write('\n')
        parent.stdin.flush()
        parent.wait(timeout=5)
        self.assertNotEqual(process_identity(identities[1]['processId'])['parentProcessId'], parent.pid)
        proof = terminate_verified_processes(identities, timeout_seconds=1)
        self.assertEqual(proof['remainingProcessIds'], [])
        self.assertIn(identities[1]['processId'], proof['reparentedProcessIds'])
        self.assertIsNone(same_running_process(identities[1]))


if __name__ == '__main__':
    unittest.main()

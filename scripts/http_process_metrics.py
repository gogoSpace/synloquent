"""Sample only the verified PHP worker belonging to one synthetic HTTP fixture."""

import json
import os
import signal
import subprocess
import shlex
import threading
import time
from pathlib import Path
from urllib.parse import urlparse


def process_identity(identity: int) -> dict:
    contents = subprocess.check_output(['ps', '-o', 'ppid=,pgid=,lstart=,args=', '-p', str(identity)], text=True)
    parts = contents.strip().split(None, 7)
    if len(parts) != 8:
        raise ValueError('Owned process identity is incomplete')
    return {'processId': identity, 'parentProcessId': int(parts[0]), 'processGroupId': int(parts[1]),
            'startedAt': ' '.join(parts[2:7]), 'arguments': shlex.split(parts[7])}


def running_python_executable() -> str:
    """Launch the current interpreter binary without a launcher re-exec race."""
    executable = Path(process_identity(os.getpid())['arguments'][0]).resolve(strict=True)
    if not executable.is_file() or not os.access(executable, os.X_OK):
        raise ValueError('The current Python interpreter executable cannot be verified')
    return str(executable)


def worker_identity(configuration: dict) -> dict:
    children = subprocess.run(['pgrep', '-P', str(configuration['hostProcess'])],
                              text=True, capture_output=True, check=False)
    address = urlparse(configuration['address'])
    expected_address = address.hostname + ':' + str(address.port)
    matches = []
    for raw_identity in children.stdout.split():
        identity = int(raw_identity)
        observed = process_identity(identity)
        arguments = observed['arguments']
        if observed['parentProcessId'] == configuration['hostProcess'] and observed['processGroupId'] == configuration['hostProcess'] and Path(arguments[0]).name == 'php' and len(arguments) == 4 and arguments[1:3] == ['-S', expected_address]:
            matches.append(observed)
    if len(matches) != 1:
        raise ValueError('Exactly one fixture-owned PHP HTTP worker is required')
    return matches[0]


def same_running_process(recorded: dict) -> dict | None:
    """Allow reparenting while retaining the immutable task process identity."""
    status = subprocess.run(['ps', '-o', 'stat=', '-p', str(recorded['processId'])],
                            text=True, capture_output=True, check=False)
    if status.returncode == 1 and not status.stdout.strip():
        return None
    if status.returncode or not status.stdout.strip():
        raise ValueError('Owned process status cannot be verified')
    if status.stdout.strip().startswith('Z'):
        return None
    try:
        observed = process_identity(recorded['processId'])
    except subprocess.CalledProcessError as failure:
        if failure.returncode == 1 and not failure.output.strip():
            return None
        raise
    for key in ('processId', 'processGroupId', 'startedAt', 'arguments'):
        if observed[key] != recorded[key]:
            raise ValueError('Owned process identity changed: ' + key)
    return observed


def verified_group_members(identities: list[dict]) -> list[dict]:
    known = {identity['processId']: identity for identity in identities}
    groups = {identity['processGroupId'] for identity in identities}
    members = []
    for group_identifier in sorted(groups):
        group = subprocess.run(['pgrep', '-g', str(group_identifier)],
                               text=True, capture_output=True, check=False)
        if group.returncode not in (0, 1):
            raise ValueError('Owned process group membership cannot be verified')
        for value in group.stdout.split():
            process_identifier = int(value)
            if process_identifier not in known:
                status = subprocess.run(['ps', '-o', 'stat=', '-p', str(process_identifier)],
                                        text=True, capture_output=True, check=False)
                if (status.returncode == 1 and not status.stdout.strip()) or status.stdout.strip().startswith('Z'):
                    continue
                raise ValueError('Owned group contains an unverified process')
            observed = same_running_process(known[process_identifier])
            if observed is not None:
                members.append(observed)
    return members


def terminate_verified_processes(identities: list[dict], timeout_seconds: float = 5) -> dict:
    """Signal exact known processes only, never an unverified group member."""
    verified_group_members(identities)
    signalled = []
    reparented = []
    for termination_signal in (signal.SIGTERM, signal.SIGKILL):
        for recorded in reversed(identities):
            observed = same_running_process(recorded)
            if observed is None:
                continue
            if observed['parentProcessId'] != recorded['parentProcessId']:
                reparented.append(recorded['processId'])
            try:
                os.kill(recorded['processId'], termination_signal)
                signalled.append({'processId': recorded['processId'], 'signal': termination_signal.name})
            except ProcessLookupError:
                pass
        deadline = time.monotonic() + timeout_seconds
        while time.monotonic() < deadline:
            remaining = verified_group_members(identities)
            if not remaining:
                return {'signalled': signalled, 'reparentedProcessIds': sorted(set(reparented)), 'remainingProcessIds': []}
            time.sleep(0.05)
    raise RuntimeError('Verified owned processes did not exit after bounded cleanup')


class RequestMemorySampler:
    def __init__(self, identity: dict):
        self.identity = identity
        self.process_identity = identity['processId']
        self.samples = []
        self.errors = []
        self.stopped = threading.Event()
        self.thread = threading.Thread(target=self.sample, daemon=True)

    def sample(self):
        while not self.stopped.is_set():
            if not self.sample_once():
                break
            self.stopped.wait(0.05)

    def sample_once(self):
        try:
            contents = subprocess.check_output(
                ['ps', '-o', 'rss=', '-p', str(self.process_identity)], text=True)
            self.samples.append({'monotonicSeconds': time.perf_counter(),
                                 'rssBytes': int(contents.strip()) * 1024})
            return True
        except (subprocess.CalledProcessError, ValueError) as failure:
            self.errors.append(str(failure))
            return False

    def start(self):
        if process_identity(self.process_identity) != self.identity:
            raise ValueError('Owned PHP process identity changed before HTTP request')
        if not self.sample_once():
            raise ValueError('Owned HTTP worker baseline RSS is unavailable')
        self.thread.start()
        return self

    def finish(self):
        self.stopped.set()
        self.thread.join(timeout=5)
        if self.thread.is_alive() or self.errors or not self.samples:
            raise ValueError('Owned HTTP worker RSS measurement did not complete')
        if process_identity(self.process_identity) != self.identity:
            raise ValueError('Owned PHP process identity changed during HTTP request')
        return {'processId': self.process_identity, 'sampleCount': len(self.samples),
                'processIdentity': self.identity,
                'baselineRssBytes': self.samples[0]['rssBytes'],
                'maximumObservedRssBytes': max(sample['rssBytes'] for sample in self.samples),
                'samplingIntervalMilliseconds': 50,
                'limitations': 'External ps sampling of one verified PHP worker. Short RSS peaks between samples may be missed.'}


def lifecycle_profile(configuration: dict, profile_identity: str) -> dict | None:
    directory = configuration.get('lifecycleProfiles')
    if not directory:
        return None
    path = Path(directory) / (profile_identity + '.json')
    deadline = time.monotonic() + 10
    while not path.exists():
        if time.monotonic() >= deadline:
            raise ValueError('Application termination did not produce whole HTTP lifecycle evidence')
        time.sleep(0.025)
    report = json.loads(path.read_text())
    if report.get('profileId') != profile_identity:
        raise ValueError('Whole lifecycle evidence belongs to another HTTP request')
    return report

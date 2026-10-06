"""Prepared targeted native application observation. No launch or signal authority."""
import argparse
from hashlib import sha256
import importlib.util
import json
from pathlib import Path
import subprocess


def main():
    arguments = argparse.ArgumentParser()
    arguments.add_argument('--pid', type=int, required=True)
    arguments.add_argument('--expected-executable', required=True)
    arguments.add_argument('--owner-reader', required=True)
    arguments.add_argument('--owner-reader-sha256', required=True)
    selected = arguments.parse_args()
    if selected.pid <= 0:
        raise ValueError('Exact original native application PID is required.')
    reader_path = Path(selected.owner_reader)
    if sha256(reader_path.read_bytes()).hexdigest() != selected.owner_reader_sha256:
        raise ValueError('The independently reviewed kernel reader bytes changed.')
    specification = importlib.util.spec_from_file_location('native_application_kernel_reader', reader_path)
    reader = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(reader)
    kernel = reader.KernelReader()
    before = kernel.identity(selected.pid)
    if before is None or before['executablePath'] != selected.expected_executable:
        raise ValueError('The exact installed application kernel identity is unknown.')
    observation = subprocess.run(['/bin/ps', '-o', 'rss=', '-p', str(selected.pid)], capture_output=True, check=True, timeout=1, text=True)
    if not observation.stdout.strip().isdigit() or observation.stderr:
        raise ValueError('Exact native RSS observation is unknown.')
    after = kernel.identity(selected.pid)
    if not reader.same_identity(before, after):
        raise ValueError('Native application kernel identity changed during the RSS observation.')
    resident_bytes = int(observation.stdout.strip()) * 1024
    if resident_bytes <= 0:
        raise ValueError('Unknown native RSS cannot be reported as zero.')
    identity = {name: before[name] for name in reader.IMMUTABLE_KEYS}
    identity.update(domain='ios-simulator-host-kernel', birthWitness=str(before['birthMicroseconds']))
    print(json.dumps({'residentBytes': resident_bytes, 'processIdentity': identity}, sort_keys=True, separators=(',', ':')))


if __name__ == '__main__':
    main()

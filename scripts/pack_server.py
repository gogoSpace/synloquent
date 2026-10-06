#!/usr/bin/env python3
"""Create the reviewable Composer archive before freezing a candidate."""
import hashlib
import json
import shutil
import subprocess
from pathlib import Path

repository = Path(__file__).resolve().parents[1]
artifacts = repository / 'artifacts/packages'
artifacts.mkdir(parents=True, exist_ok=True)
version = json.loads((repository / 'packages/laravel/composer.json').read_text())['version']
filename = 'synloquent-laravel-' + version
subprocess.run(['composer', 'archive', '--format=zip', '--dir', str(artifacts), '--file', filename], cwd=repository / 'packages/laravel', check=True)
archive = artifacts / (filename + '.zip')
digest = hashlib.sha256(archive.read_bytes()).hexdigest()
immutable = archive.with_name(archive.stem + '-' + digest[:16] + archive.suffix)
shutil.copyfile(archive, immutable)
distribution = artifacts / 'distribution.json'
entries = json.loads(distribution.read_text()) if distribution.exists() else {}
entries['server'] = {'archive':immutable.name, 'sha256':digest}
distribution.write_text(json.dumps(entries, indent=2)+'\n')
archive.unlink()
print('Composer distribution SHA256 ' + digest)

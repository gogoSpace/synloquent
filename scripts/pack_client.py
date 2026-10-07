#!/usr/bin/env python3
"""Install an immutable, hashed distribution into the native example."""
import hashlib
import json
import shutil
import subprocess
from pathlib import Path

repository = Path(__file__).resolve().parents[1]
artifacts = repository / 'artifacts/packages'
artifacts.mkdir(parents=True, exist_ok=True)
subprocess.run(['npm', 'run', 'build'], cwd=repository, check=True)
result = subprocess.run(['npm', 'pack', '--json', '--pack-destination', str(artifacts)], cwd=repository / 'packages/client', check=True, text=True, capture_output=True)
metadata = json.loads(result.stdout)[0]
archive = artifacts / metadata['filename']
digest = hashlib.sha256(archive.read_bytes()).hexdigest()
immutable = archive.with_name(archive.stem + '-' + digest[:16] + archive.suffix)
shutil.copyfile(archive, immutable)
subprocess.run(['npm', 'install', '--save-exact', '--no-audit', '--no-fund', 'file:../../artifacts/packages/' + immutable.name], cwd=repository / 'examples/react-native', check=True)
distribution = artifacts / 'distribution.json'
entries = json.loads(distribution.read_text()) if distribution.exists() else {}
entries['client'] = {'archive':immutable.name, 'sha256':digest}
distribution.write_text(json.dumps(entries, indent=2)+'\n')
evidence = repository / '.agentic/artifacts/packages'
evidence.mkdir(parents=True, exist_ok=True)
(evidence / 'native-package.json').write_text(json.dumps({'archive':str(immutable), 'sha256':digest}, indent=2)+'\n')
archive.unlink()
print('Native consumer installed package SHA256 ' + digest)

#!/usr/bin/env python3
"""Bundle frozen shared schemas into the standalone PHP distribution."""
import argparse
from pathlib import Path

repository = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('--check', action='store_true')
arguments = parser.parse_args()
source = repository / 'protocol/schemas'
target = repository / 'packages/laravel/src/Protocol/Schemas'
target.mkdir(parents=True, exist_ok=True)
for schema in sorted(source.glob('*.json')):
    bundled = target / schema.name
    if arguments.check:
        if not bundled.exists() or bundled.read_bytes() != schema.read_bytes():
            raise SystemExit('Bundled protocol schema is stale: ' + schema.name)
    else:
        bundled.write_bytes(schema.read_bytes())
if {path.name for path in target.glob('*.json')} != {path.name for path in source.glob('*.json')}:
    raise SystemExit('Bundled protocol contains unknown schemas')
print('Bundled protocol schemas verified' if arguments.check else 'Bundled protocol schemas synchronized')

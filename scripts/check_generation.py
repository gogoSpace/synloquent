#!/usr/bin/env python3
"""Validate deterministic Laravel generation and actual consumer static types."""

import hashlib
import json
import subprocess
import tempfile
from pathlib import Path

REPOSITORY = Path(__file__).resolve().parents[1]
host = REPOSITORY / "examples/laravel"
output = subprocess.check_output(["php", "artisan", "synloquent:manifest"], cwd=host, text=True)
manifest = json.loads(output)
claimed_fingerprint = manifest.pop("fingerprint")
canonical = json.dumps(manifest, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
if hashlib.sha256(canonical.encode("utf-8")).hexdigest() != claimed_fingerprint:
    raise SystemExit("Laravel manifest fingerprint differs from the language-independent canonical oracle")
manifest["fingerprint"] = claimed_fingerprint
for model_name, definition in manifest["models"].items():
    for columns in definition.get("indexes", []) + definition.get("unique", []):
        if any(column not in definition["fields"] for column in columns):
            raise SystemExit(f"Nonprojected index column in {model_name}: {columns}")
temporary = REPOSITORY / ".local/test-results/generation"
temporary.mkdir(parents=True, exist_ok=True)
with tempfile.TemporaryDirectory(prefix="synloquent-generation-", dir=temporary) as directory:
    generated = Path(directory) / "backend.generated.ts"
    for iteration in range(2):
        subprocess.run(["php", "artisan", "synloquent:generate", "--output=" + str(generated)], cwd=host, check=True, capture_output=True)
        content = generated.read_bytes()
        if iteration == 0:
            first_content = content
        elif content != first_content:
            raise SystemExit("Generation is nondeterministic")
    subprocess.run(["php", "artisan", "synloquent:generate", "--check", "--output=" + str(generated)], cwd=host, check=True, capture_output=True)
    static_assertions = Path(directory) / "consumer.ts"
    static_assertions.write_text('''import type { BackendCommands, BackendModels, BackendScopes } from './backend.generated.js'
declare const models: BackendModels
declare const commands: BackendCommands
declare const scopes: BackendScopes
models.Item.where('title', 'Alpine stamp').with('images')
models.Item.create({ title: 'Offline stamp', price: '12.50', active: true, quantity: 1 })
commands.increaseQuantity({ item_id: 1, delta: 2 }, 'immutable-operation')
scopes.activePriced({ minimumPrice: '12.50' }).get()
// @ts-expect-error Unknown command inputs must fail generated binding checks.
commands.increaseQuantity({ item_id: 1, unknown: 2 }, 'immutable-operation')
// @ts-expect-error Decimal scope arguments must preserve exact strings.
scopes.activePriced({ minimumPrice: 12.50 })
// @ts-expect-error Unknown field must fail generation binding checks.
models.Item.where('unknown_field', 'value')
// @ts-expect-error Unknown relation must fail generation binding checks.
models.Item.with('unknown_relation')
// @ts-expect-error Primary key is read-only in the exported projection.
models.Item.create({ id: 4 })
// @ts-expect-error Exact decimal values use strings.
models.Item.create({ price: 12.50 })
''')
    subprocess.run([str(REPOSITORY / "node_modules/.bin/tsc"), "--noEmit", "--strict", "--exactOptionalPropertyTypes", "--noUncheckedIndexedAccess", "--module", "ESNext", "--moduleResolution", "Bundler", "--target", "ES2022", "--lib", "ES2022", str(static_assertions)], cwd=REPOSITORY, check=True)
    fixture = (REPOSITORY / "protocol/fixtures/backend.generated.ts").read_bytes()
    if fixture != first_content:
        raise SystemExit("Golden generated file is stale")
    golden_manifest = json.loads((REPOSITORY / "protocol/fixtures/manifest.json").read_text())
    if golden_manifest != manifest:
        raise SystemExit("Golden manifest is stale")
print("Deterministic generator and positive/negative consumer type checks passed")

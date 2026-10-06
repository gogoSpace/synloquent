#!/usr/bin/env python3
"""Install the actual distribution archives into fresh disposable consumers."""

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import tempfile
import tarfile
import zipfile
from pathlib import Path

REPOSITORY = Path(__file__).resolve().parents[1]


def verify_archive(archive: Path, expected_hash: str, source: Path) -> None:
    if hashlib.sha256(archive.read_bytes()).hexdigest() != expected_hash:
        raise RuntimeError('Distribution archive hash differs from its immutable identity')
    if archive.suffix == '.tgz':
        with tarfile.open(archive) as contents:
            observed = set()
            for member in contents.getmembers():
                if member.isfile():
                    relative = Path(member.name).relative_to('package')
                    observed.add(relative.as_posix())
                    reader = contents.extractfile(member)
                    if reader is None or reader.read() != (source / relative).read_bytes():
                        raise RuntimeError('Stale client distribution entry ' + str(relative))
            metadata = json.loads((source / 'package.json').read_text())
            expected = {'package.json', 'README.md', 'LICENSE'}
            for declared in metadata['files']:
                published = source / declared
                if published.is_dir():
                    expected.update(path.relative_to(source).as_posix() for path in published.rglob('*') if path.is_file())
                elif published.is_file():
                    expected.add(declared)
                else:
                    raise RuntimeError('Missing declared client distribution source ' + declared)
            if observed != expected:
                raise RuntimeError('Client distribution inventory differs from its public build')
    else:
        with zipfile.ZipFile(archive) as contents:
            observed = {member.filename for member in contents.infolist() if not member.is_dir()}
            expected = {path.relative_to(source).as_posix() for name in ['src', 'config', 'routes', 'database'] for path in (source / name).rglob('*') if path.is_file()} | {'composer.json', 'README.md', 'LICENSE'}
            if observed != expected:
                raise RuntimeError('Server distribution inventory differs from its public source')
            for member in contents.infolist():
                if not member.is_dir() and contents.read(member) != (source / member.filename).read_bytes():
                    raise RuntimeError('Stale server distribution entry ' + member.filename)


def run(arguments: list[str], directory: Path, environment: dict[str, str] | None = None) -> str:
    result = subprocess.run(arguments, cwd=directory, env=environment, text=True, capture_output=True, check=False)
    if result.returncode:
        raise RuntimeError(f"Command failed {arguments}\n{result.stdout}\n{result.stderr}")
    return result.stdout


def qualify_laravel_archive(temporary: Path, archives: Path, version: str, framework: str) -> dict[str, object]:
    consumer = temporary / ("laravel-" + framework)
    shutil.copytree(REPOSITORY / "examples/laravel", consumer, ignore=shutil.ignore_patterns("vendor", ".env", ".env.*", "storage", "cache", "composer.lock", "composer.json"))
    (consumer / "storage/logs").mkdir(parents=True)
    (consumer / "storage/framework/cache").mkdir(parents=True)
    (consumer / "storage/framework/sessions").mkdir(parents=True)
    (consumer / "storage/framework/views").mkdir(parents=True)
    (consumer / "bootstrap/cache").mkdir(parents=True)
    metadata = {"name": "synloquent/fresh-archive-consumer", "require": {"synloquent/laravel": version, "laravel/framework": framework}, "repositories": [{"type": "artifact", "url": str(archives)}], "autoload": {"psr-4": {"App\\": "app/"}}, "config": {"allow-plugins": {}}, "scripts": {"post-autoload-dump": ["Illuminate\\Foundation\\ComposerScripts::postAutoloadDump", "@php artisan package:discover --ansi"]}}
    (consumer / "composer.json").write_text(json.dumps(metadata, indent=2) + "\n")
    run(["composer", "install", "--no-interaction", "--prefer-dist"], consumer)
    installed = consumer / "vendor/synloquent/laravel"
    if installed.is_symlink() or str(REPOSITORY / "packages/laravel") in str(installed.resolve()):
        raise RuntimeError("Archive consumer resolved a workspace source shortcut")
    run(["php", "-r", "require 'vendor/autoload.php'; if (!class_exists('Synloquent\\Laravel\\SynloquentServiceProvider')) throw new RuntimeException('Installed archive provider is missing');"], consumer)
    database = "synloquent_archive_" + framework.replace(".", "_") + "_" + str(os.getpid())
    connection = ["-h", "127.0.0.1", "-p", "55432", "-U", "synloquent", database]
    postgres = (os.environ.get('SYNLOQUENT_POSTGRES_BIN', '').rstrip('/') + '/' if os.environ.get('SYNLOQUENT_POSTGRES_BIN') else '')
    run([postgres + "createdb", *connection], consumer)
    environment = {**os.environ, "APP_ENV": "testing", "DB_CONNECTION": "pgsql", "DB_DATABASE": database, "DB_HOST": "127.0.0.1", "DB_PORT": "55432", "DB_USERNAME": "synloquent", "DB_PASSWORD": "", "APP_KEY": "base64:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}
    try:
        run(["php", "artisan", "migrate", "--force"], consumer, environment)
        run(["php", "artisan", "synloquent:seed-example"], consumer, environment)
        doctor = run(["php", "artisan", "synloquent:doctor"], consumer, environment)
        generated = consumer / "backend.generated.ts"
        run(["php", "artisan", "synloquent:generate", "--output=" + str(generated)], consumer, environment)
        manifest = json.loads(run(["php", "artisan", "synloquent:manifest"], consumer, environment))
        if not generated.is_file() or "Item" not in manifest["models"]:
            raise RuntimeError("Fresh archive consumer did not generate its registered domain")
        return {"framework": framework, "providerDiscovery": True, "archiveInstall": True, "doctor": doctor.strip(), "generatedFingerprint": manifest["fingerprint"]}
    finally:
        run([postgres + "dropdb", "--if-exists", "--force", *connection], consumer)



def qualify_native_archive(temporary: Path, client_archive: Path) -> dict[str, object]:
    workspace = temporary / 'native-consumer'
    consumer = workspace / 'examples/react-native'
    shutil.copytree(REPOSITORY / 'examples/react-native', consumer, ignore=shutil.ignore_patterns('node_modules', 'Pods', 'build', '.gradle', '.cxx', 'local.properties', 'DerivedData'))
    archives = workspace / 'artifacts/packages'
    archives.mkdir(parents=True)
    shutil.copyfile(client_archive, archives / client_archive.name)
    scripts = workspace / 'scripts'
    scripts.mkdir()
    for filename in ['repair_rn_types.mjs', 'rn-type-repairs.json']:
        shutil.copyfile(REPOSITORY / 'scripts' / filename, scripts / filename)
    metadata = json.loads((consumer / 'package.json').read_text())
    if metadata.get('codegenConfig'):
        raise RuntimeError('Fresh RN consumer must discover the provider from the installed library')
    if any('SynloquentCrypto' in path.name for path in (consumer / 'ios').rglob('*')) or any('SynloquentCrypto' in path.name for path in (consumer / 'android').rglob('*')):
        raise RuntimeError('Fresh RN consumer still contains copied provider native sources')
    for platform in ['android', 'ios']:
        for path in (consumer / platform).rglob('*'):
            if path.suffix in ['.kt', '.java', '.mm', '.m', '.h'] and 'SynloquentCryptoPackage' in path.read_text():
                raise RuntimeError('Fresh RN consumer still registers the example-only provider')
    disk_before = shutil.disk_usage(workspace).free
    if disk_before < 3 * 1024 * 1024 * 1024:
        raise RuntimeError('Fresh RN install requires3GiB task artifact headroom')
    run(['npm', 'ci', '--no-audit', '--no-fund'], consumer)
    installed = consumer / 'node_modules/@synloquent/client'
    if installed.is_symlink() or str(REPOSITORY / 'packages/client') in str(installed.resolve()):
        raise RuntimeError('Fresh RN consumer resolved a source shortcut')
    configuration = json.loads(run(['node_modules/.bin/react-native', 'config'], consumer))
    dependency = configuration['dependencies'].get('@synloquent/client')
    if not isinstance(dependency, dict):
        raise RuntimeError('RN autolinking did not discover the public native provider')
    platforms = dependency.get('platforms', {})
    android = platforms.get('android')
    ios = platforms.get('ios')
    if not isinstance(android, dict) or not isinstance(ios, dict):
        raise RuntimeError('The public provider did not autolink on both native platforms')
    if not Path(android.get('sourceDir', '')).resolve().is_relative_to(installed.resolve()) or not Path(ios.get('podspecPath', '')).resolve().is_relative_to(installed.resolve()):
        raise RuntimeError('RN autolinking points outside the installed archive')
    generated = consumer / 'build/fresh-codegen'
    codegen = run(['node', 'node_modules/react-native/scripts/generate-codegen-artifacts.js', '-p', str(consumer), '-t', 'all', '-o', str(generated)], consumer)
    generated_files = list(generated.rglob('*'))
    if not any(path.is_file() and path.name == 'NativeSynloquentCryptoSpec.java' for path in generated_files) or not any(path.is_file() and 'SynloquentNativeSpec' in path.name and path.suffix == '.h' for path in generated_files):
        raise RuntimeError('Fresh public archive did not generate both native provider interfaces')
    # The clean public consumer bundles only published imports, without the repository's native test harness.
    entry = consumer / 'fresh-public-entry.js'
    entry.write_text("import React from 'react'\nimport { AppRegistry, Text } from 'react-native'\nimport { createSynloquent } from '@synloquent/client'\nimport { createDatabaseAdapter } from '@synloquent/client/sqlite'\nimport { createNativeCryptoProvider } from '@synloquent/client/native-crypto'\nimport { createReactNativeClient, createReactNativeHttpTransport } from '@synloquent/client/react-native'\nimport { useSynloquentQuery } from '@synloquent/client/react'\nimport { backendSchema } from './backend.generated'\nconst cryptography = createNativeCryptoProvider()\nconst options = { schema: backendSchema, database: createDatabaseAdapter, digest: cryptography.digest, digestChunks: cryptography.digestChunks }\nfunction FreshPublicConsumer() { return React.createElement(Text, null, String(typeof createSynloquent === 'function' && typeof useSynloquentQuery === 'function' && typeof createReactNativeClient === 'function' && typeof createReactNativeHttpTransport === 'function' && options.schema.schemaVersion >= 1)) }\nAppRegistry.registerComponent('SynloquentExample', () => FreshPublicConsumer)\n")
    (consumer / 'metro.config.js').write_text("const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config')\nmodule.exports = mergeConfig(getDefaultConfig(__dirname), {})\n")
    for platform in ['ios', 'android']:
        run(['node_modules/.bin/react-native', 'bundle', '--entry-file', entry.name, '--platform', platform, '--dev', 'false', '--bundle-output', str(consumer / 'build' / (platform + '.jsbundle'))], consumer)
    return {'archiveInstall': True, 'sourceShortcut': False, 'exampleNativeSources': False, 'androidAutolink': True, 'iosAutolink': True, 'bothPlatformCodegen': True, 'bothPlatformMetroBundle': True, 'codegenLog': codegen.strip(), 'freeDiskBytesBefore': disk_before, 'freeDiskBytesAfter': shutil.disk_usage(workspace).free}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--examples", action="store_true")
    arguments = parser.parse_args()
    artifacts = REPOSITORY / ".local/test-results/packages"
    artifacts.mkdir(parents=True, exist_ok=True)
    client_metadata = json.loads((REPOSITORY / "packages/client/package.json").read_text())
    server_metadata = json.loads((REPOSITORY / "packages/laravel/composer.json").read_text())
    if client_metadata["version"] != server_metadata["version"]:
        raise RuntimeError("Public package release versions differ")
    if not (REPOSITORY / "packages/client/dist/index.js").exists():
        raise RuntimeError("The client package has not been built")
    distribution_directory = REPOSITORY / 'artifacts/packages'
    distribution = json.loads((distribution_directory / 'distribution.json').read_text())
    client_archive = distribution_directory / distribution['client']['archive']
    server_archive = distribution_directory / distribution['server']['archive']
    verify_archive(client_archive, distribution['client']['sha256'], REPOSITORY / 'packages/client')
    verify_archive(server_archive, distribution['server']['sha256'], REPOSITORY / 'packages/laravel')
    temporary_directory = Path(tempfile.mkdtemp(prefix="synloquent-package-smoke-", dir=REPOSITORY / ".local/test-results"))
    try:
        server_archives = temporary_directory / 'composer-artifacts'
        server_archives.mkdir()
        shutil.copyfile(server_archive, server_archives / server_archive.name)
        client_consumer = temporary_directory / "client"
        client_consumer.mkdir()
        (client_consumer / "package.json").write_text(json.dumps({"name": "synloquent-smoke-consumer", "private": True, "type": "module"}) + "\n")
        run(["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund", str(client_archive)], client_consumer)
        run(["node", "--input-type=module", "-e", "const packageModule = await import('@synloquent/client'); if (typeof packageModule.createSynloquent !== 'function') throw new Error('Missing public client entrypoint')"], client_consumer)
        installed_package = client_consumer / "node_modules/@synloquent/client"
        source_imports = [path for path in (installed_package / "dist").rglob("*.js") if "/Users/" in path.read_text() or "packages/client/src" in path.read_text()]
        if source_imports:
            raise RuntimeError("Distribution imports private source paths")
        server_consumer = temporary_directory / "server"
        server_consumer.mkdir()
        (server_consumer / "composer.json").write_text(json.dumps({"name": "synloquent/smoke-host", "require": {"synloquent/laravel": client_metadata["version"]}, "repositories": [{"type": "artifact", "url": str(server_archives)}], "config": {"allow-plugins": {}}}, indent=2) + "\n")
        run(["composer", "install", "--no-interaction", "--prefer-dist", "--no-scripts"], server_consumer)
        run(["php", "-r", "require 'vendor/autoload.php'; if (!class_exists('Synloquent\\Laravel\\SynloquentServiceProvider')) { throw new RuntimeException('Provider autoload failed'); }"], server_consumer)
        laravel_consumers = [qualify_laravel_archive(temporary_directory, server_archives, client_metadata["version"], framework) for framework in ["12.55.1", "13.34.0"]]
        native_consumer = None
        if arguments.examples:
            native_metadata = json.loads((REPOSITORY / "examples/react-native/package.json").read_text())
            client_dependency = native_metadata.get("dependencies", {}).get("@synloquent/client", "")
            if not client_dependency.endswith(".tgz"):
                raise RuntimeError("Final RN example must consume a packed package")
            if not (REPOSITORY / "examples/react-native/backend.generated.ts").exists():
                raise RuntimeError("RN example has no generated Laravel definitions")
            run(["php", "artisan", "synloquent:doctor"], REPOSITORY / "examples/laravel")
            native_consumer = qualify_native_archive(temporary_directory, client_archive)
        evidence = {"releaseVersion": client_metadata["version"], "clientArchive": str(client_archive), "clientArchiveHash": hashlib.sha256(client_archive.read_bytes()).hexdigest(), "serverArchive": str(server_archive), "serverArchiveHash": hashlib.sha256(server_archive.read_bytes()).hexdigest(), "freshClientInstall": True, "freshComposerInstall": True, "laravelConsumers": laravel_consumers, "examplesChecked": arguments.examples, "nativeConsumer": native_consumer}
        (artifacts / "smoke.json").write_text(json.dumps(evidence, indent=2) + "\n")
        print(json.dumps(evidence, indent=2))
    finally:
        shutil.rmtree(temporary_directory)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

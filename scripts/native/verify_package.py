"""Compare every installed published byte with the declared immutable archive."""
import argparse
import hashlib
import json
import shutil
import tarfile
from pathlib import Path, PurePosixPath


def inventory_hash(files):
    return hashlib.sha256(json.dumps(files, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def archive_inventory(archive):
    files = {}
    contents = {}
    with tarfile.open(archive, 'r:gz') as package:
        for member in package.getmembers():
            path = PurePosixPath(member.name)
            if path.is_absolute() or '..' in path.parts or not path.parts or path.parts[0] != 'package':
                raise ValueError('Invalid published archive path')
            if member.isdir():
                continue
            if not member.isfile() or len(path.parts) < 2:
                raise ValueError('Published archive must contain regular files only')
            relative = str(PurePosixPath(*path.parts[1:]))
            if relative in files:
                raise ValueError('Duplicate published archive file')
            stream = package.extractfile(member)
            if stream is None:
                raise ValueError('Published archive file is unreadable')
            content = stream.read()
            files[relative] = {'bytes': len(content), 'sha256': hashlib.sha256(content).hexdigest()}
            if relative == 'package.json':
                contents[relative] = content
    metadata = json.loads(contents['package.json'])
    if metadata.get('name') != '@synloquent/client' or set(metadata.get('exports', {})) != {'.', './react', './sqlite', './native-crypto', './react-native'}:
        raise ValueError('The archive does not expose the required public consumer entries')
    for entry in metadata['exports'].values():
        for kind in ('types', 'import'):
            target = entry[kind]
            if not isinstance(target, str) or not target.startswith('./') or target[2:] not in files:
                raise ValueError('Public generated JavaScript or declaration entry is missing')
    required = {
        'react-native.config.cjs', 'SynloquentNativeCrypto.podspec',
        'src/native-crypto/specs/NativeSynloquentCrypto.ts',
        'dist/native-crypto/specs/NativeSynloquentCrypto.js',
        'dist/native-crypto/specs/NativeSynloquentCrypto.d.ts',
        'native/ios/SynloquentCrypto.h', 'native/ios/SynloquentCrypto.mm',
        'native/android/build.gradle',
        'native/android/src/main/java/com/synloquent/nativecrypto/SynloquentCryptoModule.kt',
        'native/android/src/main/java/com/synloquent/nativecrypto/SynloquentCryptoPackage.kt',
    }
    if not required <= files.keys():
        raise ValueError('Published native provider inventory is incomplete')
    return files


def installed_inventory(directory):
    if directory.is_symlink() or not directory.is_dir():
        raise ValueError('Installed package must be a real distribution directory')
    files = {}
    for path in sorted(directory.rglob('*')):
        if path.is_symlink():
            raise ValueError('Installed package contains an unexpected symbolic link')
        if path.is_dir():
            continue
        if not path.is_file():
            raise ValueError('Installed package contains a nonregular file')
        content = path.read_bytes()
        files[path.relative_to(directory).as_posix()] = {
            'bytes': len(content), 'sha256': hashlib.sha256(content).hexdigest(),
        }
    return files


def verify_distribution(repository, installed):
    distribution = repository / 'artifacts/packages/distribution.json'
    declared = json.loads(distribution.read_text())['client']
    filename = declared['archive']
    if not isinstance(filename, str) or Path(filename).name != filename:
        raise ValueError('Distribution archive must have one local filename')
    archive = distribution.parent / filename
    archive_digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    if archive_digest != declared['sha256']:
        raise ValueError('Actual distribution archive SHA256 differs from distribution.json')
    native_declaration = json.loads((repository / '.local/test-results/packages/native-package.json').read_text())
    if Path(native_declaration['archive']).resolve() != archive.resolve() or native_declaration['sha256'] != archive_digest:
        raise ValueError('Native archive declaration differs from the actual distribution')
    published = archive_inventory(archive)
    installed_files = installed_inventory(installed)
    if installed_files != published:
        missing = sorted(published.keys() - installed_files.keys())
        extra = sorted(installed_files.keys() - published.keys())
        changed = sorted(name for name in published.keys() & installed_files.keys() if published[name] != installed_files[name])
        raise ValueError(json.dumps({'missing': missing, 'extra': extra, 'changed': changed}))
    return {
        'archive': str(archive.resolve()), 'sha256': archive_digest,
        'publishedFileCount': len(published), 'installedFileCount': len(installed_files),
        'inventoryFingerprint': inventory_hash(published),
        'exactInventoryAndBytes': True, 'files': published,
    }


def cleanup_generated(installed, before):
    if before.get('exactInventoryAndBytes') is not True:
        raise ValueError('Generated output cleanup requires a complete before-build witness')
    directory = installed / 'native/android/build'
    if not directory.exists():
        return {'removedDirectory': None, 'generatedFiles': {}}
    if directory.is_symlink() or not directory.is_dir():
        raise ValueError('Generated Android output must be a real task build directory')
    files = installed_inventory(directory)
    proof = {'removedDirectory': str(directory), 'generatedFiles': files,
             'inventoryFingerprint': inventory_hash(files)}
    shutil.rmtree(directory)
    return proof


def validate_native_provenance(evidence, repository, installed=None):
    """Require complete before/after witnesses and recheck their actual archive."""
    try:
        current = verify_distribution(
            repository,
            installed or repository / 'examples/react-native/node_modules/@synloquent/client',
        )
        if evidence.get('packageArchiveWitness', {}).get('sha256') != current['sha256']:
            return ['Native package archive witness differs from actual current archive']
        for boundary in ('packageInventoryBefore', 'packageInventoryAfter'):
            witness = evidence.get(boundary)
            if not isinstance(witness, dict) or any(witness.get(key) != value for key, value in current.items()):
                return ['Native evidence lacks complete exact archive provenance at ' + boundary]
        if evidence.get('packageProvenanceFailure'):
            return ['Native evidence reports a package provenance failure']
        return []
    except (OSError, ValueError, KeyError, TypeError, AttributeError, tarfile.TarError) as failure:
        return ['Actual native distribution provenance failed: ' + type(failure).__name__]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--before', type=Path)
    parser.add_argument('--cleanup-generated', action='store_true')
    arguments = parser.parse_args()
    repository = Path(__file__).resolve().parents[2]
    installed = repository / 'examples/react-native/node_modules/@synloquent/client'
    generated = None
    if arguments.cleanup_generated:
        if arguments.before is None:
            raise ValueError('A before-build witness is required for generated cleanup')
        generated = cleanup_generated(installed, json.loads(arguments.before.read_text()))
    proof = verify_distribution(repository, installed)
    if generated is not None:
        proof['generatedOutputCleanup'] = generated
    print(json.dumps(proof, separators=(',', ':')))


if __name__ == '__main__':
    main()

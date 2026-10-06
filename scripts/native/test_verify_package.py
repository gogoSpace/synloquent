"""Provenance negatives use temporary installs and do not claim native execution."""
import json
import shutil
import tarfile
import tempfile
import unittest
from pathlib import Path

from verify_package import cleanup_generated, verify_distribution, validate_native_provenance


class PackageProvenanceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='synloquent-native-package-proof-')
        self.addCleanup(self.temporary.cleanup)
        self.repository = Path(self.temporary.name)
        original_repository = Path(__file__).resolve().parents[2]
        declaration = json.loads((original_repository / 'artifacts/packages/distribution.json').read_text())['client']
        archive_directory = self.repository / 'artifacts/packages'
        archive_directory.mkdir(parents=True)
        self.archive = archive_directory / declaration['archive']
        shutil.copyfile(original_repository / 'artifacts/packages' / declaration['archive'], self.archive)
        (archive_directory / 'distribution.json').write_text(json.dumps({'client': declaration}))
        native_directory = self.repository / '.local/test-results/packages'
        native_directory.mkdir(parents=True)
        (native_directory / 'native-package.json').write_text(json.dumps({'archive': str(self.archive), 'sha256': declaration['sha256']}))
        self.installed = self.repository / 'installed'
        self.installed.mkdir()
        with tarfile.open(self.archive, 'r:gz') as archive:
            for member in archive.getmembers():
                if not member.isfile():
                    continue
                relative = Path(member.name).relative_to('package')
                target = self.installed / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(archive.extractfile(member).read())

    def test_complete_exact_public_distribution(self):
        proof = verify_distribution(self.repository, self.installed)
        self.assertTrue(proof['exactInventoryAndBytes'])
        self.assertEqual(proof['publishedFileCount'], proof['installedFileCount'])

    def test_modified_public_javascript_rejected(self):
        with (self.installed / 'dist/index.js').open('a') as target:
            target.write('\n// unexpected installed mutation\n')
        with self.assertRaises(ValueError):
            verify_distribution(self.repository, self.installed)

    def test_modified_native_source_and_missing_spec_rejected(self):
        (self.installed / 'native/ios/SynloquentCrypto.mm').write_text('changed native implementation')
        with self.assertRaises(ValueError):
            verify_distribution(self.repository, self.installed)
        (self.installed / 'src/native-crypto/specs/NativeSynloquentCrypto.ts').unlink()
        with self.assertRaises(ValueError):
            verify_distribution(self.repository, self.installed)

    def test_extra_installed_file_rejected(self):
        (self.installed / 'unexpected.js').write_text('export const unexpected = true')
        with self.assertRaises(ValueError):
            verify_distribution(self.repository, self.installed)

    def test_archive_bytes_do_not_match_declaration_rejected(self):
        with self.archive.open('ab') as archive:
            archive.write(b'unexpected archive mutation')
        with self.assertRaises(ValueError):
            verify_distribution(self.repository, self.installed)

    def test_generated_task_output_requires_cleanup_before_exact_proof(self):
        before = verify_distribution(self.repository, self.installed)
        output = self.installed / 'native/android/build/generated/source/codegen/proof.cpp'
        output.parent.mkdir(parents=True)
        output.write_text('task-generated build output')
        with self.assertRaises(ValueError):
            verify_distribution(self.repository, self.installed)
        cleanup = cleanup_generated(self.installed, before)
        self.assertIn('generated/source/codegen/proof.cpp', cleanup['generatedFiles'])
        after = verify_distribution(self.repository, self.installed)
        self.assertEqual(after['inventoryFingerprint'], before['inventoryFingerprint'])

    def test_native_evidence_requires_exact_before_and_after_inventory(self):
        proof = verify_distribution(self.repository, self.installed)
        evidence = {'packageArchiveWitness': {'sha256': proof['sha256']}, 'packageInventoryBefore': proof, 'packageInventoryAfter': proof}
        self.assertEqual(validate_native_provenance(evidence, self.repository, self.installed), [])
        for boundary in ('packageInventoryBefore', 'packageInventoryAfter'):
            incomplete = {**evidence, boundary: {'sha256': proof['sha256'], 'exactInventoryAndBytes': True}}
            self.assertTrue(validate_native_provenance(incomplete, self.repository, self.installed))
        changed = {**evidence, 'packageInventoryAfter': {**proof, 'files': {}}}
        self.assertTrue(validate_native_provenance(changed, self.repository, self.installed))


if __name__ == '__main__':
    unittest.main()

import importlib.util
import plistlib
import tempfile
import unittest
import zipfile
from pathlib import Path

spec = importlib.util.spec_from_file_location('ipa_metadata', Path(__file__).with_name('ipa_metadata.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class MetadataTest(unittest.TestCase):
    def test_uses_actual_bundle_version_and_digest(self):
        with tempfile.TemporaryDirectory() as folder:
            ipa = Path(folder) / 'app.ipa'
            with zipfile.ZipFile(ipa, 'w') as z:
                z.writestr('Payload/Runner.app/Info.plist', plistlib.dumps({
                    'CFBundleIdentifier': 'com.cheyapp.chey',
                    'CFBundleShortVersionString': '1.4.10', 'CFBundleVersion': '1234501'}))
            result = module.metadata(ipa, 'a' * 40, True)
            self.assertEqual(result['tag'], 'che-ios-v1.4.10-b1234501')
            self.assertEqual(result['size'], ipa.stat().st_size)
            self.assertEqual(len(result['sha256']), 64)
            self.assertTrue(result['shorebird_base'])
            with self.assertRaises(ValueError):
                module.metadata(ipa, 'main', True)

    def test_rejects_wrong_app(self):
        with tempfile.TemporaryDirectory() as folder:
            ipa = Path(folder) / 'app.ipa'
            with zipfile.ZipFile(ipa, 'w') as z:
                z.writestr('Payload/Runner.app/Info.plist', plistlib.dumps({'CFBundleIdentifier': 'other.app'}))
            with self.assertRaises(ValueError):
                module.metadata(ipa, 'a' * 40, False)


class VerifyTest(unittest.TestCase):
    def make_ipa(self, folder, bundle=module.BUNDLE_ID, version='1.4.10', build='1234501'):
        ipa = Path(folder) / 'app.ipa'
        with zipfile.ZipFile(ipa, 'w') as z:
            z.writestr('Payload/Runner.app/Info.plist', plistlib.dumps({
                'CFBundleIdentifier': bundle, 'CFBundleShortVersionString': version, 'CFBundleVersion': build}))
        return ipa

    def test_accepts_only_the_expected_version_and_build(self):
        with tempfile.TemporaryDirectory() as folder:
            ipa = self.make_ipa(folder)
            self.assertEqual(module.verify(ipa, '1.4.10', '1234501'), ('1.4.10', '1234501'))
            with self.assertRaisesRegex(ValueError, 'expected 1.4.11'):
                module.verify(ipa, '1.4.11', '1234501')
            with self.assertRaisesRegex(ValueError, 'build is 1234501, expected 1'):
                module.verify(ipa, '1.4.10', '1')

    def test_rejects_a_debug_or_renamed_bundle(self):
        with tempfile.TemporaryDirectory() as folder:
            for bundle in ['com.cheyapp.chey.debug', 'che-ios-v1.4', 'com.cheyapp.che']:
                with self.subTest(bundle=bundle):
                    with self.assertRaisesRegex(ValueError, 'bundle identifier'):
                        module.verify(self.make_ipa(folder, bundle=bundle))

    def test_metadata_records_the_bundle_identifier(self):
        with tempfile.TemporaryDirectory() as folder:
            self.assertEqual(module.metadata(self.make_ipa(folder), 'a' * 40, False)['bundle_id'], 'com.cheyapp.chey')

    def test_command_line_gate_fails_a_mismatched_release(self):
        import subprocess
        import sys
        tool = Path(__file__).with_name('ipa_metadata.py')
        with tempfile.TemporaryDirectory() as folder:
            ipa = self.make_ipa(folder, bundle='com.cheyapp.chey.debug')
            bad = subprocess.run([sys.executable, '-I', str(tool), 'verify', str(ipa), '1.4.10', '1234501'],
                                 capture_output=True, text=True)
            self.assertNotEqual(bad.returncode, 0)
            self.assertIn('bundle identifier', bad.stderr)
            good = subprocess.run([sys.executable, '-I', str(tool), 'verify', str(self.make_ipa(folder)), '1.4.10', '1234501'],
                                  capture_output=True, text=True)
            self.assertEqual(good.returncode, 0, good.stderr)

    def test_release_script_writes_the_same_bundle_identifier(self):
        script = Path(__file__).with_name('che_mobile_release.sh').read_text()
        self.assertTrue(f'bundle_id={module.BUNDLE_ID}' in script, 'release script must write the bundle ID')
        self.assertTrue('verify "$IPA" "$FULL_VERSION" "$FULL_BUILD"' in script, 'release script must verify the IPA')


if __name__ == '__main__':
    unittest.main()

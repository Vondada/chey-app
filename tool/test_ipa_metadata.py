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

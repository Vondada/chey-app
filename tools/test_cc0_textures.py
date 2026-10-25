"""Tests for CHE's job-time CC0 textures (tools/avatar_body/cc0_textures.py) against a fake Poly Haven: the choice is
deterministic, each file is checked by the API's md5 and size, cached by SHA-256 and never fetched twice, the receipt
records source and license without local paths, and any failure is recorded instead of raised. No network is used.

  python3 -m unittest tools/test_cc0_textures.py
"""
import hashlib
import json
import os
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'tools', 'avatar_body'))
import cc0_textures as T  # noqa: E402

JPG = b'\xff\xd8\xff\xe0' + b'wood pixels' * 50
NOR = b'\xff\xd8\xff\xe0' + b'normal pixels' * 40
LISTING = {
    'old_planks': {'name': 'Old planks', 'categories': ['wood'], 'download_count': 900},
    'oak_floor_2': {'name': 'Oak floor', 'categories': ['wood', 'floor'], 'download_count': 500},
    'oak_floor_1': {'name': 'Oak floor 1', 'categories': ['wood', 'floor'], 'download_count': 500},
    'red_brick': {'name': 'Red brick', 'categories': ['brick', 'wall'], 'download_count': 10},
}


def files_for(aid, md5=None):
    return {'Diffuse': {'1k': {'jpg': {'url': f'https://dl.polyhaven.org/{aid}_diff_1k.jpg', 'md5': md5 or hashlib.md5(JPG).hexdigest(), 'size': len(JPG)}}},  # noqa: S324
            'nor_gl': {'1k': {'jpg': {'url': f'https://dl.polyhaven.org/{aid}_nor_gl_1k.jpg', 'md5': hashlib.md5(NOR).hexdigest(), 'size': len(NOR)}}}}  # noqa: S324


class FakeHaven:
    def __init__(self, md5=None, fail=None):
        self.calls = []; self.md5 = md5; self.fail = fail

    def __call__(self, url):
        self.calls.append(url)
        if self.fail: raise OSError(self.fail)
        if url == f'{T.API}/assets?t=textures': return json.dumps(LISTING).encode()
        if url.startswith(f'{T.API}/files/'): return json.dumps(files_for(url.rsplit('/', 1)[1], self.md5)).encode()
        if url.endswith('_diff_1k.jpg'): return JPG
        if url.endswith('_nor_gl_1k.jpg'): return NOR
        raise OSError(f'404 {url}')


class Cc0TexturesTest(unittest.TestCase):
    def setUp(self):
        self.cache = tempfile.mkdtemp(); os.environ.pop('CHE_TEXTURES', None)

    def test_choice_is_deterministic_and_prefers_the_floor_category(self):
        self.assertEqual(T.choose(LISTING, 'wood'), 'oak_floor_1')   # preferred category, then downloads, then id
        self.assertEqual(T.choose(LISTING, 'brick'), 'red_brick')
        self.assertIsNone(T.choose(LISTING, 'metal'))

    def test_fetch_verifies_caches_by_hash_and_records_the_license(self):
        net = FakeHaven()
        rec = T.fetch(['wood'], self.cache, get=net)['wood']
        self.assertEqual(rec['status'], 'ok'); self.assertEqual(rec['asset_id'], 'oak_floor_1')
        self.assertEqual((rec['source'], rec['license']), ('Poly Haven', 'CC0 1.0'))
        self.assertEqual(rec['license_url'], 'https://creativecommons.org/publicdomain/zero/1.0/')
        self.assertEqual(rec['asset_page'], 'https://polyhaven.com/a/oak_floor_1')
        d = rec['maps']['diffuse']
        self.assertEqual(d['sha256'], hashlib.sha256(JPG).hexdigest()); self.assertEqual(d['bytes'], len(JPG))
        self.assertTrue(os.path.isfile(os.path.join(self.cache, d['sha256'] + '.jpg'))); self.assertIn('normal', rec['maps'])
        self.assertFalse(rec['cached'])
        # A second job: the remembered choice and the files by hash; only the small file list is asked again.
        net2 = FakeHaven()
        again = T.fetch(['wood'], self.cache, get=net2)['wood']
        self.assertTrue(again['cached']); self.assertEqual(again['maps']['diffuse']['sha256'], d['sha256'])
        self.assertEqual(net2.calls, [f'{T.API}/files/oak_floor_1'])
        view = T.receipt_view({'wood': again})['wood']
        self.assertNotIn('path', json.dumps(view)); self.assertEqual(view['maps']['diffuse']['sha256'], d['sha256'])

    def test_a_checksum_mismatch_or_no_network_is_recorded_not_raised(self):
        bad = T.fetch(['wood'], self.cache, get=FakeHaven(md5='0' * 32))['wood']
        self.assertEqual(bad['status'], 'unavailable'); self.assertIn('md5 does not match', bad['reason'])
        self.assertFalse([f for f in os.listdir(self.cache) if f.endswith('.jpg')], 'nothing unverified is kept')
        off = T.fetch(['wood', 'brick'], tempfile.mkdtemp(), get=FakeHaven(fail='network is unreachable'))
        self.assertEqual({k: v['status'] for k, v in off.items()}, {'wood': 'unavailable', 'brick': 'unavailable'})
        self.assertIn('network is unreachable', off['wood']['reason'])
        self.assertEqual(T.fetch(['metal'], tempfile.mkdtemp(), get=FakeHaven())['metal']['reason'], 'Poly Haven lists no metal texture')

    def test_switched_off_and_unknown_materials(self):
        os.environ['CHE_TEXTURES'] = '0'
        try:
            net = FakeHaven()
            self.assertEqual(T.fetch(['wood'], self.cache, get=net)['wood']['status'], 'unavailable'); self.assertEqual(net.calls, [])
        finally:
            os.environ.pop('CHE_TEXTURES', None)
        self.assertEqual(T.fetch(['gold'], self.cache, get=FakeHaven()), {})

    def test_the_user_agent_names_che(self):
        self.assertIn('CHE-creation-worker', T.USER_AGENT)


if __name__ == '__main__':
    unittest.main()

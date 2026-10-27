"""scripts/che_gpu_worker.py reference_photo: the person job's reference photo is fetched from CHE's worker route with
the worker's credential, checked against its SHA-256 and handed to the runner as a private file (never printed).

  python3 -m unittest discover -s tools -p 'test_worker_reference.py'
"""
import hashlib
import io
import json
import os
import stat
import sys
import unittest
from contextlib import redirect_stdout

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'scripts'))
import che_gpu_worker as w  # noqa: E402

PHOTO = b'\x89PNG\r\n\x1a\n synthetic test bytes, not a photo of anyone'


class FakeChe:
    worker_id = 'gha-1-1'

    def __init__(self, data):
        self.data, self.asked = data, []

    def fetch(self, route, query=''):
        self.asked.append((route, query)); return self.data


def job(sha=None, kind='person_model'):
    ref = {'url': '/api/gpu/worker/reference?worker=gha-1-1&job=j7', 'sha256': sha or hashlib.sha256(PHOTO).hexdigest(),
           'bytes': len(PHOTO), 'consent': 'self'}
    return {'id': 'j7', 'kind': kind, 'settings': {'REFERENCE': json.dumps(ref)}}


class ReferencePhoto(unittest.TestCase):
    def test_fetched_verified_and_private(self):
        che = FakeChe(PHOTO); out = io.StringIO()
        with redirect_stdout(out): path = w.reference_photo(che, job())
        self.assertEqual(che.asked, [('reference', '?worker=gha-1-1&job=j7')])
        with open(path, 'rb') as f: self.assertEqual(f.read(), PHOTO)
        self.assertEqual(stat.S_IMODE(os.stat(os.path.dirname(path)).st_mode), 0o700)
        self.assertIn('photo fetched and verified', out.getvalue()); self.assertNotIn('worker=', out.getvalue())

    def test_wrong_bytes_are_not_used(self):
        with redirect_stdout(io.StringIO()):
            self.assertIsNone(w.reference_photo(FakeChe(b'other bytes'), job()))
            self.assertIsNone(w.reference_photo(FakeChe(None), job()))

    def test_no_reference_or_not_a_person_job(self):
        self.assertIsNone(w.reference_photo(FakeChe(PHOTO), {'id': 'j1', 'kind': 'person_model', 'settings': {}}))
        self.assertIsNone(w.reference_photo(FakeChe(PHOTO), job(kind='object_model')))
        self.assertIsNone(w.reference_photo(FakeChe(PHOTO), job(sha='not-a-sha')))


if __name__ == '__main__':
    unittest.main()

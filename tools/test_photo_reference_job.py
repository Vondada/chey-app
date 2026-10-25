"""The person job with a reference photo (scripts/che_gpu_face_preview.py, settings REFERENCE), with the stand-in
Blender of test_che_gpu_face_preview.py: consent and SHA-256 checks, refusals, the cached fit applied to the build,
the receipt's reference_fit and device_summary in the shape CHE's Worker reads (gpu_queue.js trimReferenceFit).

  python3 -m unittest discover -s tools -p 'test_photo_reference_job.py' -v

The fit itself runs only when pip mediapipe is installed (flutter-check.yml installs it); the synthetic fixture is a
render of the CC0 MakeHuman base, not a real person.
"""
import hashlib
import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'tools'))
from test_che_gpu_face_preview import FAKE, RUNNER  # noqa: E402

PHOTO = os.path.join(ROOT, 'test', 'fixtures', 'character', 'synthetic_face.png')
# The stand-in Blender also records what the build was handed (FIT, colours, FACE) when FAKE_ENV names a file.
FAKE_ENV = FAKE.replace("if any(x.endswith('mpfb_body.py') for x in a):      # full body: model, rig, animate, export; no views\n",
                        "if any(x.endswith('mpfb_body.py') for x in a):      # full body: model, rig, animate, export; no views\n"
                        "    import json as _j\n"
                        "    if os.environ.get('FAKE_ENV'): open(os.environ['FAKE_ENV'], 'w').write(_j.dumps({k: os.environ.get(k) for k in "
                        "('FIT', 'FIT_W', 'TARGET_SRGB', 'HAIR_SRGB', 'IRIS_SRGB', 'FACE')}))\n")
try:
    import mediapipe  # noqa: F401
    HAVE = True
except ImportError:  # pragma: no cover
    HAVE = False


def sha(path):
    with open(path, 'rb') as f: return hashlib.sha256(f.read()).hexdigest()


class ReferenceJobTest(unittest.TestCase):
    def setUp(self):
        assert 'FAKE_ENV' in FAKE_ENV
        self.tmp = tempfile.mkdtemp()
        self.blender = os.path.join(self.tmp, 'blender')
        with open(self.blender, 'w') as f: f.write(FAKE_ENV)
        os.chmod(self.blender, os.stat(self.blender).st_mode | stat.S_IEXEC)
        self.project = os.path.join(self.tmp, 'project'); os.makedirs(self.project)
        for n in ('che.blend', 'fit.json'):
            with open(os.path.join(self.project, n), 'w') as f: f.write(n)
        self.out = os.path.join(self.tmp, 'out'); self.env_log = os.path.join(self.tmp, 'env.json')

    def run_job(self, settings, *args):
        sp = os.path.join(self.tmp, 'settings.json')
        with open(sp, 'w') as f: json.dump(settings, f)
        e = dict(os.environ, FAKE_ENV=self.env_log)
        p = subprocess.run([sys.executable, RUNNER, '--blender', self.blender, '--project', self.project, '--out', self.out,
                            '--device', 'cpu', '--model', '--settings', sp, *args], env=e, capture_output=True, text=True)
        jobs = sorted(os.listdir(self.out)) if os.path.isdir(self.out) else []
        r = None
        if jobs:
            with open(os.path.join(self.out, jobs[-1], 'receipt.json')) as f: r = json.load(f)
        return p.returncode, p.stdout + p.stderr, r, jobs

    def ref(self, photo=PHOTO, consent='fictional', url='/api/gpu/worker/reference?worker=w1&job=j1', digest=None):
        return json.dumps({'url': url, 'sha256': digest or sha(photo), 'bytes': os.path.getsize(photo), 'consent': consent})

    def test_reference_without_consent_is_refused(self):
        code, out, r, jobs = self.run_job({'REFERENCE': self.ref(consent='someone'), 'REFERENCE_FILE': PHOTO})
        self.assertEqual(code, 2, out); self.assertIn('REFERENCE REFUSED', out); self.assertEqual(jobs, [])

    def test_photo_that_does_not_match_its_sha_is_refused(self):
        code, out, r, _ = self.run_job({'REFERENCE': self.ref(digest='0' * 64), 'REFERENCE_FILE': PHOTO})
        self.assertEqual(code, 2, out)
        self.assertEqual(r['status'], 'reference_mismatch'); self.assertEqual(r['reference_fit']['sha256'], '0' * 64)
        self.assertFalse(os.path.exists(self.env_log), 'nothing was built')

    def test_missing_photo_fails_honestly(self):
        code, out, r, _ = self.run_job({'REFERENCE': self.ref()})
        self.assertEqual(code, 4, out); self.assertEqual(r['status'], 'reference_missing')
        self.assertIn('device_summary', r); self.assertEqual(r['device_summary']['kind'], 'CPU')

    @unittest.skipUnless(HAVE, 'pip mediapipe is needed for the fit itself')
    def test_fit_is_applied_cached_and_reported(self):
        code, out, r, jobs = self.run_job({'REFERENCE': self.ref(), 'REFERENCE_FILE': PHOTO, 'RENDER_PROFILE': 'final'})
        self.assertEqual(code, 0, out)
        f = r['reference_fit']
        self.assertEqual(f['status'], 'ok'); self.assertEqual(f['sha256'], sha(PHOTO)); self.assertFalse(f['cached'])
        # the Worker's contract: colours #rrggbb, landmarks a count, fit_error one number, limits sentences
        self.assertRegex(f['colors']['skin'], r'^#[0-9a-f]{6}$'); self.assertEqual(f['landmarks'], 478)
        self.assertIsInstance(f['fit_error'], float); self.assertTrue(f['limits'] and all(isinstance(x, str) for x in f['limits']))
        self.assertGreaterEqual(sum(1 for v in f['sliders'].values() if abs(v) >= 0.15), 3, f['sliders'])
        with open(self.env_log) as fh: env = json.load(fh)
        self.assertTrue(env['FIT'].endswith(f"reference_fit_{sha(PHOTO)[:16]}.json")); self.assertEqual(env['FIT_W'], '1')
        self.assertEqual(env['FACE'], '')                       # the photo's face replaces CHE's built-in features
        self.assertEqual(env['TARGET_SRGB'], f['colors_srgb']['skin'])
        self.assertIn('reference', r['stage_seconds']); self.assertGreater(r['process_seconds'], 0)
        self.assertEqual(r['device_summary']['kind'], 'CPU'); self.assertIsInstance(r['device_summary']['limits'], list)
        job = os.path.join(self.out, jobs[0])
        self.assertFalse(any(n.endswith(('.png', '.jpg')) and not n.startswith('view_') for n in os.listdir(job)), 'the photo is not kept')
        self.assertNotIn('worker=w1', json.dumps(r))             # the fetch URL never reaches the receipt
        # same photo, a new fetch URL: the same job folder, and the fit is reused
        code, out, r, jobs2 = self.run_job({'REFERENCE': self.ref(url='/api/gpu/worker/reference?worker=w2&job=j9'),
                                            'REFERENCE_FILE': PHOTO, 'RENDER_PROFILE': 'final'})
        self.assertEqual(code, 0, out); self.assertEqual(jobs2, jobs); self.assertIn('SKIP reference fit', out)
        self.assertTrue(r['reference_fit']['cached'])

    @unittest.skipUnless(HAVE, 'pip mediapipe is needed for the fit itself')
    def test_photo_without_a_face_is_refused(self):
        from PIL import Image
        blank = os.path.join(self.tmp, 'blank.png'); Image.new('RGB', (320, 400), (120, 120, 120)).save(blank)
        code, out, r, _ = self.run_job({'REFERENCE': self.ref(photo=blank), 'REFERENCE_FILE': blank})
        self.assertEqual(code, 2, out); self.assertEqual(r['status'], 'reference_refused')
        self.assertIn('no face', r['reference_fit']['refused']); self.assertIn('REFERENCE REFUSED: no face', out)


if __name__ == '__main__':
    unittest.main()

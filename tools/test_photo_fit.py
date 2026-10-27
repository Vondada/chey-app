"""Reference photo fit (tools/avatar_face/photo_fit.py) on SYNTHETIC fixtures only: renders of the CC0 MakeHuman base
with known slider values and colours (tools/fixtures/photo_fit/, test/fixtures/character/synthetic_face.png, made by
tools/avatar_face/make_photo_fixtures.py). No photo of a real person is used anywhere.

  python3 -m unittest discover -s tools -p 'test_photo_fit.py' -v

Needs pip `mediapipe` (Apache-2.0) and the pinned landmark model (downloaded once by photo_fit.model_path into
CHE_FACE_MODEL_DIR or ~/.cache/che-face-model and checked by SHA-256). The measured recovery errors are printed.
"""
import json
import os
import sys
import unittest

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'tools', 'avatar_face'))
import photo_fit as pf  # noqa: E402

FIX = os.path.join(ROOT, 'tools', 'fixtures', 'photo_fit')
ACCEPT = os.path.join(ROOT, 'test', 'fixtures', 'character')
try:
    import mediapipe  # noqa: F401
    from PIL import Image
    HAVE = True
except ImportError:   # pragma: no cover - CI installs it (flutter-check.yml); say so instead of passing silently
    HAVE = False


def truth():
    with open(os.path.join(FIX, 'truth.json')) as f: t = json.load(f)
    with open(os.path.join(ACCEPT, 'synthetic_face.json')) as f: t['synthetic_face'] = json.load(f)
    return t


def path_of(name):
    return os.path.join(ACCEPT if name == 'synthetic_face' else FIX, f'{name}.png')


def rgb(s):
    return np.array([int(x) for x in s.split(',')])


class Fixtures(unittest.TestCase):
    def test_fixtures_are_synthetic_and_small(self):
        for name, t in truth().items():
            self.assertTrue(t['synthetic'], name)
            self.assertIn('not a real person', t['note'])
            self.assertLess(os.path.getsize(path_of(name)), 300_000, name)

    def test_calibration_file_matches_the_fit(self):
        cal = pf.load_calibration()
        self.assertEqual(cal['base'].shape, (468, 2))
        self.assertEqual(set(cal['names']), set(pf.FRONTAL_SLIDERS))
        self.assertTrue(all(abs(g).max() > 0 for g in cal['gains'].values()))
        names = pf.fitted_names(cal)
        # what a frontal photo is calibrated to read: widths and heights only, never a depth slider
        self.assertTrue({'head_w', 'chin_h', 'mouth_up'} <= set(names), names)
        self.assertFalse({'nose_d', 'brow_fwd', 'chin_prog'} & set(names))

    def test_pinned_model_record(self):
        self.assertRegex(pf.MODEL['sha256'], r'^[0-9a-f]{64}$')
        self.assertEqual(pf.MODEL['license'], 'Apache-2.0')
        self.assertTrue(pf.MODEL['url'].startswith('https://storage.googleapis.com/mediapipe-models/face_landmarker/'))


@unittest.skipUnless(HAVE, 'pip mediapipe and pillow are needed (flutter-check.yml installs them)')
class Fit(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.cal = pf.load_calibration()
        cls.res = {}
        for name in ('base', 'wide', 'long', 'narrow_nose', 'synthetic_face'):
            cls.res[name] = pf.fit_image(pf.load_image(path_of(name)), cal=cls.cal)

    def test_base_face_fits_the_average(self):
        r = self.res['base']['reference_fit']
        self.assertTrue(all(abs(x) < 0.05 for x in r['sliders'].values()), r['sliders'])

    def test_known_sliders_are_recovered(self):
        T = truth(); report = {}
        for name in ('wide', 'long', 'narrow_nose', 'synthetic_face'):
            r = self.res[name]['reference_fit']
            err = {k: round(r['sliders'][k] - T[name]['sliders'].get(k, 0.0), 3) for k in r['sliders']}
            mae = float(np.mean([abs(x) for x in err.values()]))
            report[name] = {'mae': round(mae, 3), 'max': max(abs(x) for x in err.values()), 'err': err}
            self.assertLess(mae, 0.2, (name, err))
            self.assertLess(max(abs(x) for x in err.values()), 0.45, (name, err))
            # a clearly set, measured slider comes back with the right sign
            for k, v in T[name]['sliders'].items():
                if k in r['sliders'] and abs(v) >= 0.3 and k in ('head_w', 'chin_h', 'mouth_up', 'lip_lower'):
                    self.assertGreater(r['sliders'][k] * v, 0, (name, k, r['sliders'][k], v))
        print('\nMEASURED slider recovery error (fitted sliders):', json.dumps(report))

    def test_reference_changes_face_shape_not_only_colour(self):
        w = self.res['synthetic_face']['winner']['weights']
        self.assertGreaterEqual(sum(1 for x in w.values() if abs(x) >= 0.15), 3, w)

    def test_colours_are_recovered(self):
        T = truth(); report = {}
        for name in ('base', 'wide', 'long', 'narrow_nose', 'synthetic_face'):
            c = self.res[name]['reference_fit']['colors']
            d = {k: int(np.abs(rgb(c[k]) - rgb(T[name]['colors'][k])).max()) for k in ('skin', 'hair', 'eyes') if k in c}
            report[name] = d
            self.assertLessEqual(d['skin'], 16, (name, c))
            self.assertLessEqual(d.get('hair', 0), 30, (name, c))
            self.assertLessEqual(d.get('eyes', 0), 60, (name, c))
            r, g, b = (pf.lin(rgb(c['skin'])))
            self.assertTrue(r >= g >= b, c['skin'])   # the renderer's skin rule
        print('\nMEASURED colour error (max sRGB channel difference):', json.dumps(report))

    def test_receipt_shape(self):
        r = self.res['synthetic_face']['reference_fit']
        for k in ('method', 'model', 'landmarks', 'sliders', 'colors', 'fit_error', 'limits', 'not_measured'):
            self.assertIn(k, r)
        self.assertEqual(r['landmarks']['count'], 478)
        self.assertIn('approximate', r['limits'])
        self.assertLess(r['fit_error']['landmark_rms_eye_gaps'], 0.05)

    # ── refusals ──────────────────────────────────────────────────────────────────────────────────────────────────
    def refused(self, img):
        with self.assertRaises(pf.Refused) as cm:
            pf.fit_image(img, cal=self.cal)
        return str(cm.exception)

    def test_blank_image_is_refused(self):
        self.assertIn('no face', self.refused(np.full((400, 320, 3), 128, np.uint8)))

    def test_two_faces_are_refused(self):
        a, b = pf.load_image(path_of('base')), pf.load_image(path_of('wide'))
        self.assertIn('2 faces', self.refused(np.concatenate([a, b], axis=1)))

    def test_turned_face_is_refused(self):
        self.assertIn('turned', self.refused(pf.load_image(path_of('turned'))))

    def test_tiny_face_is_refused(self):
        im = Image.fromarray(pf.load_image(path_of('base'))).resize((48, 60))
        canvas = Image.new('RGB', (480, 600), (82, 87, 92)); canvas.paste(im, (200, 250))
        msg = self.refused(np.asarray(canvas))
        self.assertTrue('too small' in msg or 'no face' in msg, msg)

    def test_cli_writes_refusal(self):
        import subprocess, tempfile
        d = tempfile.mkdtemp(); blank = os.path.join(d, 'blank.png'); out = os.path.join(d, 'fit.json')
        Image.new('RGB', (320, 400), (128, 128, 128)).save(blank)
        r = subprocess.run([sys.executable, os.path.join(ROOT, 'tools', 'avatar_face', 'photo_fit.py'), '--image', blank, '--out', out],
                           capture_output=True, text=True)
        self.assertEqual(r.returncode, 3, r.stdout + r.stderr)
        self.assertIn('no face', json.load(open(out))['refused'])


if __name__ == '__main__':
    unittest.main()

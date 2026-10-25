"""Tests for CHE's facial animation layer (tools/avatar_facial): viseme mapping and coarticulation, blinks, saccades,
expression blending, lip-sync timing measurement, and that every face unit is a real MPFB2 target.

  python3 -m unittest discover -s tools -p 'test_avatar_facial.py'
"""
import math
import os
import sys
import unittest

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, 'avatar_facial'))
import expressions as E  # noqa: E402
import face_anim as FA  # noqa: E402

FPS = 30


class VisemeTest(unittest.TestCase):
    CUES = [(0.0, 0.3, 'X'), (0.3, 0.45, 'A'), (0.45, 0.7, 'D'), (0.7, 0.85, 'F'), (0.85, 1.2, 'X')]

    def test_shapes_and_coarticulation(self):
        n = int(1.2 * FPS)
        c = FA.visemes(self.CUES, FPS, n)
        t = lambda s: int(s * FPS)  # noqa: E731
        self.assertGreater(c['mouth_press'][t(0.42)], 0.3)          # M/B/P closes the lips
        self.assertGreater(c['mouth_open'][t(0.66)], 0.4)           # AA opens wide
        self.assertGreater(c['mouth_pucker'][t(0.83)], 0.4)         # OO puckers
        self.assertLess(c['mouth_open'][t(1.15)], 0.05)             # rest closes again
        # several units move at once (not only a jaw open) and no frame jumps by more than one full shape
        moving = [k for k, v in c.items() if v.max() > 0.2]
        self.assertGreaterEqual(len(moving), 3)
        for v in c.values(): self.assertLess(np.abs(np.diff(v)).max(), 0.6)

    def test_lead_moves_shapes_earlier(self):
        n = int(1.2 * FPS)
        late = FA.visemes(self.CUES, FPS, n, lead_s=0.0)['mouth_open']; early = FA.visemes(self.CUES, FPS, n, lead_s=0.1)['mouth_open']
        self.assertLess(int(np.argmax(early > 0.3)), int(np.argmax(late > 0.3)))

    def test_every_viseme_uses_known_units(self):
        known = set(E.UNITS) | {'mouth_open', 'smile', 'brows_up', 'blink_l', 'blink_r'}
        for shape, w in E.VISEMES.items():
            self.assertLessEqual(set(w), known, shape)
        self.assertEqual(set(E.VISEMES), set('ABCDEFGHX'))


class EyesTest(unittest.TestCase):
    def test_blink_rate_and_shape(self):
        n = 60 * FPS
        y, times = FA.blinks(n, FPS, seed=3)
        self.assertTrue(8 <= len(times) <= 30, len(times))   # people blink about 15-20 times a minute at rest
        self.assertAlmostEqual(y.max(), 1.0, places=6); self.assertGreaterEqual(y.min(), 0.0)
        y2, t2 = FA.blinks(n, FPS, seed=3, forced=[30.05])
        self.assertTrue(any(abs(x - 30.05) < 0.6 for x in t2))

    def test_saccades(self):
        n = 20 * FPS
        yaw, pitch, big = FA.gaze(n, FPS, seed=4, targets=[(0.0, (0.0, 0.0)), (10.0, (15.0, -5.0))])
        self.assertLess(abs(np.mean(yaw[:9 * FPS])), 6)
        self.assertGreater(np.mean(yaw[12 * FPS:]), 8)       # the eyes went to the new target
        steps = np.abs(np.diff(yaw))
        self.assertGreater(steps.max(), 1.0)                 # saccades are fast moves, not a slow pan
        keys = FA.look_keys(yaw, pitch)
        for v in keys.values(): self.assertTrue((v >= 0).all() and (v <= 1).all())

    def test_expression_blend_and_pulse(self):
        n = 3 * FPS
        e = FA.expression(n, FPS, [(0.0, {'smile': 0.0}), (1.0, {'smile': 0.6})], blend_s=0.4)
        self.assertAlmostEqual(e['smile'][0], 0.0); self.assertAlmostEqual(e['smile'][-1], 0.6)
        self.assertTrue(0.0 < e['smile'][int(1.2 * FPS)] < 0.6)
        p = FA.pulse(n, FPS, 1.0, 'brows_up', 0.5)['brows_up']
        self.assertAlmostEqual(p.max(), 0.5, places=6); self.assertLess(p[-1], 0.01)
        cmb = FA.combine(e, {'smile': np.full(n, 0.8)})
        self.assertLessEqual(cmb['smile'].max(), 1.0)


class TimingTest(unittest.TestCase):
    def test_lag_detection(self):
        sr, fps = 8000, 100
        t = np.arange(int(2.0 * sr)) / sr
        gate = ((t % 0.4) < 0.2).astype(float)
        x = np.sin(2 * math.pi * 220 * t) * gate
        n = int(2.0 * fps)
        tt = np.arange(n) / fps
        mouth = (((tt - 0.05) % 0.4) < 0.2).astype(float)   # opens 50 ms after the sound
        lag, corr = FA.lip_sync_lag(mouth, x, sr, fps, max_lag_s=0.15)
        self.assertAlmostEqual(lag, 50.0, delta=10.0); self.assertGreater(corr, 0.5)


class UnitsExistTest(unittest.TestCase):
    @unittest.skipUnless(os.path.isdir(os.path.join(os.environ.get('MPFB', ''), 'targets')), 'MPFB data (env MPFB) not available')
    def test_units_are_mpfb_targets(self):
        root = os.path.join(os.environ['MPFB'], 'targets')
        for k, units in E.UNITS.items():
            for u in units: self.assertTrue(os.path.exists(os.path.join(root, u + '.target.gz')), u)


if __name__ == '__main__':
    unittest.main()

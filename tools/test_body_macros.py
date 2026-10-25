"""Body macros (tools/avatar_face/mpfb_base.py: BODY_GENDER, BODY_AGE, BODY_HEIGHT, BODY_WEIGHT, BODY_MUSCLE,
BODY_PROPORTIONS). The blend weights are checked everywhere; the vertex checks need the MPFB2 data (MPFB).

  python3 -m unittest discover -s tools -p 'test_body_macros.py' -v
"""
import os
import sys
import unittest

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'tools', 'avatar_face'))
import mpfb_base as mb  # noqa: E402

HAVE = os.path.isfile(os.path.join(mb.MPFB, '3dobjs', 'base.obj'))


class Blend(unittest.TestCase):
    def test_blend_weights(self):
        self.assertEqual(mb.blend('age', 0.5), {'young': 1.0})
        self.assertEqual(mb.blend('age', 1.0), {'old': 1.0})
        self.assertAlmostEqual(mb.blend('age', 0.75)['old'], 0.5)
        self.assertEqual(mb.blend('height', 0.5), {})                      # the average has no target
        self.assertEqual(mb.blend('height', 0.0), {'minheight': 1.0})
        self.assertAlmostEqual(mb.blend('weight', 0.25)['minweight'], 0.5)
        for kind in mb.BODY_PARTS:
            for x in (0, 0.1, 0.3, 0.5, 0.8, 1):
                self.assertLessEqual(sum(mb.blend(kind, x).values()), 1.0 + 1e-9)

    def test_defaults_are_todays_look(self):
        v = mb.body_values({})
        self.assertEqual(v, {'gender': 0.0, 'age': 0.5, 'muscle': 0.5, 'weight': 0.5, 'height': 0.5, 'proportions': 0.75})
        self.assertEqual(mb.body_values({'MATURE': '0.1', 'SEX': '1'})['age'], 0.55)
        self.assertEqual(mb.body_values({'BODY_PROPORTIONS': '0.5'})['proportions'], 0.75)   # the Create room's 0.5
        self.assertEqual(mb.body_values({'BODY_PROPORTIONS': '1'})['proportions'], 1.0)
        self.assertEqual(mb.body_values({'BODY_PROPORTIONS': '0'})['proportions'], 0.0)
        self.assertFalse(mb.has_body_macros({'SEX': '1', 'BODY_HEIGHT': ''}))
        self.assertTrue(mb.has_body_macros({'BODY_HEIGHT': '0.7'}))


@unittest.skipUnless(HAVE, 'needs the MPFB2 data (set MPFB)')
class Vertices(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.verts = mb.load_base()[0]

    def test_no_body_setting_is_exactly_the_previous_body(self):
        s = {'RACE': 'african=0.7,caucasian=0.3', 'MATURE': '0.1', 'SEX': '0'}
        a = mb.macro_from_settings(self.verts, s)
        b = mb.macro_woman(self.verts, mb.parse_race(s['RACE']), mature=0.1, sex=0.0)
        self.assertTrue(np.array_equal(a, b))

    def test_full_system_at_defaults_is_close_to_the_previous_body(self):
        s = {'RACE': 'african=0.7,caucasian=0.3', 'BODY_HEIGHT': '0.5'}
        d = np.abs(mb.macro_from_settings(self.verts, s) - mb.macro_woman(self.verts, mb.parse_race(s['RACE']))).max() * 0.1
        self.assertLess(d, 0.01, f'{d:.4f} m')   # MakeHuman units are decimetres
        print(f'\nMEASURED largest vertex difference, full macro system at defaults vs before: {d * 1000:.2f} mm')

    def test_height_changes_stature(self):
        h = lambda s: float(np.ptp(mb.macro_from_settings(self.verts, s)[:, 1])) * 0.1
        self.assertLess(h({'BODY_HEIGHT': '0'}) + 0.1, h({'BODY_HEIGHT': '1'}))


if __name__ == '__main__':
    unittest.main()

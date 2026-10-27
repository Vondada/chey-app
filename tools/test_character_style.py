"""tools/avatar_body/character_style.py: the three looks differ in numbers, and the colour maths keeps skin a skin colour.

  python3 -m unittest discover -s tools -p 'test_character_style.py' -v

No Blender needed. tools/test_glb_inspect.py (RealCharacters, with bpy + MPFB2) measures real builds of each look.
"""
import json
import os
import re
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'tools', 'avatar_body'))
import character_style as cs  # noqa: E402



def read(*parts):
    with open(os.path.join(ROOT, *parts)) as f: return f.read()


# The Worker's named skin tones (server/cloudflare/creation_studio.js SKIN_TONES), read from the source.
SRC = read('server', 'cloudflare', 'creation_studio.js')
SKIN = {k.strip(): v for k, v in re.findall(r"'?([a-z ]+)'?: '(#[0-9a-f]{6})'", re.search(r'export const SKIN_TONES = \{([^}]*)\}', SRC).group(1))}


def lin(hexs):
    return [cs.srgb_to_linear(int(hexs[i:i + 2], 16)) for i in (1, 3, 5)]


class Looks(unittest.TestCase):
    def test_three_looks_differ_in_every_dimension(self):
        p, h, s = (cs.STYLE_SPEC[k] for k in cs.STYLES)
        self.assertEqual(p['head_scale'], 1.0)
        self.assertLess(p['head_scale'], h['head_scale']); self.assertLess(h['head_scale'], s['head_scale'])
        for part in ('skin', 'hair'):   # matte as the look gets less realistic
            self.assertLess(p[part]['roughness'], h[part]['roughness'], part)
            self.assertLess(h[part]['roughness'], s[part]['roughness'], part)
        self.assertEqual(max(cs.STYLE_SPEC, key=lambda k: cs.STYLE_SPEC[k]['cloth']['roughness']), 'stylized')
        self.assertGreater(p['skin']['specular'], h['skin']['specular']); self.assertGreater(h['skin']['specular'], s['skin']['specular'])
        self.assertEqual(p['saturation'], 1.0); self.assertLess(p['saturation'], h['saturation']); self.assertLess(h['saturation'], s['saturation'])
        self.assertEqual(p['emission'], 0.0); self.assertLess(h['emission'], s['emission'])
        for key in ('brows', 'hair_cards', 'shading'):
            self.assertEqual(len({x[key] for x in (p, h, s)}), 3, key)
        self.assertEqual(p['face'], ''); self.assertIn('eye-scale-incr', s['face'])
        self.assertIs(cs.spec('nonsense'), cs.STYLE_SPEC['photoreal'])

    def test_hair_cards_go_from_fine_to_chunky(self):
        f, c, k = (cs.HAIR_CARDS[x] for x in ('fine', 'clumps', 'chunks'))
        self.assertGreater(f['count'], c['count']); self.assertGreater(c['count'], k['count'])
        self.assertLess(f['width'], c['width']); self.assertLess(c['width'], k['width'])

    def test_saturation_keeps_every_skin_tone_a_skin_colour(self):
        """Linear-space scaling at 1.3 clipped warm skin's blue channel to 0 (the stylized skin rendered orange); in
        sRGB space at each look's factor, every named tone keeps its luma, its hue and a non-zero blue."""
        self.assertGreater(len(SKIN), 8)
        for name, hexs in SKIN.items():
            base = lin(hexs)
            self.assertEqual(cs.saturate(base, 1.0), base)
            e0 = [cs.linear_to_srgb(c) for c in base]
            for look in ('hybrid', 'stylized'):
                out = cs.saturate(base, cs.STYLE_SPEC[look]['saturation'])
                e = [cs.linear_to_srgb(c) for c in out]
                self.assertGreater(min(e), 0, (name, look, e))
                self.assertLess(abs(cs.luminance(e) - cs.luminance(e0)), 3.0, (name, look, e0, e))
                self.assertGreater(cs.saturation_hsv(e), cs.saturation_hsv(e0) - 1e-9, (name, look))
                self.assertEqual(max(range(3), key=lambda i: e[i]), max(range(3), key=lambda i: e0[i]), 'hue family kept')

    def test_brow_curve_arches_and_tapers(self):
        pts = [cs.brow_curve(t / 20) for t in range(21)]
        ups = [u for _, u, _ in pts]; halves = [h for _, _, h in pts]
        peak = max(range(21), key=lambda i: ups[i])
        self.assertTrue(8 <= peak <= 16, peak)                     # highest past the middle
        self.assertLess(ups[0], ups[peak]); self.assertLess(ups[-1], ups[peak])
        self.assertTrue(all(a >= b for a, b in zip(halves, halves[1:])))   # thick inner end, fine tail
        self.assertLess(pts[0][0], 0); self.assertGreater(pts[-1][0], 1)     # from inside the eye's centre to past its edge
        self.assertGreater(min(ups), 1.3)                                   # always above the eye (radii)

    def test_head_weight(self):
        self.assertEqual(cs.head_weight(0.4), 0.4); self.assertEqual(cs.head_weight(3), 1.0); self.assertEqual(cs.head_weight(-1), 0.0)
        self.assertEqual(cs.head_weight(0.0, helper=True), 1.0)

    def test_render_glb_is_calibrated_and_reads_the_look(self):
        src = read('tools', 'avatar_body', 'render_glb.py')
        self.assertRegex(src, r"VIEW_EXPOSURE = -0\.6"); self.assertIn("VIEW_LOOK = 'AgX - Punchy'", src)
        self.assertIn('upgrade_materials(sc.objects, shading_of(path))', src)
        prof = read('tools', 'avatar_body', 'render_profiles.py')
        self.assertIn("def toon_materials(objects)", prof); self.assertIn("shading == 'toon'", prof)
        for look in cs.STYLES: self.assertIn(cs.STYLE_SPEC[look]['shading'], ('subsurface', 'game', 'toon'))


class DemoSettings(unittest.TestCase):
    def test_demo_builds_every_look_from_one_parsed_base(self):
        spec = json.loads(read('tools', 'demo', 'characters.json'))
        b = spec['base']
        self.assertEqual([spec['jobs'][k]['STYLE'] for k in cs.STYLES], list(cs.STYLES))
        self.assertNotIn('STYLE', b)
        self.assertGreater(float(b['BODY_AGE']), 0.55)          # about 35 years, not the 27-year default
        self.assertNotEqual(b.get('HAIR_STYLE', 'close_crop'), 'close_crop')
        self.assertEqual(b['TARGET_SRGB'], ','.join(str(int(SKIN['brown'][i:i + 2], 16)) for i in (1, 3, 5)))


if __name__ == '__main__':
    unittest.main()

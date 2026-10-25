"""tools/avatar_body/glb_inspect.py: measurements read straight from a GLB (no Blender), on GLBs written by this test.

  python3 -m unittest discover -s tools -p 'test_glb_inspect.py' -v

With bpy and the MPFB2 data present (MPFB set; not on the plain CI runner) it also builds real characters with
tools/avatar_body/mpfb_body.py and checks the controls on the saved files: height, build, every hair style, the t-shirt.
"""
import json
import os
import struct
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'tools', 'avatar_body'))
import glb_inspect as gi  # noqa: E402


def box(cx, cy, cz, sx, sy, sz):
    """The box's front and back faces sampled on a 1 cm grid (a dense surface, like a real body mesh)."""
    n = max(1, int(round(sy / 0.01))); m = max(1, int(round(sx / 0.01)))
    return [(cx - sx / 2 + sx * i / m, cy - sy / 2 + sy * k / n, cz + dz * sz / 2) for k in range(n + 1) for i in range(m + 1) for dz in (-1, 1)]


def write_glb(path, meshes, extras=None):
    """meshes: [(node name, material name, [(x, y, z), ...])]; positions only, one primitive each."""
    binary, js = b'', {'asset': {'version': '2.0'}, 'nodes': [], 'meshes': [], 'accessors': [], 'bufferViews': [], 'materials': []}
    if extras: js['asset']['extras'] = extras
    mats = {}
    for name, mat, pts in meshes:
        if mat not in mats: mats[mat] = len(js['materials']); js['materials'].append({'name': mat})
        data = b''.join(struct.pack('<3f', *p) for p in pts)
        js['bufferViews'].append({'buffer': 0, 'byteOffset': len(binary), 'byteLength': len(data)})
        js['accessors'].append({'bufferView': len(js['bufferViews']) - 1, 'componentType': 5126, 'count': len(pts), 'type': 'VEC3',
                                'min': [min(p[k] for p in pts) for k in range(3)], 'max': [max(p[k] for p in pts) for k in range(3)]})
        binary += data
        js['meshes'].append({'name': name, 'primitives': [{'attributes': {'POSITION': len(js['accessors']) - 1}, 'material': mats[mat]}]})
        js['nodes'].append({'name': name, 'mesh': len(js['meshes']) - 1})
    js['buffers'] = [{'byteLength': len(binary)}]
    j = json.dumps(js).encode(); j += b' ' * (-len(j) % 4); binary += b'\0' * (-len(binary) % 4)
    out = struct.pack('<4sII', b'glTF', 2, 12 + 8 + len(j) + 8 + len(binary)) + struct.pack('<I4s', len(j), b'JSON') + j
    out += struct.pack('<I4s', len(binary), b'BIN\x00') + binary
    with open(path, 'wb') as f: f.write(out)


def person(height=1.7, waist=0.26, hair=True, bun=False):
    """A blocky stand-in character: torso, arms apart, head, optional hair and bun."""
    h = height
    body = box(0, h * 0.62, 0, waist, h * 0.5, 0.18) + box(0.3, h * 0.6, 0, 0.06, h * 0.4, 0.06) + box(-0.3, h * 0.6, 0, 0.06, h * 0.4, 0.06) \
        + box(0, h * 0.93, 0.02, 0.16, h * 0.14, 0.2) + box(0, h * 0.2, 0, 0.3, h * 0.4, 0.14)
    m = [('Body', 'Top', body)]
    if hair: m.append(('Hair', 'Hair', box(0, h * 0.99, 0, 0.17, 0.04, 0.2)))
    if bun: m.append(('HairBun', 'Hair', box(0, h * 1.02, -0.06, 0.06, 0.06, 0.06)))
    m.append(('Shoes', 'Shoes', box(0, 0.03, 0.03, 0.3, 0.06, 0.25)))
    return m


class Inspect(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()

    def glb(self, name, meshes, extras=None):
        p = os.path.join(self.d, name); write_glb(p, meshes, extras); return p

    def test_height_build_hair_clothing(self):
        a = gi.inspect(self.glb('a.glb', person(), extras={'che_character': {'hair_style': 'close_crop'}}))
        self.assertAlmostEqual(a['height_m'], 1.7 * 0.99 + 0.02, places=3)
        self.assertAlmostEqual(a['body']['waist_w'], 0.26, places=3)   # the arms (2 cm+ apart) are not the waist
        self.assertTrue(a['hair']['present']); self.assertEqual(a['hair']['kind'], 'cap'); self.assertEqual(a['hair']['vertices'], len(box(0, 0, 0, 0.17, 0.04, 0.2)))
        self.assertEqual(a['clothing']['garment_materials'], ['Shoes', 'Top'])
        self.assertEqual(a['character'], {'hair_style': 'close_crop'})

    def test_compare_reports_the_change(self):
        a = self.glb('a.glb', person()); b = self.glb('b.glb', person(height=1.9, waist=0.34, bun=True))
        ra, rb = gi.inspect(a), gi.inspect(b)
        d = gi.compare(ra, rb)
        self.assertGreater(d['height_m'], 0.19); self.assertAlmostEqual(d['body.waist_w'], 0.08, places=3)
        self.assertEqual(rb['hair']['kind'], 'bun'); self.assertEqual(d['hair.vertices'], len(box(0, 0, 0, 0.06, 0.06, 0.06)))

    def test_no_hair(self):
        r = gi.inspect(self.glb('bald.glb', person(hair=False)))
        self.assertFalse(r['hair']['present']); self.assertIsNone(r['hair']['kind'])

    def test_cli(self):
        p = self.glb('a.glb', person()); q = self.glb('b.glb', person(height=1.8))
        out = subprocess.run([sys.executable, os.path.join(ROOT, 'tools', 'avatar_body', 'glb_inspect.py'), p, '--compare', q],
                             capture_output=True, text=True).stdout.splitlines()
        self.assertTrue(out[0].startswith('INSPECT ')); self.assertTrue(out[1].startswith('COMPARE '))
        self.assertGreater(json.loads(out[1][8:])['delta']['height_m'], 0.09)

    def test_not_a_glb(self):
        p = os.path.join(self.d, 'x.glb')
        with open(p, 'wb') as f: f.write(b'nope' * 10)
        with self.assertRaises(ValueError): gi.inspect(p)


def have_build():
    try:
        import bpy  # noqa: F401
    except ImportError:
        return False
    return os.path.isfile(os.path.join(os.environ.get('MPFB', ''), '3dobjs', 'base.obj'))


@unittest.skipUnless(have_build(), 'needs the bpy module and MPFB2 data (MPFB): run on a machine with Blender')
class RealCharacters(unittest.TestCase):
    """Builds real GLBs (about 10 s each on 4 CPU cores) and checks each control on the saved file."""

    @classmethod
    def setUpClass(cls):
        cls.d = tempfile.mkdtemp(); cls.reports = {}

    def build(self, name, **env):
        if name in self.reports: return self.reports[name]
        path = os.path.join(self.d, f'{name}.glb')
        e = dict(os.environ, VIEWS='', SUIT_REFINE='0', EXPORT_GLB=path, **env)
        r = subprocess.run([sys.executable, os.path.join(ROOT, 'tools', 'avatar_body', 'mpfb_body.py')], env=e, capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stdout[-2000:] + r.stderr[-2000:])
        v = subprocess.run([sys.executable, os.path.join(ROOT, 'tools', 'avatar_body', 'verify_glb.py'), path, '--no-bpy'], capture_output=True, text=True)
        rig = json.loads(next(l for l in v.stdout.splitlines() if l.startswith('RIG_RECEIPT '))[len('RIG_RECEIPT '):])
        rep = gi.inspect(path); rep['rig_ok'] = rig['ok']; rep['rig_failures'] = rig.get('failures')
        self.reports[name] = rep
        return rep

    def test_height_extremes_and_rig(self):
        lo, mid, hi = self.build('short', BODY_HEIGHT='0'), self.build('default'), self.build('tall', BODY_HEIGHT='1')
        self.assertLess(lo['height_m'] + 0.1, mid['height_m']); self.assertLess(mid['height_m'] + 0.1, hi['height_m'])
        for r in (lo, hi): self.assertTrue(r['rig_ok'], r['rig_failures'])
        print('\nMEASURED height (m): short', lo['height_m'], 'default', mid['height_m'], 'tall', hi['height_m'])

    def test_build_extremes_and_rig(self):
        thin, heavy = self.build('thin', BODY_WEIGHT='0', BODY_MUSCLE='0'), self.build('heavy', BODY_WEIGHT='1', BODY_MUSCLE='1')
        self.assertGreater(heavy['body']['waist_w'], thin['body']['waist_w'] + 0.04)
        for r in (thin, heavy): self.assertTrue(r['rig_ok'], r['rig_failures'])
        print('\nMEASURED waist width (m): thin', thin['body']['waist_w'], 'heavy', heavy['body']['waist_w'])

    def test_every_hair_style_is_in_the_glb(self):
        sys.path.insert(0, os.path.join(ROOT, 'tools', 'avatar_face'))
        import identity
        counts = {}
        for st in identity.HAIR_BUILT:
            r = self.build(f'hair_{st}', HAIR_STYLE=st)
            self.assertTrue(r['hair']['present'], st); self.assertEqual(r['character']['hair_style'], st)
            counts[st] = r['hair']['vertices']
        self.assertIn('HairBun', self.reports['hair_bun_high']['hair']['meshes'])
        self.assertIn('HairLong', self.reports['hair_long_wavy']['hair']['meshes'])
        self.assertGreater(counts['afro'], counts['close_crop'])
        print('\nMEASURED hair vertices:', counts)

    def test_t_shirt_shows_the_forearms(self):
        a, b = self.build('default'), self.build('tshirt', OUTFIT_TOP='t_shirt')
        self.assertEqual(b['character']['outfit_top_built'], 't_shirt')
        self.assertIn('Top', b['clothing']['garment_materials'])


if __name__ == '__main__':
    unittest.main()

"""Tests for Create Object / Create Room param specs (tools/avatar_body/creation_params.py): validation, defaults, the
measured size each build must have, and that CHE's Worker (server/cloudflare/creation_objects.js) uses the same
families, limits and defaults. With the bpy module installed, one object and one room are built for real in Blender
and measured from the exported GLB.

  python3 -m unittest tools/test_creation_params.py
"""
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BODY = os.path.join(ROOT, 'tools', 'avatar_body')
sys.path.insert(0, BODY)
import creation_params as P  # noqa: E402


class ObjectSpecTest(unittest.TestCase):
    def test_defaults_fill_a_minimal_spec(self):
        s = P.validate_object({'family': 'lamp'})
        self.assertEqual(s, {'family': 'lamp', 'size': 1.0, 'color': '#1f6f78', 'roughness': 0.35, 'metallic': 0.0, 'style': 'modern', 'form': 'desk'})
        self.assertNotIn('form', P.validate_object({'family': 'vase'}))

    def test_every_family_style_and_form_validates(self):
        for fam in P.FAMILIES:
            for st in P.STYLES:
                for form in P.FORMS.get(fam, (None,)):
                    spec = {'family': fam, 'style': st, **({'form': form} if form else {})}
                    self.assertEqual(P.validate_object(spec)['style'], st)

    def test_a_family_outside_the_list_is_refused_with_the_list(self):
        with self.assertRaises(P.SpecError) as e: P.validate_object({'family': 'dragon'})
        self.assertIn('lamp, chair, table, mug, vase, shelf', str(e.exception)); self.assertIn('not free-form text-to-3D', str(e.exception))

    def test_numbers_colours_and_choices_are_checked_together(self):
        with self.assertRaises(P.SpecError) as e:
            P.validate_object({'family': 'chair', 'size': 3, 'color': 'red', 'roughness': -1, 'metallic': 'x', 'style': 'baroque', 'form': 'floor', 'glow': 1})
        r = ' | '.join(e.exception.reasons)
        for part in ('size 3 is outside 0.5 to 2', 'color must be a #rrggbb colour', 'roughness -1 is outside 0 to 1', 'metallic must be a number',
                     "style 'baroque' is not one of modern, classic, industrial", 'chair has no forms', 'unknown keys: glow'):
            self.assertIn(part, r)
        with self.assertRaises(P.SpecError): P.validate_object({'family': 'lamp', 'form': 'ceiling'})
        with self.assertRaises(P.SpecError): P.validate_object({'family': 'lamp', 'size': float('nan')})

    def test_expected_bbox_scales_with_size(self):
        (w, h, d), tol = P.expected_bbox('object_model', {'family': 'table', 'form': 'coffee', 'size': 2})
        self.assertEqual((w, h, d), (2.0, 0.84, 1.1)); self.assertEqual(tol, P.OBJECT_TOLERANCE)


class RoomSpecTest(unittest.TestCase):
    def test_defaults_per_type(self):
        s = P.validate_room({'type': 'office'})
        self.assertEqual(s['furniture'], ['desk', 'chair', 'lamp', 'shelf', 'plant', 'mug'])
        self.assertEqual((s['width'], s['depth'], s['height'], s['floor'], s['lighting']), (3.5, 3.5, 2.7, 'concrete', 'cool'))

    def test_limits_furniture_and_types_are_refused_with_reasons(self):
        with self.assertRaises(P.SpecError) as e:
            P.validate_room({'type': 'bedroom', 'width': 12, 'height': 1.5, 'floor': 'marble', 'lighting': 'pink', 'furniture': ['bed', 'piano', 'bed']})
        r = ' | '.join(e.exception.reasons)
        for part in ('width 12 is outside 2.5 to 8', 'height 1.5 is outside 2.3 to 4', "floor 'marble'", "lighting 'pink'", "furniture ['piano'] is not built",
                     'each piece of furniture is listed once'):
            self.assertIn(part, r)
        with self.assertRaises(P.SpecError) as e: P.validate_room({'type': 'kitchen'})
        self.assertIn('living_room, bedroom, office, studio', str(e.exception))
        with self.assertRaises(P.SpecError): P.validate_room({'type': 'studio', 'furniture': list(P.ROOM_ITEMS)})   # 11 > 10

    def test_expected_bbox_includes_the_two_walls(self):
        (w, h, d), tol = P.expected_bbox('room_model', {'type': 'studio', 'width': 5, 'depth': 4, 'height': 3})
        self.assertEqual((w, h, d), (5.1, 3.0, 4.1)); self.assertEqual(tol, P.ROOM_TOLERANCE)

    def test_parse_and_describe(self):
        self.assertEqual(P.parse('{"type": "office"}'), {'type': 'office'})
        for bad in ('', 'not json', '[1]'):
            with self.assertRaises(P.SpecError): P.parse(bad)
        self.assertIn('procedural industrial office 3.5 x 3.5 m', P.describe('room', {'type': 'office'}))
        self.assertEqual(P.hex_rgb('#ffffff'), (1.0, 1.0, 1.0))


@unittest.skipUnless(shutil.which('node'), 'node is needed to read the Worker module')
class WorkerParityTest(unittest.TestCase):
    """The Worker refuses and builds exactly what the Blender builders refuse and build."""

    def test_same_families_limits_and_defaults(self):
        js = ("import('./server/cloudflare/creation_objects.js').then((O) => console.log(JSON.stringify({families: O.FAMILIES, styles: O.STYLES, "
              "forms: O.FORMS, rooms: O.ROOM_TYPES, floors: O.FLOORS, lightings: O.LIGHTINGS, items: O.ROOM_ITEMS, max: O.MAX_ITEMS, size: O.SIZE, "
              "limits: O.ROOM_LIMITS, od: O.OBJECT_DEFAULTS, rd: O.ROOM_DEFAULTS, "
              "spec: O.defaultSpec('room', 'living_room'), obj: O.defaultSpec('object', 'desk')})))")
        out = subprocess.run(['node', '--input-type=module', '-e', js], cwd=ROOT, capture_output=True, text=True, timeout=60)
        self.assertEqual(out.returncode, 0, out.stderr)
        w = json.loads(out.stdout)
        self.assertEqual(w['families'], list(P.FAMILIES)); self.assertEqual(w['styles'], list(P.STYLES))
        self.assertEqual({k: tuple(v) for k, v in w['forms'].items()}, P.FORMS)
        self.assertEqual(w['rooms'], list(P.ROOM_TYPES)); self.assertEqual(w['floors'], list(P.FLOORS))
        self.assertEqual(w['lightings'], list(P.LIGHTINGS)); self.assertEqual(w['items'], list(P.ROOM_ITEMS))
        self.assertEqual(w['max'], P.MAX_ITEMS); self.assertEqual(tuple(w['size']), P.SIZE)
        self.assertEqual({k: tuple(v) for k, v in w['limits'].items()}, P.ROOM_LIMITS)
        self.assertEqual(w['od'], P.OBJECT_DEFAULTS); self.assertEqual(w['rd'], P.ROOM_DEFAULTS)
        # The Worker's starting specs build as they are.
        self.assertEqual(P.validate_room(w['spec'])['furniture'], P.ROOM_DEFAULTS['living_room']['furniture'])
        self.assertEqual(P.validate_object(w['obj'])['form'], 'desk')


@unittest.skipUnless(importlib.util.find_spec('bpy'), 'the bpy module (Blender as a Python module) is not installed')
class RealBlenderTest(unittest.TestCase):
    """A real build with Blender: the exported GLB is re-read and measured against the size the spec asks for."""

    def build(self, script, spec):
        tmp = tempfile.mkdtemp(); path = os.path.join(tmp, 'model.glb')
        out = subprocess.run([sys.executable, os.path.join(BODY, script)], env=dict(os.environ, SPEC_JSON=json.dumps(spec), EXPORT_GLB=path),
                             capture_output=True, text=True, timeout=300)
        self.assertEqual(out.returncode, 0, out.stdout[-2000:] + out.stderr[-2000:])
        self.assertRegex(out.stdout, r'MODEL \S+model\.glb \d+ bytes \d+ vertices')
        import verify_glb
        return out.stdout, verify_glb.verify_static(path, *P.expected_bbox('object' if script == 'objects.py' else 'room', spec))

    def test_a_chair_measures_its_real_size(self):
        _, rec = self.build('objects.py', {'family': 'chair', 'style': 'classic', 'size': 1.5})
        self.assertTrue(rec['ok'], rec['failures'])
        self.assertAlmostEqual(rec['bbox_m']['size'][1], 0.87 * 1.5, places=2)
        self.assertEqual(rec['materials'], ['Chair (classic)']); self.assertGreater(rec['triangles'], 100)

    def test_a_room_measures_its_size_and_lists_its_layout(self):
        out, rec = self.build('rooms.py', {'type': 'office', 'width': 4, 'depth': 3.6})
        self.assertTrue(rec['ok'], rec['failures'])
        self.assertEqual([round(x, 1) for x in rec['bbox_m']['size']], [4.1, 2.7, 3.7])
        layout = json.loads(next(l for l in out.splitlines() if l.startswith('LAYOUT '))[7:])
        self.assertEqual([p['item'] for p in layout['placed']], ['desk', 'chair', 'lamp', 'shelf', 'plant', 'mug'])
        self.assertEqual(layout['skipped'], [])

    def test_a_piece_that_does_not_fit_is_left_out_and_named(self):
        out, rec = self.build('rooms.py', {'type': 'bedroom', 'width': 2.5, 'depth': 2.5, 'furniture': ['bed', 'sofa', 'desk', 'shelf', 'plant']})
        self.assertTrue(rec['ok'], rec['failures'])
        layout = json.loads(next(l for l in out.splitlines() if l.startswith('LAYOUT '))[7:])
        self.assertTrue(layout['skipped'], 'a 2.5 m room cannot hold a bed, sofa, desk, shelf and plant')
        self.assertTrue(all('no free floor space' in s['reason'] for s in layout['skipped']))


class InventionSpec(unittest.TestCase):
    """invention_model: the parts list the Worker's placeholder uses (invention_visuals.js), validated for Blender."""
    PAL = {'name': 'red', 'primary': '#9a1f1f', 'secondary': '#c8a040', 'glow': '#9fe8ff', 'joint': '#2a2d33'}

    def spec(self, **over):
        parts = [{'name': 'helmet', 'subsystem': 'sensors', 'mat': 'primary', 'c': [0, 1.7, 0], 's': [0.24, 0.3, 0.26], 'taper': 0.9},
                 {'name': 'left boot', 'subsystem': 'movement', 'mat': 'secondary', 'c': [0.1, 0.05, 0.02], 's': [0.12, 0.1, 0.28]},
                 {'name': 'right boot', 'subsystem': 'movement', 'mat': 'secondary', 'c': [-0.1, 0.05, 0.02], 's': [0.12, 0.1, 0.28]}]
        return dict({'template': 'powered_suit', 'parts': parts, 'palette': dict(self.PAL)}, **over)

    def test_valid_spec_measures_its_parts(self):
        s = P.validate('invention_model', self.spec())
        self.assertEqual(len(s['parts']), 3); self.assertEqual(s['parts'][1]['taper'], 1)
        size, tol = P.expected_bbox('invention_model', self.spec())
        self.assertEqual(size, (0.32, 1.85, 0.29)); self.assertEqual(tol, P.INVENTION_TOLERANCE)
        self.assertIn('3 bevelled, subdivided parts (movement, sensors)', P.describe('invention_model', self.spec()))

    def test_bad_specs_are_refused_with_reasons(self):
        bad = [self.spec(parts=[]), self.spec(template='Iron Man!'), self.spec(palette={'primary': 'red'}),
               self.spec(parts=[dict(self.spec()['parts'][0], mat='gold')]), self.spec(parts=[dict(self.spec()['parts'][0], s=[0, 1, 1])]),
               self.spec(parts=[self.spec()['parts'][0]] * (P.MAX_PARTS + 1))]
        for b in bad:
            with self.assertRaises(P.SpecError): P.validate('invention_model', b)

    def test_every_worker_template_is_a_valid_blender_spec(self):
        node = shutil.which('node')
        if not node: self.skipTest('node not installed')
        js = ("import { partsFor, paletteFor } from './server/cloudflare/invention_visuals.js';"
              "const out = {}; for (const t of ['powered_suit', 'exoskeleton', 'robot', 'device'])"
              " out[t] = { template: t, parts: partsFor(t), palette: paletteFor(t) };"
              "console.log(JSON.stringify(out));")
        r = subprocess.run([node, '--input-type=module', '-e', js], cwd=ROOT, capture_output=True, text=True, timeout=60)
        self.assertEqual(r.returncode, 0, r.stderr[-400:])
        specs = json.loads(r.stdout.strip().splitlines()[-1])
        for t, spec in specs.items():
            s = P.validate('invention_model', spec)
            self.assertEqual(len(s['parts']), len(spec['parts']), t)
            self.assertLess(len(json.dumps(spec, separators=(',', ':'))), 12000, f'{t}: SPEC must fit the queue setting limit')


if __name__ == '__main__':
    unittest.main()

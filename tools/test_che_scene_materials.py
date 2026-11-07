"""A partial material edit keeps everything it does not name (Codex #967): the window keeps its colour and emission
after a roughness-only edit, and a GLB prop keeps its image textures. The Blender part runs wherever the bpy module is
installed (the scene render job, or locally); the source check below runs everywhere."""
import ast
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
SOURCE = (HERE / "che_scene_render.py").read_text()
ROOT = HERE.parent

try:
    import bpy  # noqa: F401
    HAVE_BPY = True
except Exception:  # noqa: BLE001 - no Blender here
    HAVE_BPY = False


class SourceCheck(unittest.TestCase):
    def test_an_edit_copies_the_material_it_replaces_and_sets_only_named_fields(self):
        tree = ast.parse(SOURCE)
        fn = next(n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef) and n.name == "edited_material")
        body = ast.unparse(fn)
        self.assertIn("original.copy()", body, "starts from the material it replaces")
        for field, socket in (("base_color", "Base Color"), ("roughness", "Roughness"), ("metallic", "Metallic"), ("emission", "Emission Color")):
            self.assertIn(f"if '{field}' in m:", body, f"{socket} changes only when the edit names {field}")
        self.assertNotIn("materials.new(f'{target} edited')\n    mat.use_nodes = True\n    bsdf = mat.node_tree.nodes['Principled BSDF']", body)
        apply = ast.unparse(next(n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef) and n.name == "apply_materials"))
        self.assertIn("edited_material(slot, target, m)", apply)


@unittest.skipUnless(HAVE_BPY, "needs the bpy module (pip install bpy==4.2.0 on Python 3.11)")
class InBlender(unittest.TestCase):
    def setUp(self):
        import importlib
        import bpy
        bpy.ops.wm.read_factory_settings(use_empty=True)
        self.r = importlib.import_module("che_scene_render")
        self.r.TARGETS.clear()
        self.r.ACTOR_IDS.clear()

    def principled(self, mat):
        return next(n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED")

    def test_a_roughness_edit_keeps_the_windows_colour_and_emission(self):
        r = self.r
        window = r.box("window", (3.2, 0.02, 1.5), (0, 0, 1.6), r.material("window", "#0b1630", 0.2, emission="#7fa8ff", strength=1.2))
        r.tag("window", window)
        before = self.principled(window.data.materials[0])
        base = tuple(before.inputs["Base Color"].default_value)
        glow = tuple(before.inputs["Emission Color"].default_value)
        r.apply_materials({"materials": {"window": {"roughness": 0.1}}})
        after = self.principled(window.data.materials[0])
        self.assertAlmostEqual(after.inputs["Roughness"].default_value, 0.1, places=5)
        self.assertEqual(tuple(after.inputs["Base Color"].default_value), base)
        self.assertEqual(tuple(after.inputs["Emission Color"].default_value), glow)
        self.assertAlmostEqual(after.inputs["Emission Strength"].default_value, 1.2, places=5)

    def test_a_glb_prop_keeps_its_textures_unless_the_edit_names_that_field(self):
        import bpy
        r = self.r
        r.place_props({"props": [{"id": "nova-figure", "asset": "assets/characters/crew/nova.glb", "position": [0, 0, 0]}]},
                      r.LIGHTING["warm"], str(ROOT))

        def textured(mat):
            b = self.principled(mat)
            return any(l.from_node.type == "TEX_IMAGE" for l in b.inputs["Base Color"].links)

        mats = {m for o in r.TARGETS["nova-figure"] for m in o.data.materials if m}
        with_tex = [m for m in mats if textured(m)]
        self.assertTrue(with_tex, "the crew GLB carries an image texture to protect")
        r.apply_materials({"materials": {"nova-figure": {"roughness": 0.3}}})
        now = {m for o in r.TARGETS["nova-figure"] for m in o.data.materials if m}
        self.assertTrue(all(m.name.startswith("nova-figure edited") for m in now))
        self.assertEqual(sum(textured(m) for m in now), len(with_tex), "every texture survives a roughness-only edit")
        self.assertTrue(all(abs(self.principled(m).inputs["Roughness"].default_value - 0.3) < 1e-5 for m in now))
        self.assertLessEqual(len(now), len(mats), "one shared copy per original material")
        r.apply_materials({"materials": {"nova-figure": {"base_color": "#ff0000"}}})
        last = {m for o in r.TARGETS["nova-figure"] for m in o.data.materials if m}
        self.assertFalse(any(textured(m) for m in last), "naming base_color replaces the texture with that colour")
        del bpy


if __name__ == "__main__":
    unittest.main()

"""The scene's look as data (Stage 7): lights, props, materials, actor poses and camera keys are read, clamped and
defaulted by che_scene_look.py, and the Blender script draws every field from it. No Blender needed."""
import re
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import che_scene_look as look  # noqa: E402

WARM = {"key": ("#ffd9a8", 380), "lamp": ("#ffc27a", 60), "fill": ("#cfe0ff", 160), "window": ("#7fa8ff", 1.2), "world": ("#1a1f2b", 0.35)}
RENDERER = (Path(__file__).resolve().parent / "che_scene_render.py").read_text()


class Defaults(unittest.TestCase):
    def test_an_old_spec_gets_the_three_point_rig_and_the_office_dressing(self):
        lights = look.lights({}, WARM)
        self.assertEqual([l["id"] for l in lights], ["key", "fill", "rim", "lamp"])
        self.assertTrue(all(l["type"] == "area" and "look_at" in l for l in lights))
        self.assertGreater(lights[0]["power"], lights[1]["power"], "the key is brighter than the fill")
        ids = [p["id"] for p in look.props({})]
        for wanted in ("bookshelf", "whiteboard", "print", "sideboard", "coffee-machine", "filing-cabinet", "rug", "plant"):
            self.assertIn(wanted, ids)
        self.assertEqual(look.materials({}), {})
        self.assertEqual(look.camera_keys({"camera": {"move": "orbit"}}), [])

    def test_an_empty_props_list_means_no_props(self):
        self.assertEqual(look.props({"props": []}), [])

    def test_the_default_props_stand_inside_the_room(self):
        r = look.ROOM
        for p in look.props({}):
            x, y, _ = p["position"]
            self.assertTrue(r["x0"] < x < r["x1"] and r["y0"] < y < r["y1"], p["id"])


class Fields(unittest.TestCase):
    def test_lights_every_field_and_every_type(self):
        spec = {"lights": [
            {"id": "sun", "type": "sun", "position": [0, -3, 3], "rotation": [50, 0, 20], "color": "#ffd2a0", "power": 3},
            {"id": "spot", "type": "spot", "position": [1, -1, 2.9], "look_at": [-0.5, 0.3, 1], "color": "#ff5a8a", "power": 400, "size": 35},
            {"id": "glow", "type": "point", "position": [-2, 2, 2], "color": "#5ab0ff", "power": 150, "size": 0.3},
            {"id": "soft", "type": "area", "position": [0, 0, 3], "size": 2},
        ]}
        sun, spot, glow, soft = look.lights(spec, WARM)
        self.assertEqual((sun["type"], sun["rotation"], sun["power"]), ("sun", [50, 0, 20], 3))
        self.assertNotIn("look_at", sun)
        self.assertEqual((spot["size"], spot["look_at"], spot["color"]), (35, [-0.5, 0.3, 1], "#ff5a8a"))
        self.assertEqual((glow["type"], glow["size"]), ("point", 0.3))
        self.assertEqual((soft["size"], soft["color"]), (2, "#ffffff"))

    def test_lights_are_clamped_and_bounded(self):
        many = [{"type": "laser", "position": [99, -99, "x"], "color": "red", "power": 1e9, "size": -4}] * 20
        out = look.lights({"lights": many}, WARM)
        self.assertEqual(len(out), look.MAX_LIGHTS)
        l = out[0]
        self.assertEqual((l["type"], l["position"], l["color"], l["power"], l["size"]), ("area", [20, -20, 2.8], "#ffffff", 5000, 0.01))
        self.assertEqual(look.lights({"lights": [{"type": "sun", "power": 999}]}, WARM)[0]["power"], 20)

    def test_props_every_field_glb_paths_and_clamps(self):
        spec = {"props": [
            {"id": "crate", "asset": "box", "position": [1.6, -0.8, 0], "rotation": 30, "scale": 0.6, "material": {"base_color": "#c0392b", "roughness": 0.3}},
            {"id": "fern", "asset": "plant", "position": [-1.8, 1.8, 0], "rotation": [0, 0, 45], "scale": [1, 1, 50]},
            {"id": "chair", "asset": "assets/characters/crew/nova.glb", "position": [0, 0, 0]},
            {"id": "evil", "asset": "assets/../../etc/passwd.glb"},
            {"id": "odd", "asset": "teapot"},
            {"id": "crate", "asset": "rug"},
        ]}
        out = look.props(spec)
        self.assertEqual([p["id"] for p in out], ["crate", "fern", "chair", "prop-6"], "unknown assets and path tricks are dropped; ids stay unique")
        crate, fern = out[0], out[1]
        self.assertEqual((crate["rotation"], crate["scale"], crate["material"]), ([0, 0, 30], [0.6, 0.6, 0.6], {"base_color": "#c0392b", "roughness": 0.3}))
        self.assertEqual((fern["rotation"], fern["scale"]), ([0, 0, 45], [1, 1, 10]))
        self.assertEqual(len(look.props({"props": [{"asset": "box"}] * 99})), look.MAX_PROPS)

    def test_materials_every_field_and_clamps(self):
        out = look.materials({"materials": {
            "floor": {"base_color": "#2b2f36", "roughness": 0.2, "metallic": 3},
            "nova": {"emission": "#e2b33c", "emission_strength": 999},
            "Bad Id": {"base_color": "#ffffff"}, "wall": {"base_color": "blue"},
        }})
        self.assertEqual(out, {"floor": {"base_color": "#2b2f36", "roughness": 0.2, "metallic": 1}, "nova": {"emission": "#e2b33c", "emission_strength": 50}})

    def test_actor_position_and_rotation_override_the_start(self):
        self.assertEqual(look.actor_start({"start": [-4.4, 0.4, -90]}), [-4.4, 0.4, -90])
        self.assertEqual(look.actor_start({"start": [-4.4, 0.4, -90], "position": [-2.6, -1.2], "rotation": -60}), [-2.6, -1.2, -60])
        self.assertEqual(look.actor_start({"start": [-4.4, 0.4, -90], "position": [99, 1]}), [20, 1, -90])

    def test_camera_keys_are_sorted_clamped_and_eased(self):
        keys = look.camera_keys({"camera": {"keys": [
            {"t": 6, "position": [-2, -2, 1.4], "look_at": [0, 0, 1], "lens": 500},
            {"t": 0, "position": [2, -4, 1.7], "look_at": [0, 0, 1], "lens": 24},
        ]}})
        self.assertEqual([k["t"] for k in keys], [0, 6])
        self.assertEqual(keys[1]["lens"], 135)
        self.assertEqual(look.camera_at(keys, -1)[0], [2, -4, 1.7], "held before the first key")
        self.assertEqual(look.camera_at(keys, 99)[2], 135, "held after the last key")
        mid = look.camera_at(keys, 3)
        self.assertAlmostEqual(mid[0][0], 0.0)
        self.assertAlmostEqual(mid[2], (24 + 135) / 2)
        early = look.camera_at(keys, 1)[0][0]
        self.assertGreater(early, 2 - 4 * (1 / 6), "eased: it starts slowly")


class Renderer(unittest.TestCase):
    def test_the_blender_script_reads_every_look_field(self):
        for call in ("look_data.lights(", "look_data.props(", "look_data.materials(", "look_data.actor_start(", "look_data.camera_keys(", "look_data.camera_at("):
            self.assertIn(call, RENDERER)
        for field in ("position", "rotation", "look_at", "color", "power", "size", "scale", "material", "base_color", "roughness",
                      "metallic", "emission", "emission_strength", "asset", "type"):
            self.assertTrue(re.search(r'\["' + field + r'"\]', RENDERER), f"che_scene_render.py uses {field}")
        for kind in look.PROP_KINDS:
            self.assertTrue(re.search(rf"^def prop_{kind}\(", RENDERER, re.M), f"a builder for {kind}")
        for kind, blender in (("area", "AREA"), ("sun", "SUN"), ("point", "POINT"), ("spot", "SPOT")):
            self.assertIn(f'"{kind}": "{blender}"', RENDERER)
        for target in look.SET_TARGETS:
            self.assertTrue(re.search(r'tag\("' + target + r'"', RENDERER), f"material target {target} is tagged")

    def test_the_room_is_closed_and_the_camera_stays_inside_it(self):
        for wall in ("back wall", "side wall front", "side wall back", "right wall", "front wall", "corridor far wall"):
            self.assertIn(f'"{wall}"', RENDERER)
        self.assertIn("loc = inside_room(loc)", RENDERER)
        self.assertTrue(re.search(r'view_transform = transform', RENDERER), "AgX or Filmic colour management")


if __name__ == "__main__":
    unittest.main()

"""Previews of a Create Object or Create Room model, rendered from the exported GLB itself (what CHE delivers).

  python3 render_creation.py MODEL.glb   env: CREATION_KIND (object | room), SPEC_JSON (for the room's light colour),
                                         OUT_DIR, VIEWS ("0,45,90"), SAMPLES, TEST_RES, CYCLES_DEVICE, CPU_THREADS

Imports the GLB with Blender's glTF importer, adds light and a camera framed on the measured bounding box, and renders
in Cycles on the device render_device.py reports (DEVICE line). An object turns on a dark studio floor under a soft
three-point light (view = degrees around it). A room is seen from its open sides only (0 front, 45 the front-right
corner, 90 the right side), lit by a ceiling area light, the window and one point lamp at each bulb, all in the room's
warm, neutral or cool colour. Each view prints WROTE <OUT_DIR>/creation_<deg>.png.
"""
import json
import math
import os
import sys

import bpy
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE); sys.path.insert(0, os.path.join(HERE, '..', 'avatar_face'))
import objects as O  # noqa: E402
from render_device import setup as render_setup  # noqa: E402
import render_profiles  # noqa: E402

LIGHT = {'warm': (1.0, 0.78, 0.55), 'neutral': (1.0, 0.95, 0.88), 'cool': (0.8, 0.9, 1.0)}


def load(path):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    bpy.ops.import_scene.gltf(filepath=path)
    meshes = [o for o in sc.objects if o.type == 'MESH']
    lo, hi = Vector((1e9, 1e9, 1e9)), Vector((-1e9, -1e9, -1e9))
    for o in meshes:
        for c in o.bound_box:
            w = o.matrix_world @ Vector(c)
            lo = Vector(map(min, lo, w)); hi = Vector(map(max, hi, w))
    return sc, meshes, lo, hi


def object_stage(sc, lo, hi):
    size = hi - lo; centre = (lo + hi) / 2; r = max(size.length / 2, 0.05)
    floor = O.mat('Studio floor', (0.06, 0.065, 0.07), 0.6)
    O.prim('plane', floor, (centre.x, centre.y, lo.z), size=r * 12)
    O.light(sc, 'AREA', (centre.x + 2.2 * r, centre.y - 2.6 * r, lo.z + 2.8 * r), 120 * r * r, 2.2 * r, (1, 0.97, 0.94), target=centre)
    O.light(sc, 'AREA', (centre.x - 2.8 * r, centre.y - 1.6 * r, lo.z + 1.6 * r), 45 * r * r, 2.6 * r, (0.75, 0.85, 1.0), target=centre)
    O.light(sc, 'AREA', (centre.x - 0.8 * r, centre.y + 2.6 * r, lo.z + 2.4 * r), 70 * r * r, 1.4 * r, (0.6, 0.95, 0.9), target=centre)
    O.world(sc, (0.02, 0.022, 0.026), 1.0)
    cam = O.camera(sc, (0, 0, 0), centre, 50)
    dist = r / math.sin(cam.data.angle / 2) * 1.1

    def place(deg):
        a = math.radians(deg); e = math.radians(18)
        cam.location = Vector((centre.x + math.sin(a) * dist * math.cos(e), centre.y - math.cos(a) * dist * math.cos(e), centre.z + dist * math.sin(e)))
    return place, (800, 800)


def room_stage(sc, lo, hi, spec, meshes):
    colour = LIGHT.get(spec.get('lighting'), LIGHT['neutral'])
    W, D, H = hi.x - lo.x, hi.y - lo.y, hi.z - lo.z; c = (lo + hi) / 2
    O.light(sc, 'AREA', (c.x, c.y, lo.z + H - 0.05), 90 * W * D / 16 * 2, min(W, D) * 0.6, colour, target=(c.x, c.y, lo.z))
    for o in meshes:   # one lamp at each glowing bulb, in the room's light colour
        if any(s.material and s.material.name.startswith('Bulb') for s in o.material_slots):
            p = o.matrix_world.translation
            O.light(sc, 'POINT', (p.x, p.y, p.z), 35, 0.05, colour)
        if any(s.material and s.material.name.startswith('Window light') for s in o.material_slots):
            p = o.matrix_world @ Vector([(a + b) / 2 for a, b in zip(o.bound_box[0], o.bound_box[6])])
            O.light(sc, 'AREA', (p.x, p.y - 0.15, p.z), 180, 1.2, (0.9, 0.94, 1.0) if spec.get('lighting') != 'warm' else (1.0, 0.88, 0.72),
                    target=(p.x, c.y - D / 2, lo.z))
    O.world(sc, (0.04, 0.045, 0.05), 1.0)
    target = Vector((c.x - 0.1 * W, c.y + 0.05 * D, lo.z + 0.9))
    cam = O.camera(sc, (0, 0, 0), target, 18)
    eye = lo.z + min(1.75, H * 0.62)

    def place(deg):
        # Only the open sides: from the front (0), the front-right corner (45), the right side (90).
        a = math.radians(max(0, min(90, deg)))
        reach = 0.55 * max(W, D) + 1.4
        cam.location = Vector((c.x + math.sin(a) * reach + 0.25 * W * math.cos(a), c.y - math.cos(a) * reach - 0.0, eye))
    return place, (960, 720)


def render(path):
    kind = os.environ.get('CREATION_KIND', 'object')
    spec = json.loads(os.environ.get('SPEC_JSON') or '{}')
    sc, meshes, lo, hi = load(path)
    place, size = room_stage(sc, lo, hi, spec, meshes) if kind == 'room' else object_stage(sc, lo, hi)
    render_setup(sc, size)
    # RENDER_PROFILE (render_profiles.py; legacy when unset, which is this renderer's old setting exactly). The final
    # profile's material upgrades are for people (skin, cloth, hair); objects and inventions keep their own PBR materials.
    render_profiles.apply(sc, render_profiles.profile_name(), int(os.environ.get('SAMPLES', '32')),
                          os.environ.get('CYCLES_DEVICE', 'CPU').upper() != 'CPU')
    if os.environ.get('CPU_THREADS'):
        sc.render.threads_mode = 'FIXED'; sc.render.threads = int(os.environ['CPU_THREADS'])
    sc.view_settings.view_transform = 'AgX'; sc.view_settings.look = 'AgX - Medium High Contrast'
    out = os.environ.get('OUT_DIR', '.'); os.makedirs(out, exist_ok=True)
    for deg in [int(d) for d in os.environ.get('VIEWS', '0').split(',') if d.strip()]:
        place(deg)
        p = os.path.join(out, f'creation_{deg:02d}.png'); sc.render.filepath = p
        bpy.ops.render.render(write_still=True)
        print('WROTE', p, flush=True)


if __name__ == '__main__':
    render(os.path.abspath(sys.argv[-1]))

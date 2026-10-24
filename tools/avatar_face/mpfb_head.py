"""Face rebuild, stage 1 (primary forms): CHE's head on the MPFB2 / MakeHuman base mesh (CC0), shown in clay under
neutral studio light so only the shapes are judged.

  python3 mpfb_head.py            env: MPFB (the mpfb data dir), OUT_DIR, SAVE (optional .blend), SAMPLES (24),
                                  FACE ("nose/nose-flaring-incr=0.4,lr:cheek/cheek-bones-incr=0.3"; "lr:" applies the
                                  l- and r- versions of a target), RACE ("african=1"), VIEWS ("0,30,90"),
                                  FIT (face_fit.py json: its winning identity sliders are applied first)

The macro targets build a young adult woman (female, young, average muscle and weight, ideal proportions); FACE sliders
then move her toward CHE's identity. Targets are MakeHuman's own offset files: one "index dx dy dz" line per moved
vertex, in decimetres, Y up, facing +Z. Nothing is downloaded or paid for.
"""
import json
import math
import os
import sys

import bpy
import numpy as np
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mpfb_base import load_base, macro_woman, slider_deltas, apply_sliders, to_blender, target  # noqa: E402

OUT = os.environ.get('OUT_DIR', '.')
verts, uvs, faces, groups = load_base()
race = {k: float(w) for k, w in (kv.split('=') for kv in os.environ.get('RACE', 'african=1').split(','))}
# FIT: face_fit.py's json; its winning youth blend and identity sliders are applied.
win = json.load(open(os.environ['FIT']))['winner'] if os.environ.get('FIT') else {}
weights = win.get('weights', {})
v = macro_woman(verts, race, youth=win.get('youth', 0.0))
v = apply_sliders(v, slider_deltas(len(v)), weights)
applied = [f'{k}={w}' for k, w in weights.items()]
for item in [s for s in os.environ.get('FACE', '').split(',') if s.strip()]:
    name, w = item.split('='); v += target(name.strip(), len(v)) * float(w); applied.append(item)
verts = v

# MakeHuman decimetres, Y up, facing +Z  ->  metres, Z up, facing -Y
co = [Vector(p) for p in to_blender(verts)]

# ── Skin mesh: the body group only, with its UVs ──────────────────────────────────────────────────────────────────
body_faces = [(vi, ti) for g, vi, ti in faces if g == 'body']
used = sorted({i for vi, _ in body_faces for i in vi})
remap = {old: new for new, old in enumerate(used)}
me = bpy.data.meshes.new('CHE_head')
me.from_pydata([co[i] for i in used], [], [[remap[i] for i in vi] for vi, _ in body_faces])
uvl = me.uv_layers.new(name='UVMap')
k = 0
for (vi, ti) in body_faces:
    for t in ti:
        uvl.data[k].uv = uvs[t]; k += 1
for p in me.polygons: p.use_smooth = True
for o in list(bpy.data.objects): bpy.data.objects.remove(o)
sc = bpy.context.scene
body = bpy.data.objects.new('Body', me); sc.collection.objects.link(body)
sub = body.modifiers.new('Subd', 'SUBSURF'); sub.levels = 1; sub.render_levels = 2


def centre(gname):
    pts = [co[i] for i in groups[gname]]
    c = sum(pts, Vector()) / len(pts)
    return c, max((p - c).length for p in pts)


# Eyes: plain spheres where MakeHuman's eye helpers sit (real eye shading comes at the eyes stage).
eye_mat = bpy.data.materials.new('EyeClay'); eye_mat.use_nodes = True
eb = eye_mat.node_tree.nodes['Principled BSDF']; eb.inputs['Base Color'].default_value = (0.8, 0.8, 0.8, 1); eb.inputs['Roughness'].default_value = 0.15
eyes = []
for gname in ('helper-l-eye', 'helper-r-eye'):
    c, r = centre(gname)
    bpy.ops.mesh.primitive_uv_sphere_add(segments=32, ring_count=16, radius=r * 0.97, location=c)
    e = bpy.context.active_object; e.name = gname.replace('helper-', 'Eye_'); e.data.materials.append(eye_mat)
    for p in e.data.polygons: p.use_smooth = True
    eyes.append(c)
eye_mid = (eyes[0] + eyes[1]) / 2

# Clay: one warm mid-grey, slightly rough, so the forms read and nothing hides in colour.
clay = bpy.data.materials.new('Clay'); clay.use_nodes = True
cb = clay.node_tree.nodes['Principled BSDF']
cb.inputs['Base Color'].default_value = (0.3, 0.26, 0.23, 1); cb.inputs['Roughness'].default_value = 0.55
body.data.materials.append(clay)

# ── Neutral studio light and camera ────────────────────────────────────────────────────────────────────────────────
fwd = Vector((0, -1, 0)); up = Vector((0, 0, 1)); right = Vector((1, 0, 0))
tgt = bpy.data.objects.new('HeadTarget', None); sc.collection.objects.link(tgt); tgt.location = eye_mid - up * 0.035


def area(name, pos, size, energy):
    l = bpy.data.objects.new(name, bpy.data.lights.new(name, 'AREA')); sc.collection.objects.link(l)
    l.data.size = size; l.data.energy = energy; l.location = pos
    c = l.constraints.new('TRACK_TO'); c.target = tgt; c.track_axis = 'TRACK_NEGATIVE_Z'; c.up_axis = 'UP_Y'


area('Key', eye_mid + fwd * 1.2 + right * 0.8 + up * 0.6, 1.2, 60)
area('Fill', eye_mid + fwd * 1.2 - right * 0.9 + up * 0.1, 1.5, 28)
area('Rim', eye_mid - fwd * 1.0 + right * 0.3 + up * 0.7, 0.6, 25)
w = sc.world or bpy.data.worlds.new('W'); sc.world = w; w.use_nodes = True
w.node_tree.nodes['Background'].inputs['Color'].default_value = (0.18, 0.18, 0.19, 1)
w.node_tree.nodes['Background'].inputs['Strength'].default_value = 0.6
cam = bpy.data.objects.new('Cam', bpy.data.cameras.new('Cam')); sc.collection.objects.link(cam); sc.camera = cam
cam.data.lens = 85
tr = cam.constraints.new('TRACK_TO'); tr.target = tgt; tr.track_axis = 'TRACK_NEGATIVE_Z'; tr.up_axis = 'UP_Y'
sc.render.engine = 'CYCLES'; sc.cycles.device = 'CPU'; sc.cycles.samples = int(os.environ.get('SAMPLES', '24'))
sc.cycles.use_denoising = True
sc.render.resolution_x, sc.render.resolution_y = 360, 450
sc.view_settings.view_transform = 'AgX'; sc.view_settings.look = 'None'

print('HEAD verts', len(me.vertices), 'eye gap mm', round((eyes[0] - eyes[1]).length * 1000, 1), 'face sliders', applied, flush=True)
if os.environ.get('SAVE'):
    bpy.ops.wm.save_as_mainfile(filepath=os.environ['SAVE'])
for deg in [int(d) for d in os.environ.get('VIEWS', '0,30,90').split(',')]:
    a = math.radians(deg)
    cam.location = tgt.location + (fwd * math.cos(a) + right * math.sin(a)) * 0.75 + up * 0.02
    sc.render.filepath = os.path.join(OUT, f'mpfb_{deg:02d}.png')
    bpy.ops.render.render(write_still=True)
    print('WROTE', sc.render.filepath, flush=True)

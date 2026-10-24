"""CHE's current (Route-B) head in the same clay and neutral studio light as mpfb_head.py, front and side, plus the
landmark measurements the MPFB2 rebuild is fitted to (all as ratios of the distance between the eye centres).

  python3 che_clay.py CHE.blend OUT_DIR
"""
import math
import os
import sys

import bpy

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mathutils import Vector

src, out = sys.argv[-2], sys.argv[-1]
bpy.ops.wm.open_mainfile(filepath=src)
sc = bpy.context.scene
rig = bpy.data.objects['Rig']
if rig.animation_data: rig.animation_data.action = None
for pb in rig.pose.bones: pb.matrix_basis.identity()
bpy.context.view_layer.update()


def eye(name):
    ob = bpy.data.objects[name]; dg = bpy.context.evaluated_depsgraph_get(); ev = ob.evaluated_get(dg); me = ev.to_mesh()
    pts = [ob.matrix_world @ v.co for v in me.vertices]; ev.to_mesh_clear()
    return sum(pts, Vector()) / len(pts)


el, er = eye('Eye_l'), eye('Eye_r')
eye_mid = (el + er) / 2
right = (er - el).normalized() if (er - el).x > 0 else (el - er).normalized()
up = Vector((0, 0, 1))
fwd = up.cross(right)
body = bpy.data.objects['Body']
dg = bpy.context.evaluated_depsgraph_get(); ev = body.evaluated_get(dg); me = ev.to_mesh()
pts = [body.matrix_world @ v.co for v in me.vertices]; ev.to_mesh_clear()
# Out of the face: from the head joint toward the eyes (the head's centroid is behind the eyes, so a centroid test flips it).
if (eye_mid - rig.matrix_world @ rig.pose.bones['head'].head).dot(fwd) < 0: fwd = -fwd
right = fwd.cross(up).normalized()
gap = (el - er).length
# Export the head in the face frame (x right, y up, z out of the face, metres) with the lip movers, for face_fit.py.
import numpy as np
keys = body.data.shape_keys
lipmask = np.zeros(len(pts), bool)
if keys and 'mouth_open' in keys.key_blocks and len(keys.key_blocks[0].data) == len(pts):
    kb = keys.key_blocks
    d = np.array([(kb['mouth_open'].data[i].co - kb[0].data[i].co).length for i in range(len(pts))])
    lipmask = d > np.quantile(d, 0.995) * 0.6
P = np.array([[(p - eye_mid).dot(right), (p - eye_mid).dot(up), (p - eye_mid).dot(fwd)] for p in pts])
np.savez(os.path.join(out, 'che_landmarks.npz'), P=P, gap=gap, lips=lipmask)
from landmarks import measure
print('LANDMARKS', measure(P, gap, lipmask), flush=True)

clay = bpy.data.materials.new('Clay'); clay.use_nodes = True
cb = clay.node_tree.nodes['Principled BSDF']; cb.inputs['Base Color'].default_value = (0.3, 0.26, 0.23, 1); cb.inputs['Roughness'].default_value = 0.55
for o in sc.objects:
    if o.type == 'MESH' and o.name not in ('Eye_l', 'Eye_r'):
        o.data.materials.clear(); o.data.materials.append(clay)
    if o.type in ('CURVES', 'LIGHT') or o.name in ('Hair', 'Lashes') or (o.type == 'MESH' and o.name not in ('Body', 'Eye_l', 'Eye_r')):
        o.hide_render = True
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
sc.render.engine = 'CYCLES'; sc.cycles.device = 'CPU'; sc.cycles.samples = int(os.environ.get('SAMPLES', '16')); sc.cycles.use_denoising = True
sc.render.resolution_x, sc.render.resolution_y = 360, 450
sc.view_settings.view_transform = 'AgX'; sc.view_settings.look = 'None'
for deg in (0, 90):
    a = math.radians(deg)
    cam.location = tgt.location + (fwd * math.cos(a) + right * math.sin(a)) * 0.75 + up * 0.02
    sc.render.filepath = os.path.join(out, f'che_{deg:02d}.png')
    bpy.ops.render.render(write_still=True)
    print('WROTE', sc.render.filepath, flush=True)

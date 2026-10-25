"""The cinematic set: CHE's office from the Create Room builders (tools/avatar_body/rooms.py shell and objects.py
furniture), warm practical lighting with a cool window fill and Blender's bundled CC0 interior HDRI, a handheld
camera with depth of field, and the skeleton overlay (bone geometry that follows the real armature).

Lighting is a film setup, not a studio box: a 2700 K desk-lamp practical keys the face from the side, the window adds
cool fill and rim, the HDRI (datafiles/studiolights/world/interior.exr, CC0, Poly Haven 'hotel_room' at 1K, shipped
with Blender) gives soft ambient bounce. Nothing is downloaded.
"""
import math
import os
import sys

import bpy
import numpy as np
from mathutils import Euler, Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), 'avatar_body'))



def kelvin_rgb(k):
    """Approximate linear RGB of a black body (Tanner Helland's fit), normalised to max 1."""
    t = k / 100.0
    r = 255 if t <= 66 else 329.698727446 * ((t - 60) ** -0.1332047592)
    g = 99.4708025861 * math.log(t) - 161.1195681661 if t <= 66 else 288.1221695283 * ((t - 60) ** -0.0755148492)
    b = 255 if t >= 66 else (0 if t <= 19 else 138.5177312231 * math.log(t - 10) - 305.0447927307)
    c = [max(0.0, min(255.0, x)) / 255.0 for x in (r, g, b)]
    c = [x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c]
    m = max(c)
    return tuple(x / m for x in c)


def hdri_path():
    import bpy as _b
    for base in (os.path.dirname(_b.__file__),):
        for root, dirs, files in os.walk(base):
            if root.endswith(os.path.join('studiolights', 'world')) and 'interior.exr' in files:
                return os.path.join(root, 'interior.exr')
    return None


def office(seat=(0.0, 1.25), desk_side=-1.0, seat_top=0.5, desk_off=1.3):
    """Builds the office around the seat (x, y) where CHE sits facing -Y: a backless upholstered stool (the mocap
    actor walks around behind the seat before sitting, so a chair back would be walked through), a desk beside her
    with a lamp, monitor and mug, a shelf, a plant, a rug, and walls on three sides. Returns {name: object}."""
    import objects as O
    import rooms
    from creation_params import validate_room
    spec = validate_room({'type': 'office', 'width': 5.2, 'depth': 4.6, 'height': 2.8, 'wall_color': '#a9a297', 'floor': 'oak',
                          'lighting': 'warm', 'style': 'modern', 'furniture': []})
    rooms.shell(spec)
    W, D, Hh = spec['width'], spec['depth'], spec['height']
    wall = bpy.data.materials.get('Walls')
    rooms.boxes('room_wall_right', wall, [((W / 2 + 0.06, 0, Hh / 2), (0.12, D, Hh))])
    glow = bpy.data.materials.get('Window light')
    if glow:
        p = next(n for n in glow.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'); p.inputs['Emission Strength'].default_value = 1.6
    sx, sy = seat
    props = {}
    fabric = O.mat('Stool fabric', (0.16, 0.12, 0.09), 0.85)
    base = O.fixed('Dark metal')
    cushion = O.lathe(fabric, [(0.0, seat_top - 0.09), (0.2, seat_top - 0.09), (0.215, seat_top - 0.05), (0.205, seat_top - 0.01),
                               (0.17, seat_top), (0.0, seat_top)], 48, loc=(sx, sy, 0), name='stool_cushion')
    stem = O.rod(base, (sx, sy, 0.02), (sx, sy, seat_top - 0.09), 0.025, 'stool_stem')
    foot = O.lathe(base, [(0.0, 0.0), (0.22, 0.0), (0.22, 0.02), (0.0, 0.03)], 48, loc=(sx, sy, 0), name='stool_base')
    props['stool'] = [cushion, stem, foot]
    dx = sx + desk_side * desk_off
    props['desk'] = O.build_object({'family': 'table', 'form': 'desk', 'style': 'modern'}, at=(dx, sy - 0.1, 0), rot=math.radians(90), name='desk')
    props['lamp'] = O.build_object({'family': 'lamp', 'form': 'desk', 'style': 'modern'}, at=(dx - 0.05 * desk_side, sy + 0.3, 0.75),
                                   rot=math.radians(200 if desk_side > 0 else 160), name='lamp')
    props['mug'] = O.build_object({'family': 'mug', 'style': 'modern'}, at=(dx + 0.12 * desk_side, sy - 0.4, 0.75), rot=0.3, name='mug')
    props['shelf'] = O.build_object({'family': 'shelf', 'style': 'modern'}, at=(-1.0, D / 2 - 0.2, 0), rot=0.0, name='shelf')
    rooms.plant('modern', (W / 2 - 0.4, D / 2 - 0.5, 0), 0.4)
    rooms.rug('modern', (sx + 0.2, sy - 0.6, 0), (2.6, 2.0))
    scr = O.mat('Screen', (0.02, 0.02, 0.025), 0.15, emit=(0.55, 0.7, 1.0), strength=0.8)
    body = O.mat('Monitor', (0.03, 0.03, 0.035), 0.4)
    mon = O.box(body, (0, 0, 0), (0.56, 0.03, 0.34), bevel=0.006, name='monitor')
    face = O.box(scr, (0, -0.016, 0), (0.53, 0.004, 0.31), name='monitor_screen')
    stand = O.box(body, (0, 0.05, -0.2), (0.06, 0.05, 0.2), name='monitor_stand')
    root = bpy.data.objects.new('monitor_root', None); bpy.context.scene.collection.objects.link(root)
    for o in (mon, face, stand): o.parent = root
    root.location = (dx - 0.1 * desk_side, sy + 0.05, 0.75 + 0.32); root.rotation_euler = (0, 0, math.radians(60 * desk_side))
    props['monitor'] = root
    return props


def lights(seat=(0.0, 1.25), desk_side=-1.0, hdri_strength=0.3, desk_off=1.3):
    sc = bpy.context.scene
    sx, sy = seat
    w = bpy.data.worlds.new('Interior'); sc.world = w; w.use_nodes = True
    nt = w.node_tree; bg = nt.nodes['Background']
    p = hdri_path()
    if p:
        env = nt.nodes.new('ShaderNodeTexEnvironment'); env.image = bpy.data.images.load(p)
        mp = nt.nodes.new('ShaderNodeMapping'); mp.inputs['Rotation'].default_value = (0, 0, math.radians(120))
        tc = nt.nodes.new('ShaderNodeTexCoord'); nt.links.new(tc.outputs['Generated'], mp.inputs['Vector']); nt.links.new(mp.outputs['Vector'], env.inputs['Vector'])
        nt.links.new(env.outputs['Color'], bg.inputs['Color'])
    bg.inputs['Strength'].default_value = hdri_strength
    made = {}

    def area(name, loc, size, energy, kelvin, size_y=None, shape='RECTANGLE', target=None, rot=None):
        L = bpy.data.lights.new(name, 'AREA'); L.shape = shape; L.size = size; L.size_y = size_y or size
        L.energy = energy; L.color = kelvin_rgb(kelvin)
        o = bpy.data.objects.new(name, L); sc.collection.objects.link(o); o.location = loc
        if target is not None: o.rotation_euler = (Vector(target) - o.location).to_track_quat('-Z', 'Y').to_euler()
        elif rot is not None: o.rotation_euler = rot
        made[name] = o; return o

    def point(name, loc, energy, kelvin, radius=0.03):
        L = bpy.data.lights.new(name, 'POINT'); L.energy = energy; L.color = kelvin_rgb(kelvin); L.shadow_soft_size = radius
        o = bpy.data.objects.new(name, L); sc.collection.objects.link(o); o.location = loc; made[name] = o; return o
    dx = sx + desk_side * desk_off
    face = (sx, sy, 1.12)
    # practical: the desk lamp's bulb, plus a soft key from the lamp's side that reads as its light on her face
    point('LampBulb', (dx - 0.02 * desk_side, sy + 0.18, 1.2), 14, 2700, 0.02)
    area('PracticalKey', (sx + desk_side * 0.85, sy - 0.75, 1.5), 0.5, 60, 3300, target=face)
    # window (back wall): cool daylight as fill from behind-left, and a rim on hair and shoulders
    area('WindowFill', (0.6, 2.15, 1.6), 1.4, 160, 6500, 1.2, rot=(math.radians(90), 0, math.radians(180)))
    area('Rim', (sx - desk_side * 0.7, sy + 1.0, 2.0), 0.6, 50, 5600, target=face)
    # a soft frontal fill so the shadow side of the face is not black (bounce from the room)
    area('Bounce', (sx - desk_side * 0.6, sy - 2.2, 1.2), 1.5, 25, 4200, target=face)
    area('Ceiling', (0.2, 0.3, 2.75), 1.2, 70, 3800, shape='DISK', rot=(0, 0, 0))
    return made


class Handheld:
    """Smooth pseudo-random camera shake: sums of incommensurate sines (no frame-to-frame jitter)."""

    def __init__(self, seed=3, rot_deg=0.18, pos_m=0.004):
        rng = np.random.default_rng(seed)
        self.f = rng.uniform(0.15, 1.3, (6, 3)); self.p = rng.uniform(0, 6.3, (6, 3)); self.rot, self.pos = rot_deg, pos_m

    def at(self, t):
        s = np.sum(np.sin(2 * np.pi * self.f * t + self.p) / np.arange(1, 7)[:, None], axis=0) / 1.5
        return Vector(s * self.pos), Euler(tuple(np.radians(s * self.rot)))


def camera(name='Cam', lens=35, fstop=2.8):
    sc = bpy.context.scene
    cam = bpy.data.objects.new(name, bpy.data.cameras.new(name)); sc.collection.objects.link(cam); sc.camera = cam
    cam.data.lens = lens; cam.data.dof.use_dof = True; cam.data.dof.aperture_fstop = fstop; cam.data.sensor_width = 36
    cam.data.clip_start = 0.05
    return cam


def aim(cam, loc, target, shake=None, t=0.0, roll=0.0):
    off, rot = shake.at(t) if shake else (Vector(), Euler())
    cam.location = Vector(loc) + off
    q = (Vector(target) - cam.location).to_track_quat('-Z', 'Y')
    e = q.to_euler(); e.x += rot.x; e.y += rot.y + math.radians(roll); e.z += rot.z
    cam.rotation_euler = e
    cam.data.dof.focus_distance = (Vector(target) - cam.location).length


def skeleton_overlay(arm, color=(0.1, 0.9, 1.0)):
    """One octahedral bone mesh per bone (head to tail) and a joint sphere at each head, parented to its bone, so the
    overlay shows exactly what the armature does. Returns the objects (hidden from renders until shown)."""
    import bmesh
    em = bpy.data.materials.new('BoneOverlay'); em.use_nodes = True; nt = em.node_tree; nt.nodes.clear()
    e = nt.nodes.new('ShaderNodeEmission'); e.inputs['Color'].default_value = (*color, 1); e.inputs['Strength'].default_value = 3.0
    o = nt.nodes.new('ShaderNodeOutputMaterial'); nt.links.new(e.outputs[0], o.inputs['Surface'])
    jm = bpy.data.materials.new('JointOverlay'); jm.use_nodes = True; nt = jm.node_tree; nt.nodes.clear()
    e2 = nt.nodes.new('ShaderNodeEmission'); e2.inputs['Color'].default_value = (1.0, 0.85, 0.2, 1); e2.inputs['Strength'].default_value = 3.0
    o2 = nt.nodes.new('ShaderNodeOutputMaterial'); nt.links.new(e2.outputs[0], o2.inputs['Surface'])
    made = []
    for b in arm.data.bones:
        L = b.length; w = max(0.004, min(0.03, 0.12 * L))
        verts = [(0, 0, 0), (w, 0.15 * L, 0), (0, 0.15 * L, w), (-w, 0.15 * L, 0), (0, 0.15 * L, -w), (0, L, 0)]
        faces = [(0, 1, 2), (0, 2, 3), (0, 3, 4), (0, 4, 1), (5, 2, 1), (5, 3, 2), (5, 4, 3), (5, 1, 4)]
        me = bpy.data.meshes.new('ov_' + b.name); me.from_pydata(verts, [], faces); me.materials.append(em)
        ob = bpy.data.objects.new('ov_' + b.name, me); bpy.context.scene.collection.objects.link(ob)
        bm = bmesh.new(); bmesh.ops.create_uvsphere(bm, u_segments=10, v_segments=6, radius=max(0.006, w * 0.9))
        sm = bpy.data.meshes.new('oj_' + b.name); bm.to_mesh(sm); bm.free(); sm.materials.append(jm)
        jo = bpy.data.objects.new('oj_' + b.name, sm); bpy.context.scene.collection.objects.link(jo)
        for x in (ob, jo):
            # bone space: Y along the bone from its head; a BONE parent sits at the tail, so offset by -length
            x.parent = arm; x.parent_type = 'BONE'; x.parent_bone = b.name
            x.matrix_parent_inverse = Matrix.Identity(4)
            x.location = (0, -L, 0)
            x.hide_render = True; x.visible_shadow = False
            made.append(x)
    return made


def ghost(objects, on, alpha=0.18):
    """Makes the character's meshes see-through (for the overlay) or restores them."""
    for o in objects:
        for slot in getattr(o, 'material_slots', []):
            m = slot.material
            if not m or not m.use_nodes: continue
            p = next((n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'), None)
            if p is None: continue
            if on:
                m['_alpha'] = p.inputs['Alpha'].default_value; p.inputs['Alpha'].default_value = alpha
            elif '_alpha' in m:
                p.inputs['Alpha'].default_value = m['_alpha']

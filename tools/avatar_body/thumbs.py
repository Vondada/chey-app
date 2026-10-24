"""The Creation Room tile pictures, rendered by us in Blender (no stock art): person, object, room, animation.

  python3 thumbs.py MODEL.glb OUT_DIR      env: SAMPLES (64), CYCLES_DEVICE, MAX_KB (70)

- thumb_person.jpg     the generated full-body character (MODEL.glb from mpfb_body.py), idle, three-quarter view
- thumb_animation.jpg  the same character mid-stride in its walk clip, side view, cinematic light
- thumb_object.jpg     a procedural desk lamp (brushed steel, painted shade, warm bulb) on an oak desk
- thumb_room.jpg       a small procedural living room (oak floor, two walls, window light, sofa, rug, table, plant)
Each is 480x600 JPEG, saved at the highest quality that keeps it at or under MAX_KB, and printed as WROTE <path> <bytes>.
"""
import math
import os
import sys

import bpy
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE); sys.path.insert(0, os.path.join(HERE, '..', 'avatar_face'))
import render_glb as R  # noqa: E402
from render_device import setup as render_setup  # noqa: E402

W, H = 480, 600


def mat(name, rgb, rough=0.5, metal=0.0, emit=None, strength=0.0):
    m = bpy.data.materials.new(name); m.use_nodes = True; p = m.node_tree.nodes['Principled BSDF']
    p.inputs['Base Color'].default_value = (*rgb, 1); p.inputs['Roughness'].default_value = rough
    p.inputs['Metallic'].default_value = metal
    if emit:
        p.inputs['Emission Color'].default_value = (*emit, 1); p.inputs['Emission Strength'].default_value = strength
    return m


def prim(kind, mat_, loc=(0, 0, 0), rot=(0, 0, 0), scale=(1, 1, 1), bevel=0.0, **kw):
    getattr(bpy.ops.mesh, f'primitive_{kind}_add')(location=loc, rotation=rot, **kw)
    o = bpy.context.active_object; o.scale = scale; o.data.materials.append(mat_)
    if bevel:
        b = o.modifiers.new('Bevel', 'BEVEL'); b.width = bevel; b.segments = 3
    for p in o.data.polygons: p.use_smooth = kind in ('uv_sphere', 'cylinder', 'cone', 'torus', 'ico_sphere')
    return o


def camera(sc, loc, target, lens=50):
    cam = bpy.data.objects.new('Cam', bpy.data.cameras.new('Cam')); sc.collection.objects.link(cam); sc.camera = cam
    cam.data.lens = lens; cam.location = loc
    tgt = bpy.data.objects.new('Tgt', None); sc.collection.objects.link(tgt); tgt.location = target
    c = cam.constraints.new('TRACK_TO'); c.target = tgt; c.track_axis = 'TRACK_NEGATIVE_Z'; c.up_axis = 'UP_Y'
    return cam


def light(sc, kind, loc, energy, size=1.0, color=(1, 1, 1), target=None):
    l = bpy.data.objects.new(kind, bpy.data.lights.new(kind, kind)); sc.collection.objects.link(l)
    l.location = loc; l.data.energy = energy; l.data.color = color
    if kind == 'AREA': l.data.size = size
    if kind == 'POINT': l.data.shadow_soft_size = size
    if target is not None:
        t = bpy.data.objects.new('LT', None); sc.collection.objects.link(t); t.location = target
        c = l.constraints.new('TRACK_TO'); c.target = t; c.track_axis = 'TRACK_NEGATIVE_Z'; c.up_axis = 'UP_Y'
    return l


def world(sc, rgb, strength=1.0):
    w = bpy.data.worlds.new('W'); sc.world = w; w.use_nodes = True
    bg = w.node_tree.nodes['Background']; bg.inputs['Color'].default_value = (*rgb, 1); bg.inputs['Strength'].default_value = strength


def setup(sc):
    render_setup(sc, (W, H))
    sc.render.resolution_x, sc.render.resolution_y = W, H   # tiles are always 480x600, whatever TEST_RES says
    sc.cycles.samples = int(os.environ.get('SAMPLES', '64')); sc.cycles.use_denoising = True
    sc.view_settings.view_transform = 'AgX'; sc.view_settings.look = 'AgX - Medium High Contrast'


def save_jpeg(sc, path):
    """Render, then save at the best JPEG quality that fits MAX_KB."""
    tmp = path + '.png'; sc.render.filepath = tmp; sc.render.image_settings.file_format = 'PNG'
    bpy.ops.render.render(write_still=True)
    img = bpy.data.images.load(tmp)
    limit = int(os.environ.get('MAX_KB', '70')) * 1024
    img.pixels[0]   # load the pixels
    for q in (90, 85, 80, 75, 70, 65, 60, 55, 50):
        img.file_format = 'JPEG'; img.save(filepath=path, quality=q)
        if os.path.getsize(path) <= limit: break
    bpy.data.images.remove(img); os.remove(tmp)
    print('WROTE', path, os.path.getsize(path), flush=True)


def person(glb, out, clip, frame, deg, lighting, name):
    sc, arm = R.load(glb)
    cam, tgt = R.stage(sc, arm, lighting)
    setup(sc)
    R.pose(sc, arm, clip, frame)
    a = math.radians(deg); dist = 3.0
    cam.location = Vector((math.sin(a) * dist, -math.cos(a) * dist, 1.0)); tgt.location = (0, 0, 0.9)
    save_jpeg(sc, os.path.join(out, name))


def desk_lamp(out):
    bpy.ops.wm.read_factory_settings(use_empty=True); sc = bpy.context.scene
    oak = mat('Oak', (0.16, 0.08, 0.035), 0.4); steel = mat('Steel', (0.62, 0.63, 0.65), 0.28, 1.0)
    shade = mat('Shade', (0.05, 0.34, 0.36), 0.35); dark = mat('Dark', (0.02, 0.02, 0.022), 0.4, 0.6)
    bulb = mat('Bulb', (1, 0.9, 0.7), 0.2, emit=(1.0, 0.78, 0.5), strength=25)
    prim('cube', oak, (0, 0, -0.02), scale=(0.9, 0.6, 0.02), bevel=0.004)                       # desk top
    prim('cylinder', dark, (0, 0, 0.012), vertices=48, radius=0.11, depth=0.024, bevel=0.004)    # weighted base
    # Two arm segments with joints, leaning forward, then the shade looking down at the desk.
    j0, j1, j2 = Vector((0, 0.02, 0.03)), Vector((0.02, 0.1, 0.36)), Vector((-0.02, -0.17, 0.52))
    for p, q in ((j0, j1), (j1, j2)):
        d = q - p; mid = (p + q) / 2
        o = prim('cylinder', steel, mid, vertices=24, radius=0.009, depth=d.length)
        o.rotation_mode = 'QUATERNION'; o.rotation_quaternion = Vector((0, 0, 1)).rotation_difference(d.normalized())
    for p in (j0, j1, j2): prim('uv_sphere', dark, p, radius=0.017, segments=24, ring_count=12)
    sh = prim('cone', shade, j2 + Vector((0, -0.05, -0.04)), vertices=48, radius1=0.085, radius2=0.03, depth=0.13, end_fill_type='NOTHING')
    sh.rotation_euler = (math.radians(-35), 0, 0)
    sol = sh.modifiers.new('Solid', 'SOLIDIFY'); sol.thickness = 0.003
    prim('uv_sphere', bulb, j2 + Vector((0, -0.08, -0.09)), radius=0.025, segments=24, ring_count=12)
    light(sc, 'POINT', j2 + Vector((0, -0.09, -0.1)), 18, 0.02, (1.0, 0.8, 0.55))
    prim('cube', mat('Book', (0.45, 0.08, 0.06), 0.6), (0.2, -0.12, 0.018), (0, 0, 0.3), (0.09, 0.13, 0.018), bevel=0.002)
    prim('cube', mat('Book2', (0.85, 0.82, 0.74), 0.7), (0.205, -0.115, 0.044), (0, 0, 0.22), (0.085, 0.12, 0.008), bevel=0.002)
    light(sc, 'AREA', (0.9, -0.9, 1.1), 60, 1.2, (0.75, 0.85, 1.0), target=(0, 0, 0.25))
    light(sc, 'AREA', (-0.8, 0.6, 0.9), 25, 1.0, (0.4, 0.95, 0.9), target=(0, 0, 0.3))
    world(sc, (0.012, 0.014, 0.02), 1.0)
    camera(sc, (0.55, -0.95, 0.42), (0, -0.02, 0.24), 45)
    setup(sc); save_jpeg(sc, os.path.join(out, 'thumb_object.jpg'))


def room(out):
    bpy.ops.wm.read_factory_settings(use_empty=True); sc = bpy.context.scene
    oak = mat('Floor', (0.36, 0.22, 0.12), 0.4); wall = mat('Wall', (0.72, 0.7, 0.66), 0.85)
    accent = mat('Accent', (0.09, 0.3, 0.32), 0.8); fabric = mat('Sofa', (0.55, 0.42, 0.3), 0.9)
    rug = mat('Rug', (0.62, 0.6, 0.55), 1.0); wood = mat('Wood', (0.2, 0.11, 0.06), 0.5)
    pot = mat('Pot', (0.75, 0.72, 0.68), 0.4); leaf = mat('Leaf', (0.08, 0.28, 0.08), 0.6)
    glow = mat('Window', (1, 1, 1), 0.5, emit=(0.85, 0.92, 1.0), strength=6)
    prim('cube', oak, (0, 0, -0.05), scale=(2.5, 2.5, 0.05))
    prim('cube', wall, (0, 2.5, 1.4), scale=(2.5, 0.05, 1.45))
    prim('cube', accent, (-2.5, 0, 1.4), scale=(0.05, 2.5, 1.45))
    prim('cube', glow, (0.9, 2.44, 1.5), scale=(0.75, 0.01, 0.65))                       # window
    for x in (0.15, 1.65): prim('cube', wood, (x, 2.42, 1.5), scale=(0.03, 0.03, 0.68))   # window frame
    prim('cube', wood, (0.9, 2.42, 0.83), scale=(0.78, 0.04, 0.03))
    light(sc, 'AREA', (0.9, 2.3, 1.5), 300, 1.4, (0.85, 0.92, 1.0), target=(0.2, 0.0, 0.3))
    # Sofa against the accent wall: seat, back, arms.
    prim('cube', fabric, (-2.0, 0.3, 0.22), scale=(0.42, 1.0, 0.22), bevel=0.04)
    prim('cube', fabric, (-2.33, 0.3, 0.55), scale=(0.12, 1.0, 0.35), bevel=0.04)
    for y in (-0.75, 1.35): prim('cube', fabric, (-2.0, y, 0.33), scale=(0.42, 0.1, 0.33), bevel=0.04)
    prim('cube', accent, (-2.05, 0.75, 0.55), (0.2, 0.3, 0), (0.08, 0.2, 0.18), bevel=0.05)  # cushion
    prim('cylinder', rug, (-0.9, 0.3, 0.005), vertices=64, radius=1.1, depth=0.01)
    prim('cylinder', wood, (-0.9, 0.3, 0.42), vertices=48, radius=0.45, depth=0.04)        # coffee table
    for a in range(3):
        t = a * 2 * math.pi / 3
        prim('cylinder', wood, (-0.9 + 0.3 * math.cos(t), 0.3 + 0.3 * math.sin(t), 0.2), vertices=16, radius=0.02, depth=0.4)
    prim('cylinder', mat('Mug', (0.9, 0.5, 0.2), 0.3), (-0.8, 0.2, 0.49), vertices=24, radius=0.04, depth=0.1)
    prim('cylinder', pot, (1.9, 1.9, 0.2), vertices=32, radius=0.2, depth=0.4)            # plant
    for k, (dx, dy, dz, r) in enumerate(((0, 0, 0.75, 0.3), (0.15, -0.1, 1.0, 0.22), (-0.12, 0.08, 1.05, 0.2), (0.02, 0.05, 1.25, 0.16))):
        prim('ico_sphere', leaf, (1.9 + dx, 1.9 + dy, dz), radius=r, subdivisions=2)
    prim('cube', wood, (-1.1, 2.2, 0.4), scale=(0.6, 0.22, 0.4), bevel=0.01)               # sideboard
    prim('cylinder', mat('Lamp', (1, 0.95, 0.85), 0.3, emit=(1, 0.8, 0.55), strength=8), (-1.3, 2.2, 0.95), vertices=32, radius=0.12, depth=0.22)
    light(sc, 'POINT', (-1.3, 2.2, 0.95), 40, 0.1, (1.0, 0.8, 0.55))
    world(sc, (0.05, 0.055, 0.06), 1.0)
    camera(sc, (2.1, -2.3, 1.5), (-0.7, 0.7, 0.55), 22)
    setup(sc); save_jpeg(sc, os.path.join(out, 'thumb_room.jpg'))


def main():
    glb, out = os.path.abspath(sys.argv[-2]), os.path.abspath(sys.argv[-1]); os.makedirs(out, exist_ok=True)
    person(glb, out, 'idle', 0, 25, 'studio', 'thumb_person.jpg')
    person(glb, out, 'walk', 8, 90, 'cinematic', 'thumb_animation.jpg')
    desk_lamp(out)
    room(out)


if __name__ == '__main__':
    main()

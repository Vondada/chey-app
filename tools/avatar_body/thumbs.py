"""The Creation Room tile pictures, rendered by us in Blender (no stock art): person, object, room, animation.

  python3 thumbs.py MODEL.glb OUT_DIR      env: SAMPLES (64), CYCLES_DEVICE, MAX_KB (70)

- thumb_person.jpg     the generated full-body character (MODEL.glb from mpfb_body.py), idle, three-quarter view
- thumb_animation.jpg  the same character mid-stride in its walk clip, side view, cinematic light
- thumb_object.jpg     Create Object's own modern desk lamp (objects.py: brushed steel, painted shade, warm bulb) on an
                       oak desk with two books
- thumb_room.jpg       Create Room's own default living room (rooms.py: oak floor, two walls, window, sofa, rug,
                       coffee table, floor lamp, shelf, plant, vase)
Each is 480x600 JPEG, saved at the highest quality that keeps it at or under MAX_KB, and printed as WROTE <path> <bytes>.
The object and room tiles use the same builders as the Creation Engine's object_model and room_model jobs, so the
tiles show what those jobs really make.
"""
import math
import os
import sys

import bpy
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE); sys.path.insert(0, os.path.join(HERE, '..', 'avatar_face'))
import render_glb as R  # noqa: E402
from objects import build_object, camera, light, mat, prim, world  # noqa: E402,F401  (mat/prim kept importable from here)
from render_device import setup as render_setup  # noqa: E402

W, H = 480, 600


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
    build_object({'family': 'lamp', 'style': 'modern', 'form': 'desk', 'color': '#1f6f78'})
    oak = mat('Oak desk', (0.16, 0.08, 0.035), 0.4)
    prim('cube', oak, (0, 0, -0.02), scale=(0.9, 0.6, 0.02), bevel=0.004)                       # desk top
    prim('cube', mat('Book', (0.45, 0.08, 0.06), 0.6), (0.2, -0.12, 0.018), (0, 0, 0.3), (0.09, 0.13, 0.018), bevel=0.002)
    prim('cube', mat('Book2', (0.85, 0.82, 0.74), 0.7), (0.205, -0.115, 0.044), (0, 0, 0.22), (0.085, 0.12, 0.008), bevel=0.002)
    bulb = next(o for o in sc.objects if o.name == 'Bulb')
    light(sc, 'POINT', bulb.matrix_world.translation + Vector((0, -0.01, -0.01)), 18, 0.02, (1.0, 0.8, 0.55))
    light(sc, 'AREA', (0.9, -0.9, 1.1), 60, 1.2, (0.75, 0.85, 1.0), target=(0, 0, 0.25))
    light(sc, 'AREA', (-0.8, 0.6, 0.9), 25, 1.0, (0.4, 0.95, 0.9), target=(0, 0, 0.3))
    world(sc, (0.012, 0.014, 0.02), 1.0)
    camera(sc, (0.55, -0.95, 0.42), (0, -0.02, 0.24), 45)
    setup(sc); save_jpeg(sc, os.path.join(out, 'thumb_object.jpg'))


def room(out):
    import rooms
    bpy.ops.wm.read_factory_settings(use_empty=True); sc = bpy.context.scene
    spec, _ = rooms.build_room({'type': 'living_room', 'width': 5.0, 'depth': 5.0})
    for o in sc.objects:   # the bulbs and window light the room, as render_creation.py lights a room job
        if o.type == 'MESH' and any(s.material and s.material.name == 'Bulb' for s in o.material_slots):
            light(sc, 'POINT', o.matrix_world.translation, 40, 0.1, rooms.LIGHT[spec['lighting']])
    light(sc, 'AREA', (0.6, 2.3, 1.5), 300, 1.4, (0.85, 0.92, 1.0), target=(0.2, 0.0, 0.3))
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

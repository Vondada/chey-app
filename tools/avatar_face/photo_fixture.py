"""Synthetic reference photos for the photo fit tests: a frontal face close-up of the MPFB2 character with KNOWN slider
values and colours. No real person is ever photographed or traced; every fixture is a render of the CC0 MakeHuman base.

  blender -b --factory-startup -P bl_run.py -- photo_fixture.py      (or python3 photo_fixture.py with the bpy module)
  env: FIT (a face_fit-style json: {"winner": {"weights": {slider: w}, "youth": 0}}), FIT_W (1), RACE, SEX, MATURE,
       TARGET_SRGB, HAIR_SRGB, IRIS_SRGB (as tools/avatar_body/mpfb_body.py reads them), OUT (the PNG), RES (long edge,
       default 320), SAMPLES (24), YAW (degrees the head turns, default 0), SHIFT_X (metres the face moves sideways)

The character is built by mpfb_body.build() (the same geometry and materials as a person job), then photographed
straight on with an 85 mm lens at portrait distance under a soft frontal key light, Standard view transform (so the
picture's sRGB values are the renderer's, with no film look). Prints FIXTURE <path> <w>x<h> and an EYES line with the
eye centres in pixels (the ground truth the landmark detector is compared with).
"""
import math
import os
import sys

import bpy
from bpy_extras.object_utils import world_to_camera_view
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE); sys.path.insert(0, os.path.join(HERE, '..', 'avatar_body'))
os.environ.setdefault('SUIT_REFINE', '0')   # the clothes are out of frame; refining them only costs time
from mpfb_body import build  # noqa: E402


def area(sc, name, loc, size, power, target):
    ld = bpy.data.lights.new(name, 'AREA'); ld.size = size; ld.energy = power
    lo = bpy.data.objects.new(name, ld); sc.collection.objects.link(lo); lo.location = loc
    lo.rotation_euler = (target - Vector(loc)).to_track_quat('-Z', 'Y').to_euler()


def main():
    sc, arm, meshes, info = build()
    eyes = [o for o in meshes if o.name.startswith('Eye_')]
    bpy.context.view_layer.update()
    el, er = (o.matrix_world.translation.copy() for o in eyes)
    mid = (el + er) / 2
    yaw = math.radians(float(os.environ.get('YAW', '0')))
    if yaw or os.environ.get('SHIFT_X'):
        # The whole character turns about a vertical axis through the eyes (a head turned away from the camera) and/or
        # moves sideways (two faces side by side are composited from two such pictures).
        arm.rotation_euler.z = yaw
        arm.location.x = float(os.environ.get('SHIFT_X', '0'))
        bpy.context.view_layer.update()
    res = int(os.environ.get('RES', '320'))
    sc.render.engine = 'CYCLES'; sc.cycles.device = 'CPU'
    sc.cycles.samples = int(os.environ.get('SAMPLES', '24')); sc.cycles.use_denoising = True
    sc.render.resolution_x = res * 4 // 5 // 2 * 2; sc.render.resolution_y = res; sc.render.resolution_percentage = 100
    sc.view_settings.view_transform = 'Standard'
    if os.environ.get('CPU_THREADS'):
        sc.render.threads_mode = 'FIXED'; sc.render.threads = int(os.environ['CPU_THREADS'])
    cam = bpy.data.objects.new('Cam', bpy.data.cameras.new('Cam')); sc.collection.objects.link(cam); sc.camera = cam
    cam.data.lens = 85
    look = Vector((0.0, mid.y, mid.z - 0.035))
    cam.location = look + Vector((0, -0.95, 0))
    cam.rotation_euler = (look - cam.location).to_track_quat('-Z', 'Y').to_euler()
    area(sc, 'Key', (0.35, mid.y - 1.4, mid.z + 0.6), 1.2, 25, look)
    area(sc, 'Fill', (-0.6, mid.y - 1.2, mid.z + 0.1), 1.5, 12, look)
    w = bpy.data.worlds.new('W'); sc.world = w; w.use_nodes = True
    w.node_tree.nodes['Background'].inputs['Color'].default_value = (0.32, 0.34, 0.36, 1)
    w.node_tree.nodes['Background'].inputs['Strength'].default_value = 0.4
    out = os.path.abspath(os.environ.get('OUT', 'fixture.png'))
    sc.render.filepath = out; sc.render.image_settings.file_format = 'PNG'; sc.render.image_settings.color_mode = 'RGB'
    bpy.ops.render.render(write_still=True)
    W, H = sc.render.resolution_x, sc.render.resolution_y
    px = []
    for o in eyes:
        p = world_to_camera_view(sc, cam, o.matrix_world.translation)
        px.append((round(p.x * W, 1), round((1 - p.y) * H, 1)))
    print('FIXTURE', out, f'{W}x{H}', flush=True)
    print('EYES', px, flush=True)


if __name__ == '__main__':
    main()

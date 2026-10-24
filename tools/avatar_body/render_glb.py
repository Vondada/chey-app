"""Full-body previews rendered from the exported GLB itself, so every picture shows the file CHE delivers.

  python3 render_glb.py MODEL.glb     env: OUT_DIR, VIEWS ("0,45,90,180"), STRIPS ("walk:4,wave:4"), POSE_CLIP (idle),
                                      POSE_FRAME (0), LIGHTING (studio | cinematic), SAMPLES, TEST_RES, CYCLES_DEVICE,
                                      CPU_THREADS, CAM_DIST, SIZE ("400x600"), RENDER_PROFILE (legacy | final |
                                      preview) and its settings (render_profiles.py)

Imports the GLB with Blender's glTF importer (skin, skeleton, clips, morph targets), poses it in one clip by NLA solo
and renders in Cycles on the device render_device.py reports (DEVICE line). Each view prints WROTE <OUT_DIR>/body_<deg>.png;
STRIPS renders N evenly spaced frames of a clip and joins them side by side: WROTE <OUT_DIR>/strip_<clip>.png.
RENDER_PROFILE preview writes quick looks instead: PREVIEW_WROTE <OUT_DIR>/preview_<deg>.png (never a WROTE line, so a
quick look is never taken for a finished view). Every view also prints RENDERED <deg> <seconds>. All views of a run
render in one Blender session (the GLB is imported once; the final profile keeps the scene data between views).
"""
import math
import os
import sys
import time

import bpy
import numpy as np
from mathutils import Quaternion, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE); sys.path.insert(0, os.path.join(HERE, '..', 'avatar_face'))
from mpfb_body import FPS, stage  # noqa: E402
from render_device import setup as render_setup  # noqa: E402
import render_profiles  # noqa: E402


def load(path):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene; sc.render.fps = FPS
    bpy.ops.import_scene.gltf(filepath=path)
    arm = next(o for o in sc.objects if o.type == 'ARMATURE')
    for o in list(sc.objects):   # the importer's bone-display sphere is not part of the character
        if o.type == 'MESH' and o.parent is None and not o.data.shape_keys and o.name.startswith('Icosphere'):
            o.hide_render = True
    return sc, arm


def owners(sc, arm):
    return [arm.animation_data] + [o.data.shape_keys.animation_data for o in sc.objects
                                   if o.type == 'MESH' and o.data.shape_keys and o.data.shape_keys.animation_data]


def clip_frames(sc, arm, name):
    for ad in owners(sc, arm):
        for tr in ad.nla_tracks:
            if tr.name == name and tr.strips: return int(round(tr.strips[0].frame_end - tr.strips[0].frame_start))
    raise KeyError(f'no clip {name}')


def pose(sc, arm, name, frame):
    """Plays clip `name` alone at `frame` (frames counted from the clip's start)."""
    start = 0
    for ad in owners(sc, arm):
        ad.action = None
        for tr in ad.nla_tracks:
            tr.mute = tr.name != name
            if tr.name == name and tr.strips: start = int(tr.strips[0].frame_start)   # the importer starts clips at frame 1
    for pb in arm.pose.bones:
        pb.rotation_quaternion = Quaternion(); pb.location = Vector(); pb.scale = Vector((1, 1, 1))
    sc.frame_set(start + int(frame))


def render(path):
    sc, arm = load(path)
    lighting = os.environ.get('LIGHTING', 'studio')
    cam, tgt = stage(sc, arm, lighting)
    w, h = (int(x) for x in os.environ.get('SIZE', '400x600').split('x'))
    render_setup(sc, (w, h))
    profile = render_profiles.profile_name()
    gpu = os.environ.get('CYCLES_DEVICE', 'CPU').upper() != 'CPU'
    render_profiles.apply(sc, profile, int(os.environ.get('SAMPLES', '32')), gpu)
    if profile == 'final': render_profiles.upgrade_materials(sc.objects)
    if os.environ.get('CPU_THREADS'):
        sc.render.threads_mode = 'FIXED'; sc.render.threads = int(os.environ['CPU_THREADS'])
    sc.view_settings.view_transform = 'AgX'
    out = os.environ.get('OUT_DIR', '.'); os.makedirs(out, exist_ok=True)
    dist = float(os.environ.get('CAM_DIST', '3.1'))
    tgt.location = (0, 0, float(os.environ.get('TARGET_Z', '0.9')))   # TARGET_Z 1.62, CAM_Z 1.62, CAM_DIST 0.7: a face close-up
    cam_z = float(os.environ.get('CAM_Z', '1.0'))

    def shoot(deg, filepath):
        a = math.radians(deg)
        cam.location = Vector((math.sin(a) * dist, -math.cos(a) * dist, cam_z))
        sc.render.filepath = filepath
        t0 = time.monotonic()
        bpy.ops.render.render(write_still=True)
        print('RENDERED', deg, f'{time.monotonic() - t0:.2f}', flush=True)

    views = [int(d) for d in os.environ.get('VIEWS', '0').split(',') if d.strip()]
    if views:
        pose(sc, arm, os.environ.get('POSE_CLIP', 'idle'), int(os.environ.get('POSE_FRAME', '0')))
        for deg in views:
            if profile == 'preview':
                p = os.path.join(out, f'preview_{deg:02d}.png'); shoot(deg, p)
                print('PREVIEW_WROTE', p, flush=True)
            else:
                p = os.path.join(out, f'body_{deg:02d}.png'); shoot(deg, p)
                print('WROTE', p, flush=True)
    for item in [x for x in os.environ.get('STRIPS', '').split(',') if x.strip()]:
        name, n = (item.split(':') + ['4'])[:2]; n = int(n)
        total = clip_frames(sc, arm, name)
        deg = 90 if name in ('walk', 'run') else 20
        tiles = []
        for k in range(n):
            f = round(total * k / n)
            pose(sc, arm, name, f)
            tmp = os.path.join(out, f'_strip_{name}_{k}.png'); shoot(deg, tmp)
            img = bpy.data.images.load(tmp); px = np.array(img.pixels[:]).reshape(img.size[1], img.size[0], 4)
            tiles.append(px); bpy.data.images.remove(img); os.remove(tmp)
            print(f'STRIP {name} frame {f}/{total}', flush=True)
        strip = np.concatenate(tiles, axis=1)
        im = bpy.data.images.new(f'strip_{name}', strip.shape[1], strip.shape[0], alpha=True)
        im.pixels.foreach_set(strip.ravel().astype(np.float32))
        p = os.path.join(out, f'strip_{name}.png'); im.filepath_raw = p; im.file_format = 'PNG'; im.save()
        print('WROTE', p, flush=True)


if __name__ == '__main__':
    render(os.path.abspath(sys.argv[-1]))

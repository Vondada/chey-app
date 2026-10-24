"""Build a reference-matched, rigged CHE World character in Blender (bpy) and render its model sheet.

Usage (Blender's Python module, no UI):
  python3 build_reference.py --char che --data <mpfb2>/src/mpfb/data --out <dir> [--stage shape|full] [--samples N]

Stages: "shape" renders the shaped body in clay so the face and proportions can be tuned; "full" builds the whole
character (skin, eyes, lashes, brows, hair, outfit, jewellery, rig, expressions), renders the sheet and exports
<id>.glb plus the editable <id>.blend.
"""
import argparse
import math
import os
import sys

import bpy
import numpy as np
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from characters import CHARACTERS  # noqa: E402
from mh_base import BaseHuman  # noqa: E402


def args():
    p = argparse.ArgumentParser()
    p.add_argument("--char", default="che")
    p.add_argument("--data", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--stage", default="shape")
    p.add_argument("--samples", type=int, default=32)
    p.add_argument("--res", type=int, default=640)
    p.add_argument("--views", default="front,threequarter,left,back,face")
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else sys.argv[1:]
    return p.parse_args(argv)


def hex_rgb(h, linear=True):
    h = h.lstrip("#")
    c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    if linear:
        c = [x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c]
    return c


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def shaped_base(spec, data):
    base = BaseHuman(data)
    base.apply_macros(spec["macro"])
    for name, value in spec["modifiers"].items():
        base.apply_modifier(name, value)
    return base


def mesh_from_groups(base, verts_bl, groups, name):
    """A Blender mesh from the faces of the given base-mesh groups, keeping base vertex indices in an attribute."""
    face_ids = [i for i, g in enumerate(base.face_groups) if g in groups]
    used = sorted({v for i in face_ids for v in base.faces[i]})
    remap = {v: k for k, v in enumerate(used)}
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(verts_bl[v]) for v in used], [], [[remap[v] for v in base.faces[i]] for i in face_ids])
    uv = me.uv_layers.new(name="UVMap")
    loop = 0
    for i in face_ids:
        for t in base.face_uvs[i]:
            uv.data[loop].uv = tuple(base.uv[t])
            loop += 1
    attr = me.attributes.new("base_index", "INT", "POINT")
    attr.data.foreach_set("value", used)
    me.validate()
    for p in me.polygons:
        p.use_smooth = True
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    return ob, used


def material(name, color, rough=0.5, metal=0.0, sss=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (*hex_rgb(color), 1)
    bsdf.inputs["Roughness"].default_value = rough
    bsdf.inputs["Metallic"].default_value = metal
    if sss:
        bsdf.inputs["Subsurface Weight"].default_value = sss
        bsdf.inputs["Subsurface Radius"].default_value = (0.9, 0.45, 0.25)
        bsdf.inputs["Subsurface Scale"].default_value = 0.012
    return m


# ---------- camera, lights, render
def setup_render(samples, res_x, res_y):
    sc = bpy.context.scene
    sc.render.engine = "CYCLES"
    sc.cycles.device = "CPU"
    sc.cycles.samples = samples
    sc.cycles.use_denoising = True
    try:
        sc.cycles.denoiser = "OPENIMAGEDENOISE"
    except TypeError:
        pass
    sc.cycles.max_bounces = 6
    sc.render.resolution_x, sc.render.resolution_y = res_x, res_y
    sc.render.image_settings.file_format = "PNG"
    sc.view_settings.view_transform = "AgX"
    sc.view_settings.look = "AgX - Base Contrast"


def neutral_lights(center, height):
    """The comparison lighting: the same three soft lights and grey studio for every character."""
    sc = bpy.context.scene
    w = bpy.data.worlds.new("Studio")
    sc.world = w
    w.use_nodes = True
    w.node_tree.nodes["Background"].inputs[0].default_value = (0.32, 0.32, 0.33, 1)
    w.node_tree.nodes["Background"].inputs[1].default_value = 0.55
    rig = []
    for name, off, energy, size, color in (
        ("Key", (-1.6, -2.4, 1.0), 230, 1.6, (1.0, 0.97, 0.93)),
        ("Fill", (2.2, -1.8, 0.4), 95, 2.4, (0.93, 0.96, 1.0)),
        ("Rim", (0.9, 2.6, 1.1), 170, 1.2, (1.0, 1.0, 1.0)),
    ):
        ld = bpy.data.lights.new(name, "AREA")
        ld.energy, ld.size, ld.color = energy * height / 1.7, size, color
        lo = bpy.data.objects.new(name, ld)
        sc.collection.objects.link(lo)
        lo.location = center + Vector(off) * height / 1.7
        lo.rotation_euler = (center - lo.location).to_track_quat("-Z", "Y").to_euler()
        rig.append(lo)
    return rig


def camera(target, azimuth_deg, distance, lens, elevation=0.0):
    sc = bpy.context.scene
    cd = bpy.data.cameras.new("Cam")
    cd.lens = lens
    cd.clip_start = 0.02
    cam = bpy.data.objects.new("Cam", cd)
    sc.collection.objects.link(cam)
    a = math.radians(azimuth_deg)
    # Azimuth 0 looks at the face (the body faces -Y); 90 looks at the character's left side (+X).
    cam.location = target + Vector((math.sin(a) * distance, -math.cos(a) * distance, elevation))
    cam.rotation_euler = (target - cam.location).to_track_quat("-Z", "Y").to_euler()
    sc.camera = cam
    return cam


VIEWS = {
    "front": (0, "body"), "threequarter": (-35, "body"), "left": (90, "body"), "back": (180, "body"),
    "face": (-18, "face"), "face_front": (0, "face"),
}


def render_views(out_dir, prefix, views, height, head_center, samples, res):
    os.makedirs(out_dir, exist_ok=True)
    written = []
    for view in views:
        az, kind = VIEWS[view]
        if kind == "body":
            setup_render(samples, res, int(res * 1.5))
            target = Vector((0, 0, height * 0.52))
            lens = 70
            dist = (height * 0.56) / math.tan(math.atan(18 / lens))
            cam = camera(target, az, dist, lens, elevation=0.05)
        else:
            setup_render(samples, res, res)
            target = Vector(head_center) + Vector((0, 0, -0.015))
            lens = 85
            dist = 0.17 / math.tan(math.atan(18 / lens))
            cam = camera(target, az, dist, lens, elevation=0.01)
        path = os.path.join(out_dir, f"{prefix}_{view}.png")
        bpy.context.scene.render.filepath = path
        bpy.ops.render.render(write_still=True)
        bpy.data.objects.remove(cam)
        written.append(path)
        print("RENDERED", path, flush=True)
    return written


def stage_shape(spec, a):
    reset()
    base = shaped_base(spec, a.data)
    verts, _ = base.blender_verts()
    body, used = mesh_from_groups(base, verts, {"body"}, "Body")
    body.data.materials.append(material("Clay", spec["palette"]["skin"], rough=0.55, sss=0.2))
    eyes, _ = mesh_from_groups(base, verts, {"helper-l-eye", "helper-r-eye"}, "Eyes")
    eyes.data.materials.append(material("EyeClay", "#e8e2da", rough=0.2))
    height = float(verts[used][:, 2].max())
    head = verts[sorted(base.group_verts["helper-l-eye"] | base.group_verts["helper-r-eye"])].mean(axis=0)
    lx = verts[sorted(base.group_verts["helper-l-eye"])][:, 0].mean()
    print("HEIGHT", round(height, 3), "EYES_CENTER", np.round(head, 3), "L_EYE_X", round(float(lx), 3), flush=True)
    neutral_lights(Vector((0, 0, height * 0.55)), height)
    render_views(a.out, f"{spec['id']}_shape", a.views.split(","), height, head, a.samples, a.res)


if __name__ == "__main__":
    a = args()
    spec = CHARACTERS[a.char]
    if a.stage == "shape":
        stage_shape(spec, a)
    else:
        from build_full import stage_full  # noqa: E402
        stage_full(spec, a)

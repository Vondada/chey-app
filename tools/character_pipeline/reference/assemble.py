"""Assemble a reference character, render its model sheet, bake its clips and export the GLB and editable .blend."""
import json
import math
import os
import time

import bmesh
import bpy
import numpy as np
from mathutils import Vector

import garments
import hair as hairmod
import paint
import poses
import rigging
from build_full import build_core, build_head, face_masks, hex_rgb, mat_principled, rig_core
from build_reference import neutral_lights, reset, setup_render

Z_AXIS, Y_AXIS = (0.0, 0.0, 1.0), (0.0, 1.0, 0.0)

CLIPS = [
    ("idle", 96, poses.idle, True), ("walk", 32, poses.walk, True),
    ("run", 22, lambda t: poses.walk(t, run=True), True), ("wave", 48, poses.wave, True),
    ("talk", 48, poses.talk, True), ("think", 60, poses.think, True), ("celebrate", 40, poses.celebrate, True),
    ("nod", 40, poses.nod, True), ("shake", 40, poses.shake, True),
]


EXPRESSION_SHEET = [
    ("neutral", {"smile": 0.12}, {}),
    ("smile", {"smile": 0.9, "brows_up": 0.15}, {}),
    ("talk", {"mouth_open": 0.38, "mouth_wide": 0.2, "smile": 0.35, "brows_up": 0.25}, {}),
    ("think", {"brows_frown": 0.3, "brows_worry": 0.3, "mouth_press": 0.45, "blink": 0.12},
     {"eye_l": [("aim", (0.35, -1, 0.35))], "eye_r": [("aim", (0.35, -1, 0.35))], "head": [(Z_AXIS, 6), (Y_AXIS, 4)]}),
    ("serious", {"brows_frown": 0.55, "mouth_press": 0.25}, {}),
]


def compose_strip(paths, out, labels):
    from PIL import Image, ImageDraw
    ims = [Image.open(p) for p in paths]
    w, h = ims[0].size
    sheet = Image.new("RGB", (w * len(ims), h + 34), (18, 18, 22))
    d = ImageDraw.Draw(sheet)
    for i, (im, lab) in enumerate(zip(ims, labels)):
        sheet.paste(im, (i * w, 0))
        d.text((i * w + w // 2 - 4 * len(lab), h + 10), lab.upper(), fill=(235, 220, 190))
    sheet.save(out)
    return out


def outfit_mats(pal):
    return {
        "blazer": mat_principled("Blazer", pal["blazer"], rough=0.62, sheen=0.3),
        "satin": mat_principled("Satin", pal["lapel"], rough=0.3, sheen=0.5),
        "satin_top": mat_principled("Top", pal["top"], rough=0.36, sheen=0.5),
        "trousers": mat_principled("Trousers", pal["trousers"], rough=0.62, sheen=0.3),
        "shoes": mat_principled("Shoes", pal["shoes"], rough=0.28, metal=0.85),
        "gold": mat_principled("Gold", pal["gold"], rough=0.22, metal=1.0),
        "diamond": mat_principled("Diamond", "#e9edf3", rough=0.08, metal=1.0),
    }


def weights_for(c, ob, used, k=4):
    if used is None:
        c.nearest.assign(ob, k=k)
        return
    rigging.assign_from_base(ob, used, c.per)
    for v in list(ob.data.vertices)[len(used):]:
        for bone, w in c.nearest.weights(v.co, k).items():
            g = ob.vertex_groups.get(bone) or ob.vertex_groups.new(name=bone)
            g.add([v.index], w, "REPLACE")


def set_keys(c, values):
    for ob in (c.body, c.lashes):
        for kb in ob.data.shape_keys.key_blocks[1:]:
            kb.value = values.get(kb.name, 0.0)


# ---------- props for the renders only (never exported)
def box(name, size, loc, mat, bevel=0.0):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        v.co = Vector((v.co.x * size[0], v.co.y * size[1], v.co.z * size[2]))
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    ob.location = loc
    bpy.context.scene.collection.objects.link(ob)
    ob.data.materials.append(mat)
    if bevel:
        m = ob.modifiers.new("Bevel", "BEVEL")
        m.width, m.segments = bevel, 3
    ob["prop"] = True
    return ob


def chair_and_desk(seat_z, desk_z, hip_y, with_desk=True):
    leather = mat_principled("Leather", "#efe9e2", rough=0.38, coat=0.2)
    gold = bpy.data.materials.get("Gold")
    glass = mat_principled("DeskTop", "#0c0c10", rough=0.08, coat=0.8)
    props = [
        box("Seat", (0.62, 0.56, 0.11), (0, hip_y + 0.02, seat_z - 0.055), leather, 0.03),
        box("Back", (0.64, 0.12, 0.62), (0, hip_y + 0.3, seat_z + 0.27), leather, 0.04),
        box("ArmL", (0.1, 0.56, 0.2), (0.33, hip_y + 0.04, seat_z + 0.08), leather, 0.03),
        box("ArmR", (0.1, 0.56, 0.2), (-0.33, hip_y + 0.04, seat_z + 0.08), leather, 0.03),
        box("Trim", (0.66, 0.58, 0.012), (0, hip_y + 0.02, seat_z - 0.115), gold, 0.004),
        box("Base", (0.08, 0.08, seat_z - 0.12), (0, hip_y + 0.02, (seat_z - 0.12) / 2), gold, 0.01),
    ]
    if with_desk:
        props += [
            box("Desk", (1.5, 0.75, 0.03), (0, hip_y - 0.62, desk_z - 0.015), glass, 0.006),
            box("DeskEdge", (1.52, 0.77, 0.008), (0, hip_y - 0.62, desk_z - 0.034), gold, 0.002),
            box("DeskLegL", (0.04, 0.6, desk_z - 0.04), (0.66, hip_y - 0.62, (desk_z - 0.04) / 2), gold),
            box("DeskLegR", (0.04, 0.6, desk_z - 0.04), (-0.66, hip_y - 0.62, (desk_z - 0.04) / 2), gold),
            box("Laptop", (0.34, 0.24, 0.012), (0, hip_y - 0.47, desk_z + 0.006), glass, 0.004),
            box("Screen", (0.34, 0.012, 0.22), (0, hip_y - 0.6, desk_z + 0.115), glass, 0.004),
        ]
    return props


def floor(mat_hex="#1a1a1f", rough=0.35):
    return box("Floor", (8, 8, 0.02), (0, 0, -0.01), mat_principled("Floor", mat_hex, rough=rough))


def clear(objs):
    for ob in objs:
        bpy.data.objects.remove(ob, do_unlink=True)


def shoot(path, target, az, dist, lens, res, elev=0.0, samples=64):
    sc = bpy.context.scene
    setup_render(samples, res[0], res[1])
    sc.cycles.transparent_max_bounces = 48
    cd = bpy.data.cameras.new("Cam")
    cd.lens = lens
    cd.clip_start = 0.02
    cam = bpy.data.objects.new("Cam", cd)
    sc.collection.objects.link(cam)
    a = math.radians(az)
    target = Vector(target)
    cam.location = target + Vector((math.sin(a) * dist, -math.cos(a) * dist, elev))
    cam.rotation_euler = (target - cam.location).to_track_quat("-Z", "Y").to_euler()
    sc.camera = cam
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True)
    bpy.data.objects.remove(cam)
    print("RENDERED", path, flush=True)
    return path


def body_dist(height, lens, frac=0.56):
    return (height * frac) / math.tan(math.atan(18 / lens))


def sunset_world():
    """The poster's light: a warm low sun behind and to the side, violet city sky, cool fill."""
    sc = bpy.context.scene
    for ob in [o for o in sc.objects if o.type == "LIGHT"]:
        bpy.data.objects.remove(ob)
    w = bpy.data.worlds.new("Sunset")
    sc.world = w
    w.use_nodes = True
    nt = w.node_tree
    bg = nt.nodes["Background"]
    tc = nt.nodes.new("ShaderNodeTexCoord")
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    nt.links.new(tc.outputs["Generated"], sep.inputs[0])
    nt.links.new(sep.outputs["Z"], ramp.inputs["Fac"])
    cr = ramp.color_ramp
    cr.elements[0].position, cr.elements[0].color = 0.48, (*hex_rgb("#f08a4b"), 1)
    cr.elements[1].position, cr.elements[1].color = 0.62, (*hex_rgb("#4a2c6e"), 1)
    mid = cr.elements.new(0.53)
    mid.color = (*hex_rgb("#c75a6b"), 1)
    nt.links.new(ramp.outputs["Color"], bg.inputs["Color"])
    bg.inputs["Strength"].default_value = 0.9
    out = []
    for name, loc, energy, size, color in (
        ("Sun", (2.4, 2.2, 2.6), 900, 1.2, "#ffb070"),
        ("Rim", (-1.8, 1.9, 2.0), 380, 1.0, "#ff9a6a"),
        ("Fill", (-1.6, -2.4, 1.2), 120, 2.6, "#8f86ff"),
        ("Face", (0.8, -2.0, 1.7), 140, 1.4, "#ffd9bd"),
    ):
        ld = bpy.data.lights.new(name, "AREA")
        ld.energy, ld.size, ld.color = energy, size, hex_rgb(color, linear=False)
        lo = bpy.data.objects.new(name, ld)
        sc.collection.objects.link(lo)
        lo.location = loc
        lo.rotation_euler = (Vector((0, 0, 1.1)) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()
        out.append(lo)
    return out


def assemble(spec, a):
    t0 = time.time()
    reset()
    c = build_core(spec, a)
    c.masks = face_masks(c)
    bd = garments.BodyData(c)
    lm = garments.Landmarks(c)
    cut = garments.Cut(lm, spec.get("suit", {}))
    rg = garments.Regions(c, bd, lm, cut)
    build_head(c, keep_body_face=rg.keep_face)
    mats = outfit_mats(c.pal)
    suit = garments.build_suit(c, bd, lm, rg, cut, mats)
    jewels = garments.build_jewelry(c, bd, lm, mats)
    hair_tex = paint.strand_texture(c.pal, c.tex_dir)
    hair_mat = mat_principled("Hair", tex=hair_tex, alpha_tex=True, rough=0.5)
    hair_mat.node_tree.nodes["Principled BSDF"].inputs["Specular IOR Level"].default_value = 0.35
    hair_ob, strands = hairmod.build_hair(c, [c.body, suit["Blazer"][0], suit["Top"][0]], hair_mat, spec["hair"], lm)
    rig_core(c)
    for name, (ob, used) in suit.items():
        weights_for(c, ob, used, k=6 if name == "Belt" else 4)
        rigging.bind(ob, c.arm)
    for ob, fixed in jewels:
        if fixed:
            for bone, w in fixed.items():
                g = ob.vertex_groups.new(name=bone)
                g.add([v.index for v in ob.data.vertices], w, "REPLACE")
        else:
            c.nearest.assign(ob, k=8)
        rigging.bind(ob, c.arm)
    rigging.bind(hair_ob, c.arm)
    print("BUILT in", round(time.time() - t0, 1), "s; strands", strands, flush=True)

    out = a.out
    os.makedirs(out, exist_ok=True)
    sid = spec["id"]
    head = Vector(((c.eyes["l"] + c.eyes["r"]) / 2).tolist())
    H = c.height
    renders = []
    samples, res = a.samples, a.res
    views = set(a.views.split(","))

    # ---- model sheet: identical neutral lighting for every character
    lights = neutral_lights(Vector((0, 0, H * 0.55)), H)
    set_keys(c, {"smile": 0.18})
    body_res = (res, int(res * 1.5))
    # As on the production sheet: hands on hips from the front and 3/4, arms relaxed from the side and back.
    for view, az, pose in (("front", 0, "hips"), ("threequarter", -35, "hips"), ("left", 90, "stand"),
                           ("back", 180, "stand")):
        if view in views:
            rigging.set_pose(c.arm, poses.hands_on_hips(lm) if pose == "hips"
                             else poses.merge(poses.STAND, poses.RELAXED_HANDS))
            renders.append(shoot(f"{out}/{sid}_{view}.png", (0, 0, H * 0.52), az, body_dist(H, 70), 70, body_res, 0.05,
                                 samples))
    if "expressions" in views:
        rigging.set_pose(c.arm, poses.merge(poses.STAND, poses.RELAXED_HANDS))
        strip = []
        for name, keys, look in EXPRESSION_SHEET:
            set_keys(c, keys)
            pose = poses.merge(poses.STAND, poses.RELAXED_HANDS, look)
            rigging.set_pose(c.arm, pose)
            strip.append(shoot(f"{out}/{sid}_expr_{name}.png", head + Vector((0, 0, -0.02)), -12, 0.6, 85,
                               (int(res * 0.6), int(res * 0.6)), 0.0, samples))
        renders.append(compose_strip(strip, f"{out}/{sid}_expressions.png", [e[0] for e in EXPRESSION_SHEET]))
    if "face" in views:
        renders.append(shoot(f"{out}/{sid}_face.png", head + Vector((0, 0, -0.02)), -20, 0.62, 85, (res, res), 0.01,
                             samples))
    if "speaking" in views:
        rigging.set_pose(c.arm, poses.talk(0.25))
        set_keys(c, {"mouth_open": 0.32, "mouth_wide": 0.15, "smile": 0.35, "brows_up": 0.3})
        renders.append(shoot(f"{out}/{sid}_speaking.png", head + Vector((0, 0, -0.06)), -25, 0.95, 85, (res, res),
                             0.0, samples))
    if "walk" in views:
        rigging.set_pose(c.arm, poses.walk(0.25))
        set_keys(c, {"smile": 0.2})
        renders.append(shoot(f"{out}/{sid}_walk.png", (0, 0, H * 0.5), -50, body_dist(H, 70), 70, body_res, 0.05,
                             samples))
    # ---- seated at a desk
    rigging.set_pose(c.arm, poses.sit(0.0))
    ankle = c.arm.matrix_world @ c.arm.pose.bones["foot_l"].head
    drop = float(ankle.z - lm.ankle)
    rigging.set_pose(c.arm, poses.sit(drop))
    hip = c.arm.matrix_world @ c.arm.pose.bones["thigh_l"].head
    wrist = c.arm.matrix_world @ c.arm.pose.bones["hand_l"].head
    seat_z, desk_z = float(hip.z - 0.1), float(wrist.z - 0.035)
    if "seated" in views:
        props = chair_and_desk(seat_z, desk_z, float(hip.y)) + [floor()]
        set_keys(c, {"smile": 0.2})
        renders.append(shoot(f"{out}/{sid}_seated.png", (0, -0.15, 0.82), -40, 3.0, 50, (res, int(res * 1.1)), 0.35,
                             samples))
        clear(props)
    # ---- cinematic: the poster's seated pose in sunset light
    if "sunset" in views:
        clear(lights)
        lights = sunset_world()
        rigging.set_pose(c.arm, poses.sit_base(drop))
        chin = c.arm.pose.bones["head"].head + Vector((0, -0.085, -0.04))
        pose = poses.poster(drop)
        pose["upperarm_r"] = [("aim_at", tuple(chin + Vector((-0.11, 0.03, -0.25))))]
        pose["lowerarm_r"] = [("aim_at", tuple(chin + Vector((0, 0.01, -0.035))))]
        pose["hand_r"] = [("aim", (0.15, -0.35, 0.92))]
        rigging.set_pose(c.arm, pose)
        set_keys(c, {"smile": 0.3})
        props = chair_and_desk(seat_z, desk_z, float(hip.y), with_desk=False) + [floor("#121218", 0.25)]
        renders.append(shoot(f"{out}/{sid}_sunset.png", (0, -0.05, 0.98), -18, 2.3, 50, (res, int(res * 1.25)), 0.25,
                             samples))
        clear(props)
    clear(lights)

    # ---- clips, then the export in the rest pose with every expression at zero
    rigging.clear_pose(c.arm)
    set_keys(c, {})
    for name, frames, fn, loop in CLIPS:
        rigging.bake_action(c.arm, name, frames, fn, loop)
    rigging.bake_action(c.arm, "sit", 24, lambda t: poses.sit(drop), True)
    rigging.bake_action(c.arm, "type", 60, lambda t: poses.sit(drop, typing=1.0, t=t), True)
    stand_pose = poses.merge(poses.STAND, poses.RELAXED_HANDS)
    rigging.bake_action(c.arm, "stand", 30, lambda t: rigging.blend_poses(poses.sit(drop), stand_pose,
                                                                          t * t * (3 - 2 * t)), False)
    c.arm.animation_data.action = None
    rigging.clear_pose(c.arm)

    glb = os.path.join(out, f"{sid}.glb")
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.export_scene.gltf(
        filepath=glb, export_format="GLB", use_selection=False, export_animations=True,
        export_animation_mode="ACTIONS", export_skins=True, export_morph=True, export_morph_normal=False,
        export_apply=False, export_yup=True, export_image_format="AUTO", export_cameras=False, export_lights=False,
    )
    blend = os.path.join(out, f"{sid}.blend")
    bpy.ops.file.pack_all()
    bpy.ops.wm.save_as_mainfile(filepath=blend, compress=True)

    meshes = [o for o in bpy.data.objects if o.type == "MESH"]
    tris = {o.name: sum(len(p.vertices) - 2 for p in o.data.polygons) for o in meshes}
    report = {
        "character": sid,
        "glb": glb, "glb_bytes": os.path.getsize(glb), "blend": blend, "blend_bytes": os.path.getsize(blend),
        "triangles_total": sum(tris.values()), "triangles": tris,
        "bones": len(c.arm.data.bones),
        "morph_targets": [kb.name for kb in c.body.data.shape_keys.key_blocks[1:]],
        "clips": [act.name for act in bpy.data.actions],
        "hair_strands": strands, "height_m": round(H, 3),
        "renders": renders, "seconds": round(time.time() - t0, 1),
    }
    with open(os.path.join(out, f"{sid}_report.json"), "w") as fh:
        json.dump(report, fh, indent=1)
    print("REPORT", json.dumps({k: v for k, v in report.items() if k != "triangles"}), flush=True)
    print("TRIS", json.dumps(tris), flush=True)

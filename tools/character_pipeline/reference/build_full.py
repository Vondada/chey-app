"""The full reference character: shaped body, painted skin and makeup, eyes, lashes, teeth, expressions, skeleton,
hair, outfit and jewellery, then the model-sheet renders and the GLB.

Called from build_reference.py with --stage full (or --stage face for a quick head check).
"""
import json
import math
import os

import bmesh
import bpy
import numpy as np
from mathutils import Vector

import paint
import rigging
from build_reference import camera, hex_rgb, neutral_lights, render_views, reset, setup_render, shaped_base

# Morph targets the app drives. The first four keep the names the current crew page already uses.
EXPRESSIONS = {
    "blink": [("eye-left-closure", 1.0), ("eye-right-closure", 1.0)],
    "mouth_open": [("mouth-open", 1.0)],
    "mouth_wide": [("mouth-retraction", 0.8), ("mouth-open", 0.25)],
    "mouth_round": [("mouth-pursing", 0.7), ("mouth-protusion", 0.4), ("mouth-open", 0.2)],
    "mouth_press": [("mouth-compression", 0.8)],
    "smile": [("mouth-corner-puller", 0.9), ("eye-left-slit", 0.15), ("eye-right-slit", 0.15)],
    "brows_up": [("eyebrows-left-up", 1.0), ("eyebrows-right-up", 1.0)],
    "brows_frown": [("eyebrows-left-down", 1.0), ("eyebrows-right-down", 1.0)],
    "brows_worry": [("eyebrows-left-inner-up", 1.0), ("eyebrows-right-inner-up", 1.0)],
    "blink_l": [("eye-left-closure", 1.0)],
    "blink_r": [("eye-right-closure", 1.0)],
    # Expression units for the runtime facial system (che_animator.js): each face (laugh, alert, skeptical,
    # surprised, concerned...) is a mix of these, so the faces stay distinct without a key per emotion.
    "eyes_wide": [("eye-left-opened-up", 0.8), ("eye-right-opened-up", 0.8)],
    "squint": [("eye-left-slit", 0.6), ("eye-right-slit", 0.6)],
    "brow_up_l": [("eyebrows-left-up", 1.0)],
    "brow_up_r": [("eyebrows-right-up", 1.0)],
    "brow_outer_up": [("eyebrows-left-extern-up", 1.0), ("eyebrows-right-extern-up", 1.0)],
    "mouth_frown": [("mouth-depression", 0.8)],
    "mouth_upper_up": [("mouth-elevation", 0.7)],
    "nose_sneer": [("nose-left-elevation", 0.6), ("nose-right-elevation", 0.6)],
    # Visemes the lip sync needs beyond open, wide, round and press: lower lip tucked (F, V) and teeth (S, T, TH).
    "viseme_fv": [("mouth-eversion", -0.6), ("mouth-upward-retraction", 0.4), ("mouth-open", 0.08)],
    "viseme_s": [("mouth-retraction", 0.5), ("mouth-parling", 0.4), ("mouth-open", 0.06)],
}

FACE_GROUPS = ["body", "helper-upper-teeth", "helper-lower-teeth", "helper-tongue"]


class Ctx:
    pass


def to_bl_disp(base, disp_mh):
    return base.to_blender(disp_mh)


def ethnic_unit(base, spec, unit):
    total = np.zeros_like(base.v)
    for race, w in spec["macro"]["race"].items():
        if w > 0:
            base.apply(f"expression/units/{race}/{unit}", w, into=total)
    return to_bl_disp(base, total)


def norm_mag(disp):
    m = np.linalg.norm(disp, axis=1)
    return m / (m.max() or 1.0)


def interp(table, x):
    xs, ys = zip(*table)
    return np.interp(x, xs, ys)


# ---------- face masks (per base vertex, 0..1)
def face_masks(c):
    base, V = c.base, c.V
    n = len(V)
    body = np.zeros(n)
    body[sorted(base.group_verts["body"])] = 1
    masks = {}
    brow = norm_mag(to_bl_disp(base, base.displacement("eyebrows/eyebrows-trans-up")))
    masks["brow"] = np.clip((brow - 0.5) / 0.3, 0, 1) * body
    closure = norm_mag(c.keys["blink"]) * body
    closure /= closure.max() or 1
    masks["liner"] = np.clip((closure - 0.62) / 0.25, 0, 1)
    masks["lid_center"] = np.clip((closure - 0.25) / 0.5, 0, 1)
    cheek = norm_mag(to_bl_disp(base, base.displacement("cheek/l-cheek-bones-incr")
                                + base.displacement("cheek/r-cheek-bones-incr")))
    masks["cheek"] = np.clip(cheek * 1.4, 0, 1) * body
    masks["contour"] = np.zeros(n)
    lip = norm_mag(to_bl_disp(base, base.displacement("mouth/mouth-lowerlip-volume-incr")))
    masks["lip_center"] = np.clip((lip - 0.5) / 0.4, 0, 1) * body
    masks["scalp"] = scalp_mask(c) * body
    return masks


def scalp_mask(c):
    """Where the hair grows: above a hairline that sits high on the forehead, above the ears and low at the nape."""
    V, hc = c.V, c.head_center
    rel = V - hc
    az = np.degrees(np.arctan2(rel[:, 0], -rel[:, 1]))
    el = np.degrees(np.arctan2(rel[:, 2], np.hypot(rel[:, 0], rel[:, 1])))
    line = interp([(0, 27), (35, 24), (60, 14), (80, 4), (100, -8), (125, -28), (150, -48), (180, -58)], np.abs(az))
    m = np.clip((el - line) / 5.0, 0, 1)
    near = np.linalg.norm(rel, axis=1) < 0.16
    ears = np.zeros(len(V))
    for side in "lr":
        ears = np.maximum(ears, norm_mag(to_bl_disp(c.base, c.base.displacement(f"ears/{side}-ear-scale-incr"))))
    return m * near * (ears < 0.08)


# ---------- objects
def build_mesh(c, name, groups, keep_face=None):
    base = c.base
    face_ids = [i for i, g in enumerate(base.face_groups) if g in groups and (keep_face is None or keep_face(i))]
    used = sorted({v for i in face_ids for v in base.faces[i]})
    remap = {v: k for k, v in enumerate(used)}
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(c.V[v]) for v in used], [], [[remap[v] for v in base.faces[i]] for i in face_ids])
    uv = me.uv_layers.new(name="UVMap")
    loop = 0
    for i in face_ids:
        for t in base.face_uvs[i]:
            uv.data[loop].uv = tuple(base.uv[t])
            loop += 1
    for k, i in enumerate(face_ids):
        me.polygons[k].material_index = groups.index(base.face_groups[i])
        me.polygons[k].use_smooth = True
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    return ob, np.array(used), face_ids


def lash_uvs(c, ob, used, face_ids):
    """Eyelash helper strips: U runs along the lid, V from root (0) to tip (1)."""
    base = c.base
    uv = ob.data.uv_layers["UVMap"]
    loop = 0
    for k, i in enumerate(face_ids):
        g = base.face_groups[i]
        if "eyelashes" not in g:
            loop += len(base.faces[i])
            continue
        side = "l" if "-l-" in g else "r"
        center = c.eyes[side]
        verts = sorted(base.group_verts[g])
        P = c.V[verts]
        d = np.linalg.norm(P - center, axis=1)
        xs = P[:, 0]
        for vi in base.faces[i]:
            p = c.V[vi]
            u = (p[0] - xs.min()) / max(1e-6, xs.max() - xs.min())
            if side == "r":
                u = 1 - u
            v = (np.linalg.norm(p - center) - d.min()) / max(1e-6, d.max() - d.min())
            uv.data[loop].uv = (0.02 + 0.96 * u, 1 - v)
            loop += 1


def image_node(nt, path, non_color=False):
    img = bpy.data.images.load(path)
    if non_color:
        img.colorspace_settings.name = "Non-Color"
    n = nt.nodes.new("ShaderNodeTexImage")
    n.image = img
    return n


def mat_principled(name, color=None, rough=0.5, metal=0.0, tex=None, rough_tex=None, alpha_tex=False, sss=0.0,
                   coat=0.0, sheen=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    if color:
        bsdf.inputs["Base Color"].default_value = (*hex_rgb(color), 1)
    bsdf.inputs["Roughness"].default_value = rough
    bsdf.inputs["Metallic"].default_value = metal
    if tex:
        t = image_node(nt, tex)
        nt.links.new(t.outputs["Color"], bsdf.inputs["Base Color"])
        if alpha_tex:
            nt.links.new(t.outputs["Alpha"], bsdf.inputs["Alpha"])
            m.surface_render_method = "DITHERED"
            try:
                m.blend_method = "CLIP"
                m.alpha_threshold = 0.35
            except AttributeError:
                pass
    if rough_tex:
        r = image_node(nt, rough_tex, non_color=True)
        nt.links.new(r.outputs["Color"], bsdf.inputs["Roughness"])
    if sss:
        bsdf.inputs["Subsurface Weight"].default_value = sss
        bsdf.inputs["Subsurface Radius"].default_value = (1.0, 0.45, 0.25)
        bsdf.inputs["Subsurface Scale"].default_value = 0.01
    if coat:
        bsdf.inputs["Coat Weight"].default_value = coat
        bsdf.inputs["Coat Roughness"].default_value = 0.08
    if sheen:
        bsdf.inputs["Sheen Weight"].default_value = sheen
    return m


def eye_object(c, side, tex):
    center, radius = c.eyes[side], c.eye_radius[side] * 0.985
    me = bpy.data.meshes.new(f"Eye_{side}")
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=20, v_segments=12, radius=radius)
    bm.to_mesh(me)
    bm.free()
    uv = me.uv_layers.new(name="UVMap")
    fwd = np.array([0.0, -1.0, 0.0])
    for poly in me.polygons:
        poly.use_smooth = True
        for li in poly.loop_indices:
            p = np.array(me.vertices[me.loops[li].vertex_index].co)
            p /= np.linalg.norm(p) or 1
            theta = math.acos(np.clip(np.dot(p, fwd), -1, 1))
            phi = math.atan2(p[2], p[0])
            r = theta / math.pi * 0.5
            uv.data[li].uv = (0.5 + r * math.cos(phi), 0.5 + r * math.sin(phi))
    ob = bpy.data.objects.new(f"Eye_{side}", me)
    ob.location = Vector(center)
    bpy.context.scene.collection.objects.link(ob)
    ob.data.materials.append(c.mats["eye"])
    return ob


def apply_shape_keys(c, ob, used):
    ob.shape_key_add(name="Basis", from_mix=False)
    for name, disp in c.keys.items():
        sk = ob.shape_key_add(name=name, from_mix=False)
        co = c.V[used] + disp[used]
        sk.data.foreach_set("co", co.reshape(-1).astype(np.float32))
        sk.value = 0.0


def lid_margins(c, side):
    """Base-vertex indices along the upper and lower lid margins of one eye, inner corner first."""
    center, r = c.eyes[side], c.eye_radius[side]
    idx = np.array(sorted(c.base.group_verts["body"]))
    rel = c.V[idx] - center
    d = np.linalg.norm(rel, axis=1)
    near = (d < r * 1.6) & (rel[:, 1] < -r * 0.2)
    move = np.linalg.norm(c.keys["blink"][idx], axis=1)
    moving = move > 0.35 * move[near].max()
    lateral = rel[:, 0] * (1 if side == "l" else -1)          # grows toward the outer corner
    lo, hi = lateral[near].min(), lateral[near].max()
    edges = np.linspace(lo, hi, 15)
    upper, lower = [], []
    for a, b in zip(edges[:-1], edges[1:]):
        band = near & (lateral >= a) & (lateral < b)
        up = band & moving & (rel[:, 2] > -r * 0.25)
        dn = band & ~moving & (rel[:, 2] < r * 0.1) & (d < r * 1.25)
        if up.any():
            upper.append(int(idx[up][np.argmin(rel[up, 2])]))
        if dn.any():
            lower.append(int(idx[dn][np.argmax(rel[dn, 2])]))
    return upper, lower


def face_strokes(c, size, tri_v, tri_uv):
    """Eyebrows and winged eyeliner, painted per texel from the face's 3D shape (mirrored, so both sides match)."""
    eye_z = float(c.eyes["l"][2])
    head = c.V[tri_v].mean(axis=1)[:, 2] > eye_z - 0.09
    pos, cov = paint.position_map(size, tri_uv[head], c.V[tri_v[head]])
    up, _ = c.margins["l"]
    m = c.V[up]
    xs, zs = np.abs(m[:, 0]), m[:, 2]
    inner, outer = (xs[0], zs[0]), (xs[-1], zs[-1])
    mid_z = float(zs.max())
    front_y = float(c.eyes["l"][1]) + 0.012
    brow = c.spec.get("brow", {})
    lift, arch, length = brow.get("lift", 0.017), brow.get("arch", 0.009), brow.get("tail", 0.011)
    bx = np.array([inner[0] - 0.003, inner[0] + 0.006, outer[0] - 0.006, outer[0] + 0.002, outer[0] + length])
    bz = np.array([mid_z + lift - 0.001, mid_z + lift + arch * 0.45, mid_z + lift + arch, mid_z + lift + arch * 0.8,
                   mid_z + lift + arch * 0.15])
    bw = np.array([0.0062, 0.0058, 0.0046, 0.0034, 0.0011])
    liner_pts = [(x, z + 0.0006) for x, z in zip(xs, zs)]
    wing = c.spec.get("wing", {"length": 0.009, "angle": 24})
    ang = math.radians(wing["angle"])
    liner_pts.append((outer[0] + wing["length"] * math.cos(ang), outer[1] + 0.0006 + wing["length"] * math.sin(ang)))
    lw = np.interp(np.linspace(0, 1, len(liner_pts)), [0, 0.5, 0.92, 1.0], [0.0005, 0.0011, 0.0019, 0.0002])
    return {
        "brow": paint.stroke_mask(pos, cov, np.stack([bx, bz], 1), bw, front_y, soft=0.45),
        "liner": paint.stroke_mask(pos, cov, np.array(liner_pts), lw, front_y, soft=0.4),
    }


def lash_object(c, mat):
    """Upper and lower lash cards along each lid margin, with shape keys that follow the blink."""
    fwd, upv = np.array([0.0, -1.0, 0.0]), np.array([0.0, 0.0, 1.0])
    verts, faces, uvs, rows = [], [], [], []

    def norm(v):
        return v / (np.linalg.norm(v) or 1)

    for side in "lr":
        lat = np.array([1.0 if side == "l" else -1.0, 0.0, 0.0])
        upper, lower = c.margins[side]
        for which, chain in (("upper", upper), ("lower", lower[len(lower) // 3:])):
            n = len(chain)
            if n < 2:
                continue
            start = len(verts)
            for k, vi in enumerate(chain):
                t = k / (n - 1)
                if which == "upper":
                    length = 0.0075 + 0.0068 * t ** 1.3
                    d_open = norm(fwd * 0.55 + upv * 0.8 + lat * 0.35 * t)
                    d_shut = norm(fwd * 0.7 - upv * 0.65 + lat * 0.2 * t)
                else:
                    length = 0.0022 + 0.0022 * t
                    d_open = norm(fwd * 0.6 - upv * 0.75 + lat * 0.25 * t)
                    d_shut = d_open
                root = c.V[vi] + fwd * 0.0005
                for r, frac in enumerate((0.0, 0.5, 1.0)):
                    curl = fwd * length * 0.12 * math.sin(math.pi * frac)
                    verts.append(root + d_open * length * frac + curl)
                    rows.append((side, which, vi, frac, length, d_open, d_shut))
                    uvs.append((0.02 + 0.96 * t, 1.0 - frac))
            for k in range(n - 1):
                a0 = start + k * 3
                b0 = start + (k + 1) * 3
                faces.append((a0, b0, b0 + 1, a0 + 1))
                faces.append((a0 + 1, b0 + 1, b0 + 2, a0 + 2))
    me = bpy.data.meshes.new("Lashes")
    me.from_pydata([tuple(v) for v in verts], [], faces)
    uv = me.uv_layers.new(name="UVMap")
    for poly in me.polygons:
        poly.use_smooth = True
        for li in poly.loop_indices:
            uv.data[li].uv = uvs[me.loops[li].vertex_index]
    ob = bpy.data.objects.new("Lashes", me)
    bpy.context.scene.collection.objects.link(ob)
    ob.data.materials.append(mat)
    ob.shape_key_add(name="Basis", from_mix=False)
    for name, disp in c.keys.items():
        sk = ob.shape_key_add(name=name, from_mix=False)
        co = []
        for v, (side, which, vi, frac, length, d_open, d_shut) in zip(verts, rows):
            shut = which == "upper" and name in ("blink", f"blink_{side}")
            root = c.V[vi] + disp[vi] + fwd * 0.0005
            if shut:
                curl = fwd * length * 0.12 * math.sin(math.pi * frac)
                co.append(root + d_shut * length * frac + curl)
            else:
                co.append(v + disp[vi])
        sk.data.foreach_set("co", np.array(co, np.float32).reshape(-1))
        sk.value = 0.0
    return ob


def rot_x(deg):
    t = math.radians(deg)
    return np.array([[1, 0, 0], [0, math.cos(t), -math.sin(t)], [0, math.sin(t), math.cos(t)]])


def heel_lift(c, deg):
    """Stand the character in heels: each foot turns down about the ankle and the toes turn back up at the ball,
    blended by the foot and toe skin weights; then the whole body rises so the toes rest on the floor."""
    if not deg:
        return
    n = len(c.V)
    for side in "lr":
        wf, wb = np.zeros(n), np.zeros(n)
        for vi, items in c.per.items():
            if vi < n:
                for bone, w in items:
                    if bone == f"foot_{side}":
                        wf[vi] = w
                    elif bone == f"ball_{side}":
                        wb[vi] = w
        A = c.joint(f"joint-{side}-ankle")
        B = c.joint(f"joint-{side}-foot-1")
        R1, R2 = rot_x(deg), rot_x(-deg)
        P = c.V
        P1 = A + (P - A) @ R1.T
        B1 = A + (B - A) @ R1.T
        P2 = B1 + (P1 - B1) @ R2.T
        new = P * (1 - wf - wb)[:, None] + P1 * wf[:, None] + P2 * wb[:, None]
        for g, vs in c.base.group_verts.items():
            vs = sorted(vs)
            if g.startswith(f"joint-{side}-foot"):
                new[vs] = P1[vs]
            elif g.startswith(f"joint-{side}-toe"):
                new[vs] = P2[vs]
        c.V = new
    body = sorted(c.base.group_verts["body"])
    c.V[:, 2] -= c.V[body][:, 2].min()


def rig_point(c, spec):
    if spec["strategy"] == "CUBE":
        return c.joint(spec["cube_name"])
    if spec["strategy"] == "VERTEX":
        return c.V[spec["vertex_index"]]
    return c.V[spec["vertex_indices"]].mean(axis=0)


def build_core(spec, a):
    c = Ctx()
    c.spec, c.args = spec, a
    c.pal = spec["palette"]
    c.base = shaped_base(spec, a.data)
    c.V, c.ground = c.base.blender_verts()
    base = c.base
    c.rig, weights = base.load_rig("game_engine")
    c.per = rigging.weights_per_vertex(weights)
    c.joint = lambda name: c.V[sorted(base.group_verts[name])].mean(axis=0)
    heel_lift(c, spec.get("heels", 0))
    c.height = float(c.V[sorted(base.group_verts["body"])][:, 2].max())
    c.eyes, c.eye_radius = {}, {}
    for side in "lr":
        P = c.V[sorted(base.group_verts[f"helper-{side}-eye"])]
        c.eyes[side] = P.mean(axis=0)
        c.eye_radius[side] = float(np.linalg.norm(P - c.eyes[side], axis=1).mean())
    eye_mid = (c.eyes["l"] + c.eyes["r"]) / 2
    c.head_center = eye_mid + np.array([0.0, 0.085, 0.025])
    c.keys = {}
    for name, units in EXPRESSIONS.items():
        d = np.zeros_like(c.V)
        for unit, w in units:
            d += w * ethnic_unit(base, spec, unit)
        c.keys[name] = d
    c.tex_dir = os.path.join(a.out, "textures")
    os.makedirs(c.tex_dir, exist_ok=True)
    return c


def build_head(c, keep_body_face=None):
    spec, a = c.spec, c.args
    masks = c.masks = face_masks(c)
    c.margins = {s: lid_margins(c, s) for s in "lr"}
    skin_col, skin_rough = paint.skin_textures(c.base, masks, c.pal, a.data, c.tex_dir,
                                               pixel_masks=lambda size, tv, tuv: face_strokes(c, size, tv, tuv))
    eye_tex = paint.iris_texture(c.pal, c.tex_dir)
    lash_tex = paint.lash_texture(c.pal, c.tex_dir)
    c.mats = {
        "skin": mat_principled("Skin", tex=skin_col, rough_tex=skin_rough, sss=0.12),
        "teeth": mat_principled("Teeth", "#efe9df", rough=0.25),
        "tongue": mat_principled("Mouth", "#9a4a4f", rough=0.4),
        "lashes": mat_principled("Lashes", tex=lash_tex, alpha_tex=True, rough=0.6),
        "eye": mat_principled("Eyes", tex=eye_tex, rough=0.06, coat=0.6),
    }
    keep = (lambda i: c.base.face_groups[i] != "body" or keep_body_face(i)) if keep_body_face else None
    body, used, face_ids = build_mesh(c, "Body", FACE_GROUPS, keep)
    for m in ("skin", "teeth", "teeth", "tongue"):
        body.data.materials.append(c.mats[m])
    apply_shape_keys(c, body, used)
    c.lashes = lash_object(c, c.mats["lashes"])
    c.body, c.body_used = body, used
    c.eye_objs = [eye_object(c, s, eye_tex) for s in "lr"]
    return body


def rig_core(c):
    c.arm = rigging.build_armature(c.base, c.rig, c.ground, {s: c.eyes[s] for s in "lr"},
                                   point_of=lambda spec: rig_point(c, spec))
    rigging.assign_from_base(c.body, c.body_used, c.per)
    body_pts = c.V[sorted(c.base.group_verts["body"])]
    c.nearest = rigging.NearestWeights(body_pts, sorted(c.base.group_verts["body"]), c.per)
    # Helper geometry (teeth, tongue, lashes) has no weights of its own in the rig file: it follows the head.
    vg_head = c.body.vertex_groups.get("head") or c.body.vertex_groups.new(name="head")
    for v in c.body.data.vertices:
        if not v.groups:
            vg_head.add([v.index], 1.0, "REPLACE")
    rigging.bind(c.body, c.arm)
    g = c.lashes.vertex_groups.new(name="head")
    g.add([v.index for v in c.lashes.data.vertices], 1.0, "REPLACE")
    rigging.bind(c.lashes, c.arm)
    for side, ob in zip("lr", c.eye_objs):
        g = ob.vertex_groups.new(name=f"eye_{side}")
        g.add([v.index for v in ob.data.vertices], 1.0, "REPLACE")
        mat = ob.matrix_world.copy()
        rigging.bind(ob, c.arm)
        ob.matrix_world = mat


def stage_face(spec, a):
    reset()
    c = build_core(spec, a)
    build_head(c)
    rig_core(c)
    head = (c.eyes["l"] + c.eyes["r"]) / 2
    neutral_lights(Vector((0, 0, c.height * 0.55)), c.height)
    render_views(a.out, f"{spec['id']}_facecheck", a.views.split(","), c.height, head, a.samples, a.res)
    if os.environ.get("CHE_FACE_KEYS"):
        for key in os.environ["CHE_FACE_KEYS"].split(","):
            for ob in (c.body, c.lashes):
                for kb in ob.data.shape_keys.key_blocks:
                    kb.value = 1.0 if kb.name == key else 0.0
            render_views(a.out, f"{spec['id']}_key_{key}", ["face_front"], c.height, head, a.samples, a.res)
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(a.out, f"{spec['id']}_face.blend"))


def stage_full(spec, a):
    if a.stage == "face":
        return stage_face(spec, a)
    from assemble import assemble  # noqa: E402
    return assemble(spec, a)

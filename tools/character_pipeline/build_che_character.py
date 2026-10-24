"""Build CHE or one of her office agents as a rigged semi-realistic game character and export a GLB.

Run with Blender's Python module (bpy 5.x, Python 3.11):
  python build_che_character.py -- <out.glb> [character_id]
  python build_che_character.py -- <out_dir>/ all        # every character, <id>.glb each

character_id is one of CHARACTERS below (default: che). Version 2 (owner brief, 2026-10-24):
semi-realistic proportions (about seven and a half heads), a lofted torso, real-scale eyes,
brows, nose, ears and lips built into the skin, and identity from hair, eyes, outfit and
accessories. The earlier chibi look (big round head) is retired on purpose.

Units are metres-like, Z up, total height 1.12. The character faces -Y; the glTF export turns
that into +Z. Torso, arms and legs are skinned with automatic weights. Hair, eyes, brows,
lashes and accessories are rigid to one bone. The skin carries shape keys for the runtime:
blink, mouth_open, mouth_wide and mouth_round (lip sync and expressions are driven in the app).
Colours are vertex colours (glTF COLOR_0). Each clip is keyframed as its own action and exported
with export_animation_mode='ACTIONS'.
"""
import bpy
import bmesh
import math
import random
import sys
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree
from mathutils.noise import noise as pnoise

ARGS = sys.argv[sys.argv.index("--") + 1:]
OUT = ARGS[0]
WHICH = ARGS[1] if len(ARGS) > 1 else "che"
FPS = 30
META_RES = 0.006
FINGER_RES = 0.003


def srgb(h):
    """'#rrggbb' -> linear RGB tuple (vertex colours and Blender colours are linear)."""
    h = h.lstrip("#")
    out = []
    for i in (0, 2, 4):
        c = int(h[i:i + 2], 16) / 255
        out.append(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4)
    return tuple(out)


def mix(a, b, t):
    return tuple(a[i] + (b[i] - a[i]) * t for i in range(3))


def smoothstep(x):
    x = max(0.0, min(1.0, x))
    return x * x * (3 - 2 * x)


# ---------------------------------------------------------------- the crew
# Roles come from lib/che_ui/che_brain.dart (CHE's office). Identity comes from the owner's
# reference images (hair, colours, glasses, beanie, headphones) and each character's face
# values: eye, nose, lip and brow scale.
CHARACTERS = {
    "che": dict(
        name="CHE", role="Office Boss",
        skin="#c98b62", eyes="#3a2216", hair="#1c1210", hair_hi="#4a3022",
        hair_style="long_wavy", top="jacket", top_color="#1f6f78", inner="#15171a",
        pants="#17191d", shoes="#222429", sole="#e9ecef", earrings="#d8b25a",
        face=dict(eye=1.0, nose=0.95, lips=1.05, brow=1.0)),
    "nova": dict(
        name="Nova", role="Product / listings",
        skin="#f0c8a8", eyes="#3b2a4a", hair="#8d64d6", hair_hi="#c6a6f5",
        hair_style="bun_high", top="hoodie", top_color="#b79be6", inner="#b79be6",
        pants="#2a2633", shoes="#f2f2f4", sole="#f2f2f4",
        face=dict(eye=1.05, nose=0.9, lips=1.0, brow=0.9)),
    "atlas": dict(
        name="Atlas", role="Research / sourcing",
        skin="#d29a72", eyes="#2e1c12", hair="#2a1a12", hair_hi="#5a3a26",
        hair_style="curly_short", top="jacket", top_color="#e8732e", inner="#f1f1ef",
        pants="#18191c", shoes="#f4f4f4", sole="#f4f4f4",
        face=dict(eye=1.0, nose=1.05, lips=1.0, brow=1.1)),
    "mira": dict(
        name="Mira", role="Support copy / translation",
        skin="#e7b48e", eyes="#3a2416", hair="#4a2c1c", hair_hi="#7d5236",
        hair_style="bun_low", top="sweater", top_color="#e9dcc8", inner="#e9dcc8",
        pants="#3b3f47", shoes="#2a2a2e", sole="#d9d9d9", glasses="#2a1d18",
        face=dict(eye=0.98, nose=0.95, lips=0.95, brow=0.95)),
    "knox": dict(
        name="Knox", role="Engineering",
        skin="#7a4a2e", eyes="#24160e", hair="#141010", hair_hi="#2e2420",
        hair_style="afro", top="jacket", top_color="#3e5f86", inner="#e8e8e8",
        pants="#1d2028", shoes="#2a2d33", sole="#eeeeee", headphones="#2f5fd0",
        face=dict(eye=1.0, nose=1.1, lips=1.1, brow=1.15)),
    "sage": dict(
        name="Sage", role="Finance (read-only)",
        skin="#8c5a3c", eyes="#24160e", hair="#1a1210", hair_hi="#3a2a20",
        hair_style="curly_short", top="jacket", top_color="#56603e", inner="#d9d4c6",
        pants="#22242a", shoes="#3a2c22", sole="#d8d0c0", glasses="#1d1a18", beard=True,
        face=dict(eye=0.95, nose=1.1, lips=1.0, brow=1.2)),
    "lyra": dict(
        name="Lyra", role="Content / social",
        skin="#dca27a", eyes="#331f14", hair="#3b2416", hair_hi="#7a4e30",
        hair_style="wavy_medium", top="jacket", top_color="#d89a2a", inner="#f3efe6",
        pants="#262a33", shoes="#f0f0f0", sole="#f0f0f0",
        face=dict(eye=1.08, nose=0.9, lips=1.1, brow=0.9)),
    "iris": dict(
        name="Iris", role="Ad Studio",
        skin="#f1cdb0", eyes="#3d6ea8", hair="#d8b46a", hair_hi="#f0d79a",
        hair_style="beanie", top="jacket", top_color="#3a5574", inner="#e5e5e5",
        pants="#1d2129", shoes="#1f1f22", sole="#e5e5e5", beanie="#1b1c20",
        face=dict(eye=1.1, nose=0.95, lips=1.0, brow=0.85)),
}

# ---------------------------------------------------------------- proportions (about 7.5 heads)
# Total height 1.12. Head height 0.176 (crown 1.122, chin about 0.95). Shoulder half-width about 0.13,
# hips about 0.115. Arm and leg lengths follow real segment ratios.
H = Vector((0, 0, 1.035))         # head centre
HA = (0.061, 0.076, 0.088)        # head semi-axes: width, depth, height
HS = HA[0] / 0.200                # the hair and accessory offsets below were written for the old head
EYE_X, EYE_DZ = 0.031, -0.012     # eye centre: sideways offset, height relative to the head centre
ER = (0.0105, 0.0078, 0.0118)     # eye semi-axes: width, depth, height
NOSE_Z = -0.040
MOUTH_Z = -0.066
SIT_DROP = -0.20
FACE = dict(eye=1.0, nose=1.0, lips=1.0, brow=1.0)     # per character, set in build()
FINGER_BONES = {
    "thumb": ((0.150, -0.016, 0.527), (0.163, -0.040, 0.506)),
    "index": ((0.157, -0.006, 0.526), (0.160, -0.007, 0.478)),
    "middle": ((0.155, -0.003, 0.529), (0.157, -0.003, 0.472)),
    "ring": ((0.152, 0.002, 0.527), (0.154, 0.002, 0.478)),
    "pinky": ((0.149, 0.007, 0.521), (0.150, 0.007, 0.488)),
}


def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.scene.render.fps = FPS


def material(name, rough=0.6, metal=0.0, rgb=None, emit=None, emit_strength=0.0, vcol=True, double=False):
    """vcol=True: base colour comes from the 'Col' colour attribute (glTF COLOR_0)."""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    p = nt.nodes["Principled BSDF"]
    p.inputs["Roughness"].default_value = rough
    p.inputs["Metallic"].default_value = metal
    if vcol:
        a = nt.nodes.new("ShaderNodeVertexColor")
        a.layer_name = "Col"
        nt.links.new(a.outputs["Color"], p.inputs["Base Color"])
    else:
        p.inputs["Base Color"].default_value = (*rgb, 1.0)
    if emit:
        p.inputs["Emission Color"].default_value = (*emit, 1.0)
        p.inputs["Emission Strength"].default_value = emit_strength
    m.use_backface_culling = not double
    return m


def make_materials(c):
    return {
        "skin": material("skin", rough=0.5),
        "hair": material("hair", rough=0.42, double=True),
        "cloth": material("cloth", rough=0.78, double=True),
        "shoe": material("shoe", rough=0.5),
        "eye": material("eye", rough=0.08),
        "glint": material("glint", rough=0.05, rgb=(1, 1, 1), emit=(1, 1, 1), emit_strength=2.5, vcol=False),
        "lash": material("lash", rough=0.5, rgb=srgb("#100a08"), vcol=False),
        "brow": material("brow", rough=0.7, rgb=mix(srgb(c["hair"]), srgb("#100a08"), 0.5), vcol=False),
        "mouth": material("mouth", rough=0.4, rgb=srgb("#8a3530"), vcol=False),
        "nose": material("nose", rough=0.55, rgb=mix(srgb(c["skin"]), srgb("#7a3f2a"), 0.22), vcol=False),
        "acc": material("acc", rough=0.35, metal=0.2, rgb=(0.02, 0.02, 0.02), vcol=False),
    }


# ---------------------------------------------------------------- armature
def link(obj):
    bpy.context.collection.objects.link(obj)
    return obj


def meta_object(name, res=META_RES):
    mb = bpy.data.metaballs.new(name)
    mb.resolution = res
    mb.render_resolution = res
    mb.threshold = 0.6
    return mb, link(bpy.data.objects.new(name, mb))


def build_rig():
    arm_data = bpy.data.armatures.new("CHE_Rig")
    arm = bpy.data.objects.new("CHE_Rig", arm_data)
    bpy.context.collection.objects.link(arm)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode="EDIT")
    EB = arm_data.edit_bones

    def bone(name, head, tail, parent=None):
        b = EB.new(name)
        b.head = Vector(head)
        b.tail = Vector(tail)
        if parent:
            b.parent = EB[parent]

    bone("pelvis", (0, 0, 0.57), (0, 0, 0.62))
    bone("spine", (0, 0, 0.62), (0, 0, 0.735), "pelvis")
    bone("chest", (0, 0, 0.735), (0, 0, 0.85), "spine")
    bone("neck", (0, 0, 0.85), (0, 0, 0.92), "chest")
    bone("head", (0, 0, 0.92), (0, 0, 1.12), "neck")
    for s, sx in (("L", 1), ("R", -1)):
        e = EYES[s]
        bone(f"eye.{s}", e, e + Vector((0, 0, 0.03)), "head")
        bone(f"shoulder.{s}", (0.045 * sx, 0, 0.885), (0.11 * sx, 0, 0.88), "chest")
        bone(f"upper_arm.{s}", (0.11 * sx, 0, 0.88), (0.135 * sx, 0, 0.69), f"shoulder.{s}")
        bone(f"forearm.{s}", (0.135 * sx, 0, 0.69), (0.148 * sx, 0, 0.555), f"upper_arm.{s}")
        bone(f"hand.{s}", (0.148 * sx, 0, 0.555), (0.155 * sx, 0, 0.455), f"forearm.{s}")
        for fname, (h, t) in FINGER_BONES.items():
            bone(f"{fname}.{s}", (h[0] * sx, h[1], h[2]), (t[0] * sx, t[1], t[2]), f"hand.{s}")
        bone(f"thigh.{s}", (0.072 * sx, 0, 0.60), (0.080 * sx, 0, 0.33), "pelvis")
        bone(f"shin.{s}", (0.080 * sx, 0, 0.33), (0.080 * sx, 0, 0.07), f"thigh.{s}")
        bone(f"foot.{s}", (0.080 * sx, 0, 0.07), (0.080 * sx, -0.13, 0.03), f"shin.{s}")
    bpy.ops.object.mode_set(mode="OBJECT")
    return arm


# ---------------------------------------------------------------- geometry helpers
A_VIS = 1 / 0.67


def add_ball(mb, c, r, stiff=2.0, scale=None):
    e = mb.elements.new(type="ELLIPSOID" if scale else "BALL")
    e.co = Vector(c)
    e.radius = r * A_VIS
    e.stiffness = stiff
    if scale:
        e.size_x, e.size_y, e.size_z = scale


def add_capsule(mb, a, b, r, stiff=2.0):
    a, b = Vector(a), Vector(b)
    d = b - a
    e = mb.elements.new(type="CAPSULE")
    e.co = (a + b) / 2
    e.radius = r * A_VIS
    e.stiffness = stiff
    e.size_x = max(d.length / 2, 1e-4)
    e.rotation = d.normalized().to_track_quat("X", "Y")


def convert_meta(mo, mat, name):
    bpy.ops.object.select_all(action="DESELECT")
    mo.select_set(True)
    bpy.context.view_layer.objects.active = mo
    bpy.ops.object.convert(target="MESH")
    obj = bpy.context.view_layer.objects.active
    obj.name = name
    obj.data.materials.append(mat)
    for p in obj.data.polygons:
        p.use_smooth = True
    return obj


def bm_to_obj(bm, name, mat):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for p in me.polygons:
        p.use_smooth = True
    obj = link(bpy.data.objects.new(name, me))
    obj.data.materials.append(mat)
    return obj


def surface_frame(n):
    """Columns: x = world-right along the surface, y = inward, z = up along the surface."""
    n = Vector(n).normalized()
    ez = (Vector((0, 0, 1)) - n * n.z).normalized()
    ex = ez.cross(n).normalized()
    return Matrix((ex, -n, ez)).transposed()


def ellipsoid(name, center, radii, mat, rot=None, seg=(24, 14), keep_bm=False):
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=seg[0], v_segments=seg[1], radius=1.0)
    local = [v.co.copy() for v in bm.verts]
    m = Matrix.Diagonal((*radii, 1.0))
    if rot is not None:
        m = rot.to_4x4() @ m
    bmesh.ops.transform(bm, matrix=Matrix.Translation(Vector(center)) @ m, verts=bm.verts)
    obj = bm_to_obj(bm, name, mat)
    return (obj, local) if keep_bm else obj


def tube(name, pts, radii, mat, closed=False, sides=8):
    """Swept tube through `pts` with per-point radius; open ends are capped."""
    pts = [Vector(p) for p in pts]
    if isinstance(radii, (int, float)):
        radii = [radii] * len(pts)
    bm = bmesh.new()
    rings = []
    n = len(pts)
    for i, p in enumerate(pts):
        a = pts[(i - 1) % n] if (closed or i > 0) else p
        b = pts[(i + 1) % n] if (closed or i < n - 1) else p
        t = (b - a).normalized()
        ref = Vector((0, 0, 1)) if abs(t.z) < 0.9 else Vector((1, 0, 0))
        u = t.cross(ref).normalized()
        v = t.cross(u).normalized()
        rings.append([bm.verts.new(p + (u * math.cos(2 * math.pi * k / sides) + v * math.sin(2 * math.pi * k / sides)) * radii[i])
                      for k in range(sides)])
    for i in range(n if closed else n - 1):
        r0, r1 = rings[i], rings[(i + 1) % n]
        for k in range(sides):
            bm.faces.new((r0[k], r0[(k + 1) % sides], r1[(k + 1) % sides], r1[k]))
    if not closed:
        bm.faces.new(list(reversed(rings[0])))
        bm.faces.new(rings[-1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return bm_to_obj(bm, name, mat)


def paint(obj, fn):
    """Per-vertex linear colour from fn(co, normal) into the 'Col' attribute."""
    me = obj.data
    me.update()
    attr = me.color_attributes.new("Col", "FLOAT_COLOR", "POINT")
    for v in me.vertices:
        attr.data[v.index].color = (*fn(v.co, v.normal), 1.0)
    me.color_attributes.active_color = attr


def solid(obj, rgb):
    paint(obj, lambda co, n: rgb)


def displace(obj, amount, scale, stretch=(1, 1, 1), seed=0.0, mask=None):
    """Push vertices along their normal by smooth noise (hair waves, fabric folds)."""
    me = obj.data
    me.update()
    off = Vector((seed, seed * 1.7, seed * 0.3))
    for v in me.vertices:
        if mask and not mask(v.co):
            continue
        p = Vector((v.co.x * stretch[0], v.co.y * stretch[1], v.co.z * stretch[2])) * scale + off
        v.co += v.normal * (pnoise(p) * amount)


def join(objs, name):
    objs = [o for o in objs if o]
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    if len(objs) > 1:
        bpy.ops.object.join()
    o = bpy.context.view_layer.objects.active
    o.name = name
    return o


def cut_below(obj, z):
    """Clean straight hem: remove everything under height z."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    geom = bm.verts[:] + bm.edges[:] + bm.faces[:]
    bmesh.ops.bisect_plane(bm, geom=geom, plane_co=(0, 0, z), plane_no=(0, 0, 1), clear_inner=True)
    bm.to_mesh(obj.data)
    bm.free()


def decimate(obj, ratio):
    m = obj.modifiers.new("dec", "DECIMATE")
    m.ratio = ratio
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.modifier_apply(modifier=m.name)
    for p in obj.data.polygons:
        p.use_smooth = True


def solidify(obj, thick):
    m = obj.modifiers.new("solid", "SOLIDIFY")
    m.thickness = thick
    m.offset = -1
    m.use_even_offset = True
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.modifier_apply(modifier=m.name)


def grid_surface(name, mat, nu, nv, fn, closed_u=False):
    """Quad surface from fn(u, v) -> point, u and v in 0..1."""
    bm = bmesh.new()
    cols = nu if closed_u else nu + 1
    V = [[bm.verts.new(fn((i % nu) / nu if closed_u else i / nu, j / nv)) for j in range(nv + 1)] for i in range(cols)]
    for i in range(nu):
        a, b = V[i], V[(i + 1) % cols]
        for j in range(nv):
            bm.faces.new((a[j], b[j], b[j + 1], a[j + 1]))
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return bm_to_obj(bm, name, mat)


# ---------------------------------------------------------------- head shape
def sph(theta, phi):
    """Direction from polar angle theta (0 = top) and azimuth phi (0 = front, +phi = character's left)."""
    return Vector((math.sin(theta) * math.sin(phi), -math.sin(theta) * math.cos(phi), math.cos(theta)))


def face_detail(p, d):
    """Lips sit on the front of the skin. p is relative to the head centre, d its unit direction."""
    if p.y > -0.02:
        return 0.0
    lz = p.z - (MOUTH_Z)
    lx = p.x
    upper = math.exp(-(lx / 0.017) ** 2 - ((lz - 0.003) / 0.0045) ** 2) * 0.0042 * FACE["lips"]
    lower = math.exp(-(lx / 0.016) ** 2 - ((lz + 0.0065) / 0.0055) ** 2) * 0.0050 * FACE["lips"]
    return upper + lower


def head_point(d, off=0.0):
    d = Vector(d).normalized()
    r = 1 / math.sqrt((d.x / HA[0]) ** 2 + (d.y / HA[1]) ** 2 + (d.z / HA[2]) ** 2)
    p = d * r
    if p.z < 0:                                   # softer, narrower lower face and chin
        k = (-p.z / HA[2]) ** 2
        p.x *= 1 - 0.22 * k
        p.y *= 1 - 0.07 * k
    for sx in (1, -1):                            # cheek fullness, relative to the head
        w = math.exp(-((p - Vector((0.52 * HA[0] * sx, -0.70 * HA[1], -0.36 * HA[2]))).length / (0.36 * HA[2])) ** 2)
        p += d * 0.05 * HA[2] * w
    p += d * face_detail(p, d)
    if p.y < -0.02:
        for sx in (1, -1):
            lid = math.exp(-((p.x - EYE_X * sx) / 0.0135) ** 2 - ((p.z - (EYE_DZ + 0.0045)) / 0.0038) ** 2)
            p += d * 0.0026 * FACE["eye"] * lid
    return H + p + d * off


EYES = {s: H + Vector((EYE_X * sx, 0, EYE_DZ)) for s, sx in (("L", 1), ("R", -1))}


# ---------------------------------------------------------------- body
def loft(name, mat, profile, infl=0.0, n=2.4, rings=20, sides=44):
    """Torso skin: a superelliptic cross-section swept up the body through (z, half width, half depth) points."""
    zs = [p[0] for p in profile]

    def wd(z):
        for (z0, w0, d0), (z1, w1, d1) in zip(profile, profile[1:]):
            if z0 <= z <= z1:
                t = smoothstep((z - z0) / (z1 - z0))
                return w0 + (w1 - w0) * t + infl, d0 + (d1 - d0) * t + infl
        return profile[-1][1] + infl, profile[-1][2] + infl

    def f(u, v):
        th = 2 * math.pi * u
        z = zs[0] + (zs[-1] - zs[0]) * v
        w, d = wd(z)
        c, s = math.cos(th), math.sin(th)
        return Vector((w * math.copysign(abs(c) ** (2 / n), c), d * math.copysign(abs(s) ** (2 / n), s), z))
    return grid_surface(name, mat, sides, rings, f, closed_u=True)


TORSO = [
    (0.555, 0.072, 0.052),   # crotch
    (0.615, 0.112, 0.082),   # hips
    (0.680, 0.094, 0.068),   # waist (low)
    (0.735, 0.084, 0.062),   # waist
    (0.790, 0.098, 0.072),   # ribcage
    (0.845, 0.116, 0.080),   # chest
    (0.880, 0.120, 0.072),   # shoulder line
    (0.905, 0.070, 0.050),   # neck base
]


def body_parts(mb, i=0.0):
    """Legs and hips as metaballs (inflated by i for garments)."""
    for sx in (1, -1):
        add_ball(mb, (0.07 * sx, 0, 0.60), 0.058 + i)                          # hip joint
        add_capsule(mb, (0.072 * sx, 0, 0.60), (0.080 * sx, 0, 0.36), 0.056 + i)   # thigh
        add_capsule(mb, (0.080 * sx, 0, 0.345), (0.080 * sx, 0, 0.10), 0.040 + i)  # shin
        add_capsule(mb, (0.080 * sx, 0, 0.10), (0.080 * sx, 0, 0.06), 0.028 + i)   # ankle


def arm_parts(mb, i=0.0, palms=False):
    """Arms are their own metaball object so they never melt into the torso."""
    for sx in (1, -1):
        add_ball(mb, (0.105 * sx, 0, 0.875), 0.040 + i)                                   # shoulder cap
        add_capsule(mb, (0.112 * sx, 0, 0.88), (0.135 * sx, 0, 0.69), 0.031 + i)           # upper arm
        add_capsule(mb, (0.135 * sx, 0, 0.69), (0.148 * sx, 0, 0.555), 0.025 + i)          # forearm
        if palms:
            add_ball(mb, (0.150 * sx, -0.002, 0.50), 0.028, 2.0, (0.92, 0.55, 1.25))       # palm


def build_head(mat):
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=72, v_segments=48, radius=1.0)
    for v in bm.verts:
        v.co = head_point(v.co)
    return bm_to_obj(bm, "head_mesh", mat)


# ---------------------------------------------------------------- hair
def hairline(phi, front, side, back):
    """Polar angle where the hair cap ends, interpolated front -> side -> back."""
    a = abs(math.atan2(math.sin(phi), math.cos(phi)))
    if a < math.pi / 2:
        t = a / (math.pi / 2)
        return front + (side - front) * (1 - math.cos(t * math.pi)) / 2
    t = (a - math.pi / 2) / (math.pi / 2)
    return side + (back - side) * (1 - math.cos(t * math.pi)) / 2


def hair_cap(M, front, side, back, off=0.018, top=0.02, part=0.0):
    def f(u, v):
        phi = -math.pi + 2 * math.pi * u
        th = max(1e-3, v) * hairline(phi, front, side, back)
        lift = top * HS * math.cos(min(th, math.pi / 2)) ** 2                  # volume on top
        lift += 0.006 * HS * math.exp(-((phi - part) / 0.25) ** 2) * (1 - v)  # side part
        return head_point(sph(th, phi), off * HS + lift)
    cap = grid_surface("hair_cap", M["hair"], 64, 20, f, closed_u=True)
    solidify(cap, 0.016 * HS)
    return cap


def hair_skirt(M, z_end, flare, phi0=0.95, wave=0.012, start_th=1.45):
    """Long hair falling from the cap at the sides and back down to z_end (absolute height)."""
    def f(u, v):
        phi = phi0 + (2 * math.pi - 2 * phi0) * u
        top = head_point(sph(start_th, phi), 0.022 * HS)
        side = Vector((math.sin(phi), -math.cos(phi) * 0.82, 0))
        r0 = Vector((top.x, top.y, 0)).length
        bottom_z = z_end + 0.03 * math.sin(phi * 7) - 0.04 * math.cos(phi) ** 2 * (math.cos(phi) < 0)
        z = top.z + (bottom_z - top.z) * v
        r = r0 + flare * HS * (v ** 0.7) + wave * HS * math.sin(v * 9 + phi * 4) * v
        p = side * r
        return Vector((p.x, p.y + 0.01 * HS * v, z))
    skirt = grid_surface("hair_skirt", M["hair"], 80, 24, f)
    solidify(skirt, 0.03 * HS)
    return skirt


def hair_strands(M, n, z_end, phi0=0.9, seed=11, th_range=(1.05, 1.4), fall=0.42):
    """Long hair as separate strands that leave the scalp and fall past the shoulders."""
    random.seed(seed)
    strands = []
    for k in range(n):
        phi = -math.pi + (2 * math.pi) * (k + random.random() * 0.6) / n
        if abs(phi) < phi0:                       # the face and the fringe stay clear of strands
            continue
        th0 = random.uniform(*th_range)
        out = Vector((math.sin(phi), -math.cos(phi), 0.0)).normalized()
        base = head_point(sph(th0, phi), 0.012 * HS)
        drop = base.z - (z_end + random.uniform(-0.06, 0.02))
        steps = 6
        pts, rad = [], []
        for s in range(steps + 1):
            t = s / steps
            p = base + out * (0.010 * HS * t * (1 + fall)) + Vector((0, 0, -drop * t))
            p += out * 0.016 * HS * math.sin(t * 6 + k * 0.7) * t
            p += Vector((0.010 * HS * math.sin(t * 4 + k), 0, 0)) * t
            pts.append(p)
            rad.append(0.0042 * HS * (1.0 - 0.4 * t))
        strands.append(tube(f"strand{k}", pts, rad, M["hair"], sides=5))
    return join(strands, "hair_strands")


def hair_fringe(M, th_left, th_right, span=0.95, off=0.03, scallop=0.06):
    """Side-swept bangs: longer on the character's right (th_right) than the left."""
    def f(u, v):
        phi = -span + 2 * span * u
        end = th_right + (th_left - th_right) * u - scallop * abs(math.sin(u * math.pi * 5))
        th = 0.25 + (end - 0.25) * v
        return head_point(sph(th, phi), off * HS + 0.006 * HS * math.sin(v * math.pi))
    fr = grid_surface("hair_fringe", M["hair"], 40, 14, f)
    solidify(fr, 0.012 * HS)
    return fr


def meta_curls(M, pts, name="hair_curls", res=0.005):
    mb, mo = meta_object(name + "_mb", res)
    for c, r in pts:
        add_ball(mb, c, r)
    o = convert_meta(mo, M["hair"], name)
    decimate(o, 0.45)
    return o


def scatter_on_head(n, seed, th_min, th_max, skip_face, off, rmin, rmax, lift=0.0, skip=None):
    random.seed(seed)
    out = []
    while len(out) < n:
        th = math.acos(random.uniform(math.cos(th_max), math.cos(th_min)))
        phi = random.uniform(-math.pi, math.pi)
        if skip_face and abs(phi) < skip_face[0] and th > skip_face[1]:
            continue
        if skip and skip(th, phi):
            continue
        out.append((head_point(sph(th, phi), off * HS) + Vector((0, 0, lift * HS)), random.uniform(rmin, rmax) * HS))
    return out


def build_hair(c, M):
    style = c["hair_style"]
    parts = []
    if style == "long_wavy":
        parts += [hair_cap(M, 1.05, 1.55, 2.3, part=-0.35),
                  hair_strands(M, 46, 0.66, seed=21, phi0=1.15),
                  hair_fringe(M, 1.08, 1.40)]
    elif style == "wavy_medium":
        parts += [hair_cap(M, 1.05, 1.55, 2.3, part=0.35),
                  hair_strands(M, 40, 0.80, seed=33, th_range=(1.1, 1.45), phi0=1.1),
                  hair_fringe(M, 1.32, 1.12)]
    elif style == "curly_short":
        parts += [hair_cap(M, 1.0, 1.45, 2.05, off=0.02, top=0.03),
                  meta_curls(M, scatter_on_head(34, 7, 0.0, 1.35, (0.9, 0.75), 0.03, 0.032, 0.045)
                             + [(head_point(sph(0.92 + 0.08 * (k % 2), -0.6 + 0.3 * k), 0.035 * HS), 0.036 * HS) for k in range(5)])]
    elif style == "afro":
        parts += [hair_cap(M, 1.0, 1.5, 2.1, off=0.02, top=0.03),
                  meta_curls(M, scatter_on_head(240, 3, 0.0, 1.95, (1.0, 0.9), 0.07, 0.03, 0.038, lift=0.015,
                                                skip=lambda th, phi: th > 1.45 and abs(abs(phi) - math.pi / 2) < 0.45), res=0.005)]
    elif style == "bun_high":
        parts += [hair_cap(M, 1.02, 1.6, 2.3, off=0.012, top=0.012, part=0.3),
                  meta_curls(M, [(H + Vector((0, 0.02 * HS, 0.25 * HS)), 0.085 * HS), (H + Vector((0.04 * HS, 0.0, 0.29 * HS)), 0.05 * HS),
                                 (H + Vector((-0.04 * HS, 0.04 * HS, 0.28 * HS)), 0.05 * HS)], "hair_bun"),
                  tube("strand_l", [head_point(sph(1.1, 0.95), 0.02 * HS), head_point(sph(1.55, 1.05), 0.03 * HS), head_point(sph(1.95, 1.0), 0.03 * HS)], [0.012 * HS, 0.011 * HS, 0.006 * HS], M["hair"]),
                  tube("strand_r", [head_point(sph(1.1, -0.95), 0.02 * HS), head_point(sph(1.55, -1.05), 0.03 * HS), head_point(sph(1.95, -1.0), 0.03 * HS)], [0.012 * HS, 0.011 * HS, 0.006 * HS], M["hair"])]
    elif style == "bun_low":
        parts += [hair_cap(M, 1.02, 1.6, 2.3, off=0.012, top=0.012, part=-0.3),
                  meta_curls(M, [(H + Vector((0, 0.17 * HS, 0.12 * HS)), 0.08 * HS), (H + Vector((0.03 * HS, 0.17 * HS, 0.17 * HS)), 0.045 * HS)], "hair_bun"),
                  hair_fringe(M, 1.15, 1.0, span=0.8, off=0.022, scallop=0.04)]
    elif style == "beanie":
        parts += [hair_cap(M, 1.15, 1.85, 2.25, off=0.014, top=0.0),
                  hair_fringe(M, 1.38, 1.28, span=0.9, off=0.026, scallop=0.08)]
    hair = join(parts, "hair")
    displace(hair, 0.008 * HS, 22.0, (1.0, 1.0, 0.3), seed=4.0)       # waves
    displace(hair, 0.003 * HS, 90.0, (1.0, 1.0, 0.15), seed=9.0)      # strand grooves
    dark, hi = srgb(c["hair"]), srgb(c["hair_hi"])

    def col(co, n):
        a = math.atan2(co.x, -co.y)
        streak = 0.5 + 0.5 * pnoise(Vector((a * 9, co.z * 6, 0.5)))
        sheen = max(0.0, n.z) * 0.35 + max(0.0, -n.y) * 0.1
        return mix(dark, hi, min(1.0, 0.1 + 0.6 * streak ** 2 + sheen))
    paint(hair, col)
    return hair


def eye_material(cid, white, iris, light, dark, pupil, size=256):
    """Paint the eye (sclera, iris with light lower half, pupil, lid shadow) into a texture."""
    import numpy as np
    n = size
    w, u = np.mgrid[0:n, 0:n].astype(np.float32)
    u = (u + 0.5) / n * 2 - 1
    w = (w + 0.5) / n * 2 - 1
    aa = 2.5 / n
    c = lambda t: np.array(t, dtype=np.float32)

    def cover(d):                     # d < 0 inside; smooth 1 -> 0 edge
        return np.clip(0.5 - d / aa, 0, 1)[..., None]
    img = np.broadcast_to(c(white), (n, n, 3)).copy()
    img = img * (1 - np.clip(w - 0.5, 0, 1)[..., None] * 0.35)                 # lid shadow
    iris_d = np.sqrt((u / 0.80) ** 2 + ((w + 0.02) / 0.94) ** 2) - 1
    t = np.clip((w + 0.55) / 0.9, 0, 1)[..., None]
    iris_col = c(light) * (1 - t) + c(iris) * t
    iris_col = iris_col * (1 - np.clip(w - 0.35, 0, 1)[..., None] * 1.2) + c(dark) * np.clip(w - 0.35, 0, 1)[..., None] * 1.2
    ring = np.clip(1 - np.abs(iris_d + 0.05) / 0.06, 0, 1)[..., None]           # darker iris rim
    iris_col = iris_col * (1 - ring * 0.6) + c(dark) * ring * 0.6
    k = cover(iris_d)
    img = img * (1 - k) + iris_col * k
    k = cover(np.sqrt((u / 0.42) ** 2 + ((w + 0.02) / 0.52) ** 2) - 1)
    img = img * (1 - k) + c(pupil) * k
    rgba = np.concatenate([np.clip(img, 0, 1), np.ones((n, n, 1), np.float32)], axis=2)
    im = bpy.data.images.new(f"eye_{cid}", n, n, alpha=False, float_buffer=False)
    im.colorspace_settings.name = "sRGB"
    lin = rgba.copy()
    lin[..., :3] = np.where(lin[..., :3] <= 0.0031308, lin[..., :3] * 12.92, 1.055 * np.power(lin[..., :3], 1 / 2.4) - 0.055)
    im.pixels.foreach_set(lin.ravel())
    im.pack()
    m = bpy.data.materials.new("eye")
    m.use_nodes = True
    nt = m.node_tree
    p = nt.nodes["Principled BSDF"]
    p.inputs["Roughness"].default_value = 0.08
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = im
    nt.links.new(tex.outputs["Color"], p.inputs["Base Color"])
    return m


# ---------------------------------------------------------------- shape keys (blink, mouth, expression)
MOUTH = Vector((0, -0.07, 0))


def _front(co):
    return smoothstep((-co.y - 0.025) / 0.03)


def add_shape_keys(body):
    """Blink and mouth targets on the skin. Each key moves vertices by position only."""
    base = [v.co.copy() for v in body.data.vertices]
    body.shape_key_add(name="Basis", from_mix=False)

    def key(name, fn):
        k = body.shape_key_add(name=name, from_mix=False)
        for i, co in enumerate(base):
            k.data[i].co = fn(co.copy())

    def mouth_c(co):
        return Vector((co.x, co.y + 0.075, co.z - H.z - MOUTH_Z))

    def open_fn(co):
        f = _front(co)
        d = mouth_c(co)
        w = math.exp(-((co.x / 0.034) ** 2 + (d.y / 0.04) ** 2 + (d.z / 0.034) ** 2)) * f
        co.z -= 0.022 * w
        co.y += 0.005 * w
        return co

    def wide_fn(co):
        f = _front(co)
        d = mouth_c(co)
        w = math.exp(-((co.x / 0.03) ** 2 + (d.z / 0.011) ** 2)) * f
        co.x += math.copysign(0.0065 * w, co.x) if abs(co.x) > 1e-6 else 0.0
        co.z += 0.0025 * w
        return co

    def round_fn(co):
        f = _front(co)
        d = mouth_c(co)
        w = math.exp(-((co.x / 0.026) ** 2 + (d.z / 0.02) ** 2)) * f
        co.x -= co.x * 0.32 * w
        co.y -= 0.004 * w
        return co

    def blink_fn(co):
        for s, sx in (("L", 1), ("R", -1)):
            e = EYES[s]
            dx, dz = co.x - e.x, co.z - e.z
            if dz < -0.012:
                continue
            w = math.exp(-((dx / 0.017) ** 2) - ((dz + 0.002) / 0.012) ** 2) * _front(co)
            if w > 1e-4:
                co = co + (Vector((e.x, -0.062, e.z)) - co) * 0.85 * w
        return co

    key("blink", blink_fn)
    key("mouth_open", open_fn)
    key("mouth_wide", wide_fn)
    key("mouth_round", round_fn)
    body.data.shape_keys.use_relative = True


# ---------------------------------------------------------------- build one character
def build(cid):
    global FACE
    c = CHARACTERS[cid]
    FACE = {"eye": 1.0, "nose": 1.0, "lips": 1.0, "brow": 1.0, **c.get("face", {})}
    reset_scene()
    M = make_materials(c)
    arm = build_rig()

    def rigid(obj, bone_name):
        g = obj.vertex_groups.new(name=bone_name)
        g.add(range(len(obj.data.vertices)), 1.0, "REPLACE")
        m = obj.modifiers.new("Armature", "ARMATURE")
        m.object = arm
        obj.parent = arm

    def auto_skin(obj):
        bpy.ops.object.mode_set(mode="OBJECT")
        bpy.ops.object.select_all(action="DESELECT")
        obj.select_set(True)
        arm.select_set(True)
        bpy.context.view_layer.objects.active = arm
        bpy.ops.object.parent_set(type="ARMATURE_AUTO")

    skin = srgb(c["skin"])
    blush = mix(skin, srgb("#ff7a72"), 0.42)
    lip_c = mix(skin, srgb("#b35a52"), 0.55)

    # ---- body: lofted torso, metaball legs, neck, ears, head mesh
    torso = loft("torso", M["skin"], TORSO)
    mb, mo = meta_object("legs_mb", 0.008)
    body_parts(mb)
    legs = convert_meta(mo, M["skin"], "legs")
    neck = tube("neck", [(0, 0, 0.82), (0, 0, 0.90), (0, 0, 0.97)], [0.050, 0.043, 0.041], M["skin"], sides=16)
    ears = [ellipsoid(f"ear{sx}", H + Vector((0.058 * sx, 0.004, -0.012)), (0.011, 0.007, 0.018), M["skin"], seg=(16, 10)) for sx in (1, -1)]
    head = build_head(M["skin"])
    mb, mo = meta_object("arms_mb", 0.008)
    arm_parts(mb, palms=True)
    arms = convert_meta(mo, M["skin"], "arms")
    body = join([torso, legs, neck, arms, head] + ears, f"{cid}_body")
    decimate(body, 0.32)
    cheeks = [head_point(sph(1.72, 0.62 * sx)) for sx in (1, -1)]

    def skin_col(co, n):
        d = min((co - k).length for k in cheeks)
        base = mix(skin, blush, 0.8 * max(0.0, 1 - d / 0.035) ** 1.2)
        lz = co.z - H.z - MOUTH_Z
        if co.y < -0.06 and abs(co.x) < 0.016 and abs(lz) < 0.0085:
            base = mix(base, lip_c, 0.9)
        return base
    paint(body, skin_col)

    # ---- top: jacket (open front shows the shirt), hoodie or sweater
    top_c, inner_c, kind = srgb(c["top_color"]), srgb(c["inner"]), c["top"]
    top_torso = loft("top_torso", M["cloth"], TORSO, infl=0.011)
    cut_below(top_torso, 0.600)
    mb, mo = meta_object("sleeves_mb")
    arm_parts(mb, i=0.010)
    for sx in (1, -1):
        add_capsule(mb, (0.142 * sx, 0, 0.56), (0.148 * sx, 0, 0.58), 0.034)           # cuff band
    sleeves = convert_meta(mo, M["cloth"], "sleeves")
    top = join([top_torso, sleeves], f"{cid}_top")
    decimate(top, 0.3)
    displace(top, 0.0022, 55.0, (1.0, 1.0, 0.4), seed=2.0)

    def top_col(co, n):
        base = top_c
        if abs(co.x) > 0.125 and co.z < 0.56:
            base = mix(top_c, (0, 0, 0), 0.2)                                   # cuffs
        if kind == "jacket" and co.y < 0:
            w = 0.016 + 0.05 * max(0.0, co.z - 0.70)                             # opening widens to the collar
            e = abs(co.x) - w
            if abs(co.x) < 0.1 and e < 0.006:
                t = max(0.0, min(1.0, (e + 0.006) / 0.012))
                return mix(inner_c, mix(top_c, (0, 0, 0), 0.3 * (1 - t)), t)
        if kind == "hoodie" and co.y < 0 and abs(co.x) < 0.07 and 0.42 < co.z < 0.48:
            return mix(top_c, (0, 0, 0), 0.12)                                  # front pocket
        return base
    paint(top, top_col)

    mb, mo = meta_object("pants_mb", 0.011)
    for sx in (1, -1):
        add_ball(mb, (0.07 * sx, 0, 0.60), 0.068)
        add_capsule(mb, (0.072 * sx, 0, 0.60), (0.080 * sx, 0, 0.36), 0.066)
        add_capsule(mb, (0.080 * sx, 0, 0.345), (0.080 * sx, 0, 0.10), 0.050)
    pants = convert_meta(mo, M["cloth"], f"{cid}_pants")
    decimate(pants, 0.3)
    displace(pants, 0.0022, 50.0, (1, 1, 0.3), seed=5.0)
    solid(pants, srgb(c["pants"]))

    hair = build_hair(c, M)
    hair.name = f"{cid}_hair"
    rigid(hair, "head")

    # ---- face, placed on the real head surface
    head_bvh = BVHTree.FromObject(body, bpy.context.evaluated_depsgraph_get())

    def on_face(x, z):
        hit = head_bvh.ray_cast(Vector((x, -0.6, z)), Vector((0, 1, 0)))
        return hit[0], hit[1]

    iris_c = srgb(c["eyes"])
    iris_dark = mix(iris_c, (0, 0, 0), 0.6)
    iris_light = mix(iris_c, srgb("#c08850"), 0.55)
    white = srgb("#f6f1ea")
    pupil = srgb("#0a0605")
    er = tuple(v * FACE["eye"] for v in ER)

    eye_mat = eye_material(cid, white, iris_c, iris_light, iris_dark, pupil)

    for s, sx in (("L", 1), ("R", -1)):
        p, n = on_face(EYES[s].x, EYES[s].z)
        n = (n + Vector((0, -0.35, 0))).normalized()                # eyes look slightly forward
        R = surface_frame(n)
        centre = p - n * 0.006
        eye, local = ellipsoid(f"eye.{s}", centre, er, eye_mat, R, seg=(24, 16), keep_bm=True)
        uv = eye.data.uv_layers.new(name="UVMap")
        for loop in eye.data.loops:
            lc = local[loop.vertex_index]
            # Front projection; the back half is hidden inside the head.
            uv.data[loop.index].uv = (0.5 + 0.5 * lc.x * (1 if lc.y < 0 else 0.3), 0.5 + 0.5 * lc.z)
        rigid(eye, f"eye.{s}")

        def eye_pt(u, w, out=0.0):
            d = math.sqrt(max(0.0, 1 - u * u - w * w))
            return centre + R @ Vector((u * er[0], -d * er[1], w * er[2])) + n * out

        for k, (u, w, r) in enumerate(((0.32, 0.38, 0.0042), (-0.3, -0.32, 0.0018))):
            g = ellipsoid(f"glint{k}.{s}", eye_pt(u, w, 0.0006), (r, r * 0.4, r * 1.15), M["glint"], R, seg=(10, 6))
            rigid(g, f"eye.{s}")
        # Upper lash line, thicker toward the outer corner, ending in a flick.
        pts, rad = [], []
        for k in range(13):
            a = math.pi * (0.04 + 0.9 * k / 12)
            u, w = math.cos(a) * 0.97, math.sin(a) * 0.9 + 0.05
            pts.append(eye_pt(u, w, 0.0012))
            outer = (u * sx + 1) / 2
            rad.append(0.0011 + 0.0016 * outer * math.sin(math.pi * k / 12) ** 0.3)
        pts = ([eye_pt(1.0 * sx, 0.25, 0.001) + Vector((0.003 * sx, 0, 0.003))] if sx < 0 else []) + pts \
            + ([eye_pt(1.0 * sx, 0.25, 0.001) + Vector((0.003 * sx, 0, 0.003))] if sx > 0 else [])
        rad = ([0.0009] if sx < 0 else []) + rad + ([0.0009] if sx > 0 else [])
        rigid(tube(f"lash.{s}", pts, rad, M["lash"]), f"eye.{s}")
        # Brow: a soft arch above the eye, a little heavier on some faces.
        bpts = []
        for k in range(7):
            t = k / 6
            bx = EYES[s].x + (-0.012 + 0.030 * t) * sx
            bz = EYES[s].z + 0.030 * FACE["brow"] + 0.004 * math.sin(math.pi * t) - 0.002 * t
            bp, bn = on_face(bx, bz)
            bpts.append(bp + bn * 0.001)
        rigid(tube(f"brow.{s}", bpts, [0.0012, 0.0017, 0.0019, 0.0019, 0.0017, 0.0014, 0.0008], M["brow"]), "head")

    p, n = on_face(0, H.z + NOSE_Z)
    rigid(ellipsoid("nose", p + n * 0.002, (0.0075 * FACE["nose"], 0.0055, 0.0095), M["nose"], surface_frame(n)), "head")

    # ---- accessories (positions scale with the head)
    def acc_mat(o, hexc, rough=0.35, metal=0.3):
        o.data.materials.clear()
        o.data.materials.append(material(f"acc_{o.name}", rough=rough, metal=metal, rgb=srgb(hexc), vcol=False))

    if c.get("earrings"):
        for sx in (1, -1):
            ec = head_point(sph(1.95, 1.62 * sx), 0.001)
            ring = [ec + Vector((0, 0.006 * math.cos(2 * math.pi * k / 18), -0.007 + 0.007 * math.sin(2 * math.pi * k / 18))) for k in range(18)]
            e = tube(f"earring{sx}", ring, 0.0011, M["acc"], closed=True, sides=6)
            acc_mat(e, c["earrings"], 0.25, 0.9)
            rigid(e, "head")
    if c.get("glasses"):
        objs = []
        rx, rz = 0.72 * EYE_X * FACE["eye"] + 0.004, 0.66 * EYE_X * FACE["eye"] + 0.002
        for s, sx in (("L", 1), ("R", -1)):
            p, n = on_face(EYES[s].x, EYES[s].z)
            R = surface_frame((n + Vector((0, -1.5, 0))).normalized())
            rim = [p + R @ Vector((rx * math.cos(2 * math.pi * k / 24), -0.010, rz * math.sin(2 * math.pi * k / 24))) for k in range(24)]
            objs.append(tube(f"rim.{s}", rim, 0.0014, M["acc"], closed=True, sides=6))
            objs.append(tube(f"arm.{s}", [p + R @ Vector((rx * sx, -0.010, 0.003)),
                                          head_point(sph(1.55, 1.5 * sx), 0.003)], 0.0012, M["acc"]))
        bp, bn = on_face(0, EYES["L"].z + 0.004)
        objs.append(tube("bridge", [Vector((-0.009, bp.y - 0.009, EYES["L"].z + 0.004)),
                                    Vector((0, bp.y - 0.011, EYES["L"].z + 0.006)),
                                    Vector((0.009, bp.y - 0.009, EYES["L"].z + 0.004))], 0.0013, M["acc"]))
        g = join(objs, "glasses")
        acc_mat(g, c["glasses"], 0.3, 0.2)
        rigid(g, "head")
    if c.get("headphones"):
        band = [H + Vector((1.275 * HA[0] * math.cos(math.pi * k / 20), 0.0, 1.76 * HA[2] * math.sin(math.pi * k / 20))) for k in range(21)]
        objs = [tube("hp_band", band, 0.0055, M["acc"], sides=10)]
        for sx in (1, -1):
            objs.append(ellipsoid(f"hp_cup{sx}", H + Vector((0.068 * sx, 0.0, -0.012)), (0.014, 0.021, 0.024), M["acc"]))
            objs.append(ellipsoid(f"hp_pad{sx}", H + Vector((0.058 * sx, 0.0, -0.012)), (0.005, 0.018, 0.021), M["acc"]))
        g = join(objs, "headphones")
        acc_mat(g, c["headphones"], 0.3, 0.4)
        rigid(g, "head")
    if c.get("beanie"):
        def bf(u, v):
            phi = -math.pi + 2 * math.pi * u
            th = max(1e-3, v) * hairline(phi, 1.18, 1.5, 1.8)
            return head_point(sph(th, phi), (0.03 + 0.02 * math.cos(min(th, 1.5)) ** 2) * HS)
        cap = grid_surface("beanie", M["acc"], 56, 16, bf, closed_u=True)
        solidify(cap, 0.012 * HS)
        displace(cap, 0.0025 * HS, 70.0, (1.0, 1.0, 0.05))
        brims = [tube(f"brim{j}", [head_point(sph(hairline(-math.pi + 2 * math.pi * k / 48, 1.18, 1.5, 1.8) - 0.05 - 0.13 * j, -math.pi + 2 * math.pi * k / 48), 0.03 * HS)
                                  for k in range(36)], 0.02 * HS, M["acc"], closed=True, sides=8) for j in range(2)]
        brim = join(brims, "brim")
        displace(brim, 0.003 * HS, 90.0, (1.0, 1.0, 0.05))
        g = join([cap, brim], "beanie_all")
        acc_mat(g, c["beanie"], 0.85, 0.0)
        rigid(g, "head")
    if c.get("beard"):
        def jaw(u, v):
            phi = -1.4 + 2.8 * u
            top = 2.22 - 0.5 * max(0.0, abs(phi) - 0.55) / 0.85        # sideburns rise toward the ears
            th = top + (2.72 - top) * v
            return head_point(sph(th, phi), (0.006 + 0.008 * math.sin(v * math.pi)) * HS)
        beard = grid_surface("beard", M["hair"], 40, 10, jaw)
        solidify(beard, 0.01 * HS)
        mp, mn = on_face(0, H.z + MOUTH_Z - 0.012)
        must = tube("moustache", [mp + Vector((0.012 * t, -0.002, -0.002 * t * t)) for t in (-1, -0.5, 0, 0.5, 1)],
                    [0.0016, 0.0028, 0.0028, 0.0028, 0.0016], M["hair"])
        beard = join([beard, must], "beard_all")
        displace(beard, 0.002 * HS, 140.0)
        solid(beard, mix(srgb(c["hair"]), srgb(c["hair_hi"]), 0.25))
        rigid(beard, "head")

    # ---- shoes (sneakers) and fingers
    sole, upper = srgb(c["sole"]), srgb(c["shoes"])
    for s, sx in (("L", 1), ("R", -1)):
        mb, mo = meta_object(f"shoe_mb.{s}", 0.010)
        add_capsule(mb, (0.080 * sx, 0.03, 0.040), (0.080 * sx, -0.095, 0.036), 0.033)
        add_ball(mb, (0.080 * sx, -0.110, 0.032), 0.031, 2.0, (1.1, 1.0, 0.85))
        add_capsule(mb, (0.080 * sx, 0.01, 0.065), (0.080 * sx, 0.0, 0.095), 0.028)
        shoe = convert_meta(mo, M["shoe"], f"shoe.{s}")
        paint(shoe, lambda co, n: sole if co.z < 0.02 else upper)
        rigid(shoe, f"foot.{s}")
        for fname in FINGER_BONES:
            bb = arm.data.bones[f"{fname}.{s}"]
            mb, mo = meta_object(f"{fname}_mb.{s}", FINGER_RES)
            add_capsule(mb, bb.head_local, bb.tail_local, 0.0056 if fname == "thumb" else 0.0046)
            fm = convert_meta(mo, M["skin"], f"{fname}_finger.{s}")
            solid(fm, skin)
            rigid(fm, f"{fname}.{s}")

    for obj in (body, top, pants):
        auto_skin(obj)
    add_shape_keys(body)

    for clip_name, n, fn, loops in CLIPS:
        bake_clip(arm, [b.name for b in arm.data.bones], clip_name, n, fn, loops)
    arm.animation_data.action = bpy.data.actions["idle"]
    return c


# ---------------------------------------------------------------- animation clips
TAU = 2 * math.pi
FINGERS = list(FINGER_BONES)


def S(t, k=1):
    return math.sin(TAU * k * t)


def smooth(x):
    return x * x * (3 - 2 * x)


def mz(side, v):
    """Sideways (Y) angles mirror for the left side."""
    return v if side == "R" else -v


def fingers(P, curl):
    for s in ("L", "R"):
        for f in FINGERS:
            P[f"{f}.{s}"] = (curl, 0, 0)
    return P


def idle(t):
    P = {
        "chest": (0.016 * S(t), 0, 0),
        "spine": (0.008 * S(t), 0.012 * S(t, 2), 0),
        "head": (0.02 * S(t) - 0.02, 0.04 * math.sin(TAU * t + 0.6), 0.03 * math.sin(TAU * t + 2.0)),
        "upper_arm.L": (0.03 * S(t), 0, mz("L", 0.1)),
        "upper_arm.R": (0.03 * math.sin(TAU * t + 0.8), 0, mz("R", 0.1)),
        "forearm.L": (-0.12, 0, 0),
        "forearm.R": (-0.12, 0, 0),
        "_loc": (0, 0, 0.002 * S(t)),
    }
    return fingers(P, 0.2)


def walk(t):
    a = 0.42 * S(t)
    P = {
        "thigh.L": (a, 0, 0),
        "thigh.R": (-a, 0, 0),
        "shin.L": (0.62 * max(0.0, math.cos(TAU * t)), 0, 0),
        "shin.R": (0.62 * max(0.0, -math.cos(TAU * t)), 0, 0),
        "upper_arm.L": (-0.6 * a, 0, mz("L", 0.1)),
        "upper_arm.R": (0.6 * a, 0, mz("R", 0.1)),
        "forearm.L": (-0.28, 0, 0),
        "forearm.R": (-0.28, 0, 0),
        "spine": (0, 0.05 * S(t), 0),
        "chest": (0, -0.04 * S(t), 0),
        "head": (0.02 * S(t, 2), 0, 0),
        "_loc": (0, 0, 0.007 * (1 - math.cos(2 * TAU * t))),
    }
    return fingers(P, 0.2)


def run(t):
    a = 0.75 * S(t)
    P = {
        "thigh.L": (a, 0, 0),
        "thigh.R": (-a, 0, 0),
        "shin.L": (1.0 * max(0.0, math.cos(TAU * t)), 0, 0),
        "shin.R": (1.0 * max(0.0, -math.cos(TAU * t)), 0, 0),
        "upper_arm.L": (-0.95 * a, 0, mz("L", 0.14)),
        "upper_arm.R": (0.95 * a, 0, mz("R", 0.14)),
        "forearm.L": (-1.2, 0, 0),
        "forearm.R": (-1.2, 0, 0),
        "chest": (0.14, 0, 0),
        "spine": (0, 0.07 * S(t), 0),
        "_loc": (0, 0, 0.018 * (1 - math.cos(2 * TAU * t))),
    }
    return fingers(P, 0.5)


def wave(t):
    P = {
        # Elbow out at shoulder height, forearm up, hand swinging.
        "upper_arm.R": (-0.3, 0, mz("R", 1.7)),
        "forearm.R": (0, 0, mz("R", 1.25 + 0.25 * S(t, 2))),
        "hand.R": (0, 0.25 * S(t, 2), 0),
        "upper_arm.L": (0.02, 0, mz("L", 0.1)),
        "forearm.L": (-0.12, 0, 0),
        "head": (0, 0.08 * S(t), mz("R", -0.07)),
        "chest": (0.02, 0, 0),
    }
    return fingers(P, 0.05)


def sit(t):
    e = smooth(t)
    P = {
        "thigh.L": (-1.5 * e, 0, 0),
        "thigh.R": (-1.5 * e, 0, 0),
        "shin.L": (1.5 * e, 0, 0),
        "shin.R": (1.5 * e, 0, 0),
        "upper_arm.L": (-0.45 * e, 0, mz("L", 0.1 * e)),
        "upper_arm.R": (-0.45 * e, 0, mz("R", 0.1 * e)),
        "forearm.L": (-0.9 * e, 0, 0),
        "forearm.R": (-0.9 * e, 0, 0),
        "chest": (0.05 * e, 0, 0),
        "_loc": (0, 0, SIT_DROP * e),
    }
    return fingers(P, 0.3 * e)


def stand(t):
    return sit(1 - t)


def typing(t):
    """Seated at a desk: forearms forward, fingers tapping in alternation, a slight lean to the screen."""
    e = 1.0
    tap = [0.5 + 0.5 * S(t * 2, 1), 0.5 + 0.5 * S(t * 2, 1)]
    P = {
        "thigh.L": (-1.5, 0, 0),
        "thigh.R": (-1.5, 0, 0),
        "shin.L": (1.5, 0, 0),
        "shin.R": (1.5, 0, 0),
        "_loc": (0, 0, SIT_DROP),
        "chest": (0.14, 0, 0),
        "neck": (0.08, 0, 0),
        "head": (0.12, 0.05 * S(t), 0),
        "upper_arm.L": (-0.95, 0, mz("L", 0.12)),
        "upper_arm.R": (-0.95, 0, mz("R", 0.12)),
        "forearm.L": (-1.05 + 0.04 * S(t, 2), 0, 0),
        "forearm.R": (-1.05 - 0.04 * S(t, 2), 0, 0),
        "hand.L": (0.15 * S(t, 2), 0, 0),
        "hand.R": (-0.15 * S(t, 2), 0, 0),
    }
    for s, k in (("L", 0), ("R", 1)):
        for j, f in enumerate(FINGERS):
            phase = (j + 2 * k) % 5 / 5
            curl = 0.25 + 0.5 * max(0.0, S(t * 4, 1) + phase * 2 - 1)
            P[f"{f}.{s}"] = (curl, 0, 0)
    return P


def talk(t):
    P = {
        "upper_arm.R": (-0.5 + 0.08 * S(t, 2), 0, mz("R", 0.22)),
        "forearm.R": (-1.0 + 0.3 * S(t, 2), 0, 0),
        "head": (0.03 * S(t, 2), 0.07 * S(t), 0.025 * S(t)),
        "chest": (0.02 * S(t, 2), 0, 0),
        "upper_arm.L": (0.02, 0, mz("L", 0.1)),
        "forearm.L": (-0.12, 0, 0),
        "_loc": (0, 0, 0.002 * S(t, 2)),
    }
    return fingers(P, 0.15)


def celebrate(t):
    P = {
        "upper_arm.L": (-0.25, 0, mz("L", 1.8)),
        "upper_arm.R": (-0.25, 0, mz("R", 1.8)),
        "forearm.L": (0, 0, mz("L", 0.9 + 0.22 * S(t, 2))),
        "forearm.R": (0, 0, mz("R", 0.9 + 0.22 * S(t, 2))),
        "head": (-0.1, 0, 0),
        "chest": (-0.04, 0, 0),
        "_loc": (0, 0, 0.035 * abs(S(t))),
    }
    return fingers(P, 0.1)


def nod(t):
    return {"head": (0.2 * S(t), 0, 0), "chest": (0.02 * S(t), 0, 0)}


def shake(t):
    return {"head": (0, 0.32 * S(t), 0), "chest": (0, 0.03 * S(t), 0)}


def think(t):
    P = {
        "upper_arm.R": (-0.95, 0, mz("R", 0.2)),
        "forearm.R": (-1.85, 0, 0),
        "upper_arm.L": (-0.5, 0, mz("L", 0.2)),
        "forearm.L": (-1.25, 0, 0),
        "head": (0.06, -0.1 + 0.03 * S(t), 0.12),
        "chest": (0.02, 0, 0),
    }
    return fingers(P, 0.3)


# name, frames (the clip runs 0..n and frame n equals frame 0 when looping), function, loops
CLIPS = [
    ("idle", 120, idle, True),
    ("walk", 30, walk, True),
    ("run", 20, run, True),
    ("wave", 60, wave, True),
    ("sit", 45, sit, False),
    ("stand", 45, stand, False),
    ("talk", 60, talk, True),
    ("celebrate", 40, celebrate, True),
    ("nod", 40, nod, True),
    ("shake", 40, shake, True),
    ("think", 60, think, True),
    ("type", 60, typing, True),
]


def bake_clip(arm, bones, name, n, fn, loops):
    act = bpy.data.actions.new(name)
    act.use_fake_user = True
    arm.animation_data_create()
    arm.animation_data.action = act
    pelvis = arm.pose.bones["pelvis"]
    for i in range(n + 1):
        t = i / n
        P = fn(t)
        frame = i + 1
        for b in bones:
            pb = arm.pose.bones[b]
            pb.rotation_mode = "XYZ"
            pb.rotation_euler = P.get(b, (0, 0, 0))
            pb.keyframe_insert("rotation_euler", frame=frame)
        pelvis.location = P.get("_loc", (0, 0, 0))
        pelvis.keyframe_insert("location", frame=frame)
    return act


def export(path):
    # Export the rest pose: the skin is bound to the pose that is active at export time.
    arm = bpy.data.objects["CHE_Rig"]
    arm.animation_data.action = None
    for pb in arm.pose.bones:
        pb.rotation_mode = "XYZ"
        pb.rotation_euler = (0, 0, 0)
        pb.location = (0, 0, 0)
    bpy.ops.object.mode_set(mode="OBJECT")
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format="GLB",
        use_selection=False,
        export_animations=True,
        export_animation_mode="ACTIONS",
        export_skins=True,
        export_apply=False,
        export_yup=True,
        export_vertex_color="MATERIAL",
        export_morph=True,
    )
    tris = sum(len(p.vertices) - 2 for o in bpy.data.objects if o.type == "MESH" for p in o.data.polygons)
    import os
    if os.environ.get("CHE_TRIS"):
        per = sorted(((sum(len(p.vertices) - 2 for p in o.data.polygons), o.name) for o in bpy.data.objects if o.type == "MESH"), reverse=True)
        print("TRIS", per[:14], flush=True)
    bones = len(bpy.data.objects["CHE_Rig"].data.bones)
    print("EXPORTED", path, "triangles", tris, "bones", bones, "clips", len(CLIPS))


def preview(path, mode, pose):
    """Cycles still of the built scene, for checking the model by eye. pose: 'rest' or a clip name at mid-clip."""
    import os
    arm = bpy.data.objects["CHE_Rig"]
    if pose == "rest":
        arm.animation_data.action = None
        for pb in arm.pose.bones:
            pb.rotation_mode = "XYZ"
            pb.rotation_euler = (0, 0, 0)
            pb.location = (0, 0, 0)
    else:
        arm.animation_data.action = bpy.data.actions[pose]
        bpy.context.scene.frame_set(len(bpy.data.actions[pose].fcurves[0].keyframe_points) // 2 + 1)
    sc = bpy.context.scene
    sc.render.engine = "CYCLES"
    sc.cycles.samples = int(os.environ.get("CHE_PREVIEW_SAMPLES", "48"))
    sc.cycles.device = "CPU"
    sc.render.resolution_x, sc.render.resolution_y = (640, 900) if mode == "portrait" else (720, 720)
    sc.render.image_settings.file_format = "PNG"
    sc.view_settings.view_transform = "Filmic"
    w = bpy.data.worlds.new("W")
    sc.world = w
    w.use_nodes = True
    w.node_tree.nodes["Background"].inputs[0].default_value = (0.05, 0.09, 0.1, 1)
    w.node_tree.nodes["Background"].inputs[1].default_value = 0.8
    target = Vector((0, 0, 0.92)) if mode == "portrait" else Vector((0, 0, 0.56))
    dist = 0.9 if mode == "portrait" else 3.1
    cam_data = bpy.data.cameras.new("C")
    cam_data.lens = 85 if mode == "portrait" else 50
    cam = bpy.data.objects.new("C", cam_data)
    sc.collection.objects.link(cam)
    sc.camera = cam
    ang = math.radians(28)
    cam.location = target + Vector((math.sin(ang) * dist, -math.cos(ang) * dist, 0.08 if mode == "portrait" else 0.0))
    cam.rotation_euler = (target - cam.location).to_track_quat("-Z", "Y").to_euler()

    def light(name, loc, energy, size, color=(1, 1, 1)):
        ld = bpy.data.lights.new(name, "AREA")
        ld.energy, ld.size, ld.color = energy, size, color
        lo = bpy.data.objects.new(name, ld)
        sc.collection.objects.link(lo)
        lo.location = loc
        lo.rotation_euler = (target - Vector(loc)).to_track_quat("-Z", "Y").to_euler()
    light("key", (1.6, -1.8, 2.2), 900, 1.5)
    light("fill", (-2.0, -1.0, 1.2), 180, 2.5, (0.7, 0.95, 1.0))
    light("rim", (-0.8, 2.2, 2.0), 500, 1.0, (0.4, 1.0, 0.92))
    bpy.context.view_layer.update()
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True)
    print("RENDERED", path, flush=True)


if WHICH == "all":
    for cid in CHARACTERS:
        build(cid)
        export(OUT.rstrip("/") + f"/{cid}.glb")
else:
    build(WHICH)
    import os
    if os.environ.get("CHE_PREVIEW"):
        preview(os.environ["CHE_PREVIEW"], os.environ.get("CHE_PREVIEW_MODE", "body"), os.environ.get("CHE_PREVIEW_POSE", "rest"))
    export(OUT)

"""Build CHE or one of her office agents as a rigged chibi character and export a GLB.

Run with Blender's Python module (bpy 5.x, Python 3.11):
  python build_che_character.py -- <out.glb> [character_id]
  python build_che_character.py -- <out_dir>/ all        # every character, <id>.glb each

character_id is one of CHARACTERS below (default: che). The looks follow the owner's
reference images in assets/characters/reference/ (ref-02, ref-04, ref-05): big round
head, large dark glossy eyes with lashes, small smile, soft blush, full hair, short body.

Units are metres, Z up. The character faces -Y; the glTF export turns that into +Z.
Body, top and trousers are skinned with automatic weights. Hair, face details, eyes,
shoes, fingers and accessories are rigid: each has 100% weight on one bone.
Colours are vertex colours (glTF COLOR_0), so one material per surface type is enough.
Each clip is keyframed as its own action and exported with export_animation_mode='ACTIONS'.
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
META_RES = 0.008


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


# ---------------------------------------------------------------- the crew
# Roles come from lib/che_ui/che_brain.dart (CHE's office). Looks come from the reference
# images: ref-04 (CHE, the orange-jacket runner, the headphones coder, purple bun,
# glasses bun, beanie, curly glasses) and ref-02 (the agents list cards).
CHARACTERS = {
    "che": dict(
        name="CHE", role="Office Boss",
        skin="#c98b62", eyes="#3a2216", hair="#1c1210", hair_hi="#4a3022",
        hair_style="long_wavy", top="jacket", top_color="#1f6f78", inner="#15171a",
        pants="#17191d", shoes="#222429", sole="#e9ecef", earrings="#d8b25a"),
    "nova": dict(
        name="Nova", role="Product / listings",
        skin="#f0c8a8", eyes="#3b2a4a", hair="#8d64d6", hair_hi="#c6a6f5",
        hair_style="bun_high", top="hoodie", top_color="#b79be6", inner="#b79be6",
        pants="#2a2633", shoes="#f2f2f4", sole="#f2f2f4"),
    "atlas": dict(
        name="Atlas", role="Research / sourcing",
        skin="#d29a72", eyes="#2e1c12", hair="#2a1a12", hair_hi="#5a3a26",
        hair_style="curly_short", top="jacket", top_color="#e8732e", inner="#f1f1ef",
        pants="#18191c", shoes="#f4f4f4", sole="#f4f4f4"),
    "mira": dict(
        name="Mira", role="Support copy / translation",
        skin="#e7b48e", eyes="#3a2416", hair="#4a2c1c", hair_hi="#7d5236",
        hair_style="bun_low", top="sweater", top_color="#e9dcc8", inner="#e9dcc8",
        pants="#3b3f47", shoes="#2a2a2e", sole="#d9d9d9", glasses="#2a1d18"),
    "knox": dict(
        name="Knox", role="Engineering",
        skin="#7a4a2e", eyes="#24160e", hair="#141010", hair_hi="#2e2420",
        hair_style="afro", top="jacket", top_color="#3e5f86", inner="#e8e8e8",
        pants="#1d2028", shoes="#2a2d33", sole="#eeeeee", headphones="#2f5fd0"),
    "sage": dict(
        name="Sage", role="Finance (read-only)",
        skin="#8c5a3c", eyes="#24160e", hair="#1a1210", hair_hi="#3a2a20",
        hair_style="curly_short", top="jacket", top_color="#56603e", inner="#d9d4c6",
        pants="#22242a", shoes="#3a2c22", sole="#d8d0c0", glasses="#1d1a18", beard=True),
    "lyra": dict(
        name="Lyra", role="Content / social",
        skin="#dca27a", eyes="#331f14", hair="#3b2416", hair_hi="#7a4e30",
        hair_style="wavy_medium", top="jacket", top_color="#d89a2a", inner="#f3efe6",
        pants="#262a33", shoes="#f0f0f0", sole="#f0f0f0"),
    "iris": dict(
        name="Iris", role="Ad Studio",
        skin="#f1cdb0", eyes="#3d6ea8", hair="#d8b46a", hair_hi="#f0d79a",
        hair_style="beanie", top="jacket", top_color="#3a5574", inner="#e5e5e5",
        pants="#1d2129", shoes="#1f1f22", sole="#e5e5e5", beanie="#1b1c20"),
}

# ---------------------------------------------------------------- proportions (chibi)
# Head is an exact ellipsoid mesh (not a metaball) so the face, eyes and hair sit
# precisely on it. Visible sizes: head 0.40 wide; body 0.78 tall to the chin.
H = Vector((0, 0, 0.885))         # head centre
HA = (0.200, 0.186, 0.190)        # head semi-axes x (width), y (depth), z (height)
EYE_X, EYE_DZ = 0.080, -0.040     # eye centre: sideways offset, height below head centre
SIT_DROP = -0.19
FINGER_BONES = {
    "thumb": ((0.138, -0.02, 0.338), (0.134, -0.034, 0.316)),
    "index": ((0.148, -0.013, 0.315), (0.15, -0.014, 0.293)),
    "middle": ((0.151, -0.003, 0.313), (0.153, -0.003, 0.289)),
    "ring": ((0.151, 0.007, 0.314), (0.152, 0.007, 0.293)),
    "pinky": ((0.149, 0.016, 0.317), (0.15, 0.016, 0.299)),
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
        "skin": material("skin", rough=0.58),
        "hair": material("hair", rough=0.45, double=True),
        "cloth": material("cloth", rough=0.8, double=True),
        "shoe": material("shoe", rough=0.5),
        "eye": material("eye", rough=0.08),
        "glint": material("glint", rough=0.05, rgb=(1, 1, 1), emit=(1, 1, 1), emit_strength=2.5, vcol=False),
        "lash": material("lash", rough=0.5, rgb=srgb("#100a08"), vcol=False),
        "brow": material("brow", rough=0.7, rgb=mix(srgb(c["hair"]), srgb("#100a08"), 0.5), vcol=False),
        "mouth": material("mouth", rough=0.4, rgb=srgb("#8a3530"), vcol=False),
        "nose": material("nose", rough=0.6, rgb=mix(srgb(c["skin"]), srgb("#7a3f2a"), 0.22), vcol=False),
        "acc": material("acc", rough=0.35, metal=0.2, rgb=(0.02, 0.02, 0.02), vcol=False),
    }


# ---------------------------------------------------------------- armature
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

    bone("pelvis", (0, 0, 0.36), (0, 0, 0.43))
    bone("spine", (0, 0, 0.43), (0, 0, 0.52), "pelvis")
    bone("chest", (0, 0, 0.52), (0, 0, 0.63), "spine")
    bone("neck", (0, 0, 0.63), (0, 0, 0.70), "chest")
    bone("head", (0, 0, 0.70), (0, 0, 1.12), "neck")
    for s, sx in (("L", 1), ("R", -1)):
        e = EYES[s]
        bone(f"eye.{s}", e, e + Vector((0, 0, 0.05)), "head")
        bone(f"shoulder.{s}", (0.03 * sx, 0, 0.62), (0.10 * sx, 0, 0.615), "chest")
        bone(f"upper_arm.{s}", (0.10 * sx, 0, 0.615), (0.125 * sx, 0, 0.49), f"shoulder.{s}")
        bone(f"forearm.{s}", (0.125 * sx, 0, 0.49), (0.142 * sx, 0, 0.37), f"upper_arm.{s}")
        bone(f"hand.{s}", (0.142 * sx, 0, 0.37), (0.152 * sx, 0, 0.31), f"forearm.{s}")
        for fname, (h, t) in FINGER_BONES.items():
            bone(f"{fname}.{s}", (h[0] * sx, h[1], h[2]), (t[0] * sx, t[1], t[2]), f"hand.{s}")
        bone(f"thigh.{s}", (0.055 * sx, 0, 0.35), (0.058 * sx, 0, 0.20), "pelvis")
        bone(f"shin.{s}", (0.058 * sx, 0, 0.20), (0.058 * sx, 0, 0.065), f"thigh.{s}")
        bone(f"foot.{s}", (0.058 * sx, 0, 0.065), (0.058 * sx, -0.07, 0.025), f"shin.{s}")
    bpy.ops.object.mode_set(mode="OBJECT")
    return arm


# ---------------------------------------------------------------- geometry helpers
def link(obj):
    bpy.context.collection.objects.link(obj)
    return obj


def meta_object(name, res=META_RES):
    mb = bpy.data.metaballs.new(name)
    mb.resolution = res
    mb.render_resolution = res
    mb.threshold = 0.6
    return mb, link(bpy.data.objects.new(name, mb))


# A lone metaball's visible radius is about 0.67 x its radius (stiffness 2, threshold 0.6).
# These helpers take the visible radius.
VIS = 1 / 0.67


def add_ball(mb, c, r, stiff=2.0, scale=None):
    e = mb.elements.new(type="ELLIPSOID" if scale else "BALL")
    e.co = Vector(c)
    e.radius = r * VIS
    e.stiffness = stiff
    if scale:
        e.size_x, e.size_y, e.size_z = scale


def add_capsule(mb, a, b, r, stiff=2.0):
    a, b = Vector(a), Vector(b)
    d = b - a
    e = mb.elements.new(type="CAPSULE")
    e.co = (a + b) / 2
    e.radius = r * VIS
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
    for i in range(nu if closed_u else nu):
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


def head_point(d, off=0.0):
    d = Vector(d).normalized()
    r = 1 / math.sqrt((d.x / HA[0]) ** 2 + (d.y / HA[1]) ** 2 + (d.z / HA[2]) ** 2)
    p = d * r
    if p.z < 0:                                   # softer, narrower lower face and chin
        k = (-p.z / HA[2]) ** 2
        p.x *= 1 - 0.20 * k
        p.y *= 1 - 0.05 * k
    for sx in (1, -1):                            # full cheeks
        w = math.exp(-((p - Vector((0.10 * sx, -0.14, -0.065))).length / 0.065) ** 2)
        p += d * 0.012 * w
    return H + p + d * off


EYES = {s: H + Vector((EYE_X * sx, 0, EYE_DZ)) for s, sx in (("L", 1), ("R", -1))}


# ---------------------------------------------------------------- body
def body_parts(mb, i=0.0, legs=True):
    """Chibi torso and legs in visible radii. `i` inflates garments over the body."""
    add_capsule(mb, (0, 0, 0.53), (0, 0, 0.60), 0.082 + i)            # chest
    add_capsule(mb, (0, 0, 0.43), (0, 0, 0.52), 0.074 + i)            # waist
    add_capsule(mb, (0, 0.0, 0.36), (0, 0, 0.42), 0.088 + i)          # hips
    for sx in (1, -1):
        add_ball(mb, (0.07 * sx, 0, 0.605), 0.045 + i)                 # shoulder
        add_ball(mb, (0.04 * sx, 0, 0.37), 0.064 + i)                  # hip shape
        if legs:
            add_capsule(mb, (0.055 * sx, 0, 0.35), (0.058 * sx, 0, 0.21), 0.052 + i)   # thigh
            add_capsule(mb, (0.058 * sx, 0, 0.20), (0.058 * sx, 0, 0.075), 0.043 + i)  # shin


def arm_parts(mb, i=0.0, palms=False):
    """Arms are their own metaball object so they never melt into the torso."""
    for sx in (1, -1):
        add_ball(mb, (0.095 * sx, 0, 0.605), 0.036 + i)                          # shoulder cap
        add_capsule(mb, (0.10 * sx, 0, 0.61), (0.125 * sx, 0, 0.495), 0.031 + i)   # upper arm
        add_capsule(mb, (0.125 * sx, 0, 0.49), (0.141 * sx, 0, 0.38), 0.028 + i)   # forearm
        if palms:
            add_ball(mb, (0.143 * sx, -0.002, 0.33), 0.03, 2.0, (0.95, 0.75, 1.15))


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
        lift = top * math.cos(min(th, math.pi / 2)) ** 2                  # volume on top
        # A side part: the hair rises a little either side of the parting line.
        lift += 0.006 * math.exp(-((phi - part) / 0.25) ** 2) * (1 - v)
        return head_point(sph(th, phi), off + lift)
    cap = grid_surface("hair_cap", M["hair"], 96, 30, f, closed_u=True)
    solidify(cap, 0.016)
    return cap


def hair_skirt(M, z_end, flare, phi0=0.95, wave=0.012, start_th=1.45):
    """Long hair falling from the cap at the sides and back down to z_end."""
    def f(u, v):
        phi = phi0 + (2 * math.pi - 2 * phi0) * u
        top = head_point(sph(start_th, phi), 0.022)
        side = Vector((math.sin(phi), -math.cos(phi) * 0.82, 0))
        r0 = Vector((top.x, top.y, 0)).length
        bottom_z = z_end + 0.03 * math.sin(phi * 7) - 0.04 * math.cos(phi) ** 2 * (math.cos(phi) < 0)
        z = top.z + (bottom_z - top.z) * v
        r = r0 + flare * (v ** 0.7) + wave * math.sin(v * 9 + phi * 4) * v
        p = side * r
        return Vector((p.x, p.y + 0.01 * v, z))
    skirt = grid_surface("hair_skirt", M["hair"], 80, 24, f)
    solidify(skirt, 0.03)
    return skirt


def hair_fringe(M, th_left, th_right, span=0.95, off=0.03, scallop=0.06):
    """Side-swept bangs: longer on the character's right (th_right) than the left."""
    def f(u, v):
        phi = -span + 2 * span * u
        end = th_right + (th_left - th_right) * u - scallop * abs(math.sin(u * math.pi * 5))
        th = 0.25 + (end - 0.25) * v
        return head_point(sph(th, phi), off + 0.006 * math.sin(v * math.pi))
    fr = grid_surface("hair_fringe", M["hair"], 40, 14, f)
    solidify(fr, 0.012)
    return fr


def meta_curls(M, pts, name="hair_curls", res=0.007):
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
        out.append((head_point(sph(th, phi), off) + Vector((0, 0, lift)), random.uniform(rmin, rmax)))
    return out


def build_hair(c, M):
    style = c["hair_style"]
    parts = []
    if style == "long_wavy":
        parts += [hair_cap(M, 1.05, 1.55, 2.3, part=-0.35),
                  hair_skirt(M, 0.40, 0.11, phi0=0.98, wave=0.018),
                  hair_fringe(M, 1.08, 1.40)]
    elif style == "wavy_medium":
        parts += [hair_cap(M, 1.05, 1.55, 2.3, part=0.35),
                  hair_skirt(M, 0.62, 0.07, phi0=1.0, wave=0.014),
                  hair_fringe(M, 1.32, 1.12)]
    elif style == "curly_short":
        parts += [hair_cap(M, 1.0, 1.45, 2.05, off=0.02, top=0.03),
                  meta_curls(M, scatter_on_head(34, 7, 0.0, 1.35, (0.9, 0.75), 0.03, 0.032, 0.045)
                             + [(head_point(sph(0.92 + 0.08 * (k % 2), -0.6 + 0.3 * k), 0.035), 0.036) for k in range(5)])]
    elif style == "afro":
        parts += [hair_cap(M, 1.0, 1.5, 2.1, off=0.02, top=0.03),
                  meta_curls(M, scatter_on_head(240, 3, 0.0, 1.95, (1.0, 0.9), 0.07, 0.03, 0.038, lift=0.015,
                                                skip=lambda th, phi: th > 1.45 and abs(abs(phi) - math.pi / 2) < 0.45), res=0.008)]
    elif style == "bun_high":
        parts += [hair_cap(M, 1.02, 1.6, 2.3, off=0.012, top=0.012, part=0.3),
                  meta_curls(M, [(H + Vector((0, 0.02, 0.25)), 0.085), (H + Vector((0.04, 0.0, 0.29)), 0.05),
                                 (H + Vector((-0.04, 0.04, 0.28)), 0.05)], "hair_bun"),
                  tube("strand_l", [head_point(sph(1.1, 0.95), 0.02), head_point(sph(1.55, 1.05), 0.03), head_point(sph(1.95, 1.0), 0.03)], [0.012, 0.011, 0.006], M["hair"]),
                  tube("strand_r", [head_point(sph(1.1, -0.95), 0.02), head_point(sph(1.55, -1.05), 0.03), head_point(sph(1.95, -1.0), 0.03)], [0.012, 0.011, 0.006], M["hair"])]
    elif style == "bun_low":
        parts += [hair_cap(M, 1.02, 1.6, 2.3, off=0.012, top=0.012, part=-0.3),
                  meta_curls(M, [(H + Vector((0, 0.17, 0.12)), 0.08), (H + Vector((0.03, 0.17, 0.17)), 0.045)], "hair_bun"),
                  hair_fringe(M, 1.15, 1.0, span=0.8, off=0.022, scallop=0.04)]
    elif style == "beanie":
        parts += [hair_cap(M, 1.15, 1.85, 2.25, off=0.014, top=0.0),
                  hair_fringe(M, 1.38, 1.28, span=0.9, off=0.026, scallop=0.08)]
    hair = join(parts, "hair")
    displace(hair, 0.008, 22.0, (1.0, 1.0, 0.3), seed=4.0)       # waves
    displace(hair, 0.003, 90.0, (1.0, 1.0, 0.15), seed=9.0)      # strand grooves
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


# ---------------------------------------------------------------- build one character
def build(cid):
    c = CHARACTERS[cid]
    reset_scene()
    M = make_materials(c)
    arm = build_rig()
    bones = [b.name for b in arm.data.bones]

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

    skin, blush = srgb(c["skin"]), mix(srgb(c["skin"]), srgb("#ff6b6e"), 0.45)

    # ---- body: metaball limbs and torso + exact head mesh
    mb, mo = meta_object("body_mb")
    body_parts(mb)
    add_capsule(mb, (0, 0, 0.60), (0, 0, 0.74), 0.04)                      # neck
    torso = convert_meta(mo, M["skin"], "torso")
    decimate(torso, 0.35)
    mb, mo = meta_object("arms_mb")
    arm_parts(mb, palms=True)
    body = join([torso, convert_meta(mo, M["skin"], "arms"), build_head(M["skin"])], f"{cid}_body")
    cheeks = [head_point(sph(1.72, 0.62 * sx)) for sx in (1, -1)]

    def skin_col(co, n):
        d = min((co - k).length for k in cheeks)
        return mix(skin, blush, 0.9 * max(0.0, 1 - d / 0.055) ** 1.2)
    paint(body, skin_col)

    # ---- top: jacket (open front shows the shirt), hoodie or sweater
    top_c, inner_c, kind = srgb(c["top_color"]), srgb(c["inner"]), c["top"]
    mb, mo = meta_object("top_mb")
    body_parts(mb, i=0.012, legs=False)
    add_capsule(mb, (0, 0, 0.36), (0, 0, 0.42), 0.112)                      # covers the trouser waist
    for sx in (1, -1):
        add_ball(mb, (0.04 * sx, 0, 0.375), 0.088)
    if kind == "hoodie":
        add_capsule(mb, (-0.06, 0.05, 0.635), (0.06, 0.05, 0.635), 0.045)       # hood bunched at the back
    else:
        add_capsule(mb, (-0.055, 0.02, 0.63), (0.055, 0.02, 0.63), 0.03)        # collar
    torso_top = convert_meta(mo, M["cloth"], "top_torso")
    mb, mo = meta_object("sleeves_mb")
    arm_parts(mb, i=0.011)
    for sx in (1, -1):
        add_capsule(mb, (0.134 * sx, 0, 0.43), (0.141 * sx, 0, 0.39), 0.043)   # rolled cuff
    cut_below(torso_top, 0.345)
    top = join([torso_top, convert_meta(mo, M["cloth"], "sleeves")], f"{cid}_top")
    decimate(top, 0.4)
    displace(top, 0.002, 55.0, (1.0, 1.0, 0.4), seed=2.0)

    def top_col(co, n):
        base = top_c
        if abs(co.x) > 0.115 and co.z < 0.425:
            base = mix(top_c, (0, 0, 0), 0.2)                                   # cuffs
        if kind == "jacket" and co.y < 0:
            w = 0.026 + 0.16 * max(0.0, co.z - 0.5)                             # opening widens to the collar
            e = abs(co.x) - w
            if abs(co.x) < 0.1 and e < 0.008:
                t = max(0.0, min(1.0, (e + 0.008) / 0.016))
                return mix(inner_c, mix(top_c, (0, 0, 0), 0.3 * (1 - t)), t)
        if kind == "hoodie" and co.y < 0 and abs(co.x) < 0.07 and 0.42 < co.z < 0.48:
            return mix(top_c, (0, 0, 0), 0.12)                                  # front pocket
        return base
    paint(top, top_col)

    mb, mo = meta_object("pants_mb")
    add_capsule(mb, (0, 0, 0.355), (0, 0, 0.41), 0.098)
    for sx in (1, -1):
        add_ball(mb, (0.04 * sx, 0, 0.37), 0.074)
        add_capsule(mb, (0.055 * sx, 0, 0.35), (0.058 * sx, 0, 0.21), 0.061)
        add_capsule(mb, (0.058 * sx, 0, 0.20), (0.059 * sx, 0, 0.085), 0.053)
    pants = convert_meta(mo, M["cloth"], f"{cid}_pants")
    decimate(pants, 0.35)
    displace(pants, 0.002, 50.0, (1, 1, 0.3), seed=5.0)
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
    white = srgb("#fbf7f2")
    pupil = srgb("#0a0605")
    ER = (0.052, 0.03, 0.06)                     # eye semi-axes: width, depth, height

    eye_mat = eye_material(cid, white, iris_c, iris_light, iris_dark, pupil)

    for s, sx in (("L", 1), ("R", -1)):
        p, n = on_face(EYES[s].x, EYES[s].z)
        n = (n + Vector((0, -1.2, 0))).normalized()                 # chibi eyes look forward
        R = surface_frame(n)
        centre = p - n * 0.016
        eye, local = ellipsoid(f"eye.{s}", centre, ER, eye_mat, R, seg=(40, 28), keep_bm=True)
        uv = eye.data.uv_layers.new(name="UVMap")
        for loop in eye.data.loops:
            lc = local[loop.vertex_index]
            # Front projection; the back half is hidden inside the head.
            uv.data[loop.index].uv = (0.5 + 0.5 * lc.x * (1 if lc.y < 0 else 0.3), 0.5 + 0.5 * lc.z)
        rigid(eye, f"eye.{s}")

        def eye_pt(u, w, out=0.0):
            d = math.sqrt(max(0.0, 1 - u * u - w * w))
            return centre + R @ Vector((u * ER[0], -d * ER[1], w * ER[2])) + n * out

        for k, (u, w, r) in enumerate(((0.32, 0.38, 0.016), (-0.3, -0.32, 0.007))):
            g = ellipsoid(f"glint{k}.{s}", eye_pt(u, w, 0.002), (r, r * 0.4, r * 1.15), M["glint"], R)
            rigid(g, f"eye.{s}")
        # Upper lash line, thicker toward the outer corner, ending in a flick.
        pts, rad = [], []
        for k in range(13):
            a = math.pi * (0.04 + 0.9 * k / 12)
            u, w = math.cos(a) * 0.97, math.sin(a) * 0.9 + 0.05
            pts.append(eye_pt(u, w, 0.004))
            outer = (u * sx + 1) / 2
            rad.append(0.0032 + 0.005 * outer * math.sin(math.pi * k / 12) ** 0.3)
        o1 = sx
        pts = ([eye_pt(1.0 * o1, 0.25, 0.003) + Vector((0.012 * sx, 0, 0.012))] if sx < 0 else []) + pts \
            + ([eye_pt(1.0 * o1, 0.25, 0.003) + Vector((0.012 * sx, 0, 0.012))] if sx > 0 else [])
        rad = ([0.0025] if sx < 0 else []) + rad + ([0.0025] if sx > 0 else [])
        rigid(tube(f"lash.{s}", pts, rad, M["lash"]), f"eye.{s}")
        # Brow: soft arch on the forehead.
        bpts = []
        for k in range(7):
            t = k / 6
            bx = EYES[s].x + (-0.035 + 0.075 * t) * sx
            bz = EYES[s].z + 0.088 + 0.012 * math.sin(math.pi * t) - 0.008 * t
            bp, bn = on_face(bx, bz)
            bpts.append(bp + bn * 0.003)
        rigid(tube(f"brow.{s}", bpts, [0.004, 0.0055, 0.006, 0.006, 0.0055, 0.0045, 0.0025], M["brow"]), "head")

    p, n = on_face(0, H.z - 0.088)
    rigid(ellipsoid("nose", p, (0.009, 0.006, 0.007), M["nose"], surface_frame(n)), "head")
    mouth = []
    for k in range(9):
        t = (k - 4) / 4
        mp, mn = on_face(0.026 * t, H.z - 0.128 + 0.011 * t * t)
        mouth.append(mp + mn * 0.0015)
    rigid(tube("mouth", mouth, [0.002, 0.003, 0.0036, 0.004, 0.004, 0.004, 0.0036, 0.003, 0.002], M["mouth"]), "head")

    # ---- accessories
    def acc_mat(o, hexc, rough=0.35, metal=0.3):
        o.data.materials.clear()
        o.data.materials.append(material(f"acc_{o.name}", rough=rough, metal=metal, rgb=srgb(hexc), vcol=False))

    if c.get("earrings"):
        for sx in (1, -1):
            ec = head_point(sph(1.95, 1.62 * sx), 0.004)
            ring = [ec + Vector((0, 0.018 * math.cos(2 * math.pi * k / 18), -0.02 + 0.02 * math.sin(2 * math.pi * k / 18))) for k in range(18)]
            e = tube(f"earring{sx}", ring, 0.003, M["acc"], closed=True, sides=6)
            acc_mat(e, c["earrings"], 0.25, 0.9)
            rigid(e, "head")
    if c.get("glasses"):
        objs = []
        for s, sx in (("L", 1), ("R", -1)):
            p, n = on_face(EYES[s].x, EYES[s].z)
            R = surface_frame((n + Vector((0, -1.5, 0))).normalized())
            rim = [p + R @ Vector((0.058 * math.cos(2 * math.pi * k / 24), -0.028, 0.052 * math.sin(2 * math.pi * k / 24))) for k in range(24)]
            objs.append(tube(f"rim.{s}", rim, 0.0045, M["acc"], closed=True, sides=6))
            objs.append(tube(f"arm.{s}", [p + R @ Vector((0.058 * sx, -0.028, 0.01)),
                                          head_point(sph(1.55, 1.5 * sx), 0.01)], 0.0035, M["acc"]))
        bp, bn = on_face(0, EYES["L"].z + 0.012)
        objs.append(tube("bridge", [Vector((-0.024, bp.y - 0.026, EYES["L"].z + 0.012)),
                                    Vector((0, bp.y - 0.03, EYES["L"].z + 0.018)),
                                    Vector((0.024, bp.y - 0.026, EYES["L"].z + 0.012))], 0.0038, M["acc"]))
        g = join(objs, "glasses")
        acc_mat(g, c["glasses"], 0.3, 0.2)
        rigid(g, "head")
    if c.get("headphones"):
        band = [H + Vector((0.255 * math.cos(math.pi * k / 20), 0.0, 0.0 + 0.335 * math.sin(math.pi * k / 20))) for k in range(21)]
        objs = [tube("hp_band", band, 0.016, M["acc"], sides=10)]
        for sx in (1, -1):
            objs.append(ellipsoid(f"hp_cup{sx}", H + Vector((0.245 * sx, 0.0, -0.03)), (0.04, 0.062, 0.068), M["acc"]))
            objs.append(ellipsoid(f"hp_pad{sx}", H + Vector((0.212 * sx, 0.0, -0.03)), (0.016, 0.055, 0.06), M["acc"]))
        g = join(objs, "headphones")
        acc_mat(g, c["headphones"], 0.3, 0.4)
        rigid(g, "head")
    if c.get("beanie"):
        def bf(u, v):
            phi = -math.pi + 2 * math.pi * u
            th = max(1e-3, v) * hairline(phi, 1.18, 1.5, 1.8)
            return head_point(sph(th, phi), 0.03 + 0.02 * math.cos(min(th, 1.5)) ** 2)
        cap = grid_surface("beanie", M["acc"], 72, 22, bf, closed_u=True)
        solidify(cap, 0.012)
        displace(cap, 0.0025, 70.0, (1.0, 1.0, 0.05))
        brims = [tube(f"brim{j}", [head_point(sph(hairline(-math.pi + 2 * math.pi * k / 48, 1.18, 1.5, 1.8) - 0.05 - 0.13 * j, -math.pi + 2 * math.pi * k / 48), 0.03)
                                  for k in range(48)], 0.02, M["acc"], closed=True, sides=10) for j in range(2)]
        brim = join(brims, "brim")
        displace(brim, 0.003, 90.0, (1.0, 1.0, 0.05))
        g = join([cap, brim], "beanie_all")
        acc_mat(g, c["beanie"], 0.85, 0.0)
        rigid(g, "head")
    if c.get("beard"):
        def jaw(u, v):
            phi = -1.4 + 2.8 * u
            top = 2.22 - 0.5 * max(0.0, abs(phi) - 0.55) / 0.85        # sideburns rise toward the ears
            th = top + (2.72 - top) * v
            return head_point(sph(th, phi), 0.006 + 0.008 * math.sin(v * math.pi))
        beard = grid_surface("beard", M["hair"], 40, 10, jaw)
        solidify(beard, 0.01)
        mp, mn = on_face(0, H.z - 0.112)
        must = tube("moustache", [mp + Vector((0.03 * t, -0.004, -0.004 * t * t)) for t in (-1, -0.5, 0, 0.5, 1)],
                    [0.004, 0.007, 0.007, 0.007, 0.004], M["hair"])
        beard = join([beard, must], "beard_all")
        displace(beard, 0.002, 140.0)
        solid(beard, mix(srgb(c["hair"]), srgb(c["hair_hi"]), 0.25))
        rigid(beard, "head")

    # ---- shoes (chunky sneakers) and fingers
    sole, upper = srgb(c["sole"]), srgb(c["shoes"])
    for s, sx in (("L", 1), ("R", -1)):
        mb, mo = meta_object(f"shoe_mb.{s}", 0.006)
        add_capsule(mb, (0.06 * sx, 0.022, 0.036), (0.06 * sx, -0.07, 0.032), 0.04)
        add_ball(mb, (0.06 * sx, -0.074, 0.03), 0.038, 2.0, (1.08, 1.0, 0.85))
        add_capsule(mb, (0.058 * sx, 0.01, 0.062), (0.058 * sx, -0.006, 0.085), 0.034)
        shoe = convert_meta(mo, M["shoe"], f"shoe.{s}")
        paint(shoe, lambda co, n: sole if co.z < 0.017 else upper)
        rigid(shoe, f"foot.{s}")
        for fname in FINGER_BONES:
            bb = arm.data.bones[f"{fname}.{s}"]
            mb, mo = meta_object(f"{fname}_mb.{s}", 0.004)
            add_capsule(mb, bb.head_local, bb.tail_local, 0.0105 if fname == "thumb" else 0.0082)
            fm = convert_meta(mo, M["skin"], f"{fname}_finger.{s}")
            solid(fm, skin)
            rigid(fm, f"{fname}.{s}")

    for obj in (body, top, pants):
        auto_skin(obj)

    for clip_name, n, fn, loops in CLIPS:
        bake_clip(arm, bones, clip_name, n, fn, loops)
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
        "chest": (0.018 * S(t), 0, 0),
        "spine": (0.01 * S(t), 0, 0),
        "head": (0.02 * S(t), 0.05 * math.sin(TAU * t + 0.6), 0.04 * math.sin(TAU * t + 2.0)),
        "upper_arm.L": (0.03 * S(t), 0, mz("L", 0.12)),
        "upper_arm.R": (0.03 * math.sin(TAU * t + 0.8), 0, mz("R", 0.12)),
        "forearm.L": (-0.15, 0, 0),
        "forearm.R": (-0.15, 0, 0),
        "_loc": (0, 0, 0.003 * S(t)),
    }
    return fingers(P, 0.25)


def walk(t):
    a = 0.5 * S(t)
    P = {
        "thigh.L": (a, 0, 0),
        "thigh.R": (-a, 0, 0),
        "shin.L": (0.7 * max(0.0, math.cos(TAU * t)), 0, 0),
        "shin.R": (0.7 * max(0.0, -math.cos(TAU * t)), 0, 0),
        "upper_arm.L": (-0.8 * a, 0, mz("L", 0.12)),
        "upper_arm.R": (0.8 * a, 0, mz("R", 0.12)),
        "forearm.L": (-0.35, 0, 0),
        "forearm.R": (-0.35, 0, 0),
        "spine": (0, 0.05 * S(t), 0),
        "head": (0.03 * S(t, 2), 0, 0),
        "_loc": (0, 0, 0.008 * (1 - math.cos(2 * TAU * t))),
    }
    return fingers(P, 0.25)


def run(t):
    a = 0.8 * S(t)
    P = {
        "thigh.L": (a, 0, 0),
        "thigh.R": (-a, 0, 0),
        "shin.L": (1.1 * max(0.0, math.cos(TAU * t)), 0, 0),
        "shin.R": (1.1 * max(0.0, -math.cos(TAU * t)), 0, 0),
        "upper_arm.L": (-1.0 * a, 0, mz("L", 0.15)),
        "upper_arm.R": (1.0 * a, 0, mz("R", 0.15)),
        "forearm.L": (-1.25, 0, 0),
        "forearm.R": (-1.25, 0, 0),
        "chest": (0.15, 0, 0),
        "spine": (0, 0.08 * S(t), 0),
        "_loc": (0, 0, 0.02 * (1 - math.cos(2 * TAU * t))),
    }
    return fingers(P, 0.6)


def wave(t):
    P = {
        # Elbow out at shoulder height, forearm up, hand swinging (the big head blocks a higher arm).
        "upper_arm.R": (-0.3, 0, mz("R", 1.75)),
        "forearm.R": (0, 0, mz("R", 1.3 + 0.3 * S(t, 2))),
        "hand.R": (0, 0.3 * S(t, 2), 0),
        "upper_arm.L": (0.02, 0, mz("L", 0.12)),
        "forearm.L": (-0.15, 0, 0),
        "head": (0, 0.1 * S(t), mz("R", -0.08)),
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


def talk(t):
    P = {
        "upper_arm.R": (-0.55 + 0.08 * S(t, 2), 0, mz("R", 0.25)),
        "forearm.R": (-1.1 + 0.35 * S(t, 2), 0, 0),
        "head": (0.04 * S(t, 2), 0.08 * S(t), 0.03 * S(t)),
        "chest": (0.02 * S(t, 2), 0, 0),
        "upper_arm.L": (0.02, 0, mz("L", 0.12)),
        "forearm.L": (-0.15, 0, 0),
        "_loc": (0, 0, 0.003 * S(t, 2)),
    }
    return fingers(P, 0.2)


def celebrate(t):
    P = {
        "upper_arm.L": (-0.25, 0, mz("L", 1.85)),
        "upper_arm.R": (-0.25, 0, mz("R", 1.85)),
        "forearm.L": (0, 0, mz("L", 0.9 + 0.25 * S(t, 2))),
        "forearm.R": (0, 0, mz("R", 0.9 + 0.25 * S(t, 2))),
        "head": (-0.12, 0, 0),
        "chest": (-0.04, 0, 0),
        "_loc": (0, 0, 0.04 * abs(S(t))),
    }
    return fingers(P, 0.1)


def nod(t):
    return {"head": (0.22 * S(t), 0, 0), "chest": (0.02 * S(t), 0, 0)}


def shake(t):
    return {"head": (0, 0.35 * S(t), 0), "chest": (0, 0.03 * S(t), 0)}


def think(t):
    P = {
        "upper_arm.R": (-1.0, 0, mz("R", 0.2)),
        "forearm.R": (-1.9, 0, 0),
        "upper_arm.L": (-0.5, 0, mz("L", 0.2)),
        "forearm.L": (-1.3, 0, 0),
        "head": (0.06, -0.1 + 0.03 * S(t), 0.14),
        "chest": (0.02, 0, 0),
    }
    return fingers(P, 0.35)


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
]


def bake_clip(arm, bones, name, n, fn, loops):
    act = bpy.data.actions.new(name)
    act.use_fake_user = True
    arm.animation_data_create()
    arm.animation_data.action = act
    pelvis = arm.pose.bones["pelvis"]
    eyes = [arm.pose.bones["eye.L"], arm.pose.bones["eye.R"]]
    for i in range(n + 1):
        t = i / n
        P = fn(t)
        if loops and "_blink" not in P:
            # One blink per loop: both eyes squash vertically (bone Y = world up) for a few frames.
            P["_blink"] = 1 - 0.92 * max(0.0, 1 - abs((t - 0.55) / 0.035))
        frame = i + 1
        for b in bones:
            pb = arm.pose.bones[b]
            pb.rotation_mode = "XYZ"
            pb.rotation_euler = P.get(b, (0, 0, 0))
            pb.keyframe_insert("rotation_euler", frame=frame)
        pelvis.location = P.get("_loc", (0, 0, 0))
        pelvis.keyframe_insert("location", frame=frame)
        for eb in eyes:
            eb.scale = (1, P.get("_blink", 1.0), 1)
            eb.keyframe_insert("scale", frame=frame)
    return act


def export(path):
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
    )
    tris = sum(len(p.vertices) - 2 for o in bpy.data.objects if o.type == "MESH" for p in o.data.polygons)
    bones = len(bpy.data.objects["CHE_Rig"].data.bones)
    print("EXPORTED", path, "triangles", tris, "bones", bones, "clips", len(CLIPS))


if WHICH == "all":
    for cid in CHARACTERS:
        build(cid)
        export(OUT.rstrip("/") + f"/{cid}.glb")
else:
    build(WHICH)
    export(OUT)

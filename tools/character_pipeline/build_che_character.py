"""Build CHE's rigged, skinned character and export it as a GLB with animation clips.

Run with Blender's Python module (bpy 5.x, Python 3.11):
  python build_che_character.py -- <out.glb>

Units are metres, Z up. The character faces -Y; the glTF export turns that into +Z.
Body, jacket and trousers are skinned with automatic weights. Eyes, hair, shoes and
fingers are rigid parts: each has 100% weight on one bone.
Each clip is keyframed as its own action and exported with export_animation_mode='ACTIONS'.
"""
import bpy
import bmesh
import math
import sys
from mathutils import Vector

OUT = sys.argv[sys.argv.index("--") + 1]
FPS = 30
META_RES = 0.022
FINGER_RES = 0.012

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.context.scene.render.fps = FPS


def material(name, rgb, rough=0.45, metal=0.0, emit=None, emit_strength=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    p = m.node_tree.nodes["Principled BSDF"]
    p.inputs["Base Color"].default_value = (*rgb, 1.0)
    p.inputs["Roughness"].default_value = rough
    p.inputs["Metallic"].default_value = metal
    if emit:
        p.inputs["Emission Color"].default_value = (*emit, 1.0)
        p.inputs["Emission Strength"].default_value = emit_strength
    return m


MAT = {
    "skin": material("skin", (0.86, 0.62, 0.48), rough=0.42),
    "hair": material("hair", (0.09, 0.06, 0.07), rough=0.28),
    "jacket": material("jacket", (0.05, 0.10, 0.12), rough=0.38, metal=0.05),
    "trousers": material("trousers", (0.06, 0.07, 0.09), rough=0.5),
    "shoe": material("shoe", (0.03, 0.03, 0.04), rough=0.3),
    "sclera": material("sclera", (0.95, 0.96, 0.97), rough=0.12),
    "iris": material("iris", (0.08, 0.7, 0.68), rough=0.1, emit=(0.1, 0.9, 0.85), emit_strength=0.35),
    "pupil": material("pupil", (0.01, 0.01, 0.02), rough=0.1),
    "glint": material("glint", (1, 1, 1), rough=0.05, emit=(1, 1, 1), emit_strength=2.0),
}

# ---------------------------------------------------------------- armature
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


bone("pelvis", (0, 0, 0.95), (0, 0, 1.08))
bone("spine", (0, 0, 1.08), (0, 0, 1.22), "pelvis")
bone("chest", (0, 0, 1.22), (0, 0, 1.40), "spine")
bone("neck", (0, 0, 1.40), (0, 0, 1.52), "chest")
bone("head", (0, 0, 1.52), (0, 0, 1.92), "neck")
bone("eye.L", (0.085, -0.20, 1.67), (0.085, -0.20, 1.72), "head")
bone("eye.R", (-0.085, -0.20, 1.67), (-0.085, -0.20, 1.72), "head")
FINGER_BONES = {
    "thumb": ((0.26, -0.02, 0.76), (0.23, -0.04, 0.72)),
    "index": ((0.285, -0.02, 0.72), (0.29, -0.02, 0.64)),
    "middle": ((0.29, 0.0, 0.72), (0.295, 0.0, 0.62)),
    "ring": ((0.295, 0.015, 0.72), (0.295, 0.015, 0.64)),
    "pinky": ((0.29, 0.03, 0.73), (0.29, 0.03, 0.67)),
}
for s, sx in (("L", 1), ("R", -1)):
    bone(f"shoulder.{s}", (0.10 * sx, 0, 1.34), (0.22 * sx, 0, 1.33), "chest")
    bone(f"upper_arm.{s}", (0.22 * sx, 0, 1.33), (0.24 * sx, 0, 1.07), f"shoulder.{s}")
    bone(f"forearm.{s}", (0.24 * sx, 0, 1.07), (0.27 * sx, 0, 0.82), f"upper_arm.{s}")
    bone(f"hand.{s}", (0.27 * sx, 0, 0.82), (0.29 * sx, 0, 0.70), f"forearm.{s}")
    for fname, (h, t) in FINGER_BONES.items():
        bone(f"{fname}.{s}", (h[0] * sx, h[1], h[2]), (t[0] * sx, t[1], t[2]), f"hand.{s}")
    bone(f"thigh.{s}", (0.10 * sx, 0, 0.92), (0.11 * sx, 0, 0.50), "pelvis")
    bone(f"shin.{s}", (0.11 * sx, 0, 0.50), (0.11 * sx, 0, 0.14), f"thigh.{s}")
    bone(f"foot.{s}", (0.11 * sx, 0, 0.14), (0.11 * sx, -0.13, 0.05), f"shin.{s}")
bpy.ops.object.mode_set(mode="OBJECT")
BONES = [b.name for b in arm.data.bones]


# ---------------------------------------------------------------- geometry helpers
def link(obj):
    bpy.context.collection.objects.link(obj)
    return obj


def meta_object(name, res=META_RES):
    mb = bpy.data.metaballs.new(name)
    mb.resolution = res
    mb.render_resolution = res
    return mb, link(bpy.data.objects.new(name, mb))


def add_ball(mb, c, r, stiff=2.0):
    e = mb.elements.new(type="BALL")
    e.co = Vector(c)
    e.radius = r
    e.stiffness = stiff


def add_capsule(mb, a, b, r, stiff=2.0):
    a, b = Vector(a), Vector(b)
    d = b - a
    e = mb.elements.new(type="CAPSULE")
    e.co = (a + b) / 2
    e.radius = r
    e.stiffness = stiff
    e.size_x = d.length / 2
    e.rotation = d.normalized().to_track_quat("X", "Y")


def convert_meta(mo, mat):
    bpy.ops.object.select_all(action="DESELECT")
    mo.select_set(True)
    bpy.context.view_layer.objects.active = mo
    bpy.ops.object.convert(target="MESH")
    obj = bpy.context.view_layer.objects.active
    obj.data.materials.append(mat)
    return obj


def sphere_obj(name, center, r, mat):
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=28, v_segments=18, radius=r)
    bmesh.ops.translate(bm, vec=Vector(center), verts=bm.verts)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    obj = link(bpy.data.objects.new(name, me))
    obj.data.materials.append(mat)
    return obj


def rigid(obj, bone_name):
    """100% of the object's weight on one bone, so it moves rigidly with that bone."""
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


def capsule_mesh(name, a, b, r, mat):
    mb, mo = meta_object(name, FINGER_RES)
    add_capsule(mb, a, b, r)
    obj = convert_meta(mo, mat)
    obj.name = name
    return obj


# ---------------------------------------------------------------- body (metaball -> mesh)
def body_parts(mb, inflate=0.0, legs=True):
    """Shared proportions. `inflate` thickens garments over the body."""
    i = inflate
    add_capsule(mb, (0, 0, 1.22), (0, 0, 1.36), 0.15 + i)              # chest
    add_ball(mb, (0, 0, 1.36), 0.14 + i)                               # upper chest
    add_capsule(mb, (0, 0, 1.04), (0, 0, 1.20), 0.12 + i)              # waist
    add_capsule(mb, (0, 0, 0.94), (0, 0, 1.04), 0.16 + i)              # hips
    for sx in (1, -1):
        add_ball(mb, (0.07 * sx, 0, 0.96), 0.11 + i)                   # hip shape
        add_ball(mb, (0.17 * sx, 0, 1.34), 0.09 + i)                   # shoulder
        add_capsule(mb, (0.21 * sx, 0, 1.33), (0.24 * sx, 0, 1.07), 0.062 + i)  # upper arm
        add_ball(mb, (0.245 * sx, 0, 1.07), 0.056 + i)                 # elbow
        add_capsule(mb, (0.25 * sx, 0, 1.06), (0.28 * sx, 0, 0.83), 0.05 + i)   # forearm
        add_ball(mb, (0.285 * sx, 0, 0.80), 0.058 + i)                 # wrist
        add_capsule(mb, (0.285 * sx, 0, 0.80), (0.29 * sx, 0, 0.70), 0.06 + i)   # palm
        add_ball(mb, (0.29 * sx, -0.01, 0.73), 0.065 + i)          # knuckle mass
        if legs:
            add_capsule(mb, (0.10 * sx, 0, 0.92), (0.11 * sx, 0, 0.50), 0.10 + i)  # thigh
            add_ball(mb, (0.11 * sx, 0, 0.48), 0.075 + i)              # knee
            add_capsule(mb, (0.11 * sx, 0, 0.46), (0.11 * sx, 0, 0.16), 0.07 + i)  # shin
            add_ball(mb, (0.11 * sx, 0, 0.13), 0.06 + i)               # ankle


def head_parts(mb):
    add_ball(mb, (0, 0, 1.68), 0.245)           # skull (chibi head ratio)
    add_ball(mb, (0, 0.02, 1.64), 0.21)         # cranium back
    add_ball(mb, (0, -0.02, 1.57), 0.165, 1.5)  # jaw and chin
    add_capsule(mb, (0, 0, 1.42), (0, 0, 1.56), 0.065)  # neck


mb, mo = meta_object("CHE_body")
body_parts(mb)
head_parts(mb)
body = convert_meta(mo, MAT["skin"])
body.name = "CHE_body"

mb, mo = meta_object("CHE_jacket")
body_parts(mb, inflate=0.035, legs=False)
jacket = convert_meta(mo, MAT["jacket"])
jacket.name = "CHE_jacket"

mb, mo = meta_object("CHE_trousers")
add_capsule(mb, (0, 0, 0.94), (0, 0, 1.04), 0.175)
for sx in (1, -1):
    add_capsule(mb, (0.10 * sx, 0, 0.92), (0.11 * sx, 0, 0.50), 0.115)
    add_capsule(mb, (0.11 * sx, 0, 0.46), (0.11 * sx, 0, 0.16), 0.085)
trousers = convert_meta(mo, MAT["trousers"])
trousers.name = "CHE_trousers"

# Long hair: a cap, a back drape and a fringe. Rigid on the head bone.
mb, mo = meta_object("CHE_hair")
add_ball(mb, (0, 0.01, 1.80), 0.25)                       # crown
add_capsule(mb, (0, 0.12, 1.50), (0, 0.16, 1.82), 0.20)   # back volume
add_capsule(mb, (0, 0.16, 1.18), (0, 0.18, 1.50), 0.16)   # back curls drop
add_ball(mb, (-0.13, -0.04, 1.98), 0.09)                  # top curls
add_ball(mb, (0.13, -0.04, 1.98), 0.09)
add_ball(mb, (0, 0.14, 1.97), 0.10)
for fx in (-0.12, 0.0, 0.12):
    add_ball(mb, (fx, -0.15, 1.87), 0.095)                # fringe curls
for sx in (1, -1):
    add_ball(mb, (0.22 * sx, 0.02, 1.62), 0.11)           # side curl
    add_ball(mb, (0.23 * sx, 0.07, 1.42), 0.10)
    add_capsule(mb, (0.22 * sx, 0.00, 1.70), (0.20 * sx, 0.06, 1.44), 0.09)
hair = convert_meta(mo, MAT["hair"])
hair.name = "CHE_hair"
rigid(hair, "head")

# ---------------------------------------------------------------- rigid parts
for s, sx in (("L", 1), ("R", -1)):
    cx = 0.085 * sx
    for o in (
        sphere_obj(f"eye_sclera.{s}", (cx, -0.20, 1.67), 0.08, MAT["sclera"]),
        sphere_obj(f"eye_iris.{s}", (cx, -0.25, 1.67), 0.05, MAT["iris"]),
        sphere_obj(f"eye_pupil.{s}", (cx, -0.287, 1.67), 0.026, MAT["pupil"]),
        sphere_obj(f"eye_glint.{s}", (cx + 0.016 * sx, -0.30, 1.69), 0.012, MAT["glint"]),
    ):
        rigid(o, f"eye.{s}")
    shoe = capsule_mesh(f"shoe.{s}", (0.11 * sx, 0.03, 0.07), (0.11 * sx, -0.13, 0.07), 0.075, MAT["shoe"])
    rigid(shoe, f"foot.{s}")
    for fname, (h, t) in FINGER_BONES.items():
        bb = arm.data.bones[f"{fname}.{s}"]
        fm = capsule_mesh(f"{fname}_finger.{s}", bb.head_local, bb.tail_local,
                          0.02 if fname == "thumb" else 0.016, MAT["skin"])
        rigid(fm, f"{fname}.{s}")

# ---------------------------------------------------------------- skinning
for obj in (body, jacket, trousers):
    auto_skin(obj)

# ---------------------------------------------------------------- animation clips
TAU = 2 * math.pi
FINGERS = list(FINGER_BONES)


def S(t, k=1):
    return math.sin(TAU * k * t)


def smooth(x):
    return x * x * (3 - 2 * x)


def mz(side, v):
    """Sideways (Z) angles mirror for the left side."""
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
        "head": (0, 0.05 * math.sin(TAU * t + 0.6), 0.03 * math.sin(TAU * t + 2.0)),
        "upper_arm.L": (0.03 * S(t), 0, mz("L", 0.07)),
        "upper_arm.R": (0.03 * math.sin(TAU * t + 0.8), 0, mz("R", 0.07)),
        "forearm.L": (-0.12, 0, 0),
        "forearm.R": (-0.12, 0, 0),
        "_loc": (0, 0, 0.006 * S(t)),
    }
    return fingers(P, 0.2)


def walk(t):
    a = 0.42 * S(t)
    P = {
        "thigh.L": (a, 0, 0),
        "thigh.R": (-a, 0, 0),
        "shin.L": (0.6 * max(0.0, math.cos(TAU * t)), 0, 0),
        "shin.R": (0.6 * max(0.0, -math.cos(TAU * t)), 0, 0),
        "upper_arm.L": (-0.7 * a, 0, mz("L", 0.06)),
        "upper_arm.R": (0.7 * a, 0, mz("R", 0.06)),
        "forearm.L": (-0.35, 0, 0),
        "forearm.R": (-0.35, 0, 0),
        "spine": (0, 0.05 * S(t), 0),
        "_loc": (0, 0, 0.012 * (1 - math.cos(2 * TAU * t))),
    }
    return fingers(P, 0.2)


def run(t):
    a = 0.75 * S(t)
    P = {
        "thigh.L": (a, 0, 0),
        "thigh.R": (-a, 0, 0),
        "shin.L": (1.0 * max(0.0, math.cos(TAU * t)), 0, 0),
        "shin.R": (1.0 * max(0.0, -math.cos(TAU * t)), 0, 0),
        "upper_arm.L": (-0.9 * a, 0, mz("L", 0.1)),
        "upper_arm.R": (0.9 * a, 0, mz("R", 0.1)),
        "forearm.L": (-1.25, 0, 0),
        "forearm.R": (-1.25, 0, 0),
        "chest": (0.18, 0, 0),
        "spine": (0, 0.08 * S(t), 0),
        "_loc": (0, 0, 0.03 * (1 - math.cos(2 * TAU * t))),
    }
    return fingers(P, 0.5)


def wave(t):
    P = {
        "upper_arm.R": (-1.0, 0, mz("R", 0.5)),
        "forearm.R": (-1.3, 0, 0.35 * S(t, 2)),
        "hand.R": (0, 0, 0.2 * S(t, 2)),
        "upper_arm.L": (0.02, 0, mz("L", 0.06)),
        "forearm.L": (-0.12, 0, 0),
        "head": (0, 0.12 * S(t), 0),
        "chest": (0.02, 0, 0),
    }
    return fingers(P, 0.15)


def sit(t):
    e = smooth(t)
    P = {
        "thigh.L": (-1.45 * e, 0, 0),
        "thigh.R": (-1.45 * e, 0, 0),
        "shin.L": (1.45 * e, 0, 0),
        "shin.R": (1.45 * e, 0, 0),
        "upper_arm.L": (-0.35 * e, 0, mz("L", 0.06 * e)),
        "upper_arm.R": (-0.35 * e, 0, mz("R", 0.06 * e)),
        "forearm.L": (-0.95 * e, 0, 0),
        "forearm.R": (-0.95 * e, 0, 0),
        "chest": (0.06 * e, 0, 0),
        "_loc": (0, 0, -0.45 * e),
    }
    return fingers(P, 0.3 * e)


def stand(t):
    return sit(1 - t)


def talk(t):
    P = {
        "upper_arm.R": (-0.45 + 0.08 * S(t, 2), 0, mz("R", 0.12)),
        "forearm.R": (-1.0 + 0.35 * S(t, 2), 0, 0),
        "head": (0.03 * S(t, 2), 0.08 * S(t), 0.02 * S(t)),
        "chest": (0.02 * S(t, 2), 0, 0),
        "upper_arm.L": (0.02, 0, mz("L", 0.06)),
        "_loc": (0, 0, 0.004 * S(t, 2)),
    }
    return fingers(P, 0.2)


def celebrate(t):
    P = {
        "upper_arm.L": (-0.5, 0, mz("L", 2.1)),
        "upper_arm.R": (-0.5, 0, mz("R", 2.1)),
        "forearm.L": (-0.2 + 0.15 * S(t, 2), 0, 0),
        "forearm.R": (-0.2 + 0.15 * S(t, 2), 0, 0),
        "head": (-0.12, 0, 0),
        "chest": (-0.04, 0, 0),
        "_loc": (0, 0, 0.05 * abs(S(t))),
    }
    return fingers(P, 0.1)


def nod(t):
    return {"head": (0.25 * S(t), 0, 0), "chest": (0.02 * S(t), 0, 0)}


def shake(t):
    return {"head": (0, 0.35 * S(t), 0), "chest": (0, 0.03 * S(t), 0)}


def think(t):
    P = {
        "upper_arm.R": (-1.0, 0, mz("R", 0.15)),
        "forearm.R": (-2.0, 0, 0),
        "head": (0.04, -0.08, 0.12),
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


def bake_clip(name, n, fn, loops):
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
            # One blink per loop: both eyes squash for a few frames.
            P["_blink"] = 1 - 0.9 * max(0.0, 1 - abs((t - 0.55) / 0.03))
        frame = i + 1
        for b in BONES:
            pb = arm.pose.bones[b]
            pb.rotation_mode = "XYZ"
            pb.rotation_euler = P.get(b, (0, 0, 0))
            pb.keyframe_insert("rotation_euler", frame=frame)
        pelvis.location = P.get("_loc", (0, 0, 0))
        pelvis.keyframe_insert("location", frame=frame)
        for eb in eyes:
            eb.scale = (1, 1, P.get("_blink", 1.0))
            eb.keyframe_insert("scale", frame=frame)
    return act


for clip_name, n, fn, loops in CLIPS:
    bake_clip(clip_name, n, fn, loops)
arm.animation_data.action = bpy.data.actions["idle"]

# ---------------------------------------------------------------- export
bpy.ops.object.mode_set(mode="OBJECT")
bpy.ops.object.select_all(action="SELECT")
bpy.ops.export_scene.gltf(
    filepath=OUT,
    export_format="GLB",
    use_selection=False,
    export_animations=True,
    export_animation_mode="ACTIONS",
    export_skins=True,
    export_apply=False,
    export_yup=True,
)
tris = sum(len(p.vertices) - 2 for o in bpy.data.objects if o.type == "MESH" for p in o.data.polygons)
print("EXPORTED", OUT, "triangles", tris, "bones", len(BONES), "clips", len(CLIPS))

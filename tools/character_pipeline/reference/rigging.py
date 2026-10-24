"""Skeleton, skin weights and posing for the reference characters.

The skeleton is MPFB2's "game_engine" rig (53 bones, Unreal-style names, CC0), placed on the shaped body's joint
helpers, plus two eye bones so the app can aim the eyes. Weights for the body come from the rig's own weight file;
everything else (outfit, jewellery) copies weights from the nearest body vertices.

Poses are written as rotations about armature-space axes ("turn the upper arm 60 degrees about the front-back
axis"), which reads the same whatever each bone's local axes are.
"""
import math

import bpy
import numpy as np
from mathutils import Matrix, Vector, kdtree


def weights_per_vertex(weights):
    per = {}
    for bone, items in weights.items():
        for vi, w in items:
            per.setdefault(int(vi), []).append((bone, float(w)))
    return per


def build_armature(base, rig, ground, eyes, name="Rig", point_of=None):
    data = bpy.data.armatures.new(name)
    arm = bpy.data.objects.new(name, data)
    bpy.context.scene.collection.objects.link(arm)
    bpy.context.view_layer.objects.active = arm
    arm.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")
    eb = data.edit_bones

    def point(spec):
        if point_of is not None:
            return Vector(point_of(spec))
        p = base.to_blender(base.rig_point(spec))
        p[2] -= ground
        return Vector(p)

    for bname, b in rig.items():
        e = eb.new(bname)
        e.head, e.tail = point(b["head"]), point(b["tail"])
        if (e.tail - e.head).length < 1e-3:
            e.tail = e.head + Vector((0, 0.1, 0))
        e.roll = b.get("roll", 0.0)
    for bname, b in rig.items():
        if b.get("parent"):
            eb[bname].parent = eb[b["parent"]]
    for side, center in eyes.items():
        e = eb.new(f"eye_{side}")
        e.head = Vector(center)
        e.tail = Vector(center) + Vector((0, -0.03, 0))
        e.parent = eb["head"]
    bpy.ops.object.mode_set(mode="OBJECT")
    return arm


def assign_from_base(obj, base_indices, per):
    groups = {}
    for local, bi in enumerate(base_indices):
        for bone, w in per.get(int(bi), []):
            g = groups.get(bone)
            if g is None:
                g = groups[bone] = obj.vertex_groups.new(name=bone)
            g.add([local], w, "REPLACE")


class NearestWeights:
    """Copies skin weights from the nearest body vertices (inverse-distance blend of the closest few)."""

    def __init__(self, points, base_indices, per):
        self.tree = kdtree.KDTree(len(points))
        for i, p in enumerate(points):
            self.tree.insert(Vector(p), i)
        self.tree.balance()
        self.base_indices = base_indices
        self.per = per

    def weights(self, co, k=4, exclude=()):
        acc = {}
        total = 0.0
        for _, idx, dist in self.tree.find_n(Vector(co), k):
            wd = 1.0 / max(dist, 1e-4)
            for bone, w in self.per.get(int(self.base_indices[idx]), []):
                if bone in exclude:
                    continue
                acc[bone] = acc.get(bone, 0.0) + w * wd
            total += wd
        s = sum(acc.values()) or 1.0
        return {b: w / s for b, w in acc.items()}

    def assign(self, obj, k=4, exclude=(), override=None):
        groups = {}
        for v in obj.data.vertices:
            ws = override(v.co) if override else None
            if not ws:
                ws = self.weights(obj.matrix_world @ v.co, k, exclude)
            for bone, w in ws.items():
                if w < 0.01:
                    continue
                g = groups.get(bone)
                if g is None:
                    g = groups[bone] = obj.vertex_groups.new(name=bone)
                g.add([v.index], w, "REPLACE")


def bind(obj, arm):
    obj.parent = arm
    mod = obj.modifiers.new("Armature", "ARMATURE")
    mod.object = arm


def hierarchy(arm):
    out = []

    def walk(b):
        out.append(b.name)
        for c in b.children:
            walk(c)

    for b in arm.data.bones:
        if b.parent is None:
            walk(b)
    return out


def clear_pose(arm):
    for pb in arm.pose.bones:
        pb.rotation_mode = "QUATERNION"
        pb.rotation_quaternion = (1, 0, 0, 0)
        pb.location = (0, 0, 0)
        pb.scale = (1, 1, 1)
    bpy.context.view_layer.update()


def set_pose(arm, pose):
    """pose: bone -> list of (axis, degrees) in armature space, or ("aim", direction) to point the bone along a
    world direction, or ("aim_at", point) to point it at a world point; "_move": armature-space offset of the pelvis."""
    clear_pose(arm)
    order = hierarchy(arm)
    for name in order:
        pb = arm.pose.bones[name]
        rots = pose.get(name)
        move = pose.get("_move") if name == "pelvis" else None
        if not rots and not move:
            continue
        current = pb.matrix.copy()
        head = current.to_translation()
        r = Matrix.Identity(4)
        for axis, deg in rots or []:
            if axis in ("aim", "aim_at"):
                cur = (pb.tail - pb.head).normalized()
                want = Vector(deg) - pb.head if axis == "aim_at" else Vector(deg)
                r = cur.rotation_difference(want.normalized()).to_matrix().to_4x4() @ r
                continue
            r = Matrix.Rotation(math.radians(deg), 4, Vector(axis)) @ r
        new = Matrix.Translation(head) @ r @ Matrix.Translation(-head) @ current
        if move:
            new = Matrix.Translation(Vector(move)) @ new
        pb.matrix = new
        bpy.context.view_layer.update()


def key_pose(arm, frame):
    for pb in arm.pose.bones:
        pb.keyframe_insert("rotation_quaternion", frame=frame)
    arm.pose.bones["pelvis"].keyframe_insert("location", frame=frame)


def blend_poses(a, b, t):
    """Linear blend of two pose dicts (angles and pelvis offset)."""
    out = {}
    for name in set(a) | set(b):
        if name == "_move":
            ma, mb = np.array(a.get(name, (0, 0, 0))), np.array(b.get(name, (0, 0, 0)))
            out[name] = tuple(ma * (1 - t) + mb * t)
            continue
        ra, rb = {}, {}
        for ax, d in a.get(name, []):
            if isinstance(ax, str):
                continue
            ra[tuple(ax)] = ra.get(tuple(ax), 0) + d
        for ax, d in b.get(name, []):
            if isinstance(ax, str):
                continue
            rb[tuple(ax)] = rb.get(tuple(ax), 0) + d
        out[name] = [(ax, ra.get(ax, 0) * (1 - t) + rb.get(ax, 0) * t) for ax in sorted(set(ra) | set(rb))]
    return out


def bake_action(arm, name, frames, pose_at, loop=True):
    """An action sampled from pose_at(t), t in [0, 1]; a looping clip ends on its first pose."""
    act = bpy.data.actions.new(name)
    act.use_fake_user = True
    arm.animation_data_create()
    arm.animation_data.action = act
    for i in range(frames + 1):
        t = i / frames
        set_pose(arm, pose_at(0.0 if (loop and i == frames) else t))
        key_pose(arm, i + 1)
    return act

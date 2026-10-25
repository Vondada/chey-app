"""Blender side of the motion library: read CHE's rest skeleton into a retarget.Rig and write Clips as actions and NLA
tracks (one track per clip, so the glTF exporter writes one animation per clip next to idle/walk/run/wave/talk).
Only pose channels are written; no bone is added, renamed or removed.
"""
import numpy as np

import bpy

from retarget import Rig  # noqa: E402  (tools/avatar_motion on sys.path)


def rig_from_armature(arm):
    bones = []
    for b in arm.data.bones:   # Blender lists parents before children
        bones.append({'name': b.name, 'parent': b.parent.name if b.parent else None, 'head': list(b.head_local),
                      'tail': list(b.tail_local), 'matrix': [list(r) for r in b.matrix_local.to_3x3()]})
    return Rig(bones)


def _fcurves(action, owner):
    """The F-curve collection to add to (Blender 4.4+ slotted actions, or the legacy action.fcurves)."""
    try:
        from bpy_extras import anim_utils
        slot = action.slots.new(id_type='OBJECT' if isinstance(owner, bpy.types.Object) else 'KEY', name=owner.name) if not action.slots else action.slots[0]
        owner.animation_data_create(); owner.animation_data.action = action
        owner.animation_data.action_slot = slot
        return anim_utils.action_ensure_channelbag_for_slot(action, slot).fcurves
    except (ImportError, AttributeError):
        owner.animation_data_create(); owner.animation_data.action = action
        return action.fcurves


def _curve(fcs, path, index, values, start, group=None):
    fc = fcs.new(path, index=index) if group is None else fcs.new(path, index=index, group_name=group)
    n = len(values)
    fc.keyframe_points.add(n)
    co = np.empty(2 * n); co[0::2] = start + np.arange(n); co[1::2] = values
    fc.keyframe_points.foreach_set('co', co)
    fc.keyframe_points.foreach_set('interpolation', [1] * n)   # LINEAR: every frame is keyed
    fc.update()


def write_clip(arm, rig, clip, name=None, start=0, track=True, mute=True):
    """The clip as an action on the armature (rotation_quaternion of every bone in the clip, pelvis location)."""
    name = name or clip.name
    act = bpy.data.actions.new(name)
    fcs = _fcurves(act, arm)
    for pb in arm.pose.bones: pb.rotation_mode = 'QUATERNION'
    for b, q in clip.q.items():
        if b not in arm.pose.bones: raise KeyError(f'clip bone {b} is not in the skeleton')
        path = f'pose.bones["{b}"].rotation_quaternion'
        q = np.array(q, float)
        for i in range(1, len(q)):   # keep neighbouring keys on the same hemisphere so linear keys do not flip
            if np.dot(q[i], q[i - 1]) < 0: q[i] = -q[i]
        for k in range(4): _curve(fcs, path, k, q[:, k], start, b)
    loc = clip.root_loc(rig)
    for k in range(3): _curve(fcs, 'pose.bones["pelvis"].location', k, loc[:, k], start, 'pelvis')
    arm.animation_data.action = None
    if track:
        tr = arm.animation_data.nla_tracks.new(); tr.name = name
        tr.strips.new(name, start, act); tr.mute = mute
    return act


def write_shape_keys(key, name, curves, start=0, track=True, mute=True):
    """Shape-key values per frame ({key block: (F,) values}) as an action/NLA track on a mesh's Key datablock."""
    act = bpy.data.actions.new(name)
    fcs = _fcurves(act, key)
    for kb, vals in curves.items():
        if kb not in key.key_blocks: raise KeyError(f'no shape key {kb}')
        _curve(fcs, f'key_blocks["{kb}"].value', 0, np.asarray(vals, float), start)
    key.animation_data.action = None
    if track:
        tr = key.animation_data.nla_tracks.new(); tr.name = name
        tr.strips.new(name, start, act); tr.mute = mute
    return act

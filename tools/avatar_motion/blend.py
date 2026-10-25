"""Clips as data, and how they combine: crossfades with root alignment, layered (upper-body) blending, additive
breathing and weight shifts. Pure numpy; Blender only receives the final per-frame bone rotations.

A Clip holds, per frame at `fps`: q {bone: (F, 4) local basis quaternion} and root (F, 3), the pelvis head offset
from its rest position in armature space (Z up, the character's rest facing -Y).
"""
import numpy as np

import quat as Q  # noqa: E402  (tools/avatar_motion on sys.path)

UPPER = ('spine_02', 'spine_03', 'neck_01', 'head', 'clavicle_l', 'clavicle_r', 'upperarm_l', 'upperarm_r', 'lowerarm_l',
         'lowerarm_r', 'hand_l', 'hand_r')


class Clip:
    def __init__(self, name, q, root, fps, meta=None):
        self.name, self.q, self.root, self.fps, self.meta = name, q, np.asarray(root, float), float(fps), dict(meta or {})

    @property
    def frames(self): return len(self.root)

    @property
    def seconds(self): return (self.frames - 1) / self.fps

    def slice(self, a, b):
        return Clip(self.name, {k: v[a:b] for k, v in self.q.items()}, self.root[a:b], self.fps, self.meta)

    @staticmethod
    def from_local(name, rig, local, root_loc, fps, meta=None):
        """From retarget(): basis rotation matrices and the pelvis basis location."""
        q = {k: Q.from_matrix(v) for k, v in local.items()}
        root = root_loc @ rig.rest['pelvis'].T   # basis location -> armature-space offset (Root is never posed)
        return Clip(name, q, root, fps, meta)

    def root_loc(self, rig):
        return self.root @ rig.rest['pelvis']


def smoothstep(x):
    x = np.clip(x, 0.0, 1.0)
    return x * x * (3 - 2 * x)


def heading(rig, clip, f):
    """Yaw (radians about +Z) of the pelvis at frame f, 0 for CHE's rest facing (-Y)."""
    R = rig.rest['pelvis']; G = R @ Q.to_matrix(clip.q['pelvis'][f])
    return float(Q.yaw_of(G @ R.T))


def transform(rig, clip, yaw, offset):
    """The clip turned by `yaw` about the vertical axis through the rest pelvis and moved by `offset` (x, y)."""
    Rz = Q.axis_angle((0, 0, 1), yaw); R = rig.rest['pelvis']
    q = dict(clip.q)
    q['pelvis'] = Q.mul(Q.from_matrix(R.T @ Rz @ R), clip.q['pelvis'])
    root = clip.root @ Rz.T
    root[:, :2] += np.asarray(offset, float)[:2]
    return Clip(clip.name, q, root, clip.fps, clip.meta)


def align_to(rig, clip, f_clip, ref, f_ref, match_height=False):
    """Turn and move `clip` so its frame f_clip has the heading and ground position of `ref` at f_ref."""
    yaw = heading(rig, ref, f_ref) - heading(rig, clip, f_clip)
    c = transform(rig, clip, yaw, (0, 0))
    off = ref.root[f_ref] - c.root[f_clip]
    if not match_height: off[2] = 0.0
    c.root = c.root + off
    return c


def crossfade(rig, a, b, fade_frames, b_start=0):
    """a, then b (aligned to a's pose where the fade starts), blended over fade_frames with a smoothstep weight. b's
    frames before b_start are skipped. Returns one Clip at a's fps."""
    n = min(fade_frames, a.frames, b.frames - b_start)
    s = a.frames - n
    b2 = align_to(rig, b.slice(b_start, b.frames), 0, a, s)
    w = smoothstep((np.arange(n) + 1) / (n + 1))
    q = {}
    for k in a.q:
        mix = Q.slerp(a.q[k][s:], b2.q[k][:n], w[:, None])
        q[k] = np.concatenate([a.q[k][:s], mix, b2.q[k][n:]])
    root = np.concatenate([a.root[:s], a.root[s:] * (1 - w[:, None]) + b2.root[:n] * w[:, None], b2.root[n:]])
    return Clip(f'{a.name}+{b.name}', q, root, a.fps, {'parts': [a.name, b.name], 'fade_frames': n})


def layer(base, over, bones=UPPER, weight=None, over_start=0):
    """Overrides `bones` of base with over's (slerp by weight per frame, default 1). over loops if shorter."""
    F = base.frames
    w = np.ones(F) if weight is None else np.asarray(weight, float)
    idx = (over_start + np.arange(F)) % over.frames
    q = {k: v.copy() for k, v in base.q.items()}
    for k in bones:
        if k in over.q: q[k] = Q.slerp(base.q[k], over.q[k][idx], w[:, None])
    return Clip(f'{base.name}|{over.name}', q, base.root.copy(), base.fps, {**base.meta, 'layer': over.name})


def additive(clip, bone, axis_local, deg_curve):
    """Adds a rotation (degrees per frame) about a bone-local axis on top of the clip (breathing, weight shift)."""
    q = dict(clip.q)
    ang = np.radians(np.asarray(deg_curve, float)) / 2
    ax = np.asarray(axis_local, float) / np.linalg.norm(axis_local)
    d = np.stack([np.cos(ang), *(ax[i] * np.sin(ang) for i in range(3))], -1)
    q[bone] = Q.mul(clip.q[bone], d)
    return Clip(clip.name, q, clip.root.copy(), clip.fps, clip.meta)


def breathing(clip, rate_hz=0.24, deg=1.2, phase=0.0):
    """Idle breathing: chest (spine_03) and a little clavicle lift, as an additive layer."""
    t = np.arange(clip.frames) / clip.fps
    s = np.sin(2 * np.pi * rate_hz * t + phase)
    c = additive(clip, 'spine_03', (1, 0, 0), deg * s)
    for side in ('clavicle_l', 'clavicle_r'):
        if side in c.q: c = additive(c, side, (0, 0, 1), 0.5 * deg * s)
    return c


def resample(clip, fps):
    """The clip at another frame rate (slerp between neighbouring frames)."""
    if abs(fps - clip.fps) < 1e-6: return clip
    t = np.arange(int(np.floor(clip.seconds * fps + 1e-9)) + 1) / fps * clip.fps
    i0 = np.clip(np.floor(t).astype(int), 0, clip.frames - 1); i1 = np.clip(i0 + 1, 0, clip.frames - 1); w = (t - i0)[:, None]
    q = {k: Q.slerp(v[i0], v[i1], w) for k, v in clip.q.items()}
    return Clip(clip.name, q, clip.root[i0] * (1 - w) + clip.root[i1] * w, fps, clip.meta)


def hold(clip, frames):
    """The last frame held for `frames` more frames."""
    q = {k: np.concatenate([v, np.repeat(v[-1:], frames, 0)]) for k, v in clip.q.items()}
    return Clip(clip.name, q, np.concatenate([clip.root, np.repeat(clip.root[-1:], frames, 0)]), clip.fps, clip.meta)

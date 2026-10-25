"""BVH motion files: parse, forward kinematics and resampling, in plain numpy (no Blender), so the clip library and its
tests run anywhere.

  skel, motion, frame_time = parse(text)
  world_rot, world_pos = fk(skel, motion)          # (frames, joints, 3, 3) and (frames, joints, 3), BVH axes
  R, P = to_blender(world_rot, world_pos)          # Blender axes: Z up, character facing -Y (MPFB's rest facing)

The CMU conversion (B. Hahne, 2010) uses Y up, the subject facing +Z in its frame-0 T-pose, inches-like units, 120 fps.
"""
import math

import numpy as np

# BVH (Y up, facing +Z, left = +X) -> Blender (Z up, facing -Y, left = +X): a +90 degree rotation about X.
BVH_TO_BLENDER = np.array([[1.0, 0.0, 0.0], [0.0, 0.0, -1.0], [0.0, 1.0, 0.0]])


class Joint:
    __slots__ = ('name', 'parent', 'offset', 'channels', 'end', 'index', 'col')

    def __init__(self, name, parent):
        self.name, self.parent, self.offset, self.channels, self.end, self.index, self.col = name, parent, np.zeros(3), [], None, 0, 0


def parse(text):
    """Returns (joints, motion (frames, channels) float array, frame_time seconds)."""
    tok = text.split()
    i, joints, stack, col = 0, [], [], 0
    cur = None
    while tok[i] != 'MOTION':
        t = tok[i]
        if t in ('ROOT', 'JOINT'):
            j = Joint(tok[i + 1], stack[-1] if stack else None); j.index = len(joints); joints.append(j); cur = j; i += 2
        elif t == 'End':
            cur = None; i += 2   # "End Site"
        elif t == '{':
            stack.append(cur if cur is not None else ('END', stack[-1])); i += 1
        elif t == '}':
            stack.pop(); i += 1
        elif t == 'OFFSET':
            off = np.array([float(x) for x in tok[i + 1:i + 4]])
            top = stack[-1]
            if isinstance(top, tuple): top[1].end = off
            else: top.offset = off
            i += 4
        elif t == 'CHANNELS':
            n = int(tok[i + 1]); stack[-1].channels = tok[i + 2:i + 2 + n]; stack[-1].col = col; col += n; i += 2 + n
        else:
            i += 1
    frames = int(tok[tok.index('Frames:') + 1])
    ft = float(tok[tok.index('Time:') + 1])
    start = tok.index('Time:') + 2
    data = np.array(tok[start:start + frames * col], dtype=float).reshape(frames, col)
    return joints, data, ft


def _axis_rot(axis, deg):
    a = np.radians(deg); c, s = np.cos(a), np.sin(a)
    n = a.shape[0]
    R = np.zeros((n, 3, 3)); one = np.ones(n); zero = np.zeros(n)
    if axis == 'X': R[:] = np.stack([np.stack([one, zero, zero], -1), np.stack([zero, c, -s], -1), np.stack([zero, s, c], -1)], 1)
    elif axis == 'Y': R[:] = np.stack([np.stack([c, zero, s], -1), np.stack([zero, one, zero], -1), np.stack([-s, zero, c], -1)], 1)
    else: R[:] = np.stack([np.stack([c, -s, zero], -1), np.stack([s, c, zero], -1), np.stack([zero, zero, one], -1)], 1)
    return R


def fk(joints, motion):
    """World rotations (F, J, 3, 3) and joint positions (F, J, 3) in BVH axes and units."""
    F, J = motion.shape[0], len(joints)
    W = np.zeros((F, J, 3, 3)); P = np.zeros((F, J, 3))
    for j in joints:
        R = np.tile(np.eye(3), (F, 1, 1)); pos = np.zeros((F, 3))
        for k, ch in enumerate(j.channels):
            v = motion[:, j.col + k]
            if ch.endswith('rotation'): R = R @ _axis_rot(ch[0].upper(), v)
            else: pos[:, 'XYZ'.index(ch[0].upper())] = v
        if j.parent is None:
            W[:, j.index] = R; P[:, j.index] = j.offset + pos
        else:
            pw = W[:, j.parent.index]
            W[:, j.index] = pw @ R
            P[:, j.index] = P[:, j.parent.index] + np.einsum('fij,j->fi', pw, j.offset)
    return W, P


def end_positions(joints, W, P):
    """World position of each joint's End Site (or None)."""
    return {j.name: P[:, j.index] + np.einsum('fij,j->fi', W[:, j.index], j.end) for j in joints if j.end is not None}


def to_blender(W, P):
    C = BVH_TO_BLENDER
    return np.einsum('ij,fkjl,ml->fkim', C, W, C), np.einsum('ij,fkj->fki', C, P)


def resample_index(n_src, src_dt, dst_dt, start=0, end=None):
    """Fractional source frame numbers for each destination frame between start and end (source frames)."""
    end = n_src - 1 if end is None else min(end, n_src - 1)
    dur = (end - start) * src_dt
    m = int(math.floor(dur / dst_dt + 1e-9)) + 1
    return start + np.arange(m) * dst_dt / src_dt


def lerp_frames(A, idx):
    """Linear interpolation of a per-frame array at fractional frame numbers."""
    i0 = np.clip(np.floor(idx).astype(int), 0, len(A) - 1); i1 = np.clip(i0 + 1, 0, len(A) - 1)
    w = (idx - i0).reshape((-1,) + (1,) * (A.ndim - 1))
    return A[i0] * (1 - w) + A[i1] * w


def resample_rotations(W, idx):
    """Rotation matrices at fractional frames: quaternion slerp per joint."""
    from quat import from_matrix, slerp, to_matrix  # noqa: E402  (tools/avatar_motion on sys.path)
    q = from_matrix(W)
    i0 = np.clip(np.floor(idx).astype(int), 0, len(W) - 1); i1 = np.clip(i0 + 1, 0, len(W) - 1)
    w = (idx - i0).reshape((-1,) + (1,) * (q.ndim - 1))
    return to_matrix(slerp(q[i0], q[i1], w))

"""The realism sample's body timeline, in numpy (no Blender): walk in, turn and sit (CMU 86_15), crossfaded into a
seated gesture take (same actor), turned to face the camera, placed so her hips land over the seat, with additive
breathing, finger-curl variation while she talks and one foot-lock pass over the whole timeline.

  build(rig, fps)              -> Timeline (clip + where the seat is + reports)
  seam_report(clip, a, b)      -> angular speed inside the crossfade window vs the rest (blend quality)
  shard_range(n, k, N)         -> the k-th of N contiguous frame ranges (CI render matrix)
Used by tools/cinematic/sample.py and tested in tools/test_realism_sample.py with the real 53-bone rig fixture.
"""
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
for _p in (os.path.join(os.path.dirname(HERE), 'avatar_motion'),):
    if _p not in sys.path: sys.path.insert(0, _p)

import blend as B  # noqa: E402
import library  # noqa: E402
import quat as Q  # noqa: E402
import retarget as RT  # noqa: E402

SEAT_XY = (0.0, 1.25)
FADE_S = 0.6
SEAT_BELOW_HIPS_M = 0.095   # thigh-bone heads sit this far above the cushion top on CHE's proportions


class Timeline:
    def __init__(self, clip, walk_seconds, seated_f, fade, hips, seat_top, report):
        self.clip, self.walk_seconds, self.seated_f, self.fade = clip, walk_seconds, seated_f, fade
        self.hips, self.seat_top, self.report = hips, seat_top, report


def build(rig, fps=24, seat_xy=SEAT_XY, m=None):
    m = m or library.manifest()
    walk, _ = library.build('walk_turn_sit', rig, fps=fps, lock=False, m=m)
    talk, _ = library.build('seated_gesture', rig, fps=fps, lock=False, m=m)
    fade = int(FADE_S * fps)
    seq = B.crossfade(rig, walk, talk, fade)
    seated_f = walk.frames - fade
    seq = B.transform(rig, seq, -B.heading(rig, seq, seated_f), (0, 0))   # seated: facing the room (-Y)
    off = np.asarray(seat_xy, float) - (rig.head['pelvis'][:2] + seq.root[seated_f, :2])
    seq.root[:, :2] += off
    n = seq.frames
    t = np.arange(n) / fps
    seq = B.breathing(seq, rate_hz=0.25, deg=1.0)
    amt = np.where(t > walk.seconds - 0.6, 0.12 * np.sin(2 * np.pi * 0.7 * t) + 0.08 * np.sin(2 * np.pi * 1.9 * t + 1.0), 0.0)
    for k, R in RT.finger_curl(rig, n, amt).items(): seq.q[k] = Q.mul(seq.q[k], Q.from_matrix(R))
    local = {k: Q.to_matrix(v) for k, v in seq.q.items()}
    local, fl = RT.foot_lock(rig, local, seq.root_loc(rig), fps=fps)
    seq = B.Clip.from_local('cinematic_sample', rig, local, seq.root_loc(rig), fps)
    _, H, _ = RT.pose_world(rig, local, seq.root_loc(rig))
    hips = (H['thigh_l'][seated_f + fade] + H['thigh_r'][seated_f + fade]) / 2
    contact = {s: RT.contact_slip(H[f'foot_{s}'], H[f'ball_{s}'], fps) for s in 'lr'}
    files = sorted({m['clips'][k]['file'] for k in ('walk_turn_sit', 'seated_gesture')})
    report = {'frames': n, 'seconds': round(n / fps, 2), 'fps': fps,
              'parts': [f"walk_turn_sit (CMU {m['clips']['walk_turn_sit']['file']})", f"seated_gesture (CMU {m['clips']['seated_gesture']['file']})"],
              'files': files, 'crossfade_s': round(fade / fps, 3), 'foot_lock': fl, 'contact_check': contact,
              'seam': seam_report(seq, seated_f, seated_f + fade)}
    return Timeline(seq, walk.seconds, seated_f, fade, hips, float(hips[2]) - SEAT_BELOW_HIPS_M, report)


def angular_speed(clip, bones=None):
    """Per-frame rotation step (degrees) of each bone's local rotation: {bone: (F,)} with 0 at frame 0."""
    out = {}
    for k in bones or clip.q:
        q = clip.q[k]
        d = np.abs(np.sum(q[1:] * q[:-1], axis=1)).clip(0, 1)
        out[k] = np.r_[0.0, np.degrees(2 * np.arccos(d))]
    return out


def seam_report(clip, a, b, bones=('pelvis', 'spine_02', 'spine_03', 'neck_01', 'head', 'upperarm_l', 'upperarm_r',
                                   'lowerarm_l', 'lowerarm_r', 'thigh_l', 'thigh_r', 'calf_l', 'calf_r')):
    """Largest per-frame rotation step in the crossfade window [a, b] (one frame either side) against the 99th
    percentile outside it, and the root's largest step there against elsewhere. A pop at the seam shows as a ratio
    well above 1."""
    sp = angular_speed(clip, bones)
    F = clip.frames
    win = np.zeros(F, bool); win[max(1, a - 1):min(F, b + 2)] = True
    out = np.zeros(F, bool); out[1:] = True; out &= ~win
    inside = max(float(v[win].max()) for v in sp.values())
    ref = max(float(np.percentile(v[out], 99)) for v in sp.values())
    rs = np.r_[0.0, np.linalg.norm(np.diff(clip.root, axis=0), axis=1)] * clip.fps
    return {'window': [int(a), int(b)], 'max_step_deg': round(inside, 2), 'p99_step_deg_elsewhere': round(ref, 2),
            'ratio': round(inside / max(ref, 1e-6), 2), 'root_speed_max_ms': round(float(rs[win].max()), 3),
            'root_speed_p99_elsewhere_ms': round(float(np.percentile(rs[out], 99)), 3)}


def shard_range(n, k, N):
    """Frames of the k-th (0-based) of N contiguous, near-equal ranges over n frames."""
    if not (N >= 1 and 0 <= k < N): raise ValueError(f'shard {k}/{N}')
    return list(range((n * k) // N, (n * (k + 1)) // N))

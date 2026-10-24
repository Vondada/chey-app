"""The reusable motion library: CMU human motion capture retargeted onto the game_engine rig.

Each entry names a CMU clip (Bruce Hahne's BVH conversion of the Carnegie Mellon Graphics Lab database, free for
any use), the frames to take at 120 fps, and how the clip is finished: looped (the best pose match inside a length
window, blended so it never pops), kept in place (the app moves the character, so the horizontal hip travel is
removed and the ground speed reported), or split at a hip-height change (sit down / get up from one take).

build(target, bvh_dir, fps=30) returns {name: report} and leaves one Action per entry on the target armature.
Every report carries the retarget scale, foot-contact frames and the largest ankle slide before and after the
foot lock, so a build can be judged by numbers, not by a description.
"""
import math

import numpy as np

import mocap

# name, cmu id, (start, end) at 120 fps or None for the whole take, finish, options
# finish: "loop" (min_s, max_s), "once", "in_place_loop" (walks), "split_sit" / "split_stand" (one take, cut at the hips)
LIBRARY = [
    ("idle",           "137_28", (1, 1500),         ("loop", 3.0, 6.0), {}),
    ("idle_graceful",  "137_23", (1, 1500),         ("loop", 3.0, 6.0), {}),
    ("idle_relaxed",   "142_13", (1, 1500),         ("loop", 3.0, 6.0), {}),
    ("walk",           "137_24", (1, 600),     ("in_place_loop", 0.9, 1.5), {}),
    ("walk_confident", "137_38", (1, 600),     ("in_place_loop", 0.9, 1.5), {}),
    ("walk_plain",     "137_29", (1, 600),     ("in_place_loop", 0.9, 1.5), {}),
    ("turn_left",      "16_17",  None,         ("once",), {"in_place": True}),
    ("turn_right",     "16_19",  None,         ("once",), {"in_place": True}),
    ("sit",            "143_18", None,         ("split_sit",), {}),
    ("stand",          "143_18", None,         ("split_stand",), {}),
    ("talk",           "138_11", None,         ("loop", 2.0, 4.0), {"upper_only": True}),
    ("talk_story",     "138_12", None,         ("loop", 2.0, 3.0), {"upper_only": True}),
    ("gesture_chat",   "18_08",  (1, 1500),         ("loop", 4.0, 7.0), {"upper_only": True}),
    ("wave",           "141_16", None,         ("once",), {"trim_still": True}),
    ("celebrate",      "142_09", (1, 720),         ("once",), {"trim_still": True}),
    ("elated",         "142_06", (1, 720),         ("once",), {"trim_still": True}),
    ("type",           "79_85",  None,         ("loop", 3.0, 6.0), {}),
    ("laugh",          "79_70",  None,         ("once",), {"trim_still": True}),
    ("surprise",       "120_15", (1, 600),         ("once",), {"trim_still": True}),
    ("greet",          "141_26", None,         ("once",), {"trim_still": True}),
]


def _hip_height(clip):
    return clip.hips[:, 2]


def _split_at_hips(clip, part):
    """One take of sit-down-and-get-up: the seated stretch is where the hips sit low; 'sit' runs from the
    standing start to the first settled low frame, 'stand' from the last settled low frame to the end."""
    z = _hip_height(clip)
    hi, lo = float(np.percentile(z, 95)), float(np.percentile(z, 5))
    low = z < lo + 0.25 * (hi - lo)
    idx = np.where(low)[0]
    if not len(idx):
        raise ValueError("no seated stretch found")
    first, last = int(idx[0]), int(idx[-1])
    pad = int(0.4 * clip.fps)
    if part == "sit":
        a, b = max(0, first - int(1.2 * clip.fps)), min(clip.frames - 1, first + pad)
    else:
        a, b = max(0, last - pad), min(clip.frames - 1, last + int(1.2 * clip.fps))
    _cut(clip, a, b)
    return {"split": part, "frames": [a, b], "hip_high_m": round(hi, 3), "hip_low_m": round(lo, 3)}


def _cut(clip, a, b):
    for n in clip.names:
        clip.q[n] = clip.q[n][a:b + 1].copy()
    clip.hips = clip.hips[a:b + 1].copy()


def _trim_still(clip, thresh=0.015):
    """Drops the motionless lead-in and tail a mocap take always has (the actor waiting for the clap)."""
    d = np.array([mocap.pose_distance(clip, i, i + 1) for i in range(clip.frames - 1)])
    moving = np.where(d > thresh)[0]
    if not len(moving):
        return {"trimmed": [0, clip.frames - 1]}
    a, b = max(0, int(moving[0]) - int(0.3 * clip.fps)), min(clip.frames - 1, int(moving[-1]) + int(0.4 * clip.fps))
    _cut(clip, a, b)
    return {"trimmed": [a, b]}


def _trim_moving(clip, min_speed=0.35):
    """Keeps the stretch where the hips travel (a walking take starts and ends with the actor standing)."""
    v = np.linalg.norm(np.diff(clip.hips[:, :2], axis=0), axis=1) * clip.fps
    k = max(1, int(0.25 * clip.fps))
    vs = np.convolve(v, np.ones(k) / k, mode="same")
    moving = np.where(vs > min_speed)[0]
    if not len(moving):
        return {"moving": None}
    a, b = int(moving[0]), int(moving[-1]) + 1
    _cut(clip, a, b)
    return {"moving": [a, b], "mean_speed_mps": round(float(vs[moving].mean()), 3)}


def _loop(clip, min_s, max_s):
    lo, hi = int(min_s * clip.fps), int(max_s * clip.fps)
    if clip.frames <= lo + 2:
        return {"loop": None, "reason": f"take is {clip.frames} frames, shorter than {lo}"}
    d, a, L = mocap.best_loop(clip, lo, min(hi, clip.frames - 2))
    mocap.make_loop(clip, a, L)
    return {"loop": [a, L], "seam_distance": round(d, 4)}


def build(target, bvh_dir, fps=30, only=None, log=print):
    step = max(1, round(120 / fps))
    reports = {}
    for name, cmu, rng, finish, opts in LIBRARY:
        if only and name not in only:
            continue
        src = mocap.import_bvh(f"{bvh_dir}/{cmu}.bvh")
        total = int(src.animation_data.action.frame_range[1])
        a, b = rng if rng else (1, total)
        clip, rt = mocap.capture(target, src, a, min(b, total), step)
        clip.fps = fps
        rep = {"source": f"CMU {cmu}", "frames_120": [a, min(b, total)], "scale": round(rt.scale, 5)}
        rep["turn_deg"] = round(mocap.face_forward(clip), 1)
        mocap.smooth(clip)
        rep["head_pitch_fixed_deg"] = round(mocap.level_head(clip), 1)
        kind = finish[0]
        if kind == "split_sit":
            rep.update(_split_at_hips(clip, "sit"))
        elif kind == "split_stand":
            rep.update(_split_at_hips(clip, "stand"))
        if opts.get("trim_still"):
            rep.update(_trim_still(clip))
        if kind == "in_place_loop":
            rep.update(_trim_moving(clip))
        if kind in ("loop", "in_place_loop"):
            rep.update(_loop(clip, finish[1], finish[2]))
        if kind == "in_place_loop" or opts.get("in_place"):
            rep["ground_speed_mps"] = round(mocap.in_place(clip), 3)
        rep["foot_lock"] = mocap.foot_lock(target, clip, fps)
        loop = kind in ("loop", "in_place_loop")
        mocap.write_action(target, clip, name, loop)
        rep["frames"] = clip.frames
        rep["seconds"] = round((clip.frames - 1) / fps, 2)
        rep["loop"] = loop if "loop" not in rep else rep["loop"]
        reports[name] = rep
        log(f"[motion] {name:15s} {cmu} {clip.frames} frames {rep['seconds']} s foot slide L {rep['foot_lock']['l']['slide_mm_after']} R {rep['foot_lock']['r']['slide_mm_after']} mm")
        # The imported source armature is not part of the character: remove it before the next clip.
        import bpy
        src_action = src.animation_data.action if src.animation_data else None
        bpy.data.objects.remove(src, do_unlink=True)
        if src_action:
            bpy.data.actions.remove(src_action)
    return reports

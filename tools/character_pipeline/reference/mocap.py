"""Motion capture for the reference characters: CMU BVH clips retargeted onto the MPFB "game_engine" skeleton.

Source data: the CMU Graphics Lab Motion Capture Database in Bruce Hahne's BVH conversion (free for any use, see
READMEFIRST.txt in https://github.com/una-dinosauria/cmu-mocap), fetched by fetch_mocap.sh at pinned paths.

Retargeting (rotation transfer through a matched rest pose):
1. The target skeleton is posed into the source's rest pose: every mapped bone turned, by the smallest rotation, to
   point the way the source bone points at rest (T-pose, legs straight). Feet and toes are left alone, so her heels keep
   their angle.
2. For every frame, each target bone's world rotation is the source bone's rotation since its rest, applied to the
   matched rest: R_target(t) = R_source(t) @ R_source_rest^T @ R_target_matched. Twist carries over, because both
   skeletons start from the same pose.
3. The hips move by the source's hip path scaled by the ratio of hip heights.

Clean-up (cleanup()):
- quaternion sign continuity and a small Gaussian filter (mocap jitter),
- foot contacts found from the ankle's height and speed; while a foot is planted its ankle is pinned where it landed
  and the leg is solved with two-bone IK (no foot sliding), blended in and out over a few frames,
- loops: the cut points with the closest poses, the end blended into the start, the hip path made periodic,
- in-place clips: the forward hip travel removed and its speed recorded, so the app moves the character at the clip's
  own speed (stride and ground speed match).

Everything here is plain math on bone matrices (no depsgraph per bone), so a 20 second clip retargets in seconds.
"""
import math

import bpy
import numpy as np
from mathutils import Matrix, Quaternion, Vector

# target bone -> source bone (CMU naming). Neck1 and the hip joints fold into their neighbours' world rotations.
BONE_MAP = {
    "pelvis": "Hips", "spine_01": "LowerBack", "spine_02": "Spine", "spine_03": "Spine1", "neck_01": "Neck",
    "head": "Head",
    "clavicle_l": "LeftShoulder", "upperarm_l": "LeftArm", "lowerarm_l": "LeftForeArm", "hand_l": "LeftHand",
    "clavicle_r": "RightShoulder", "upperarm_r": "RightArm", "lowerarm_r": "RightForeArm", "hand_r": "RightHand",
    "thigh_l": "LeftUpLeg", "calf_l": "LeftLeg", "foot_l": "LeftFoot", "ball_l": "LeftToeBase",
    "thigh_r": "RightUpLeg", "calf_r": "RightLeg", "foot_r": "RightFoot", "ball_r": "RightToeBase",
}
# Bones whose rest direction is matched to the source's (the feet keep the heel angle; zero-length CMU bones are
# matched through their child's direction).
MATCH_DIR = {
    "pelvis": ("Hips", "LowerBack", "Spine1"),       # pelvis: up the spine
    "spine_01": ("LowerBack",), "spine_02": ("Spine",), "spine_03": ("Spine", "Neck"),
    "neck_01": ("Neck",), "head": ("Head",),
    "clavicle_l": ("LeftShoulder",), "upperarm_l": ("LeftArm",), "lowerarm_l": ("LeftForeArm",),
    "hand_l": ("LeftForeArm",),
    "clavicle_r": ("RightShoulder",), "upperarm_r": ("RightArm",), "lowerarm_r": ("RightForeArm",),
    "hand_r": ("RightForeArm",),
    "thigh_l": ("LeftUpLeg",), "calf_l": ("LeftLeg",), "thigh_r": ("RightUpLeg",), "calf_r": ("RightLeg",),
}
LEGS = {"l": ("thigh_l", "calf_l", "foot_l"), "r": ("thigh_r", "calf_r", "foot_r")}


def import_bvh(path):
    before = set(bpy.data.objects)
    bpy.ops.import_anim.bvh(filepath=path, global_scale=1.0, frame_start=1, use_fps_scale=False,
                            rotate_mode="NATIVE", axis_forward="-Z", axis_up="Y", update_scene_fps=False)
    ob = next(o for o in bpy.data.objects if o not in before)
    ob.hide_render = True
    return ob


def _rest_world(arm):
    mw = arm.matrix_world
    return {b.name: mw @ b.matrix_local for b in arm.data.bones}


def _dir_of(arm, names, rest):
    """World direction of a source bone (or the chain from the first to the last name) at rest."""
    b0 = arm.data.bones[names[0]]
    b1 = arm.data.bones[names[-1]]
    head = rest[b0.name].to_translation()
    tail = arm.matrix_world @ b1.tail_local
    d = tail - head
    if d.length < 1e-6:
        d = rest[b0.name].to_3x3() @ Vector((0, 1, 0))
    return d.normalized()


class Retarget:
    def __init__(self, target, source):
        self.t, self.s = target, source
        self.t_rest = _rest_world(target)
        self.s_rest = _rest_world(source)
        self.order = []

        def walk(b):
            self.order.append(b.name)
            for c in b.children:
                walk(c)

        for b in target.data.bones:
            if b.parent is None:
                walk(b)
        # Matched rest: world rotations of the target bones when posed like the source rest.
        self.matched = {}
        for name in self.order:
            rest = self.t_rest[name].to_3x3()
            parent = target.data.bones[name].parent
            if parent is not None and parent.name in self.matched:
                # Carry the parent's matching turn down the chain first.
                turn = self.matched[parent.name] @ self.t_rest[parent.name].to_3x3().inverted()
                rest = turn @ rest
            if name in MATCH_DIR:
                cur = (rest @ Vector((0, 1, 0))).normalized()
                want = _dir_of(source, MATCH_DIR[name], self.s_rest)
                rest = cur.rotation_difference(want).to_matrix() @ rest
            self.matched[name] = rest
        # Hip height above the toes at rest sets the scale (the source's units are not metres).
        hips_t = self.t_rest["pelvis"].to_translation()
        hips_s = self.s_rest["Hips"].to_translation()
        toe_t = min(self.t_rest[n].to_translation().z for n in ("ball_l", "ball_r"))
        toe_s = min((source.matrix_world @ source.data.bones[n].tail_local).z for n in ("LeftToeBase", "RightToeBase"))
        self.scale = (hips_t.z - toe_t) / max(hips_s.z - toe_s, 1e-6)
        self.floor_t = toe_t

    def frame_rotations(self, frame):
        """World rotations (3x3) of every target bone and the hip position at a source frame."""
        bpy.context.scene.frame_set(frame)
        mw = self.s.matrix_world
        out = {}
        for name in self.order:
            src = BONE_MAP.get(name)
            if src is not None:
                rs = (mw @ self.s.pose.bones[src].matrix).to_3x3()
                out[name] = rs @ self.s_rest[src].to_3x3().inverted() @ self.matched[name]
            else:
                parent = self.t.data.bones[name].parent
                # Unmapped bones (fingers, eyes, root) keep their rest pose relative to the parent.
                if parent is None:
                    out[name] = self.t_rest[name].to_3x3()
                else:
                    rel = self.t_rest[parent.name].to_3x3().inverted() @ self.t_rest[name].to_3x3()
                    out[name] = out[parent.name] @ rel
        hips = (mw @ self.s.pose.bones["Hips"].matrix).to_translation()
        p = hips * self.scale
        p.z += self.floor_t
        return out, p


def fk(target, rot, hip_pos):
    """World matrices of the target bones from world rotations and the hip position."""
    mats = {}
    rest = _rest_world(target)
    for b in _order(target):
        name = b.name
        if b.parent is None:
            head = rest[name].to_translation()
        elif name == "pelvis":
            head = hip_pos
        else:
            p = b.parent
            # The head sits at the same offset from the parent as at rest, turned with the parent.
            off = rest[p.name].inverted() @ rest[name].to_translation()
            head = mats[p.name] @ off
        m = rot[name].to_4x4()
        m.translation = head
        mats[name] = m
    return mats


def _order(arm):
    out = []

    def walk(b):
        out.append(b)
        for c in b.children:
            walk(c)

    for b in arm.data.bones:
        if b.parent is None:
            walk(b)
    return out


def two_bone_ik(hip, knee, ankle, target, pole):
    """New knee position for a leg whose ankle must reach target (lengths kept, knee toward pole)."""
    a = (knee - hip).length
    b = (ankle - knee).length
    d = target - hip
    L = min(max(d.length, 1e-4), a + b - 1e-4)
    dn = d.normalized()
    x = (a * a - b * b + L * L) / (2 * L)
    h = math.sqrt(max(a * a - x * x, 0.0))
    side = (pole - hip) - dn * (pole - hip).dot(dn)
    side = side.normalized() if side.length > 1e-6 else Vector((0, -1, 0))
    return hip + dn * x + side * h


def gaussian(a, sigma):
    if sigma <= 0:
        return a
    r = int(3 * sigma)
    k = np.exp(-0.5 * (np.arange(-r, r + 1) / sigma) ** 2)
    k /= k.sum()
    pad = np.pad(a, [(r, r)] + [(0, 0)] * (a.ndim - 1), mode="edge")
    return np.stack([np.convolve(pad[:, j], k, mode="valid") for j in range(a.shape[1])], axis=1)


class Clip:
    """A retargeted clip as arrays: per bone quaternions (frames x 4, world rotations) and the hip path."""

    def __init__(self, names, quats, hips, fps):
        self.names, self.q, self.hips, self.fps = names, quats, hips, fps

    @property
    def frames(self):
        return len(self.hips)


def capture(target, source, start, end, step):
    rt = Retarget(target, source)
    names = rt.order
    q = {n: [] for n in names}
    hips = []
    for f in range(start, end + 1, step):
        rot, hip = rt.frame_rotations(f)
        for n in names:
            q[n].append(rot[n].to_quaternion())
        hips.append(hip)
    quats = {}
    for n in names:
        arr = np.array([[x.w, x.x, x.y, x.z] for x in q[n]])
        for i in range(1, len(arr)):                     # sign continuity
            if np.dot(arr[i], arr[i - 1]) < 0:
                arr[i] = -arr[i]
        quats[n] = arr
    return Clip(names, quats, np.array([tuple(h) for h in hips]), None), rt


def smooth(clip, sigma=1.2):
    for n in clip.names:
        a = gaussian(clip.q[n], sigma)
        clip.q[n] = a / np.linalg.norm(a, axis=1, keepdims=True)
    clip.hips = gaussian(clip.hips, sigma)


def rot_at(clip, n, i):
    w, x, y, z = clip.q[n][i]
    return Quaternion((w, x, y, z)).to_matrix()


def ankle_track(target, clip):
    out = {"l": [], "r": []}
    for i in range(clip.frames):
        mats = fk(target, {n: rot_at(clip, n, i) for n in clip.names}, Vector(clip.hips[i]))
        for s, (_, _, foot) in LEGS.items():
            out[s].append(mats[foot].to_translation())
    return {s: np.array([tuple(v) for v in vs]) for s, vs in out.items()}


def contacts(track, fps, floor_z, height=0.035, speed=0.25):
    """Frames where the ankle is near its lowest height and nearly still (m/s)."""
    v = np.zeros(len(track))
    v[1:] = np.linalg.norm(np.diff(track[:, :2], axis=0), axis=1) * fps
    low = track[:, 2] < floor_z + height
    c = low & (v < speed)
    # Drop single-frame flickers.
    for i in range(1, len(c) - 1):
        if c[i - 1] == c[i + 1] != c[i]:
            c[i] = c[i - 1]
    return c


def foot_lock(target, clip, fps, blend=3):
    """Pins each planted ankle where it landed and re-solves the leg (two-bone IK), blended in and out."""
    tracks = ankle_track(target, clip)
    report = {}
    for s, (thigh, calf, foot) in LEGS.items():
        tr = tracks[s]
        floor_z = float(np.percentile(tr[:, 2], 5))
        c = contacts(tr, fps, floor_z)
        goal = tr.copy()
        w = np.zeros(len(tr))
        i = 0
        while i < len(c):
            if not c[i]:
                i += 1
                continue
            j = i
            while j + 1 < len(c) and c[j + 1]:
                j += 1
            pin = tr[i:j + 1].mean(axis=0)
            pin[2] = max(pin[2], floor_z)
            goal[i:j + 1] = pin
            w[i:j + 1] = 1.0
            for k in range(1, blend + 1):              # ease in and out of the pin
                for idx, src in ((i - k, i), (j + k, j)):
                    if 0 <= idx < len(c) and not c[idx]:
                        t = 1 - k / (blend + 1)
                        if t > w[idx]:
                            w[idx] = t
                            goal[idx] = goal[src]
            i = j + 1
        slide_before = _slide(tr, c, fps)
        for i in range(clip.frames):
            if w[i] <= 0:
                continue
            rot = {n: rot_at(clip, n, i) for n in clip.names}
            mats = fk(target, rot, Vector(clip.hips[i]))
            hip, knee, ankle = (mats[b].to_translation() for b in (thigh, calf, foot))
            want = ankle.lerp(Vector(goal[i]), w[i])
            pole = knee + (mats[thigh].to_3x3() @ Vector((0, 0, -1))) * 0.0 + (knee - (hip + ankle) / 2) * 4
            new_knee = two_bone_ik(hip, knee, ankle, want, pole)
            r_thigh = (knee - hip).normalized().rotation_difference((new_knee - hip).normalized()).to_matrix()
            new_thigh = r_thigh @ rot[thigh]
            moved_ankle = new_knee + r_thigh @ (ankle - knee)
            r_calf = (moved_ankle - new_knee).normalized().rotation_difference((want - new_knee).normalized()).to_matrix()
            new_calf = r_calf @ r_thigh @ rot[calf]
            # The foot keeps its world orientation (it is planted), so only the leg above it moves.
            for n, m in ((thigh, new_thigh), (calf, new_calf)):
                q = m.to_quaternion()
                prev = clip.q[n][i]
                arr = np.array([q.w, q.x, q.y, q.z])
                clip.q[n][i] = arr if np.dot(arr, prev) >= 0 else -arr
        after = ankle_track(target, clip)[s]
        report[s] = {"contact_frames": int(c.sum()), "slide_mm_before": slide_before,
                     "slide_mm_after": _slide(after, c, fps)}
    return report


def _slide(track, c, fps):
    """Largest horizontal travel of the ankle inside any one contact (mm)."""
    worst = 0.0
    i = 0
    while i < len(c):
        if not c[i]:
            i += 1
            continue
        j = i
        while j + 1 < len(c) and c[j + 1]:
            j += 1
        seg = track[i:j + 1, :2]
        worst = max(worst, float(np.max(np.linalg.norm(seg - seg[0], axis=1))) if len(seg) > 1 else 0.0)
        i = j + 1
    return round(worst * 1000, 1)


def pose_distance(clip, a, b):
    return float(sum(np.linalg.norm(clip.q[n][a] - clip.q[n][b]) for n in clip.names if n in BONE_MAP))


def best_loop(clip, min_len, max_len):
    best = (1e9, 0, min_len)
    for a in range(0, max(1, clip.frames - min_len)):
        for L in range(min_len, min(max_len, clip.frames - a - 1) + 1):
            d = pose_distance(clip, a, a + L)
            if d < best[0]:
                best = (d, a, L)
    return best


def make_loop(clip, a, L, blend=6):
    """Cuts frames a..a+L and blends the last frames toward the first so the clip loops without a pop."""
    for n in clip.names:
        seg = clip.q[n][a:a + L + 1].copy()
        first = seg[0]
        for k in range(blend):
            t = (k + 1) / (blend + 1)
            i = L - blend + k
            q0 = seg[i]
            f = first if np.dot(first, q0) >= 0 else -first
            m = f * t + q0 * (1 - t)
            seg[i] = m / np.linalg.norm(m)
        seg[L] = first if np.dot(first, seg[L - 1]) >= 0 else -first
        clip.q[n] = seg
    clip.hips = clip.hips[a:a + L + 1].copy()


def in_place(clip, axis_forward=Vector((0, -1, 0))):
    """Removes horizontal travel (the app moves the character) and returns the clip's ground speed (m/s)."""
    h = clip.hips
    travel = np.linalg.norm(h[-1, :2] - h[0, :2])
    seconds = (len(h) - 1) / clip.fps
    line = np.linspace(0, 1, len(h))[:, None] * (h[-1, :2] - h[0, :2])
    h[:, :2] = h[:, :2] - h[0, :2] - line
    return travel / seconds if seconds > 0 else 0.0


def face_forward(clip):
    """Turns the whole clip so its travel (or, standing still, the first frame's facing) points to -Y, her front."""
    h = clip.hips
    d = h[-1, :2] - h[0, :2]
    if np.linalg.norm(d) < 0.3:
        lr = _hip_axis(clip, 0)                         # the front is perpendicular to the hips' left-right axis
        d = np.array([lr[1], -lr[0]])
    ang = -math.atan2(d[0], -d[1])                      # turn that brings d onto -Y
    R = Matrix.Rotation(ang, 3, "Z")
    for n in clip.names:
        for i in range(clip.frames):
            q = (R @ rot_at(clip, n, i)).to_quaternion()
            clip.q[n][i] = [q.w, q.x, q.y, q.z]
        for i in range(1, clip.frames):
            if np.dot(clip.q[n][i], clip.q[n][i - 1]) < 0:
                clip.q[n][i] = -clip.q[n][i]
    for i in range(clip.frames):
        h[i] = tuple(R @ Vector(h[i]))
    return math.degrees(ang)


def _hip_axis(clip, i):
    m = rot_at(clip, "pelvis", i)
    # The pelvis bone points up the spine; its local X is the hips' left-right axis.
    v = m @ Vector((1, 0, 0))
    return (v.x, v.y)


def write_action(target, clip, name, loop):
    """Keys the clip on the target as an action of local rotations (and the pelvis location)."""
    rest = _rest_world(target)
    order = _order(target)
    act = bpy.data.actions.new(name)
    act.use_fake_user = True
    target.animation_data_create()
    target.animation_data.action = act
    for pb in target.pose.bones:
        pb.rotation_mode = "QUATERNION"
    inv_mw = target.matrix_world.inverted()
    for i in range(clip.frames):
        world = {n: rot_at(clip, n, i) for n in clip.names}
        mats = fk(target, world, Vector(clip.hips[i]))
        for b in order:
            pb = target.pose.bones[b.name]
            arm_m = inv_mw @ mats[b.name]
            if b.parent is None:
                basis = b.matrix_local.inverted() @ arm_m
            else:
                parent_m = inv_mw @ mats[b.parent.name]
                basis = (parent_m @ b.parent.matrix_local.inverted() @ b.matrix_local).inverted() @ arm_m
            pb.rotation_quaternion = basis.to_quaternion()
            pb.keyframe_insert("rotation_quaternion", frame=i + 1)
            if b.name == "pelvis":
                pb.location = basis.to_translation()
                pb.keyframe_insert("location", frame=i + 1)
    target.animation_data.action = None
    return act

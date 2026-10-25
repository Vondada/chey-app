"""Retargeting CMU mocap onto CHE's MPFB "game_engine" skeleton (53 bones), in numpy.

The target rig is described by `Rig` (rest head, tail and rest rotation of every bone, armature space, Blender axes),
which tools/avatar_motion/blender_rig.py reads from the armature. Nothing here adds, renames or removes a bone.

Method (world-space delta retargeting with a matched rest frame):
  For a mapped bone b driven by source joint s (pointing at source joint c), both rest directions get an orthonormal
  frame from the bone direction and a fixed world reference (forward -Y; up +Z for bones that point forward, the
  feet). A_b = F_src(frame 0) @ F_tgt(rest)^T takes CHE's rest A-pose bone onto the source's frame-0 T-pose bone with
  matching twist. Each frame: G_b(t) = W_s(t) @ W_s(0)^T @ A_b @ R_rest_b (the source's change since its T-pose,
  applied to CHE's matched bone). Unmapped bones keep their rest relation to their parent; fingers get a procedural
  relaxed curl (CMU has no finger data). The pose rotation Blender stores is the bone's local basis:
  Q_b = R_rest_b^T @ R_rest_parent @ G_parent^T @ G_b.
  Root motion: the pelvis head follows the source Hips, scaled by the leg-length ratio (horizontal from the clip's
  start, vertical as an offset from the rest height).
"""
import numpy as np

from quat import arc, axis_angle, yaw_of  # noqa: E402  (tools/avatar_motion on sys.path)

# MPFB game_engine bone -> (CMU joint, joint it points at). World-space retargeting, so CMU's extra joints (Neck1,
# LHipJoint, FingerBase) need no 1:1 partner.
CMU_MAP = {
    'pelvis': ('Hips', 'Spine'),   # LowerBack and Neck sit on their parents (zero offsets)
    'spine_01': ('LowerBack', 'Spine'), 'spine_02': ('Spine', 'Spine1'), 'spine_03': ('Spine1', 'Neck1'),
    'neck_01': ('Neck', 'Head'), 'head': ('Head', '@end'),
    'clavicle_l': ('LeftShoulder', 'LeftArm'), 'upperarm_l': ('LeftArm', 'LeftForeArm'),
    'lowerarm_l': ('LeftForeArm', 'LeftHand'), 'hand_l': ('LeftHand', 'LeftHandIndex1'),
    'clavicle_r': ('RightShoulder', 'RightArm'), 'upperarm_r': ('RightArm', 'RightForeArm'),
    'lowerarm_r': ('RightForeArm', 'RightHand'), 'hand_r': ('RightHand', 'RightHandIndex1'),
    'thigh_l': ('LeftUpLeg', 'LeftLeg'), 'calf_l': ('LeftLeg', 'LeftFoot'), 'foot_l': ('LeftFoot', 'LeftToeBase'),
    'ball_l': ('LeftToeBase', '@end'),
    'thigh_r': ('RightUpLeg', 'RightLeg'), 'calf_r': ('RightLeg', 'RightFoot'), 'foot_r': ('RightFoot', 'RightToeBase'),
    'ball_r': ('RightToeBase', '@end'),
}
FINGERS = ('thumb', 'index', 'middle', 'ring', 'pinky')
FORWARD = np.array([0.0, -1.0, 0.0]); UP = np.array([0.0, 0.0, 1.0])


class Rig:
    """Rest skeleton: names in parent-first order, parent name or None, head/tail (3,), rest rotation (3, 3)."""

    def __init__(self, bones):
        self.names = [b['name'] for b in bones]
        self.parent = {b['name']: b['parent'] for b in bones}
        self.head = {b['name']: np.asarray(b['head'], float) for b in bones}
        self.tail = {b['name']: np.asarray(b['tail'], float) for b in bones}
        self.rest = {b['name']: np.asarray(b['matrix'], float) for b in bones}
        self.index = {n: i for i, n in enumerate(self.names)}

    def to_json(self):
        return [{'name': n, 'parent': self.parent[n], 'head': self.head[n].tolist(), 'tail': self.tail[n].tolist(),
                 'matrix': self.rest[n].tolist()} for n in self.names]

    def leg_length(self, s='l'):
        return float(np.linalg.norm(self.head[f'calf_{s}'] - self.head[f'thigh_{s}']) + np.linalg.norm(self.head[f'foot_{s}'] - self.head[f'calf_{s}']))


def frame(d, ref=FORWARD):
    """Orthonormal frame (columns: d, ref' , d x ref') with d the bone direction."""
    d = d / np.linalg.norm(d)
    r = ref - np.dot(ref, d) * d
    if np.linalg.norm(r) < 0.3:   # bone nearly along the reference: use up instead
        r = UP - np.dot(UP, d) * d
    r /= np.linalg.norm(r)
    return np.stack([d, r, np.cross(d, r)], 1)


def pose_world(rig, local, root_loc=None):
    """Forward kinematics of the target rig. local: {bone: (F, 3, 3) basis rotations}; root_loc: (F, 3) pelvis basis
    location. Returns ({bone: (F,3,3) world rotation}, {bone: (F,3) head position}, {bone: (F,3) tail position})."""
    F = next(iter(local.values())).shape[0]
    G, H, T = {}, {}, {}
    for n in rig.names:
        R = rig.rest[n]; q = local.get(n, np.tile(np.eye(3), (F, 1, 1)))
        p = rig.parent[n]
        if p is None:
            G[n] = R @ q; H[n] = np.tile(rig.head[n], (F, 1))
        else:
            Rp = rig.rest[p]
            G[n] = G[p] @ Rp.T @ R @ q
            H[n] = H[p] + np.einsum('fij,j->fi', G[p] @ Rp.T, rig.head[n] - rig.head[p])
        if n == 'pelvis' and root_loc is not None:
            M = G[p] @ rig.rest[p].T @ R if p else np.tile(R, (F, 1, 1))
            H[n] = H[n] + np.einsum('fij,fj->fi', M, root_loc)
        T[n] = H[n] + np.einsum('fij,j->fi', G[n], R.T @ (rig.tail[n] - rig.head[n]))
    return G, H, T


def local_from_world(rig, G):
    """Basis rotations from world rotations (every bone of the rig must be in G)."""
    out = {}
    for n in rig.names:
        p = rig.parent[n]; R = rig.rest[n]
        if p is None: out[n] = np.einsum('ij,fjk->fik', R.T, G[n])
        else: out[n] = R.T @ rig.rest[p] @ np.transpose(G[p], (0, 2, 1)) @ G[n]
    return out


def finger_curl(rig, F, amount=None):
    """Relaxed-hand world rotations are built by retarget(); this returns {bone: (F, 3, 3) local curl} with each finger
    joint bent toward the palm. amount: (F,) or None (a relaxed 0.35)."""
    a = np.full(F, 0.35) if amount is None else np.asarray(amount, float)
    out = {}
    for s in 'lr':
        across = rig.head[f'index_01_{s}'] - rig.head[f'pinky_01_{s}']
        across /= np.linalg.norm(across)
        for fi, fname in enumerate(FINGERS):
            base = {'thumb': 0.5, 'index': 0.75, 'middle': 0.95, 'ring': 1.05, 'pinky': 1.15}[fname]
            for k in (1, 2, 3):
                n = f'{fname}_0{k}_{s}'
                if n not in rig.rest: continue
                d = rig.tail[n] - rig.head[n]; d /= np.linalg.norm(d)
                ax = across if fname != 'thumb' else np.cross(d, UP)
                # sign: bending must move the tip toward the body midline (palms face the thighs in the A-pose)
                tip = rig.tail[n] - rig.head[n]
                sign = 1.0
                Rt = _rot(ax, 0.3) @ tip
                if abs(rig.head[n][0] + Rt[0]) > abs(rig.head[n][0] + tip[0]): sign = -1.0
                deg = np.radians({1: 22, 2: 30, 3: 20}[k]) * base
                R = rig.rest[n]
                axl = R.T @ (ax * sign)   # the axis in the bone's own rest frame
                out[n] = np.stack([_rot(axl, ang) for ang in deg * a / 0.35])
    return out


def _rot(axis, rad):
    axis = axis / np.linalg.norm(axis)
    K = np.array([[0, -axis[2], axis[1]], [axis[2], 0, -axis[0]], [-axis[1], axis[0], 0]])
    return np.eye(3) + np.sin(rad) * K + (1 - np.cos(rad)) * K @ K


def retarget(rig, src_names, W, P, ends=None, finger_amount=None, mapping=CMU_MAP):
    """W (F, J, 3, 3), P (F, J, 3): source world rotations and positions in Blender axes, frame 0 the T-pose reference
    (pass the reference as W[0]/P[0]; see bvh.py). Returns (local {bone: (F,3,3)}, root_loc (F,3), info)."""
    idx = {n: i for i, n in enumerate(src_names)}
    F = W.shape[0]
    W0, P0 = W[0], P[0]
    src_leg = float(np.linalg.norm(P0[idx['LeftLeg']] - P0[idx['LeftUpLeg']]) + np.linalg.norm(P0[idx['LeftFoot']] - P0[idx['LeftLeg']]))
    scale = rig.leg_length('l') / src_leg
    G = {}
    for n in rig.names:
        p = rig.parent[n]; R = rig.rest[n]
        if n in mapping and mapping[n][0] in idx:
            s, c = mapping[n]
            if c == '@end':
                d_src = (ends[s][0] - P0[idx[s]]) if ends and s in ends else (W0[idx[s]] @ np.array([0, 0, 1.0]))
            else:
                d_src = P0[idx[c]] - P0[idx[s]]
            d_tgt = rig.tail[n] - rig.head[n]
            ref = UP if abs(d_tgt[1]) > 0.8 * np.linalg.norm(d_tgt) else FORWARD
            A = frame(d_src, ref) @ frame(d_tgt, ref).T
            G[n] = W[:, idx[s]] @ W0[idx[s]].T @ A @ R
        elif p is None:
            G[n] = np.tile(R, (F, 1, 1))
        else:
            G[n] = G[p] @ rig.rest[p].T @ R
    local = local_from_world(rig, G)
    curl = finger_curl(rig, F, finger_amount)
    for n, q in curl.items(): local[n] = local[n] @ q
    hips = P[:, idx['Hips']]
    root = np.zeros((F, 3))
    root[:, :2] = (hips[:, :2] - hips[0, :2]) * scale
    root[:, 2] = (hips[:, 2] - hips[0, 2]) * scale
    # The basis location is in the pelvis' rest frame (its parent Root is never posed).
    R = rig.rest['pelvis']
    root_loc = root @ R   # (R^T @ v) for each row
    return local, root_loc, {'scale_m_per_unit': scale, 'frames': F}


def foot_contacts(H_ankle, H_ball, floor=None, height_tol=0.035, speed_tol=0.25, fps=30.0):
    """Frames where a foot is planted: its lowest point (ankle or ball) is within height_tol of the floor and the
    ball moves slower than speed_tol m/s horizontally. Returns a boolean array."""
    low = np.minimum(H_ankle[:, 2] - 0.06, H_ball[:, 2])
    fl = np.percentile(low, 5) if floor is None else floor
    v = np.zeros(len(H_ball)); v[1:] = np.linalg.norm(np.diff(H_ball[:, :2], axis=0), axis=1) * fps
    c = (low - fl < height_tol) & (v < speed_tol)
    # close one-frame gaps and drop single-frame contacts
    for i in range(1, len(c) - 1):
        if not c[i] and c[i - 1] and c[i + 1]: c[i] = True
    for i in range(1, len(c) - 1):
        if c[i] and not c[i - 1] and not c[i + 1]: c[i] = False
    return c


def contact_slip(H_foot, H_ball, fps=30.0, floor=None, height_tol=0.035, speed_tol=0.25, min_frames=3):
    """Foot-contact check on finished motion (numpy FK or positions read back from Blender): finds the planted
    segments in THESE positions (same rule as foot_contacts) and measures how far each contact point drifts sideways
    while it is actually on the floor: the heel (foot head) on the frames it is within touch_tol of its lowest
    height, the ball likewise. A heel lifting while the ball stays put (the roll before toe-off) is not slip; either
    point gliding while grounded is. Segments shorter than min_frames are ignored (touch-and-go steps).
    Returns {segments, contact_frames, max_slip_mm, mean_slip_mm, per_segment_mm: [...]} (slip 0 when none)."""
    H_foot = np.asarray(H_foot, float); H_ball = np.asarray(H_ball, float)
    c = foot_contacts(H_foot, H_ball, floor=floor, height_tol=height_tol, speed_tol=speed_tol, fps=fps)
    touch_tol = 0.015
    grounded = [(P, P[:, 2] - np.percentile(P[:, 2], 5) < touch_tol) for P in (H_foot, H_ball)]
    per = []
    for s0, s1 in segments(c):
        if s1 - s0 < min_frames: continue
        worst = 0.0
        for P, g in grounded:
            idx = np.nonzero(g[s0:s1])[0] + s0
            if len(idx) >= 2: worst = max(worst, float(np.linalg.norm(P[idx, :2] - P[idx[0], :2], axis=1).max()))
        per.append(1000 * worst)
    return {'segments': len(per), 'contact_frames': int(c.sum()), 'max_slip_mm': round(max(per), 1) if per else 0.0,
            'mean_slip_mm': round(float(np.mean(per)), 1) if per else 0.0, 'per_segment_mm': [round(x, 1) for x in per]}


def ground_offset(rig, local, root_loc, pct=10):
    """Vertical shift (m) that puts the clip's planted feet on the floor: the lowest foot point per frame, measured
    against CHE's rest ankle and ball heights, at its `pct` percentile over the clip, goes to zero."""
    _, H, _ = pose_world(rig, local, root_loc)
    low = np.min([np.minimum(H[f'foot_{s}'][:, 2] - rig.head[f'foot_{s}'][2], H[f'ball_{s}'][:, 2] - rig.head[f'ball_{s}'][2])
                  for s in 'lr'], axis=0)
    return -float(np.percentile(low, pct))


def segments(mask):
    out, start = [], None
    for i, m in enumerate(list(mask) + [False]):
        if m and start is None: start = i
        if not m and start is not None: out.append((start, i)); start = None
    return out


def two_bone_ik(hip, knee, ankle, target, a, b):
    """Analytic two-bone IK. Returns the new knee position (the knee stays in the plane of the original hip-knee-ankle,
    so it bends the way the mocap bent it)."""
    d = target - hip; dist = float(np.clip(np.linalg.norm(d), 1e-6, 0.9995 * (a + b))); u = d / np.linalg.norm(d)
    cos_t = np.clip((a * a + dist * dist - b * b) / (2 * a * dist), -1, 1)
    pole = knee - hip - np.dot(knee - hip, u) * u
    if np.linalg.norm(pole) < 1e-6: pole = FORWARD - np.dot(FORWARD, u) * u
    pole /= np.linalg.norm(pole)
    return hip + a * (cos_t * u + np.sqrt(1 - cos_t ** 2) * pole)


def foot_lock(rig, local, root_loc, fps=30.0, blend=4, floor=0.0, speed_tol=0.25):
    """Pins each planted foot where it landed (two-bone IK on thigh and calf; the foot keeps its world rotation) and
    raises nothing above the floor. Returns (new local, report {side: {segments, slip_before_mm, slip_after_mm}})."""
    local = {k: v.copy() for k, v in local.items()}
    G, H, T = pose_world(rig, local, root_loc)
    F = len(root_loc)
    report = {}
    for s in 'lr':
        th, ca, fo, ba = (f'{k}_{s}' for k in ('thigh', 'calf', 'foot', 'ball'))
        contact = foot_contacts(H[fo], H[ba], floor=None, fps=fps, speed_tol=speed_tol)
        a = float(np.linalg.norm(rig.head[ca] - rig.head[th])); b = float(np.linalg.norm(rig.head[fo] - rig.head[ca]))
        target = H[fo].copy(); w = np.zeros(F)
        segs = segments(contact)
        slip_before = []
        # Which point carries the foot: the heel (foot head) while it is down, the ball while the heel is lifted
        # (the roll before toe-off, pivots). The grounded point is pinned horizontally; the heel keeps the mocap
        # height, so it can still lift. Switching points moves the anchor so the goal stays continuous.
        heel_g = H[fo][:, 2] - np.percentile(H[fo][:, 2], 5) < 0.015
        ball_g = H[ba][:, 2] - np.percentile(H[ba][:, 2], 5) < 0.015
        # A flat foot (heel and ball both down) cannot turn on the floor: its world yaw is held from the frame it
        # went flat (mocap feet often twist a few degrees there, which swings the ball sideways by centimetres).
        Gfoot = G[fo].copy()
        for s0, s1 in segs:
            yaw0 = None
            for f in range(s0, s1):
                if heel_g[f] and ball_g[f]:
                    y = float(yaw_of(Gfoot[f] @ rig.rest[fo].T))
                    if yaw0 is None: yaw0 = y
                    Gfoot[f] = axis_angle((0, 0, 1), yaw0 - y) @ Gfoot[f]
                else:
                    yaw0 = None
        off = np.einsum('fij,j->fi', Gfoot @ rig.rest[fo].T, rig.head[ba] - rig.head[fo])
        for s0, s1 in segs:
            slip_before.append(float(np.linalg.norm(H[fo][s0:s1, :2] - H[fo][s0, :2], axis=1).max()))
            mode = 'heel' if heel_g[s0] or not ball_g[s0] else 'ball'
            anchor = H[fo][s0, :2].copy() if mode == 'heel' else H[ba][s0, :2].copy()
            for f in range(s0, s1):
                m = 'heel' if heel_g[f] else ('ball' if ball_g[f] else mode)
                if m != mode and f > s0:
                    anchor = target[f - 1, :2].copy() if m == 'heel' else target[f - 1, :2] + off[f - 1, :2]
                    mode = m
                target[f, :2] = anchor if mode == 'heel' else anchor - off[f, :2]
                target[f, 2] = H[fo][f, 2]
            w[s0:s1] = 1.0
            for k in range(1, blend + 1):   # ease in and out of the lock
                if s0 - k >= 0 and w[s0 - k] < 1:
                    w[s0 - k] = max(w[s0 - k], 1 - k / (blend + 1)); target[s0 - k, :2] = target[s0, :2]
                if s1 - 1 + k < F and w[s1 - 1 + k] < 1:
                    w[s1 - 1 + k] = max(w[s1 - 1 + k], 1 - k / (blend + 1)); target[s1 - 1 + k, :2] = target[s1 - 1, :2]
        for f in range(F):
            goal = H[fo][f] * (1 - w[f]) + target[f] * w[f]
            if w[f] == 0: continue
            hip, knee, ank = H[th][f], H[ca][f], H[fo][f]
            k2 = two_bone_ik(hip, knee, ank, goal, a, b)
            # rotate thigh so its direction hits the new knee, calf so it hits the goal
            dt = arc(knee - hip, k2 - hip)
            Rt = dt @ G[th][f]
            Rc = arc(dt @ (ank - knee), goal - k2) @ dt @ G[ca][f]
            # local bases
            p = rig.parent[th]
            local[th][f] = rig.rest[th].T @ rig.rest[p] @ G[p][f].T @ Rt
            local[ca][f] = rig.rest[ca].T @ rig.rest[th] @ Rt.T @ Rc
            local[fo][f] = rig.rest[fo].T @ rig.rest[ca] @ Rc.T @ Gfoot[f]
        report[s] = {'segments': len(segs), 'contact_frames': int(contact.sum()),
                     'slip_before_mm': round(1000 * max(slip_before), 1) if slip_before else 0.0}
    G2, H2, _ = pose_world(rig, local, root_loc)
    for s in 'lr':
        fo, ba = f'foot_{s}', f'ball_{s}'
        # the same independent check before and after (contact_slip: grounded heel or ball gliding)
        report[s]['check_before_mm'] = contact_slip(H[fo], H[ba], fps)['max_slip_mm']
        report[s]['slip_after_mm'] = contact_slip(H2[fo], H2[ba], fps)['max_slip_mm']
    return local, report

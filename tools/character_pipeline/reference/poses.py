"""Poses and clips for the reference characters, in armature-space terms (see rigging.set_pose).

Axes (Blender, the character faces -Y): X is the character's left, Y points backward, Z up.
  Arm down toward the body: left arm +Y degrees, right arm -Y.  Swing an arm or a leg forward: -X.
  Bend a knee back: +X.  Bend an elbow forward: -X.  Nod down: head +X.  Turn the head to her left: +Z.
The clip names match the crew page's twelve (idle, walk, run, wave, sit, stand, talk, think, celebrate, nod, shake,
type), so the new GLB plays in the existing scene unchanged.
"""
import math

X, Y, Z = (1.0, 0.0, 0.0), (0.0, 1.0, 0.0), (0.0, 0.0, 1.0)


def merge(*poses):
    out = {}
    for p in poses:
        for k, v in p.items():
            if k == "_move":
                a = out.get(k, (0, 0, 0))
                out[k] = tuple(x + y for x, y in zip(a, v))
            else:
                out[k] = list(out.get(k, [])) + list(v)
    return out


ARMS_DOWN = {
    "upperarm_l": [(Y, 36)], "upperarm_r": [(Y, -36)],
    "lowerarm_l": [(X, 18)], "lowerarm_r": [(X, 18)],
    "hand_l": [(Y, 4)], "hand_r": [(Y, -4)],
}
STAND = dict(ARMS_DOWN)


def fingers(curl, side):
    """A relaxed curl: each finger joint bends toward the palm."""
    out = {}
    for f in ("index", "middle", "ring", "pinky"):
        for j in ("01", "02", "03"):
            out[f"{f}_{j}_{side}"] = [(X, -curl * (0.6 if j == "01" else 1.0))]
    out[f"thumb_02_{side}"] = [(X, -curl * 0.4)]
    return out


RELAXED_HANDS = merge(fingers(14, "l"), fingers(14, "r"))


def walk(t, stride=22, swing=16, run=False):
    ph = 2 * math.pi * t
    s, c = math.sin(ph), math.cos(ph)
    k = 1.5 if run else 1.0
    lean = 9 if run else 2
    pose = {
        "thigh_l": [(X, -stride * k * s - 2)], "thigh_r": [(X, stride * k * s - 2)],
        "calf_l": [(X, 6 + 30 * k * max(0.0, c) ** 1.4)], "calf_r": [(X, 6 + 30 * k * max(0.0, -c) ** 1.4)],
        "foot_l": [(X, -6 * s)], "foot_r": [(X, 6 * s)],
        "upperarm_l": [(Y, 36), (X, swing * k * s)], "upperarm_r": [(Y, -36), (X, -swing * k * s)],
        "lowerarm_l": [(X, 18 - (60 if run else 8))], "lowerarm_r": [(X, 18 - (60 if run else 8))],
        "spine_01": [(X, lean), (Z, -3 * s)], "pelvis": [(Z, 4 * s)],
        "head": [(X, -lean * 0.6)],
        "_move": (0, 0, -0.012 * abs(c) - (0.03 if run else 0.0)),
    }
    return merge(pose, RELAXED_HANDS)


def sit_base(drop):
    """Seated on a chair: thighs forward, shins down, a slight forward lean; the pelvis lowered by drop."""
    return {
        "thigh_l": [(X, -84), (Z, 4)], "thigh_r": [(X, -84), (Z, -4)],
        "calf_l": [(X, 84)], "calf_r": [(X, 84)],
        "foot_l": [(X, 4)], "foot_r": [(X, 4)],
        "spine_01": [(X, 5)], "spine_02": [(X, 3)], "head": [(X, 6)],
        "_move": (0, 0.05, -drop),
    }


def sit(drop, typing=0.0, t=0.0):
    tw = typing * math.sin(2 * math.pi * t * 6)
    return merge(sit_base(drop), {
        "upperarm_l": [(Y, 40), (X, -32)], "upperarm_r": [(Y, -40), (X, -32)],
        "lowerarm_l": [(X, -52 + 3 * tw), (Z, -14)], "lowerarm_r": [(X, -52 - 3 * tw), (Z, 14)],
        "hand_l": [(X, 8)], "hand_r": [(X, 8)],
    }, merge(fingers(18 + 8 * abs(tw), "l"), fingers(18 + 8 * abs(tw), "r")))


def poster(drop):
    """The poster's pose: seated, chin resting on her right hand, the other arm on the armrest."""
    base = sit_base(drop)
    base["head"] = [(X, 4), (Z, -6), (Y, 5)]
    return merge(base, {
        "thigh_l": [(Z, -10)], "calf_l": [(X, -6)],
        "upperarm_r": [(Y, 4), (X, -40)],
        "lowerarm_r": [(X, -122), (Z, 26)],
        "hand_r": [(X, -24)],
        "upperarm_l": [(Y, 26), (X, -10)], "lowerarm_l": [(X, -38), (Z, -10)],
    }, fingers(26, "r"), fingers(12, "l"))


def talk(t=0.25, amount=1.0):
    g = math.sin(2 * math.pi * t)
    return merge(STAND, RELAXED_HANDS, {
        "upperarm_r": [(Y, 8 * amount), (X, (-24 - 6 * g) * amount)],
        "lowerarm_r": [(X, (-62 - 10 * g) * amount), (Z, 12 * amount)],
        "hand_r": [(X, -12 * amount)],
        "head": [(Z, -5 * amount), (X, (-2 + 2 * g) * amount)],
        "spine_02": [(Z, 3 * amount)],
    })


def idle(t):
    b = math.sin(2 * math.pi * t)
    return merge(STAND, RELAXED_HANDS, {
        "spine_02": [(X, 1.2 * b)], "spine_03": [(X, 0.8 * b)],
        "head": [(Z, 3 * math.sin(2 * math.pi * t + 0.8)), (X, -1 + 1.5 * b)],
        "upperarm_l": [(Y, 1.2 * b)], "upperarm_r": [(Y, -1.2 * b)],
    })


def wave(t):
    w = math.sin(2 * math.pi * t * 2)
    return merge(STAND, RELAXED_HANDS, {
        "upperarm_r": [(Y, 128), (X, -15)],
        "lowerarm_r": [(Y, 22 + 22 * w)],
        "head": [(Z, -6)],
    })


def think(t):
    b = math.sin(2 * math.pi * t)
    return merge(STAND, {
        "upperarm_r": [(Y, 12), (X, -48)],
        "lowerarm_r": [(X, -118), (Z, 24)],
        "hand_r": [(X, -20)],
        "upperarm_l": [(X, -18)], "lowerarm_l": [(X, -70), (Z, -30)],
        "head": [(Z, -7 + 2 * b), (X, 7)],
    }, fingers(30, "r"), fingers(14, "l"))


def celebrate(t):
    b = abs(math.sin(2 * math.pi * t * 2))
    return merge(RELAXED_HANDS, {
        "upperarm_l": [(Y, -112 - 10 * b)], "upperarm_r": [(Y, 112 + 10 * b)],
        "lowerarm_l": [(Y, -20)], "lowerarm_r": [(Y, 20)],
        "head": [(X, -8)],
        "_move": (0, 0, 0.03 * b),
    })


def nod(t):
    return merge(STAND, RELAXED_HANDS, {"head": [(X, 12 * math.sin(2 * math.pi * t * 2))]})


def shake(t):
    return merge(STAND, RELAXED_HANDS, {"head": [(Z, 14 * math.sin(2 * math.pi * t * 2))]})


def hands_on_hips(lm):
    """The production sheet's front and 3/4 pose: hands on the hips, elbows out, weight on one leg."""
    out = {}
    for s, sx in (("l", 1), ("r", -1)):
        elbow = (sx * 0.31, lm.neck_y + 0.05, lm.waist + 0.11)
        hip = (sx * 0.152, lm.neck_y - 0.005, lm.waist - 0.045)
        out[f"upperarm_{s}"] = [("aim_at", elbow)]
        out[f"lowerarm_{s}"] = [("aim_at", hip)]
        out[f"hand_{s}"] = [("aim", (-sx * 0.25, -0.3, -0.92))]
    return merge(out, RELAXED_HANDS, {
        "pelvis": [(Z, -3), (Y, 2)], "spine_02": [(Y, -2)], "head": [(Z, 4), (Y, -3)],
        "thigh_r": [(Y, -3), (X, -3)], "calf_r": [(X, 5)],
    })

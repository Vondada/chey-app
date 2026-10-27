"""MPFB2 / MakeHuman base mesh and targets (CC0), read with numpy only, shared by mpfb_head.py and face_fit.py.

Coordinates stay MakeHuman's (decimetres, Y up, facing +Z) until to_blender().
"""
import gzip
import os

import numpy as np

MPFB = os.environ.get('MPFB', '/tmp/claude-0/-home-user-chey-app/e7bc87e3-82e7-5016-aa43-9dd940abd88e/scratchpad/ext/mpfb2/src/mpfb/data')
T = os.path.join(MPFB, 'targets')

# Signed identity sliders: weight > 0 applies the first target, < 0 the second. "lr:" means both l- and r- files.
SLIDERS = [
    ('head_w', 'head/head-scale-horiz-incr', 'head/head-scale-horiz-decr'),
    ('head_h', 'head/head-scale-vert-incr', 'head/head-scale-vert-decr'),
    ('nose_w', 'nose/nose-scale-horiz-incr', 'nose/nose-scale-horiz-decr'),
    ('nose_h', 'nose/nose-scale-vert-incr', 'nose/nose-scale-vert-decr'),
    ('nose_d', 'nose/nose-scale-depth-incr', 'nose/nose-scale-depth-decr'),
    ('nose_flare', 'nose/nose-flaring-incr', 'nose/nose-flaring-decr'),
    ('nose_up', 'nose/nose-trans-up', 'nose/nose-trans-down'),
    ('mouth_w', 'mouth/mouth-scale-horiz-incr', 'mouth/mouth-scale-horiz-decr'),
    ('mouth_up', 'mouth/mouth-trans-up', 'mouth/mouth-trans-down'),
    ('lip_upper', 'mouth/mouth-upperlip-volume-incr', 'mouth/mouth-upperlip-volume-decr'),
    ('lip_lower', 'mouth/mouth-lowerlip-volume-incr', 'mouth/mouth-lowerlip-volume-decr'),
    ('chin_w', 'chin/chin-width-incr', 'chin/chin-width-decr'),
    ('chin_h', 'chin/chin-height-incr', 'chin/chin-height-decr'),
    ('chin_prom', 'chin/chin-prominent-incr', 'chin/chin-prominent-decr'),
    ('cheek_bones', 'lr:cheek/cheek-bones-incr', 'lr:cheek/cheek-bones-decr'),
    ('cheek_vol', 'lr:cheek/cheek-volume-incr', 'lr:cheek/cheek-volume-decr'),
    ('brow_fwd', 'eyebrows/eyebrows-trans-forward', 'eyebrows/eyebrows-trans-backward'),
    ('forehead_fwd', 'forehead/forehead-trans-forward', 'forehead/forehead-trans-backward'),
    ('forehead_h', 'forehead/forehead-scale-vert-incr', 'forehead/forehead-scale-vert-decr'),
    ('mouth_fwd', 'mouth/mouth-trans-forward', 'mouth/mouth-trans-backward'),
    ('chin_prog', 'chin/chin-prognathism-incr', 'chin/chin-prognathism-decr'),
]


def load_base():
    verts, uvs, faces, groups, group = [], [], [], {}, ''
    with open(os.path.join(MPFB, '3dobjs', 'base.obj')) as f:
        for line in f:
            if line.startswith('v '):
                verts.append([float(x) for x in line.split()[1:4]])
            elif line.startswith('vt '):
                uvs.append([float(x) for x in line.split()[1:3]])
            elif line.startswith('g '):
                group = line.split()[1]
            elif line.startswith('f '):
                corners = [c.split('/') for c in line.split()[1:]]
                vi = [int(c[0]) - 1 for c in corners]; ti = [int(c[1]) - 1 for c in corners]
                faces.append((group, vi, ti))
                groups.setdefault(group, set()).update(vi)
    return np.array(verts), uvs, faces, groups


def target(path, n):
    """Dense (n, 3) offsets of one target; "lr:dir/name" sums the l- and r- files."""
    out = np.zeros((n, 3))
    files = [path]
    if path.startswith('lr:'):
        d, base = path[3:].split('/'); files = [f'{d}/l-{base}', f'{d}/r-{base}']
    for p in files:
        with gzip.open(os.path.join(T, p + '.target.gz'), 'rt') as f:
            for line in f:
                q = line.split()
                if len(q) == 4 and not line.startswith('#'):
                    out[int(q[0])] += (float(q[1]), float(q[2]), float(q[3]))
    return out


def exists(path):
    if path.startswith('lr:'):
        d, base = path[3:].split('/'); path = f'{d}/l-{base}'
    return os.path.exists(os.path.join(T, path + '.target.gz'))


def macro_woman(verts, race=None, youth=0.0, mature=0.0, sex=0.0, target_fn=None):
    """Young adult: race mix, universal average body, half-way to ideal proportions. sex runs 0 (woman) .. 1 (man) and
    blends MakeHuman's female and male shapes the way its gender slider does.
    youth (0..0.4) blends toward MakeHuman's child shape the way its age slider does below 25 (0.2 is about 21);
    mature (0..0.3) blends toward its old shape the way the slider does above 25 (0.1 is about 31)."""
    v = verts.copy(); n = len(v)
    target = target_fn or globals()['target']
    for g, gw in (('female', 1.0 - sex), ('male', sex)):
        if not gw: continue
        for age, aw in (('young', 1.0 - youth - mature), ('child', youth), ('old', mature)):
            if not aw: continue
            for r, w in (race or {'african': 1.0}).items():
                v += target(f'macrodetails/{r}-{g}-{age}', n) * w * aw * gw
            v += target(f'macrodetails/universal-{g}-{age}-averagemuscle-averageweight', n) * aw * gw
        v += target(f'macrodetails/proportions/{g}-young-averagemuscle-averageweight-idealproportions', n) * 0.5 * gw
    return v


# MakeHuman's body macros (macrodetails/macro.json): each 0..1 value blends its two neighbouring shapes.
BODY_KEYS = ('BODY_GENDER', 'BODY_AGE', 'BODY_HEIGHT', 'BODY_WEIGHT', 'BODY_MUSCLE', 'BODY_PROPORTIONS')
BODY_PARTS = {
    'age': [(0.0, 0.1875, 'baby', 'child'), (0.1875, 0.5, 'child', 'young'), (0.5, 1.0, 'young', 'old')],
    'muscle': [(0.0, 0.5, 'minmuscle', 'averagemuscle'), (0.5, 1.0, 'averagemuscle', 'maxmuscle')],
    'weight': [(0.0, 0.5, 'minweight', 'averageweight'), (0.5, 1.0, 'averageweight', 'maxweight')],
    'height': [(0.0, 0.5, 'minheight', ''), (0.5, 1.0, '', 'maxheight')],
    'proportions': [(0.0, 0.5, 'uncommonproportions', ''), (0.5, 1.0, '', 'idealproportions')],
}


def blend(kind, x):
    """{shape: weight} for one macro value, as MakeHuman blends it ('' is the average with no target of its own)."""
    x = min(1.0, max(0.0, float(x)))
    for lo, hi, a, b in BODY_PARTS[kind]:
        if x <= hi:
            t = (x - lo) / (hi - lo)
            return {k: w for k, w in ((a, 1.0 - t), (b, t)) if k and w > 1e-9}
    return {}


def body_values(settings, youth=0.0):
    """The six macro values (0..1) of a job. Unset keys keep today's look: gender = SEX, age from MATURE (0.1 is about
    31: 0.5 + MATURE / 2) and the fit's youth (0.5 - 0.3125 * youth), average muscle, weight and height, proportions
    MakeHuman 0.75 (half-way to ideal, as macro_woman applies them; BODY_PROPORTIONS 0.5 maps to it)."""
    def f(k, d):
        x = settings.get(k)
        return float(x) if x not in (None, '') else float(d)
    age = 0.5 + 0.5 * f('MATURE', 0.0) - 0.3125 * youth
    # BODY_PROPORTIONS is the Create room's slider, where 0.5 is today's look (half-way to MakeHuman's ideal
    # proportions, MakeHuman 0.75; server/cloudflare/creation_studio.js BODY_DEFAULTS): 0..0.5 maps to 0..0.75, 0.5..1
    # to 0.75..1. The other values are MakeHuman's own (age 0.5 = 25 years, 1 = 90).
    pv = min(1.0, max(0.0, f('BODY_PROPORTIONS', 0.5)))
    prop = 1.5 * pv if pv <= 0.5 else 0.75 + 0.5 * (pv - 0.5)
    return {'gender': f('BODY_GENDER', f('SEX', 0.0)), 'age': f('BODY_AGE', age), 'muscle': f('BODY_MUSCLE', 0.5),
            'weight': f('BODY_WEIGHT', 0.5), 'height': f('BODY_HEIGHT', 0.5), 'proportions': prop}


def macro_full(verts, race, vals, target_fn=None):
    """MakeHuman's full macro system: race x gender x age shapes, the universal gender x age x muscle x weight shapes,
    and the height and proportions shapes on top of those (macrodetails/height, macrodetails/proportions)."""
    target = target_fn or globals()['target']
    v = verts.copy(); n = len(v)
    G = {k: w for k, w in (('female', 1.0 - vals['gender']), ('male', vals['gender'])) if w > 1e-9}
    A, M, W = blend('age', vals['age']), blend('muscle', vals['muscle']), blend('weight', vals['weight'])
    H, P = blend('height', vals['height']), blend('proportions', vals['proportions'])
    for g, gw in G.items():
        for a, aw in A.items():
            for r, rw in race.items():
                if rw: v += target(f'macrodetails/{r}-{g}-{a}', n) * rw * gw * aw
            for m, mw in M.items():
                for wt, ww in W.items():
                    k = gw * aw * mw * ww
                    v += target(f'macrodetails/universal-{g}-{a}-{m}-{wt}', n) * k
                    for h, hw in H.items():
                        v += target(f'macrodetails/height/{g}-{a}-{m}-{wt}-{h}', n) * k * hw
                    for p, pw in P.items():
                        if a != 'baby':   # MakeHuman has no proportions shapes for babies
                            v += target(f'macrodetails/proportions/{g}-{a}-{m}-{wt}-{p}', n) * k * pw
    return v


def parse_race(s):
    return {k.strip(): float(x) for k, x in (kv.split('=') for kv in (s or 'african=0.7,caucasian=0.3').split(','))}


def has_body_macros(settings):
    return any(settings.get(k) not in (None, '') for k in BODY_KEYS)


def macro_from_settings(verts, settings, youth=0.0, target_fn=None):
    """The body before identity sliders. With no BODY_* setting this is exactly macro_woman (the same vertices, so
    existing presets build the same model); with any BODY_* setting it is MakeHuman's full macro system."""
    race = parse_race(settings.get('RACE'))
    if not has_body_macros(settings):
        return macro_woman(verts, race, youth=youth, mature=float(settings.get('MATURE') or 0), sex=float(settings.get('SEX') or 0),
                           target_fn=target_fn)
    return macro_full(verts, race, body_values(settings, youth), target_fn)


def slider_deltas(n):
    """{name: (positive (n,3), negative (n,3))} for the sliders whose targets exist."""
    return {name: (target(pos, n), target(neg, n)) for name, pos, neg in SLIDERS if exists(pos) and exists(neg)}


def apply_sliders(v, deltas, weights):
    v = v.copy()
    for name, w in weights.items():
        if name in deltas and w:
            v += deltas[name][0] * w if w > 0 else deltas[name][1] * -w
    return v


def to_blender(v):
    """MakeHuman decimetres, Y up, facing +Z  ->  metres, Z up, facing -Y."""
    return np.stack([v[:, 0], -v[:, 2], v[:, 1]], axis=1) * 0.1


def face_frame(v, groups):
    """Points in the landmark frame (origin between the eye centres; x across, y up, z out of the face) and the eye gap.
    Works on MakeHuman coordinates, where the face looks along +Z."""
    el = v[sorted(groups['helper-l-eye'])].mean(0); er = v[sorted(groups['helper-r-eye'])].mean(0)
    mid = (el + er) / 2
    return (v - mid) * 0.1, float(np.linalg.norm(el - er)) * 0.1

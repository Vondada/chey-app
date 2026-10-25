"""Identity presets -> render settings (owner, 2026-10-24: one reusable, parametric generator instead of a new face each time).

A preset (tools/avatar_face/identities.json) holds a character's parameters in words: body (sex, age, MakeHuman ethnic
mix), face sliders (-1..1, 0 is the MakeHuman average), skin tone, iris colour, brows, lashes, hair and outfit.
to_settings() turns one preset and one look (photoreal, hybrid, stylized) into the environment settings that
tools/avatar_face/mpfb_dress.py reads, so the GPU queue's job id (a hash of the settings) names the identity and look.

server/cloudflare/avatar_identity.js implements the same mapping for the Worker; tools/test_avatar_identity.py checks
the two agree on every preset and look. Run `python3 identity.py <id> [style]` to print one preset's settings.
"""
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PRESETS = os.path.join(HERE, 'identities.json')
STYLES = ('photoreal', 'hybrid', 'stylized')

# Face slider -> MakeHuman target pair (positive, negative). "lr:" applies the l- and r- versions.
FACE_TARGETS = {
    'eye_size': ('lr:eyes/eye-scale-incr', 'lr:eyes/eye-scale-decr'),
    'eye_tilt': ('lr:eyes/eye-corner2-up', 'lr:eyes/eye-corner2-down'),
    'eyefold': ('lr:eyes/eye-eyefold-down', 'lr:eyes/eye-eyefold-up'),
    'nose_tip_width': ('nose/nose-point-width-incr', 'nose/nose-point-width-decr'),
    'nose_width': ('nose/nose-scale-horiz-incr', 'nose/nose-scale-horiz-decr'),
    'nose_length': ('nose/nose-scale-vert-incr', 'nose/nose-scale-vert-decr'),
    'lip_upper': ('mouth/mouth-upperlip-volume-incr', 'mouth/mouth-upperlip-volume-decr'),
    'lip_lower': ('mouth/mouth-lowerlip-volume-incr', 'mouth/mouth-lowerlip-volume-decr'),
    'cupids_bow': ('mouth/mouth-cupidsbow-incr', 'mouth/mouth-cupidsbow-decr'),
    'mouth_width': ('mouth/mouth-scale-horiz-incr', 'mouth/mouth-scale-horiz-decr'),
    'cheek_volume': ('lr:cheek/cheek-volume-incr', 'lr:cheek/cheek-volume-decr'),
    'cheekbones': ('lr:cheek/cheek-bones-incr', 'lr:cheek/cheek-bones-decr'),
    'chin_width': ('chin/chin-width-incr', 'chin/chin-width-decr'),
    'chin_height': ('chin/chin-height-incr', 'chin/chin-height-decr'),
    'face_width': ('head/head-scale-horiz-incr', 'head/head-scale-horiz-decr'),
    'face_round': ('head/head-round', None),
    'face_oval': ('head/head-oval', None),
    'brow_height': ('eyebrows/eyebrows-trans-up', 'eyebrows/eyebrows-trans-down'),
}
RACES = ('african', 'asian', 'caucasian')
HAIR_STYLES = ('long_wavy', 'wavy_medium', 'bun_high', 'bun_low', 'curly_short', 'afro', 'beanie', 'close_crop')
# Hair styles from the character sheets. Every one is built as a hair mesh in the full-body model (mpfb_body.py
# hair_style, 2026-10-25); the head-and-neck bust (mpfb_dress.py) has strands only for long_wavy and shows the others
# close-cropped. server/cloudflare/avatar_identity.js keeps the same list (server/cloudflare/avatar_identity_parity.test.mjs checks parity).
HAIR_BUILT = ('long_wavy', 'wavy_medium', 'bun_high', 'bun_low', 'curly_short', 'afro', 'beanie', 'close_crop')
# Styles the head-and-neck bust (mpfb_dress.py BUST_NOHAIR) builds strands for; the others show close-cropped there.
HAIR_BUST_BUILT = ('long_wavy',)
HEX = re.compile(r'^#[0-9a-fA-F]{6}$')


def num(w):
    """A weight as both languages print it: at most 3 decimals, no trailing zeros ("0.3", "-0.25", "1")."""
    r = round(float(w) + 0.0, 3)
    return ('%.3f' % r).rstrip('0').rstrip('.') if r != int(r) else str(int(r))


def rgb(h):
    return ','.join(str(int(h[i:i + 2], 16)) for i in (1, 3, 5))


def load(path=PRESETS):
    with open(path) as f:
        return {p['id']: p for p in json.load(f)['presets']}


def lin(c):
    c /= 255.0
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def skin_ok(h):
    """The same rule as mpfb_dress.py's skin check: linear albedo mean 0.008..0.6, red >= green >= blue."""
    r, g, b = (lin(int(h[i:i + 2], 16)) for i in (1, 3, 5))
    return 0.008 < (r + g + b) / 3 < 0.6 and r >= g >= b


def validate(p):
    """Problems with one preset, as plain sentences (empty when it is valid)."""
    out = []
    if not re.fullmatch(r'[a-z][a-z0-9_]{1,23}', str(p.get('id', ''))): out.append('id must be 2-24 lowercase letters, digits or _')
    b = p.get('body', {})
    for k, lo, hi in (('sex', 0, 1), ('age', 0, 0.3), ('fit', 0, 1)):
        if not lo <= float(b.get(k, 0)) <= hi: out.append(f'body.{k} must be {lo}..{hi}')
    race = b.get('race') or {}
    if not race or any(r not in RACES or not 0 <= float(w) <= 1 for r, w in race.items()): out.append('body.race mixes african, asian, caucasian (0..1)')
    for k, w in (p.get('face') or {}).items():
        if k not in FACE_TARGETS: out.append(f'unknown face slider {k}')
        elif not -1 <= float(w) <= 1: out.append(f'face.{k} must be -1..1')
        elif FACE_TARGETS[k][1] is None and float(w) < 0: out.append(f'face.{k} is 0..1')
    for path in ('skin.tone', 'eyes.iris', 'hair.color'):
        a, c = path.split('.')
        if not HEX.match(str((p.get(a) or {}).get(c, ''))): out.append(f'{path} must be #rrggbb')
    tone = str((p.get('skin') or {}).get('tone', ''))
    if HEX.match(tone) and not skin_ok(tone): out.append('skin.tone must be a human skin albedo (red >= green >= blue, not lighter than about #e8c0a0)')
    if (p.get('hair') or {}).get('style') not in HAIR_STYLES: out.append('hair.style must be one of ' + ', '.join(HAIR_STYLES))
    return out


def to_settings(p, style='photoreal'):
    """The mpfb_dress.py environment for one preset and look. Keys are sorted, values are strings."""
    if style not in STYLES: raise ValueError(f'style must be one of {STYLES}')
    bad = validate(p)
    if bad: raise ValueError('; '.join(bad))
    b, f, sk, ey, br, la, ha = (p.get(k) or {} for k in ('body', 'face', 'skin', 'eyes', 'brows', 'lashes', 'hair'))
    face = []
    for k in FACE_TARGETS:   # fixed order, so the same preset always gives the same job id
        w = float(f.get(k, 0))
        if not w: continue
        pos, neg = FACE_TARGETS[k]
        face.append(f'{pos if w > 0 else neg}={num(abs(w))}')
    s = {
        'IDENTITY': p['id'], 'STYLE': style,
        'RACE': ','.join(f'{r}={num(b["race"][r])}' for r in RACES if r in b['race']),
        'SEX': num(b.get('sex', 0)), 'MATURE': num(b.get('age', 0)), 'FACE': ','.join(face),
        'TARGET_SRGB': rgb(sk['tone']), 'PORES': num(sk.get('pores', 0.2)),
        'IRIS': num(ey.get('brightness', 2.0)), 'IRIS_SRGB': rgb(ey['iris']),
        'BROW_N': str(int(br.get('density', 800))), 'BROW_W': num(br.get('width', 1.4)), 'LASH_LEN': num(la.get('length', 0.55)),
        'HAIR_STYLE': ha['style'], 'HAIR_SRGB': rgb(ha['color']), 'STRANDS': str(int(ha.get('density', 90))),
    }
    if float(b.get('fit', 0)): s['FIT_W'] = num(b['fit'])
    if ha['style'] not in HAIR_BUILT: s['NOHAIR'] = '1'
    return dict(sorted(s.items()))


if __name__ == '__main__':
    presets = load()
    pid = sys.argv[1] if len(sys.argv) > 1 else 'che'
    print(json.dumps(to_settings(presets[pid], sys.argv[2] if len(sys.argv) > 2 else 'photoreal'), indent=1))

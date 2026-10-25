"""CHE's face controls: MakeHuman expression units as shape keys (on top of the five mpfb_body.py already makes), eye
look shape keys, and visemes defined as weights over those units.

MPFB2 ships no expression presets (data/expressions holds only a README in the version used here) but does ship the
MakeHuman expression *units* as targets (data/targets/expression/units/<african|asian|caucasian>/*.target.gz, CC0):
mouth open/compression/pursing/protrusion/retraction/depression/elevation/eversion, brows up/down/inner/outer, eye
closure/opened-up/slit, nose elevation/dilatation/compression and neck platysma. Every face control below is one of
those units (or a left+right pair) baked as a morph target, so the GLB carries them and three.js can drive them.

Hook: install(mpfb_body) adds UNITS to mpfb_body.MORPHS before mpfb_body.build() runs, so the same code that builds
blink/mouth_open/smile/brows_up builds these on the body's own vertices (no change to mpfb_body.py).
"""
import math

ETH = 'african'   # the unit set mpfb_body.py already uses for its five keys
U = f'expression/units/{ETH}/'


def _both(a, b): return [U + a, U + b]


UNITS = {
    'mouth_press': [U + 'mouth-compression'],
    'mouth_pucker': [U + 'mouth-pursing'],
    'mouth_funnel': [U + 'mouth-protusion'],
    'mouth_stretch': [U + 'mouth-retraction'],
    'mouth_frown': [U + 'mouth-depression'],
    'mouth_lower_down': [U + 'mouth-depression-retraction'],
    'mouth_upper_up': [U + 'mouth-elevation'],
    'mouth_roll_out': [U + 'mouth-eversion'],
    'mouth_part': [U + 'mouth-parling'],
    'smile_wide': [U + 'mouth-upward-retraction'],
    'brow_down': _both('eyebrows-left-down', 'eyebrows-right-down'),
    'brow_inner_up': _both('eyebrows-left-inner-up', 'eyebrows-right-inner-up'),
    'brow_outer_up': _both('eyebrows-left-extern-up', 'eyebrows-right-extern-up'),
    'eye_wide': _both('eye-left-opened-up', 'eye-right-opened-up'),
    'eye_squint': _both('eye-left-slit', 'eye-right-slit'),
    'nose_sneer': _both('nose-left-elevation', 'nose-right-elevation'),
}

# Rhubarb Lip Sync mouth shapes (Preston Blair set, with the extended G, H, X) -> unit weights. Tuned on close-up
# renders of CHE (tools/avatar_facial/README in docs/CHE_REALISM_STACK.md): a viseme is a blend, never only jaw open.
VISEMES = {
    'X': {},                                                            # rest
    'A': {'mouth_press': 0.55},                                         # M B P: lips together
    'B': {'mouth_open': 0.10, 'mouth_stretch': 0.30, 'mouth_part': 0.4},    # most consonants, teeth close
    'C': {'mouth_open': 0.32, 'mouth_stretch': 0.20, 'mouth_part': 0.3},    # EH AE
    'D': {'mouth_open': 0.62, 'mouth_part': 0.2},                       # AA: wide open
    'E': {'mouth_open': 0.26, 'mouth_pucker': 0.35},                    # AO ER: slightly rounded
    'F': {'mouth_pucker': 0.75, 'mouth_funnel': 0.45, 'mouth_open': 0.06},   # UW OW W: puckered
    'G': {'mouth_open': 0.08, 'mouth_lower_down': 0.0, 'mouth_upper_up': 0.35, 'mouth_press': 0.15},  # F V
    'H': {'mouth_open': 0.28, 'mouth_stretch': 0.10, 'mouth_part': 0.3},    # L
}
MOUTH_KEYS = sorted({k for v in VISEMES.values() for k in v})

# Eye look keys on the Eye_l / Eye_r meshes: the eyeball's vertices rotated about its centre (the object origin).
LOOK = {'look_left': ('Z', 25.0), 'look_right': ('Z', -25.0), 'look_up': ('X', -18.0), 'look_down': ('X', 22.0)}


def install(mpfb_body):
    """Adds the expression units to mpfb_body.MORPHS (call before mpfb_body.build())."""
    for k, units in UNITS.items(): mpfb_body.MORPHS.setdefault(k, units)
    return list(mpfb_body.MORPHS)


def add_eye_look_keys(eye_objects):
    """Look-direction shape keys on each eye mesh (rotation about the mesh origin, which is the eye centre). The eye
    looks along -Y; look_left turns it toward the character's left (+X)."""
    from mathutils import Matrix
    for eo in eye_objects:
        me = eo.data
        if not me.shape_keys: eo.shape_key_add(name='Basis')
        base = [v.co.copy() for v in me.vertices]
        for name, (axis, deg) in LOOK.items():
            kb = eo.shape_key_add(name=name); R = Matrix.Rotation(math.radians(deg), 3, axis)
            # Z rotation by +deg moves -Y toward +X for a positive angle? -Y rotated +deg about Z goes to (+sin, -cos):
            # positive angle = toward +X (her left). X rotation by +deg moves -Y toward -Z (down).
            for v, c in zip(kb.data, base): v.co = R @ c
            kb.value = 0.0
    return list(LOOK)

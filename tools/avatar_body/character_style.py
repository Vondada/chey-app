"""The three looks of a full-body character (STYLE: photoreal | hybrid | stylized), as numbers, without Blender.

Owner requirement (2026-10-25): one Create button makes hyperrealistic, game-like and stylized characters. The Create
Room demo close-ups showed the three barely differed (only a few face targets). Each look now differs in:
- proportions: the head is scaled about the neck joint by `head_scale` (weighted by the head bone's own skin weights,
  so the neck blends), plus the face targets in `face` (eyes, nose, cheeks);
- materials written into the GLB: skin/hair/cloth roughness and specular, colour saturation about the luminance
  (`saturation`), and an emissive share of the base colour (`emission`) that flattens shading in any glTF viewer;
- brows, lashes and hair detail: `brows` strands (many fine hairs) | tufts (fewer, wider clumps) | solid (one shaped
  ribbon), `lashes` fins (upper and lower) | solid (one bold upper lash), `hair_cards` fine | clumps | chunks;
- render shading (render_profiles.upgrade_materials): subsurface skin | game PBR | toon.
mpfb_body.py builds from this table and writes it into the GLB (asset.extras.che_character.style_spec);
tools/test_character_style.py checks the table, and tools/test_glb_inspect.py measures real builds against it.
"""

STYLES = ('photoreal', 'hybrid', 'stylized')

STYLE_SPEC = {
    'photoreal': {
        'label': 'hyperrealistic', 'head_scale': 1.0, 'face': '',
        'skin': {'roughness': 0.5, 'specular': 0.35}, 'hair': {'roughness': 0.55, 'specular': 0.3},
        'cloth': {'roughness': 0.78, 'specular': 0.18}, 'saturation': 1.0, 'emission': 0.0,
        'brows': 'strands', 'lashes': 'fins', 'hair_cards': 'fine', 'shading': 'subsurface',
    },
    'hybrid': {
        'label': 'game-like', 'head_scale': 1.07,
        'face': 'lr:eyes/eye-scale-incr=0.6,nose/nose-scale-horiz-decr=0.15,chin/chin-width-decr=0.1',
        'skin': {'roughness': 0.64, 'specular': 0.22}, 'hair': {'roughness': 0.6, 'specular': 0.35},
        'cloth': {'roughness': 0.7, 'specular': 0.25}, 'saturation': 1.1, 'emission': 0.04,
        'brows': 'tufts', 'lashes': 'fins', 'hair_cards': 'clumps', 'shading': 'game',
    },
    'stylized': {
        'label': 'stylized', 'head_scale': 1.18,
        'face': 'lr:eyes/eye-scale-incr=1.6,nose/nose-scale-horiz-decr=0.6,nose/nose-scale-vert-decr=0.5,'
                'lr:cheek/cheek-volume-incr=0.45,head/head-round=0.45,chin/chin-height-decr=0.35,mouth/mouth-scale-horiz-decr=0.15',
        'skin': {'roughness': 0.88, 'specular': 0.06}, 'hair': {'roughness': 0.85, 'specular': 0.08},
        'cloth': {'roughness': 0.9, 'specular': 0.05}, 'saturation': 1.2, 'emission': 0.14,
        'brows': 'solid', 'lashes': 'solid', 'hair_cards': 'chunks', 'shading': 'toon',
    },
}

# Hair cards on the scalp cap: how many, how wide, how long and how far above the cap (metres). Fine strands for the
# realistic look, clumps for game-like, a few broad chunks for stylized.
HAIR_CARDS = {'fine': {'count': 900, 'width': 0.0032, 'length': (0.035, 0.06), 'lift': 0.0012, 'segments': 5},
              'clumps': {'count': 380, 'width': 0.0075, 'length': (0.04, 0.07), 'lift': 0.0018, 'segments': 5},
              'chunks': {'count': 120, 'width': 0.016, 'length': (0.05, 0.08), 'lift': 0.003, 'segments': 4}}


def spec(style):
    """The look's spec; an unknown style is photoreal (as identity.py validates STYLE before a job is queued)."""
    return STYLE_SPEC.get(style or 'photoreal', STYLE_SPEC['photoreal'])


def luminance(rgb):
    """Relative luminance of a linear RGB triple (Rec. 709 weights)."""
    return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]


def saturate(rgb, s):
    """Linear RGB with its chroma scaled by s about its luma in sRGB (display) space, clamped, returned linear
    (s = 1 returns it unchanged). Scaling in linear space clipped warm skin's blue channel to zero at s = 1.3 and turned
    the stylized skin orange (measured 2026-10-25), so the scaling is done on the encoded values, as a viewer sees them."""
    if s == 1.0: return [float(c) for c in rgb]
    e = [linear_to_srgb(c) / 255.0 for c in rgb]
    y = luminance(e)
    return [srgb_to_linear(min(1.0, max(0.0, y + (c - y) * s)) * 255.0) for c in e]


def srgb_to_linear(c):
    c = c / 255.0
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def linear_to_srgb(x):
    v = x * 12.92 if x <= 0.0031308 else 1.055 * x ** (1 / 2.4) - 0.055
    return int(round(min(1.0, max(0.0, v)) * 255))


def saturation_hsv(rgb):
    """HSV saturation (0..1) of an RGB triple in any range."""
    hi, lo = max(rgb), min(rgb)
    return 0.0 if hi <= 0 else (hi - lo) / hi


def head_weight(head_bone_weight, helper=False):
    """How much of the head scale a vertex takes: its skin weight to the head bone (the neck blends between the
    head and neck bones), or 1 for the eye, lash and hair helpers that sit inside the head."""
    return 1.0 if helper else max(0.0, min(1.0, float(head_bone_weight)))


def brow_curve(t):
    """The brow's shape along its length t (0 inner end .. 1 outer tail), in eye radii from the eye centre:
    (sideways toward the temple, up, half-thickness). An arched brow: highest a little past the middle, thick at the
    inner end and tapering to a fine tail."""
    t = min(1.0, max(0.0, t))
    side = -0.95 + 2.35 * t
    up = 1.42 + 0.5 * (1 - (2 * t - 1.3) ** 2 / 1.69)   # 1.42 at the inner end, 1.92 at t = 0.65, 1.78 at the tail
    half = 0.36 * (1 - t) + 0.08
    return side, up, half

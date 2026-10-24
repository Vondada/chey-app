"""Character specs for CHE World's reference-matched 3D crew (owner brief, 2026-10-24: Route B, rigged 3D).

Visual source of truth: the owner's CHE World poster. Values marked "sampled" were read from the poster's pixels
(ref/<id>_samples.json records where); the poster is lit by a warm sunset, so every material colour below is an
estimate of the underlying colour, not the sampled appearance. Anything the poster does not show (the back of the
outfit, shoes, hair at the back) is a design proposal that needs the owner's approval.
"""

CHE = {
    "id": "che",
    "name": "CHE",
    "role": "CEO & Central AI",
    # MakeHuman macro values: female, about 25, average build with a slim waist, a little taller than average.
    "macro": {
        "gender": 0.0, "age": 0.5, "muscle": 0.5, "weight": 0.48, "proportions": 0.85, "height": 0.52,
        "cupsize": 0.62, "firmness": 0.6, "race": {"african": 0.62, "caucasian": 0.23, "asian": 0.15},
    },
    # Face and body detail modifiers (MakeHuman target names; positive = incr/up/out side).
    "modifiers": {
        # Large almond eyes with lifted outer corners and full lids (the poster's most recognisable feature).
        "eyes/l-eye-scale": 1.0, "eyes/r-eye-scale": 1.0,
        "eyes/l-eye-corner2": 0.55, "eyes/r-eye-corner2": 0.55,
        "eyes/l-eye-height2": 0.35, "eyes/r-eye-height2": 0.35,
        # Small, soft nose with a rounded, slightly lifted tip.
        "nose/nose-scale-horiz": -0.45, "nose/nose-point-width": -0.35, "nose/nose-flaring": -0.25,
        "nose/nose-scale-vert": -0.15, "nose/nose-point": 0.2, "nose/nose-volume": -0.2,
        # Full lips with a defined cupid's bow and a hint of a smile.
        "mouth/mouth-upperlip-volume": 0.6, "mouth/mouth-lowerlip-volume": 0.55,
        "mouth/mouth-cupidsbow": 0.45, "mouth/mouth-angles": 0.2, "mouth/mouth-scale-horiz": -0.1,
        # Heart-shaped face: high cheekbones, narrow tapered chin.
        "head/head-oval": 0.45, "head/head-invertedtriangular": 0.3,
        "cheek/l-cheek-bones": 0.4, "cheek/r-cheek-bones": 0.4,
        "cheek/l-cheek-volume": 0.1, "cheek/r-cheek-volume": 0.1,
        "forehead/forehead-scale-vert": -0.35, "head/head-scale-vert": -0.08,
        "chin/chin-width": -0.3, "chin/chin-height": -0.1, "chin/chin-prominent": 0.1,
        "eyebrows/eyebrows-angle": 0.35,
        "neck/neck-scale-horiz": -0.2,
        # Hourglass figure: defined waist, fuller hips.
        "hip/hip-scale-horiz": 0.2, "hip/hip-waist": 0.0, "torso/torso-scale-horiz": -0.08,
        "stomach/stomach-pregnant": -0.3, "buttocks/buttocks-volume": 0.25,
    },
    "palette": {
        # Estimated underlying colours (sRGB hex). See ref/che_samples.json for what was sampled and where.
        "skin": "#87502f", "lips": "#6a2a22", "brows": "#2a170f", "eyeshadow": "#6e3c25",
        "liner": "#120a08", "iris": "#4a2a16", "hair": "#17100d", "hair_sheen": "#3a2a22",
        "blazer": "#ede7dd", "lapel": "#121014", "top": "#121014", "trousers": "#ede7dd",
        "gold": "#e2b878", "shoes": "#d8ae66", "nails": "#b88270",
    },
    # Brows: arched and groomed; eyeliner: a lifted wing (poster close-up).
    "brow": {"lift": 0.017, "arch": 0.009, "tail": 0.011},
    "wing": {"length": 0.010, "angle": 24},
    # Production sheet: waist-length, voluminous loose waves with a deep side part on her right.
    "hair": {"style": "long_waves", "length": 0.8, "volume": 1.0, "part": "side_right", "clumps": 74,
             "per_clump": 5, "row": 0.036, "wave": 0.026, "wavelength": 0.1, "card_width": (0.03, 0.045)},
    # Stiletto heels (degrees the foot turns down at the ankle).
    "heels": 24,
    "outfit": "executive_suit",
    "suit": {"v_above_belt": 0.035, "neck_half": 0.066, "lapel_width": 0.058, "top_dip": 0.018,
             "top_side_x": 0.105, "top_side_rise": 0.07, "hem_below_crotch": 0.0, "trouser_above_ankle": 0.03},
}

CHARACTERS = {"che": CHE}

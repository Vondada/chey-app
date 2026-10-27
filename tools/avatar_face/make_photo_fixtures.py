"""Render the synthetic reference photos the photo fit is tested on (tools/fixtures/photo_fit/) and the acceptance
fixture (test/fixtures/character/synthetic_face.png). Every picture is a render of the CC0 MakeHuman base with KNOWN
slider values and colours (photo_fixture.py); none shows or is traced from a real person.

  MPFB=... python3 tools/avatar_face/make_photo_fixtures.py --blender BLENDER [--only NAME]

Writes <name>.png and truth.json ({name: {sliders, colors (sRGB albedo), eyes_px, synthetic: true}}).
"""
import argparse
import json
import os
import re
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
OUT = os.path.join(ROOT, 'tools', 'fixtures', 'photo_fit')
ACCEPT = os.path.join(ROOT, 'test', 'fixtures', 'character')

# name: (sliders, skin, hair, iris, extra env). Slider values stay inside +-0.8 like the fit's bound.
FIXTURES = {
    'base': ({}, '80,46,32', '28,18,16', '94,62,40', {}),
    'wide': ({'head_w': 0.5, 'chin_w': 0.4, 'nose_w': 0.6, 'mouth_w': -0.4, 'mouth_up': 0.3},
             '150,100,75', '70,40,22', '60,82,50', {}),
    'long': ({'head_w': -0.4, 'nose_h': 0.5, 'chin_h': 0.5, 'lip_lower': 0.5, 'mouth_w': 0.4, 'cheek_bones': 0.4},
             '200,150,120', '120,80,40', '50,70,110', {}),
    'narrow_nose': ({'nose_flare': -0.5, 'nose_w': -0.5, 'nose_up': -0.4, 'chin_w': -0.5, 'lip_upper': 0.5},
                    '105,62,44', '22,16,13', '80,50,30', {}),
    'turned': ({}, '80,46,32', '28,18,16', '94,62,40', {'YAW': '38'}),
}
ACCEPT_FIXTURE = ('synthetic_face', {'head_w': 0.45, 'chin_w': -0.4, 'nose_w': 0.55, 'nose_h': 0.4, 'mouth_w': 0.4,
                                     'lip_lower': 0.4, 'chin_h': 0.35},
                  '160,108,80', '64,38,20', '58,84,62', {'RES': '480'})


def render(blender, name, sliders, skin, hair, iris, extra, out_dir):
    with tempfile.NamedTemporaryFile('w', suffix='.json', delete=False) as f:
        json.dump({'winner': {'weights': sliders, 'youth': 0.0}}, f); fit = f.name
    png = os.path.join(out_dir, f'{name}.png')
    env = dict(os.environ, FIT=fit, FIT_W='1', TARGET_SRGB=skin, HAIR_SRGB=hair, IRIS_SRGB=iris, OUT=png,
               **dict({'RES': '320', 'SAMPLES': '32'}, **extra))
    for k in ('IDENTITY', 'FACE', 'RACE', 'SEX', 'MATURE'): env.pop(k, None)
    r = subprocess.run([blender, '-b', '--factory-startup', '-P', os.path.join(HERE, 'bl_run.py'), '--',
                        os.path.join(HERE, 'photo_fixture.py')], env=env, capture_output=True, text=True)
    os.unlink(fit)
    eyes = re.search(r'^EYES (.*)$', r.stdout, re.M)
    if r.returncode or not eyes: raise SystemExit(f'{name}: render failed\n{r.stdout[-2000:]}\n{r.stderr[-2000:]}')
    # Smaller PNGs: the renders are re-encoded as 8-bit RGB with maximum compression.
    from PIL import Image
    Image.open(png).convert('RGB').save(png, optimize=True)
    return {'sliders': sliders, 'colors': {'skin': skin, 'hair': hair, 'eyes': iris}, 'eyes_px': eval(eyes.group(1)),
            'env': {k: v for k, v in extra.items()}, 'synthetic': True,
            'note': 'render of the CC0 MakeHuman/MPFB2 base by tools/avatar_face/photo_fixture.py; not a real person'}


CAL_STEP = 0.6
# Colour calibration renders: base face, albedos unlike every test fixture's.
CAL_COLOURS = [('120,78,56', '40,26,18', '70,52,36'), ('185,135,105', '95,60,30', '60,80,95'), ('62,38,27', '16,12,10', '40,30,22')]


def calibrate(blender):
    """photo_calibration.npz: the base head, each frontal slider at +-CAL_STEP and three colour renders, all through
    the landmark detector (needs mediapipe in this Python)."""
    import numpy as np  # noqa: F401
    sys.path.insert(0, HERE)
    import photo_fit as pf
    tmp = tempfile.mkdtemp(prefix='che-photo-cal-')
    shot = lambda name, sl, cols=('80,46,32', '28,18,16', '94,62,40'): (
        render(blender, name, sl, *cols, {}, tmp), pf.load_image(os.path.join(tmp, f'{name}.png')))[1]
    base = shot('base', {})
    sliders = {}
    for n in pf.FRONTAL_SLIDERS:
        sliders[n] = (shot(f'{n}_pos', {n: CAL_STEP}), shot(f'{n}_neg', {n: -CAL_STEP}))
        print('CALIBRATION', n, flush=True)
    colours = [(shot(f'colour_{k}', {}, c), {'skin': c[0], 'hair': c[1], 'eyes': c[2]}) for k, c in enumerate(CAL_COLOURS)]
    cal = pf.build_calibration(base, sliders, colours, CAL_STEP)
    print('CALIBRATED', cal['renders'], 'renders; observability', pf.observability(cal), flush=True)
    print('GAINS', {k: [round(float(x), 3) for x in v] for k, v in cal['gains'].items()}, flush=True)
    return 0


def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--blender', required=True); ap.add_argument('--only')
    ap.add_argument('--calibrate', action='store_true', help='rebuild tools/avatar_face/photo_calibration.npz instead')
    a = ap.parse_args()
    if a.calibrate: return calibrate(a.blender)
    os.makedirs(OUT, exist_ok=True); os.makedirs(ACCEPT, exist_ok=True)
    tpath = os.path.join(OUT, 'truth.json')
    truth = json.load(open(tpath)) if os.path.exists(tpath) else {}
    for name, (sl, skin, hair, iris, extra) in FIXTURES.items():
        if a.only and a.only != name: continue
        truth[name] = render(a.blender, name, sl, skin, hair, iris, extra, OUT); print('FIXTURE', name, flush=True)
    with open(tpath, 'w') as f: json.dump(truth, f, indent=1, sort_keys=True)
    if not a.only or a.only == ACCEPT_FIXTURE[0]:
        name, sl, skin, hair, iris, extra = ACCEPT_FIXTURE
        t = render(a.blender, name, sl, skin, hair, iris, extra, ACCEPT)
        with open(os.path.join(ACCEPT, f'{name}.json'), 'w') as f: json.dump(t, f, indent=1, sort_keys=True)
        print('FIXTURE', name, flush=True)
    return 0


if __name__ == '__main__':
    sys.exit(main())

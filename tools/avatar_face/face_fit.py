"""Fit the MPFB2 head's identity sliders to CHE's face proportions, by measurement only (no rendering).

  python3 face_fit.py CHE_LANDMARKS.npz OUT.json

CHE's current head is a stylised one (short nose, small chin), so matching it exactly would bring the doll look back.
Each candidate trades identity against realism with a different pull toward the plain human base (REG); a candidate is
plausible when every slider stays within +-0.8 (inside MakeHuman's human range). The winner is the plausible candidate
with the smallest identity error. Body vertices only take part in the measurements.
"""
import json
import sys

import numpy as np

from landmarks import NAMES, measure
from mpfb_base import load_base, macro_woman, slider_deltas, face_frame, target

che = np.load(sys.argv[1])
goal = measure(che['P'], float(che['gap']), che['lips'])
verts, _, faces, groups = load_base()
n = len(verts)
base = macro_woman(verts)
deltas = slider_deltas(n)
names = sorted(deltas)
body = np.array(sorted({i for g, vi, _ in faces if g == 'body' for i in vi}))
opened = np.linalg.norm(target('expression/units/african/mouth-open', n), axis=1)
lips_all = opened > np.quantile(opened[body], 0.995) * 0.6
lips = lips_all[body]


def landmarks(w):
    v = base.copy()
    for k, x in w.items():
        if x: v += deltas[k][0] * x if x > 0 else deltas[k][1] * -x
    P, gap = face_frame(v, groups)
    return measure(P[body], gap, lips)


def error(m):
    # Relative error per proportion, as a percentage RMS.
    r = [(m[k] - goal[k]) / max(abs(goal[k]), 1e-6) for k in NAMES if goal[k]]
    return float(np.sqrt(np.mean(np.square(r))) * 100)


def fit(reg):
    w = {k: 0.0 for k in names}
    cost = lambda w: error(landmarks(w)) + reg * 100 * float(np.mean(np.square(list(w.values()))))
    best = cost(w)
    for step in (0.4, 0.2, 0.1, 0.05):
        improved = True
        while improved:
            improved = False
            for k in names:
                for s in (step, -step):
                    t = dict(w); t[k] = float(np.clip(w[k] + s, -1, 1))
                    c = cost(t)
                    if c < best - 1e-4:
                        best, w, improved = c, t, True
    return w


start = landmarks({k: 0.0 for k in names})
print('CHE      ', {k: round(goal[k], 3) for k in NAMES})
print('MPFB base', {k: round(start[k], 3) for k in NAMES}, 'error %.1f%%' % error(start))
cands = []
for reg in (0.05, 0.15, 0.4, 1.0):
    w = fit(reg)
    m = landmarks(w)
    plausible = max(abs(x) for x in w.values()) <= 0.8
    cands.append({'reg': reg, 'error': round(error(m), 2), 'plausible': plausible, 'max_slider': round(max(abs(x) for x in w.values()), 2),
                  'weights': {k: round(x, 2) for k, x in w.items() if x}, 'landmarks': {k: round(m[k], 3) for k in NAMES}})
    print('reg %.2f error %.1f%% plausible %s max %.2f' % (reg, cands[-1]['error'], plausible, cands[-1]['max_slider']), cands[-1]['weights'])
ok = [c for c in cands if c['plausible']] or cands[-1:]
win = min(ok, key=lambda c: c['error'])
print('WINNER reg', win['reg'], 'error', win['error'])
json.dump({'goal': {k: round(goal[k], 3) for k in NAMES}, 'base_error': round(error(start), 2), 'candidates': cands, 'winner': win},
          open(sys.argv[2], 'w'), indent=1)

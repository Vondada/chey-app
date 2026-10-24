"""Face proportions as ratios of the distance between the eye centres, measured the same way on any head.

P: (N, 3) points in the face frame (origin between the eye centres; x right, y up, z out of the face), metres.
gap: distance between the eye centres. lips: boolean mask of the lip vertices (the strongest mouth-open movers).
"""
import numpy as np

NAMES = ('cheek_w', 'jaw_w', 'mouth_w', 'lip_h', 'eye_mouth', 'nose_y', 'nose_proj', 'nose_w', 'chin_y',
         'brow_proj', 'cheek_proj', 'mouth_proj', 'chin_proj', 'head_top')


def _width(P, g, y, zmin):
    row = P[(np.abs(P[:, 1] - y) < 0.07 * g) & (P[:, 2] > zmin)]
    return float(np.ptp(row[:, 0])) / g if len(row) else 0.0


def measure(P, gap, lips):
    g = float(gap)
    L = P[lips]
    lip_y = float(L[:, 1].mean())
    centre = np.abs(P[:, 0]) < 0.15 * g
    nose_zone = P[centre & (P[:, 1] < 0) & (P[:, 1] > lip_y)]
    tip = nose_zone[np.argmax(nose_zone[:, 2])]
    ala = P[(np.abs(P[:, 1] - tip[1] + 0.12 * g) < 0.08 * g) & (P[:, 2] > tip[2] - 0.45 * g) & (np.abs(P[:, 0]) < 0.5 * g)]
    chin = P[centre & (P[:, 1] < lip_y) & (P[:, 1] > lip_y - 1.2 * g) & (P[:, 2] > -0.1 * g)]  # above the chest
    return {
        'cheek_w': _width(P, g, -0.35 * g, -0.6 * g),
        'jaw_w': _width(P, g, lip_y - 0.25 * g, -0.6 * g),
        'mouth_w': float(np.ptp(L[:, 0])) / g,
        'lip_h': float(np.ptp(L[:, 1])) / g,
        'eye_mouth': -lip_y / g,
        'nose_y': -float(tip[1]) / g,
        'nose_proj': float(tip[2]) / g,
        'nose_w': float(np.ptp(ala[:, 0])) / g if len(ala) else 0.0,
        'chin_y': -float(chin[:, 1].min()) / g if len(chin) else 0.0,
        # Depth: how far the brow ridge, cheeks, lips and chin come forward of the eye centres (feminine faces have a
        # flat brow ridge and fuller cheeks), and the skull top above the eyes (face length).
        'brow_proj': _front(P, g, (-0.6, 0.6), (0.15, 0.45)),
        'cheek_proj': _front(P, g, (0.55, 0.85), (-0.6, -0.3)),
        'mouth_proj': float(L[:, 2].max()) / g,
        'chin_proj': float(chin[:, 2].max()) / g if len(chin) else 0.0,
        'head_top': float(P[np.abs(P[:, 0]) < 0.5 * g][:, 1].max()) / g,
    }


def _front(P, g, xs, ys):
    zone = P[(np.abs(P[:, 0]) >= xs[0] * g if xs[0] > 0 else P[:, 0] >= xs[0] * g) & (np.abs(P[:, 0]) <= abs(xs[1]) * g)
             & (P[:, 1] > ys[0] * g) & (P[:, 1] < ys[1] * g)]
    return float(zone[:, 2].max()) / g if len(zone) else 0.0

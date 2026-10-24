"""Face proportions as ratios of the distance between the eye centres, measured the same way on any head.

P: (N, 3) points in the face frame (origin between the eye centres; x right, y up, z out of the face), metres.
gap: distance between the eye centres. lips: boolean mask of the lip vertices (the strongest mouth-open movers).
"""
import numpy as np

NAMES = ('cheek_w', 'jaw_w', 'mouth_w', 'lip_h', 'eye_mouth', 'nose_y', 'nose_proj', 'nose_w', 'chin_y')


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
    }

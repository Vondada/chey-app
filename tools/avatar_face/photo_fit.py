"""Reference photo -> MPFB2 face sliders and colours, on the CPU, with a freely licensed landmark model.

  python3 photo_fit.py --image PHOTO --out FIT.json [--model-dir DIR]
  (photo_calibration.npz is rebuilt by tools/avatar_face/make_photo_fixtures.py --calibrate)

Landmarks: MediaPipe Face Landmarker (pip `mediapipe`, Apache-2.0), model `face_landmarker.task` float16 v1 (Apache-2.0
per its model cards: Face Mesh V2, Blendshape V2, BlazeFace short range), pinned below by URL, size and SHA-256 and
downloaded once into a cache. It finds up to 3 faces, 478 landmarks each (iris centres included) and the head pose.

Refusals (exit 3, a REFUSED line and {"refused": reason} in FIT.json, never a guess): no face, more than one face, a
face too small (eye centres closer than MIN_EYE_PX pixels), a head turned or tilted more than MAX_TURN_DEG.

Shape, by measurement only: the photo's 468 face-mesh landmarks are put in an eye frame (origin between the iris
centres, x along the eye line, y up, unit = the distance between the iris centres), the frame face_fit.py and
landmarks.py use. photo_calibration.npz records how the detector's landmarks move, in that frame, when each identity
slider a single frontal photo can see (FRONTAL_SLIDERS: widths and heights, never depth) is set to +-0.6 on synthetic
renders of the MakeHuman base (measured, not assumed: a landmark detector reports only part of a shape change, so
mapping its landmarks straight onto mesh vertices under-reads every slider). The sliders are then fitted by coordinate
descent so the predicted landmarks match the photo's, with a pull toward the average face and every slider kept within
+-SLIDER_LIMIT (inside MakeHuman's human range). Depth sliders (nose depth, brow, chin projection) stay at the average.
Colours, robustly: skin from cheek and forehead patches, hair from a band above the forehead (only when it differs from
the skin), iris from the ring between pupil and limbus; each the median after trimming highlights and shadows, turned
from the photo's sRGB into an albedo with gains measured on the calibration renders and kept inside the skin rule
mpfb_dress.py checks (red >= green >= blue, linear mean 0.008..0.6).
FIT.json holds {"winner": {"weights", "youth"}} (what mpfb_body.py reads as FIT) plus reference_fit: method, landmarks
(measured ratios and the fitted model's), sliders, colours (sRGB "r,g,b"), fit_error, calibration and limits.
"""
import argparse
import hashlib
import json
import math
import os
import sys
import time
import urllib.request

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

METHOD = 'mediapipe-face-landmarker-v1+mpfb2-detector-response-fit-v1'
MODEL = {
    'name': 'MediaPipe Face Landmarker (face_landmarker.task, float16, version 1)',
    'url': 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
    'sha256': '64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff',
    'bytes': 3758596,
    'license': 'Apache-2.0',
    'license_source': 'https://storage.googleapis.com/mediapipe-assets/Model%20Card%20MediaPipe%20Face%20Mesh%20V2.pdf '
                      '(and the Blendshape V2 and BlazeFace short-range model cards: "LICENSED UNDER Apache License, Version 2.0")',
    'runtime': 'pip mediapipe (Apache-2.0), https://github.com/google-ai-edge/mediapipe',
}
MIN_EYE_PX = 28          # below this the iris and mouth corners are a few pixels each
MAX_TURN_DEG = 20.0      # yaw or pitch; a turned head makes the frontal widths lie
SLIDER_LIMIT = 0.8       # face_fit.py's plausibility bound
CONFOUNDED = ('nose_up',)   # frontal-photo twins of a fitted slider (see fitted_names)
MIN_OBSERVABLE = 0.018    # rms eye gaps per unit slider below which a slider is not fitted
REG = 2e-5               # pull toward the average face (per unit slider^2, against the landmark error in eye gaps^2)
FRONTAL_SLIDERS = ('head_w', 'cheek_bones', 'chin_w', 'chin_h', 'mouth_w', 'mouth_up', 'lip_upper', 'lip_lower',
                   'nose_w', 'nose_flare', 'nose_h', 'nose_up')
IRIS_R, IRIS_L = 468, 473        # image-left iris (the subject's right eye), image-right iris
RATIOS = {   # name: (kind, a, b) measured in the eye frame, in eye gaps
    'face_w': ('dx', 234, 454), 'jaw_w': ('dx', 172, 397), 'mouth_w': ('dx', 61, 291), 'nose_w': ('dx', 129, 358),
    'lip_h': ('dy', 0, 17), 'eye_mouth': ('y', 13, 14), 'nose_y': ('y', 2, 2), 'chin_y': ('y', 152, 152),
}
LIMITS = ('One frontal photo: widths and heights are measured; depth (nose and chin projection, brow ridge) and the '
          'profile are left at the average face, so the side view is estimated. Likeness is approximate: MakeHuman '
          'sliders cannot reproduce every face, and expression, lens and lighting in the photo bias the measurement. '
          'Colours depend on the photo\'s lighting and white balance. Body, age and sex are not read from the photo. The '
          'detector response was measured on renders of the default body; other bodies are fitted with that response.')


class Refused(Exception):
    pass


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''): h.update(chunk)
    return h.hexdigest()


def model_path(cache=None):
    """The pinned landmark model, downloaded once and checked by size and SHA-256 every time it is used."""
    cache = cache or os.environ.get('CHE_FACE_MODEL_DIR') or os.path.join(os.path.expanduser('~'), '.cache', 'che-face-model')
    path = os.path.join(cache, 'face_landmarker.task')
    if not (os.path.isfile(path) and os.path.getsize(path) == MODEL['bytes'] and sha256_file(path) == MODEL['sha256']):
        os.makedirs(cache, exist_ok=True)
        tmp = path + '.part'
        req = urllib.request.Request(MODEL['url'], headers={'User-Agent': 'CHE-creation-worker/1.0'})
        with urllib.request.urlopen(req, timeout=120) as r, open(tmp, 'wb') as f: f.write(r.read())
        got = sha256_file(tmp)
        if got != MODEL['sha256']:
            os.remove(tmp); raise RuntimeError(f'landmark model sha256 {got} does not match the pinned {MODEL["sha256"]}')
        os.replace(tmp, path)
    return path


def load_image(path, max_edge=1600):
    from PIL import Image, ImageOps
    im = ImageOps.exif_transpose(Image.open(path)).convert('RGB')
    if max(im.size) > max_edge:
        s = max_edge / max(im.size); im = im.resize((round(im.width * s), round(im.height * s)), Image.LANCZOS)
    return np.asarray(im)


def detect(img, cache=None):
    """[(landmarks (478, 2) in pixels, 4x4 pose matrix)] for every face MediaPipe finds (up to 3)."""
    import mediapipe as mp
    from mediapipe.tasks.python import BaseOptions, vision
    opts = vision.FaceLandmarkerOptions(base_options=BaseOptions(model_asset_path=model_path(cache)), num_faces=3,
                                        output_facial_transformation_matrixes=True, min_face_detection_confidence=0.4,
                                        min_face_presence_confidence=0.4)
    with vision.FaceLandmarker.create_from_options(opts) as lm:
        r = lm.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=np.ascontiguousarray(img)))
    h, w = img.shape[:2]
    mats = list(r.facial_transformation_matrixes or [None] * len(r.face_landmarks))
    return [(np.array([(p.x * w, p.y * h) for p in f]), (np.array(m) if m is not None else None)) for f, m in zip(r.face_landmarks, mats)]


def pose_degrees(m):
    """(yaw, pitch, roll) in degrees from MediaPipe's facial transformation matrix."""
    R = np.asarray(m)[:3, :3]
    R = R / np.linalg.norm(R, axis=0, keepdims=True)
    yaw = math.degrees(math.atan2(R[0, 2], R[2, 2]))
    pitch = math.degrees(math.atan2(-R[1, 2], R[2, 2]))
    roll = math.degrees(math.atan2(R[1, 0], R[0, 0]))
    return yaw, pitch, roll


def check(faces):
    """The one usable face, or Refused with the reason."""
    if not faces: raise Refused('no face found in the photo')
    if len(faces) > 1: raise Refused(f'{len(faces)} faces found; the reference photo must show exactly one person')
    P, m = faces[0]
    gap = float(np.linalg.norm(P[IRIS_L] - P[IRIS_R]))
    if gap < MIN_EYE_PX: raise Refused(f'the face is too small (eyes {gap:.0f} px apart; at least {MIN_EYE_PX} px are needed)')
    yaw = pitch = 0.0
    if m is not None:
        yaw, pitch, _ = pose_degrees(m)
    # Independent check from the 2D landmarks: the nose tip sits between the face edges on a frontal face.
    l, r, tip = P[234], P[454], P[1]
    side = (np.linalg.norm(tip - l) - np.linalg.norm(tip - r)) / max(np.linalg.norm(r - l), 1e-6)
    yaw2 = math.degrees(math.asin(max(-1.0, min(1.0, side))))
    turn = max(abs(yaw), abs(yaw2))
    if turn > MAX_TURN_DEG: raise Refused(f'the face is turned {turn:.0f} degrees away from the camera (at most {MAX_TURN_DEG:.0f})')
    if abs(pitch) > MAX_TURN_DEG: raise Refused(f'the face is tilted {abs(pitch):.0f} degrees up or down (at most {MAX_TURN_DEG:.0f})')
    return P, gap, {'yaw_deg': round(yaw, 1), 'pitch_deg': round(pitch, 1), 'yaw_2d_deg': round(yaw2, 1)}


def eye_frame(P):
    """Landmarks in the eye frame: origin between the irises, x along the eye line (image right), y up, unit = gap."""
    a, b = P[IRIS_R], P[IRIS_L]
    mid, gap = (a + b) / 2, float(np.linalg.norm(b - a))
    u = (b - a) / gap; v = np.array([-u[1], u[0]])   # v points down in the image
    d = P - mid
    return np.stack([d @ u, -(d @ v)], axis=1) / gap


def ratios(Q):
    out = {}
    for k, (kind, a, b) in RATIOS.items():
        if kind == 'dx': out[k] = abs(Q[b, 0] - Q[a, 0])
        elif kind == 'dy': out[k] = abs(Q[b, 1] - Q[a, 1])
        else: out[k] = -(Q[a, 1] + Q[b, 1]) / 2
    return {k: round(float(x), 4) for k, x in out.items()}


# ── The shape model: how the detector's landmarks respond to each MPFB slider ─────────────────────────────────────
CAL_FILE = os.path.join(HERE, 'photo_calibration.npz')
MESH = slice(0, 468)   # the face mesh landmarks (the iris points are used for the frame and the iris colour only)


def load_calibration(path=CAL_FILE):
    d = np.load(path, allow_pickle=False)
    names = [str(x) for x in d['names']]
    return {'names': names, 'base': d['base'], 'pos': {n: d['pos'][k] for k, n in enumerate(names)},
            'neg': {n: d['neg'][k] for k, n in enumerate(names)}, 'step': float(d['step']),
            'gains': {'skin': d['gain_skin'], 'hair': d['gain_hair'], 'iris': d['gain_iris']},
            'renders': int(d['renders'])}


def predict(cal, w, start=None, anchor=None):
    """The eye-frame landmarks (468, 2) the detector would report on a render with sliders w: linear in each slider's
    change from `start` (default: the average face), from the landmarks measured at `start` (`anchor`, default: the base
    render). Each side of a slider has its own measured response."""
    Q = (cal['base'] if anchor is None else anchor).copy()
    for k, x in w.items():
        d = x - (start or {}).get(k, 0.0)
        if d: Q = Q + (cal['pos'][k] * d if d > 0 else cal['neg'][k] * -d)
    return Q


def fitted_names(cal):
    obs = observability(cal)
    # A slider the detector barely sees (a few thousandths of an eye gap per unit) would only fit noise: it stays at
    # the average face and the receipt lists it as not measured.
    # nose_up moves the nose tip the same way nose_h does in a frontal photo; fitting both trades one against the other
    # (measured on the fixtures), so nose length is fitted with nose_h alone.
    return [n for n in FRONTAL_SLIDERS if n in cal['names'] and obs[n] >= MIN_OBSERVABLE and n not in CONFOUNDED]


def fit_shape(cal, Q, start=None, anchor=None):
    """Coordinate descent on the frontal sliders against the measured responses; returns (weights, rms in eye gaps of
    the linear prediction)."""
    T = Q[MESH]; sel = cal.get("mask", slice(None))
    names = fitted_names(cal)

    def cost(w):
        r = (predict(cal, w, start, anchor) - T)[sel]
        return float(np.mean(np.sum(r * r, axis=1))) + REG * float(np.mean(np.square(list(w.values()))))
    w = {k: float((start or {}).get(k, 0.0)) for k in names}; best = cost(w)
    for step in (0.4, 0.2, 0.1, 0.05, 0.025, 0.0125):
        improved = True
        while improved:
            improved = False
            for k in names:
                for s in (step, -step):
                    t = dict(w); t[k] = float(np.clip(w[k] + s, -SLIDER_LIMIT, SLIDER_LIMIT))
                    c = cost(t)
                    if c < best - 1e-12: best, w, improved = c, t, True
    r = (predict(cal, w, start, anchor) - T)[sel]
    return w, float(np.sqrt(np.mean(np.sum(r * r, axis=1))))


def rms(a, b):
    return float(np.sqrt(np.mean(np.sum((a - b) ** 2, axis=1))))


def observability(cal):
    """How far each slider moves the detector's landmarks (rms eye gaps per unit slider): near 0 means a frontal photo
    barely sees it, and the pull toward the average face keeps it there."""
    return {n: round(float(np.sqrt(np.mean(np.sum((cal['pos'][n] ** 2 + cal['neg'][n] ** 2) / 2, axis=1)))), 4) for n in cal['names']}


def build_calibration(base_img, slider_imgs, colour_imgs, step, cache=None, path=CAL_FILE):
    """photo_calibration.npz from synthetic renders (make_photo_fixtures.py --calibrate): the base head, each frontal
    slider at +step and -step, and colour renders with known albedos. Responses are secants: (Q(+-step) - Q(0)) / step."""
    def frame(img):
        P, gap, _ = check(detect(img, cache)); return eye_frame(P)[MESH], P, gap
    Q0, _, _ = frame(base_img)
    names = [n for n in FRONTAL_SLIDERS if n in slider_imgs]
    pos = np.stack([(frame(slider_imgs[n][0])[0] - Q0) / step for n in names])
    neg = np.stack([(frame(slider_imgs[n][1])[0] - Q0) / step for n in names])
    ratios_ = {'skin': [], 'hair': [], 'iris': []}
    ones = {'skin': np.ones(3), 'hair': np.ones(3), 'iris': np.ones(3)}
    for img, cols in colour_imgs:
        _, P, gap = frame(img)
        got, _, extra = colours(img, P, gap, ones)
        for k, kk in (('skin', 'skin'), ('hair', 'hair'), ('eyes', 'iris')):
            meas = extra['skin_photo_srgb'] if k == 'skin' else got.get(k)
            if meas: ratios_[kk].append(lin([int(x) for x in meas.split(',')]) / lin([int(x) for x in cols[k].split(',')]))
    gains = {k: np.median(np.array(v), axis=0) if v else np.ones(3) for k, v in ratios_.items()}
    np.savez_compressed(path, names=np.array(names), base=Q0.astype(np.float32), pos=pos.astype(np.float32),
                        neg=neg.astype(np.float32), step=step, gain_skin=gains['skin'], gain_hair=gains['hair'],
                        gain_iris=gains['iris'], renders=1 + 2 * len(names) + len(colour_imgs))
    return load_calibration(path)


# ── Colours ───────────────────────────────────────────────────────────────────────────────────────────────────────
def lin(c):
    c = np.asarray(c, float) / 255.0
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def srgb(l):
    l = np.clip(np.asarray(l, float), 0, 1)
    return np.round(255 * np.where(l <= 0.0031308, l * 12.92, 1.055 * l ** (1 / 2.4) - 0.055)).astype(int)


def disc(img, c, r):
    h, w = img.shape[:2]
    y, x = np.ogrid[:h, :w]
    m = (x - c[0]) ** 2 + (y - c[1]) ** 2 <= r * r
    return img[m]


def robust(px, lo=0.15, hi=0.15):
    """Median linear colour after dropping the darkest `lo` and brightest `hi` fraction (shadows, highlights)."""
    L = lin(px)
    if len(L) < 8: return None
    y = L @ np.array([0.2126, 0.7152, 0.0722])
    a, b = np.quantile(y, lo), np.quantile(y, 1 - hi)
    keep = L[(y >= a) & (y <= b)]
    return np.median(keep if len(keep) else L, axis=0)


def skin_rule(c):
    """Keep a skin albedo inside mpfb_dress.py's check: red >= green >= blue, linear mean 0.008..0.6."""
    r, g, b = (float(x) for x in c)
    g = min(g, r); b = min(b, g)
    m = (r + g + b) / 3
    s = 1.0 if 0.0085 < m < 0.59 else (0.0085 / m if m <= 0.0085 else 0.59 / m)
    return np.array([r, g, b]) * s


def colours(img, P, gap, gains):
    up = P[10] - P[152]; up = up / np.linalg.norm(up)
    skin_px = np.concatenate([disc(img, P[i], 0.12 * gap) for i in (50, 280, 151)])
    skin = robust(skin_px)
    out, notes = {}, []
    albedo = skin_rule(skin / gains['skin'])
    out['skin'] = ','.join(map(str, srgb(albedo)))
    # Hair: a band above the forehead top; only pixels clearly unlike the skin count, and only when there are enough.
    band = np.concatenate([disc(img, P[10] + up * gap * t + side, 0.14 * gap)
                           for t in (0.35, 0.55, 0.75) for side in (np.array([0, 0]), np.array([0.4 * gap, 0]), np.array([-0.4 * gap, 0]))])
    L = lin(band)
    far = np.linalg.norm(L - skin, axis=1) > 0.35 * max(float(np.linalg.norm(skin)), 0.05)
    if far.mean() > 0.3:
        hair = np.median(L[far], axis=0) / gains['hair']
        out['hair'] = ','.join(map(str, srgb(np.clip(hair, 0.002, 0.8))))
    else:
        notes.append('hair not visible above the forehead (short hair, a bald head or a cropped photo): hair colour unchanged')
    # Iris: the ring between pupil and limbus of both eyes, highlights and the darkest pixels dropped.
    ring = []
    for c, edge in ((IRIS_R, (469, 470, 471, 472)), (IRIS_L, (474, 475, 476, 477))):
        r = float(np.mean([np.linalg.norm(P[e] - P[c]) for e in edge]))
        h, w = img.shape[:2]; y, x = np.ogrid[:h, :w]
        d2 = (x - P[c][0]) ** 2 + (y - P[c][1]) ** 2
        ring.append(img[(d2 >= (0.45 * r) ** 2) & (d2 <= (0.9 * r) ** 2)])
    ring = np.concatenate(ring)
    iris = robust(ring, 0.25, 0.25) if len(ring) >= 8 else None
    if iris is not None:
        out['eyes'] = ','.join(map(str, srgb(np.clip(iris / gains['iris'], 0.002, 0.8))))
    else:
        notes.append('iris too small in the photo to sample: eye colour unchanged')
    return out, notes, {'skin_photo_srgb': ','.join(map(str, srgb(skin)))}



# ── The fit ───────────────────────────────────────────────────────────────────────────────────────────────────────
def fit_image(img, cache=None, cal=None):
    """Fit one RGB image (numpy). Raises Refused. Returns the FIT.json dict."""
    t0 = time.monotonic()
    cal = cal or load_calibration()
    P, gap, pose = check(detect(img, cache))
    Q = eye_frame(P)
    w, err = fit_shape(cal, Q)
    measured = ratios(Q)
    M = np.full((478, 2), np.nan); M[MESH] = predict(cal, w)
    model = ratios(M)
    rel = [abs(model[k] - measured[k]) / max(abs(measured[k]), 1e-6) for k in measured]
    cols, notes, extra = colours(img, P, gap, cal['gains'])
    sliders = {k: round(x, 3) for k, x in w.items()}
    obs = observability(cal)
    fe = {'landmark_rms_eye_gaps': round(err, 4), 'ratio_mean_rel_pct': round(100 * float(np.mean(rel)), 2),
          'note': 'residual between the photo\'s landmarks and the calibrated prediction for the fitted sliders'}
    return {
        'winner': {'weights': {k: x for k, x in sliders.items() if x}, 'youth': 0.0},
        'reference_fit': {
            'method': METHOD, 'model': {k: MODEL[k] for k in ('name', 'sha256', 'license')},
            'image': {'width': int(img.shape[1]), 'height': int(img.shape[0]), 'eye_gap_px': round(gap, 1), **pose},
            'landmarks': {'count': int(len(P)), 'used': 468, 'measured': measured, 'model': model},
            'sliders': sliders,
            'not_measured': sorted(n for n in obs if n not in sliders) + ['depth sliders (nose_d, brow_fwd, forehead_fwd, mouth_fwd, chin_prog, chin_prom)'],
            'colors': cols, 'color_notes': notes, **extra, 'fit_error': fe,
            'calibration': {'renders': cal['renders'], 'step': cal['step'], 'observability': obs},
            'limits': LIMITS, 'seconds': round(time.monotonic() - t0, 2),
        },
    }


def fit(image_path, cache=None):
    return fit_image(load_image(image_path), cache)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--image', required=True); ap.add_argument('--out', required=True); ap.add_argument('--model-dir')
    a = ap.parse_args()
    try:
        res = fit(a.image, a.model_dir)
    except Refused as e:
        with open(a.out, 'w') as f: json.dump({'refused': str(e), 'method': METHOD}, f)
        print('REFUSED', e, flush=True); return 3
    with open(a.out, 'w') as f: json.dump(res, f, indent=1)
    r = res['reference_fit']
    print('FIT', json.dumps({'sliders': r['sliders'], 'fit_error': r['fit_error']}), flush=True)
    return 0


if __name__ == '__main__':
    sys.exit(main())

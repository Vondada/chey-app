"""Facial animation tracks for CHE, as shape-key curves per frame (pure numpy; Blender only receives the curves).

  visemes(cues, fps, n)        Rhubarb mouth cues -> unit curves with coarticulation (anticipation, asymmetric
                               attack/release smoothing), so the mouth moves through shapes instead of snapping open/shut
  blinks(n, fps, seed, ...)    blink times from a log-normal interval model (about 15-20 a minute at rest), 60 ms
                               close / 120 ms open, occasional double blinks, plus blinks forced at big gaze shifts
  gaze(n, fps, seed, targets)  fixations with saccades (a 30-60 ms ballistic move), micro-saccades and slow drift;
                               returns (yaw, pitch) degrees and the frames where a big saccade happened
  expression(n, fps, keys)     emotion keys [(t, {unit: weight})] blended with smoothstep, plus micro-expressions
  lip_sync_lag(mouth, audio, fps, sr)  cross-correlation lag (ms) between mouth opening and the audio envelope

Units are the shape keys of tools/avatar_facial/expressions.py (UNITS, VISEMES) and mpfb_body.py's five.
"""
import json
import math

import numpy as np

try:
    from expressions import VISEMES
except ImportError:   # imported as a package module
    from .expressions import VISEMES


def load_rhubarb(path):
    with open(path) as f: d = json.load(f)
    return [(c['start'], c['end'], c['value']) for c in d['mouthCues']]


def visemes(cues, fps, n, offset_s=0.0, lead_s=0.04, attack_s=0.035, release_s=0.07, gain=1.0):
    """Unit curves {key: (n,)} for Rhubarb cues placed at offset_s. Each cue's target weights start lead_s early
    (lips shape before the sound), then a one-pole filter with a faster attack than release blends neighbouring
    shapes (coarticulation)."""
    t = np.arange(n) / fps
    keys = sorted({k for v in VISEMES.values() for k in v})
    target = {k: np.zeros(n) for k in keys}
    for start, end, shape in cues:
        a, b = start + offset_s - lead_s, end + offset_s - lead_s
        m = (t >= a) & (t < b)
        for k, w in VISEMES.get(shape, {}).items(): target[k][m] = w * gain
    out = {}
    ka = 1 - math.exp(-1.0 / (fps * attack_s)); kr = 1 - math.exp(-1.0 / (fps * release_s))
    for k, x in target.items():
        y = np.zeros(n); v = 0.0
        for i in range(n):
            v += (ka if x[i] > v else kr) * (x[i] - v); y[i] = v
        out[k] = y
    return out


def mouth_opening(curves):
    """A scalar 'how open' per frame from viseme unit curves (for timing measurement)."""
    return curves.get('mouth_open', 0) + 0.5 * curves.get('mouth_part', 0) + 0.3 * curves.get('mouth_stretch', 0)


def blinks(n, fps, seed=1, mean_interval_s=3.2, forced=(), close_s=0.06, hold_s=0.03, open_s=0.12):
    """(blink curve (n,), list of blink start times). Forced blink times are added (gaze shifts, emphasis)."""
    rng = np.random.default_rng(seed)
    times, t = [], rng.uniform(0.4, 1.6)
    dur = n / fps
    while t < dur:
        times.append(t)
        if rng.random() < 0.12: times.append(t + 0.32)   # double blink
        t += float(np.clip(rng.lognormal(math.log(mean_interval_s), 0.45), 1.0, 9.0))
    for f in forced:
        if all(abs(f - x) > 0.5 for x in times): times.append(f)
    times = sorted(times)
    y = np.zeros(n); tt = np.arange(n) / fps
    for s in times:
        a = np.clip((tt - s) / close_s, 0, 1)
        b = np.clip((tt - s - close_s - hold_s) / open_s, 0, 1)
        y = np.maximum(y, np.where(tt < s, 0, np.where(tt < s + close_s + hold_s, a, 1 - b * b * (3 - 2 * b))))
    return y, times


def gaze(n, fps, seed=2, targets=None, fix_s=(0.35, 1.6), micro_deg=0.35, big_deg=8.0):
    """Eye direction (yaw, pitch) degrees per frame. targets: list of (t_start, (yaw, pitch)) the eyes return to
    (e.g. the camera while speaking); between them fixations wander around the target. Returns (yaw, pitch, big
    saccade times)."""
    rng = np.random.default_rng(seed)
    targets = sorted(targets or [(0.0, (0.0, 0.0))])
    dur = n / fps
    fix, t = [], 0.0
    while t < dur:
        base = [tg for ts, tg in targets if ts <= t][-1] if any(ts <= t for ts, _ in targets) else targets[0][1]
        jump = rng.random() < 0.35
        aim = (base[0] + (rng.normal(0, 6) if jump else rng.normal(0, 1.5)), base[1] + (rng.normal(0, 3) if jump else rng.normal(0, 1.0)))
        fix.append((t, aim)); t += rng.uniform(*fix_s)
    yaw = np.zeros(n); pitch = np.zeros(n); big = []
    tt = np.arange(n) / fps
    prev = fix[0][1]
    for i, (ts, aim) in enumerate(fix):
        te = fix[i + 1][0] if i + 1 < len(fix) else dur + 1
        amp = math.hypot(aim[0] - prev[0], aim[1] - prev[1])
        sd = 0.025 + 0.0022 * amp   # saccade main-sequence duration (s)
        if amp > big_deg: big.append(ts)
        m = (tt >= ts) & (tt < te)
        u = np.clip((tt[m] - ts) / sd, 0, 1); s = u * u * (3 - 2 * u)
        yaw[m] = prev[0] + (aim[0] - prev[0]) * s; pitch[m] = prev[1] + (aim[1] - prev[1]) * s
        prev = aim
    # micro-saccades and drift
    yaw += micro_deg * np.cumsum(rng.normal(0, 0.15, n)).clip(-2, 2)
    pitch += micro_deg * np.cumsum(rng.normal(0, 0.15, n)).clip(-2, 2)
    return yaw, pitch, big


def look_keys(yaw, pitch, max_yaw=25.0, up_deg=18.0, down_deg=22.0):
    """Eye look shape-key weights from angles (positive yaw = her left, positive pitch = up), plus a lid follow
    (eye_squint on downward gaze, eye_wide a little on upward gaze)."""
    return {'look_left': np.clip(yaw / max_yaw, 0, 1), 'look_right': np.clip(-yaw / max_yaw, 0, 1),
            'look_up': np.clip(pitch / up_deg, 0, 1), 'look_down': np.clip(-pitch / down_deg, 0, 1)}


def lid_follow(pitch, down_deg=22.0):
    return {'eye_squint': 0.35 * np.clip(-pitch / down_deg, 0, 1), 'eye_wide': 0.25 * np.clip(pitch / 18.0, 0, 1)}


def expression(n, fps, keys, blend_s=0.35):
    """keys: [(t, {unit: weight})], each held until the next, crossfaded over blend_s with smoothstep."""
    tt = np.arange(n) / fps
    units = sorted({u for _, w in keys for u in w})
    out = {u: np.zeros(n) for u in units}
    keys = sorted(keys, key=lambda k: k[0])
    for u in units:
        vals = [w.get(u, 0.0) for _, w in keys]; ts = [k[0] for k in keys]
        y = np.full(n, vals[0])
        for i in range(1, len(ts)):
            x = np.clip((tt - ts[i]) / blend_s, 0, 1); s = x * x * (3 - 2 * x)
            y = np.where(tt >= ts[i], y * (1 - s) + vals[i] * s, y)
        out[u] = y
    return out


def pulse(n, fps, t, unit, peak, rise=0.08, hold=0.15, fall=0.3):
    """A micro-expression: unit rises to peak, holds, falls (brow flash on a stressed word, a quick lip press)."""
    tt = np.arange(n) / fps
    y = np.clip((tt - t) / rise, 0, 1) * peak
    f = np.clip((tt - t - rise - hold) / fall, 0, 1)
    return {unit: y * (1 - f * f * (3 - 2 * f))}


def combine(*tracks, clamp=(0.0, 1.0)):
    out = {}
    for tr in tracks:
        for k, v in tr.items(): out[k] = out.get(k, 0) + np.asarray(v, float)
    return {k: np.clip(v, *clamp) for k, v in out.items()}


def audio_envelope(x, sr, fps):
    hop = sr / fps; n = int(len(x) / hop)
    return np.array([np.sqrt(np.mean(x[int(i * hop):int((i + 1) * hop)] ** 2) + 1e-12) for i in range(n)])


def lip_sync_lag(mouth, x, sr, fps, max_lag_s=0.25, offset_s=0.0):
    """Lag (ms) maximising the correlation of the mouth-opening curve with the audio RMS envelope placed at offset_s.
    Positive = the mouth opens after the sound (late); negative = before (anticipation). Returns (lag_ms, corr)."""
    env = audio_envelope(x, sr, fps)
    n = len(mouth); a = np.zeros(n)
    s = int(round(offset_s * fps)); e = min(n, s + len(env))
    a[s:e] = env[:e - s]
    m = np.asarray(mouth, float)
    # only the speech span (plus the lag search margin) counts: long silences around the line, where both curves are
    # flat, would otherwise inflate the correlation
    L = int(max_lag_s * fps)
    w0, w1 = max(0, s - L), min(n, e + L)
    a, m = a[w0:w1], m[w0:w1]; n = len(a)
    def z(v): return (v - v.mean()) / (v.std() + 1e-9)
    a, m = z(a), z(m)
    best = (0, -2.0)
    for lag in range(-L, L + 1):
        if lag >= 0: c = float(np.mean(m[lag:] * a[:n - lag]))
        else: c = float(np.mean(m[:n + lag] * a[-lag:]))
        if c > best[1]: best = (lag, c)
    return round(1000 * best[0] / fps, 1), round(best[1], 3)

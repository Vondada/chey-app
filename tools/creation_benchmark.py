"""Creation Engine benchmark: the pipeline before and after the speed/photorealism upgrade, same scene, same machine.

  python3 tools/creation_benchmark.py --blender BLENDER --out DIR [--glb MODEL.glb | --build] [--views 0,45,90]
        [--samples 64] [--res 480] [--ref-samples 512] [--try-eevee] [--threads N]

The scene is CHE's full-body character: --build makes it with tools/avatar_body/mpfb_body.py (timed, shared by both
pipelines), or --glb takes one already built. Then, each in its own Blender process, measured with os.wait4 (wall time
and the process's own peak resident memory):
  legacy     render_glb.py RENDER_PROFILE=legacy: the pipeline as it was (Cycles, SAMPLES, Blender 5.0 defaults).
  preview    render_glb.py RENDER_PROFILE=preview: the upgraded pipeline's quick look, EEVEE first when --try-eevee
             (falls back to the Cycles quick look if EEVEE cannot start here), so "time to first picture" is real.
  final      render_glb.py RENDER_PROFILE=final: the upgraded delivered renders (adaptive stop, OIDN with albedo and
             normal, capped light paths, persistent data across views, skin subsurface and micro-detail).
  closeup_legacy, closeup_final   the face close up in each pipeline (same samples), where skin detail shows.
  ref_legacy, ref_final   the front view at --ref-samples with each pipeline's own materials: the converged picture each
             pipeline is aiming at, so quality is "how close to its own converged render" (SSIM, PSNR) plus a noise
             estimate (Immerkaer) on every picture. Materials differ between the pipelines on purpose (that is the
             photorealism part), so the pictures themselves are part of the result.
Nothing is estimated: every number in results.json comes from these runs; a run that fails is recorded as failed.
Blender may be the official binary or a stand-in that runs the bpy module (the same Python API).
"""
import argparse
import datetime
import hashlib
import json
import os
import platform
import re
import subprocess
import sys
import time
import zlib

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BODY = os.path.join(ROOT, 'tools', 'avatar_body')
BL_RUN = os.path.join(ROOT, 'tools', 'avatar_face', 'bl_run.py')


# ── PNG decoding (8 or 16-bit greyscale, RGB or RGBA, non-interlaced: what Blender writes) ────────────────────────────
def read_png(path):
    """The picture as float RGB in [0, 1], shape (h, w, 3)."""
    data = open(path, 'rb').read()
    if data[:8] != b'\x89PNG\r\n\x1a\n': raise ValueError(f'{path} is not a PNG')
    pos, idat, ihdr = 8, [], None
    while pos < len(data):
        n = int.from_bytes(data[pos:pos + 4], 'big'); kind = data[pos + 4:pos + 8]; body = data[pos + 8:pos + 8 + n]
        if kind == b'IHDR': ihdr = body
        elif kind == b'IDAT': idat.append(body)
        elif kind == b'IEND': break
        pos += 12 + n
    w, h = int.from_bytes(ihdr[0:4], 'big'), int.from_bytes(ihdr[4:8], 'big')
    depth, ctype, interlace = ihdr[8], ihdr[9], ihdr[12]
    if interlace or ctype not in (0, 2, 4, 6) or depth not in (8, 16): raise ValueError(f'{path}: unsupported PNG type {ctype}/{depth}')
    ch = {0: 1, 2: 3, 4: 2, 6: 4}[ctype]; bpp = ch * depth // 8; stride = w * bpp
    raw = zlib.decompress(b''.join(idat))
    out = np.zeros((h, stride), dtype=np.uint8); prev = np.zeros(stride, dtype=np.int32)
    for y in range(h):
        f = raw[y * (stride + 1)]; line = np.frombuffer(raw, np.uint8, stride, y * (stride + 1) + 1).astype(np.int32)
        if f == 0: cur = line
        elif f == 2: cur = (line + prev) & 255
        elif f in (1, 3, 4):
            cur = np.zeros(stride, dtype=np.int32)
            for x in range(stride):
                a = cur[x - bpp] if x >= bpp else 0; b = prev[x]; c = prev[x - bpp] if x >= bpp else 0
                if f == 1: pr = a
                elif f == 3: pr = (a + b) >> 1
                else:
                    p = a + b - c; pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                    pr = a if pa <= pb and pa <= pc else (b if pb <= pc else c)
                cur[x] = (line[x] + pr) & 255
        else: raise ValueError(f'{path}: bad PNG filter {f}')
        out[y] = cur; prev = cur
    px = out.reshape(h, w, bpp)
    if depth == 16: px = (px[..., 0::2].astype(np.uint16) << 8 | px[..., 1::2]).astype(np.float64) / 65535.0
    else: px = px.astype(np.float64) / 255.0
    px = px.reshape(h, w, ch)
    if ch in (1, 2): px = np.repeat(px[..., :1], 3, axis=2)
    return px[..., :3]


# ── Quality measures ─────────────────────────────────────────────────────────────────────────────────────────────────
def luma(rgb):
    return rgb @ np.array([0.2126, 0.7152, 0.0722])


def noise_sigma(rgb):
    """Immerkaer (1996) fast noise estimate on luma, in 8-bit levels: the residual of a Laplacian-difference kernel that
    cancels smooth image structure. Lower is cleaner."""
    g = luma(rgb) * 255.0
    if min(g.shape) < 3: return 0.0
    k = (g[:-2, :-2] - 2 * g[:-2, 1:-1] + g[:-2, 2:] - 2 * g[1:-1, :-2] + 4 * g[1:-1, 1:-1] - 2 * g[1:-1, 2:]
         + g[2:, :-2] - 2 * g[2:, 1:-1] + g[2:, 2:])
    h, w = g.shape
    return float(np.sqrt(np.pi / 2) * np.abs(k).sum() / (6 * (w - 2) * (h - 2)))


def _box(a, r):
    """Mean over (2r+1)^2 windows (valid region) by integral image."""
    s = np.pad(a, ((1, 0), (1, 0))).cumsum(0).cumsum(1); n = 2 * r + 1
    return (s[n:, n:] - s[:-n, n:] - s[n:, :-n] + s[:-n, :-n]) / (n * n)


def ssim(a, b, r=3):
    """Mean SSIM on luma (Wang et al. 2004 constants, 7x7 uniform windows). 1.0 is identical."""
    x, y = luma(a), luma(b)
    if x.shape != y.shape: raise ValueError('pictures differ in size')
    c1, c2 = 0.01 ** 2, 0.03 ** 2
    mx, my = _box(x, r), _box(y, r)
    vx, vy, cxy = _box(x * x, r) - mx * mx, _box(y * y, r) - my * my, _box(x * y, r) - mx * my
    s = ((2 * mx * my + c1) * (2 * cxy + c2)) / ((mx * mx + my * my + c1) * (vx + vy + c2))
    return float(s.mean())


def psnr(a, b):
    mse = float(((a - b) ** 2).mean())
    return float('inf') if mse == 0 else float(10 * np.log10(1.0 / mse))


# ── Running Blender, measured ────────────────────────────────────────────────────────────────────────────────────────
def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''): h.update(chunk)
    return h.hexdigest()


def measured(cmd, env, log):
    """Run cmd; returns (exit code, wall seconds, peak RSS MiB of that process, output lines). Peak memory comes from
    os.wait4's rusage for this one child (Linux reports ru_maxrss in KiB)."""
    t0 = time.monotonic()
    with open(log, 'w') as lf:
        p = subprocess.Popen(cmd, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        lines = []
        for line in p.stdout:
            lf.write(line); lines.append(line.rstrip('\n'))
        _, status, ru = os.wait4(p.pid, 0)
    wall = time.monotonic() - t0
    code = os.waitstatus_to_exitcode(status)
    p.returncode = code
    return code, round(wall, 2), round(ru.ru_maxrss / 1024, 1), lines


def blender_cmd(blender, script, *args):
    return [blender, '-b', '--factory-startup', '-P', BL_RUN, '--', script, *args]


def run_render(a, name, glb, outdir, env_extra):
    os.makedirs(outdir, exist_ok=True)
    env = dict(os.environ, OUT_DIR=outdir, STRIPS='', TEST_RES=str(a.res), CYCLES_DEVICE='CPU', **env_extra)
    if a.threads: env['CPU_THREADS'] = str(a.threads)
    load = round(os.getloadavg()[0], 2)   # 1-minute load before the run: a busy shared machine shows up here
    code, wall, rss, lines = measured(blender_cmd(a.blender, os.path.join(BODY, 'render_glb.py'), glb), env, os.path.join(a.out, f'{name}.log'))
    files = [re.split(r'\s+', l, 1)[1] for l in lines if l.startswith(('WROTE ', 'PREVIEW_WROTE '))]
    per_view = {m.group(1): float(m.group(2)) for m in (re.match(r'RENDERED (-?\d+) ([\d.]+)', l) for l in lines) if m}
    prof = next((l for l in lines if l.startswith('PROFILE ')), '')
    mats = next((l for l in lines if l.startswith('MATERIALS ')), '')
    dev = next((l for l in lines if l.startswith('DEVICE ')), '')
    rec = {'name': name, 'exit_code': code, 'ok': code == 0 and bool(files), 'wall_seconds': wall, 'peak_rss_mib': rss, 'load_before': load,
           'view_seconds': per_view, 'device_line': dev,
           'profile': json.loads(prof.split(' ', 3)[3]) if prof.count(' ') >= 3 else None,
           'materials': json.loads(mats[len('MATERIALS '):]) if mats else [],
           'files': [{'file': os.path.relpath(f, a.out), 'bytes': os.path.getsize(f), 'sha256': sha256(f)} for f in files if os.path.isfile(f)]}
    if not rec['ok']: rec['tail'] = lines[-8:]
    print(f"{name}: exit {code}, {wall} s wall, {rss} MiB peak, views {per_view}", flush=True)
    return rec


def machine(blender):
    info = {'platform': platform.platform(), 'python': platform.python_version(), 'cores': os.cpu_count()}
    try:
        cpu = open('/proc/cpuinfo').read(); m = re.search(r'model name\s*:\s*(.+)', cpu); info['cpu'] = m.group(1).strip() if m else ''
        mem = re.search(r'MemTotal:\s+(\d+)', open('/proc/meminfo').read()); info['ram_gib'] = round(int(mem.group(1)) / 1048576, 1)
    except (OSError, AttributeError): pass
    v = subprocess.run([blender, '--version'], capture_output=True, text=True).stdout.splitlines()
    info['blender'] = v[0] if v else 'unknown'
    info['github_runner'] = os.environ.get('RUNNER_NAME', '') or None
    return info


def picture(a, rec, view):
    f = next((x['file'] for x in rec.get('files', []) if re.search(rf'(body|preview)_{view:02d}\.png$', x['file'])), None)
    return read_png(os.path.join(a.out, f)) if f else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--blender', required=True); ap.add_argument('--out', required=True)
    ap.add_argument('--glb'); ap.add_argument('--build', action='store_true')
    ap.add_argument('--views', default='0,45,90'); ap.add_argument('--samples', type=int, default=64)
    ap.add_argument('--res', type=int, default=480); ap.add_argument('--ref-samples', type=int, default=512)
    ap.add_argument('--try-eevee', action='store_true'); ap.add_argument('--threads', type=int, default=0)
    ap.add_argument('--skip-reference', action='store_true')
    ap.add_argument('--repeat', type=int, default=3, help='legacy/final rounds (medians and the spread are reported)')
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True); a.out = os.path.abspath(a.out)
    res = {'started_at': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'), 'machine': machine(a.blender),
           'scene': {'views': a.views, 'samples': a.samples, 'long_edge_px': a.res, 'reference_samples': a.ref_samples}, 'runs': {}}
    glb = a.glb
    if a.build or not glb:
        glb = os.path.join(a.out, 'scene.glb')
        env = dict(os.environ, EXPORT_GLB=glb, VIEWS='', STRIPS='', OUT_DIR=a.out)
        code, wall, rss, lines = measured(blender_cmd(a.blender, os.path.join(BODY, 'mpfb_body.py')), env, os.path.join(a.out, 'build.log'))
        res['runs']['build'] = {'exit_code': code, 'ok': code == 0 and os.path.isfile(glb), 'wall_seconds': wall, 'peak_rss_mib': rss,
                                'model': next((l for l in lines if l.startswith('MODEL ')), '')[:300]}
        print(f'build: exit {code}, {wall} s, {rss} MiB', flush=True)
        if not res['runs']['build']['ok']:
            json.dump(res, open(os.path.join(a.out, 'results.json'), 'w'), indent=1); return 1
    res['scene']['glb_sha256'] = sha256(glb); res['scene']['glb_bytes'] = os.path.getsize(glb)
    views = a.views
    R = res['runs']
    # legacy and final, --repeat rounds, alternating which goes first so neither always meets a warmer (or busier)
    # machine; the first round's pictures are the ones measured for quality, every round's times are kept.
    rounds = {'legacy': [], 'final': []}
    for r in range(a.repeat):
        for name in (('legacy', 'final') if r % 2 == 0 else ('final', 'legacy')):
            rec = run_render(a, f'{name}_r{r + 1}', glb, os.path.join(a.out, name if r == 0 else f'{name}_r{r + 1}'),
                             {'RENDER_PROFILE': name, 'SAMPLES': str(a.samples), 'VIEWS': views})
            rounds[name].append(rec)
    R['legacy'], R['final'] = rounds['legacy'][0], rounds['final'][0]
    pv = None
    if a.try_eevee:
        pv = run_render(a, 'preview_eevee', glb, os.path.join(a.out, 'preview_eevee'), {'RENDER_PROFILE': 'preview', 'PREVIEW_ENGINE': 'eevee', 'VIEWS': views})
        R['preview_eevee'] = pv
    if not pv or not pv['ok']:
        pv = run_render(a, 'preview', glb, os.path.join(a.out, 'preview'), {'RENDER_PROFILE': 'preview', 'PREVIEW_ENGINE': 'cycles', 'VIEWS': views})
        R['preview'] = pv
    first = int(views.split(',')[0])
    # The face close up, where skin, eyes and hair detail are visible at all (a full-body view at 480 px hides them).
    face = {'VIEWS': '0', 'TARGET_Z': '1.6', 'CAM_Z': '1.62', 'CAM_DIST': '0.75', 'SAMPLES': str(a.samples)}
    R['closeup_legacy'] = run_render(a, 'closeup_legacy', glb, os.path.join(a.out, 'closeup_legacy'), dict(face, RENDER_PROFILE='legacy'))
    R['closeup_final'] = run_render(a, 'closeup_final', glb, os.path.join(a.out, 'closeup_final'), dict(face, RENDER_PROFILE='final'))
    if not a.skip_reference:
        R['ref_legacy'] = run_render(a, 'ref_legacy', glb, os.path.join(a.out, 'ref_legacy'), {'RENDER_PROFILE': 'legacy', 'SAMPLES': str(a.ref_samples), 'VIEWS': str(first)})
        R['ref_final'] = run_render(a, 'ref_final', glb, os.path.join(a.out, 'ref_final'),
                                    {'RENDER_PROFILE': 'final', 'SAMPLES': str(a.ref_samples), 'ADAPTIVE_THRESHOLD': '0.005', 'VIEWS': str(first)})
    # Quality: every picture's noise; the first view against its own pipeline's converged reference.
    q = {}
    for k, rec in R.items():
        if k == 'build' or not rec.get('ok'): continue
        q[k] = {'noise_sigma': {}}
        for f in rec['files']:
            q[k]['noise_sigma'][f['file']] = round(noise_sigma(read_png(os.path.join(a.out, f['file']))), 3)
    for k, ref in (('legacy', 'ref_legacy'), ('final', 'ref_final')):
        if R.get(k, {}).get('ok') and R.get(ref, {}).get('ok'):
            x, y = picture(a, R[k], first), picture(a, R[ref], first)
            if x is not None and y is not None:
                q[k]['vs_own_reference'] = {'view': first, 'ssim': round(ssim(x, y), 4), 'psnr_db': round(psnr(x, y), 2)}
    res['quality'] = q
    # The comparison, computed from the runs above (render processes only; the shared model build is listed apart).
    L, F, P = R['legacy'], R['final'], pv
    res['rounds'] = {k: [{x: r.get(x) for x in ('name', 'ok', 'wall_seconds', 'peak_rss_mib', 'load_before', 'view_seconds')} for r in v] for k, v in rounds.items()}
    res['comparison'] = compare(rounds, P, views.split(',')[0]) if all(x['ok'] for x in rounds['legacy'] + rounds['final']) else None
    res['finished_at'] = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    json.dump(res, open(os.path.join(a.out, 'results.json'), 'w'), indent=1)
    print('RESULTS', os.path.join(a.out, 'results.json'), flush=True)
    print(json.dumps(res.get('comparison') or {}, indent=1), flush=True)
    return 0 if L['ok'] and F['ok'] else 1


def first_picture(rec, first_view):
    """Seconds from starting Blender to the first picture written: the run's wall time minus its own render time,
    plus its first view (startup and import are paid before any picture)."""
    vs = rec.get('view_seconds') or {}
    if not rec.get('ok') or first_view not in vs: return None
    return round(rec['wall_seconds'] - sum(vs.values()) + vs[first_view], 2)


def compare(rounds, P, first_view):
    """The legacy/final comparison from every round (medians and the spread), and the quick look's first picture."""
    per = {k: [round(sum(x['view_seconds'].values()), 2) for x in v] for k, v in rounds.items()}
    walls = {k: [x['wall_seconds'] for x in v] for k, v in rounds.items()}
    firsts = [first_picture(x, first_view) for x in rounds['legacy']]
    lv, fv = float(np.median(per['legacy'])), float(np.median(per['final']))
    return {
        'rounds': len(rounds['legacy']), 'render_seconds_each_round': per, 'wall_seconds_each_round': walls,
        'load_before_each_run': {k: [x['load_before'] for x in v] for k, v in rounds.items()},
        'legacy_wall_seconds': float(np.median(walls['legacy'])),
        'upgraded_wall_seconds': round(float(np.median(walls['final'])) + (P['wall_seconds'] if P and P['ok'] else 0), 2),
        'legacy_render_seconds_median': round(lv, 2), 'final_render_seconds_median': round(fv, 2),
        'final_vs_legacy_render_speedup': round(lv / fv, 3) if fv else None,
        'speedup_range': [round(min(per['legacy']) / max(per['final']), 3), round(max(per['legacy']) / min(per['final']), 3)],
        'legacy_first_picture_seconds_each_round': firsts,
        'legacy_first_picture_seconds_median': round(float(np.median([f for f in firsts if f is not None])), 2) if any(f is not None for f in firsts) else None,
        'upgraded_first_picture_seconds': first_picture(P, first_view) if P else None,
        'peak_rss_mib': {'legacy': max(x['peak_rss_mib'] for x in rounds['legacy']), 'final': max(x['peak_rss_mib'] for x in rounds['final']),
                         'preview': P['peak_rss_mib'] if P else None},
        'preview_engine': (P or {}).get('profile', {}).get('engine') if P else None,
    }


if __name__ == '__main__':
    sys.exit(main())

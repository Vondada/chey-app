"""CHE face preview on a GPU (Colab T4): one resumable job, GPU only, with an execution receipt.

  python3 scripts/che_gpu_face_preview.py --blender BLENDER --project DIR --out DIR
        [--views 0,45,90] [--device auto|OPTIX|CUDA] [--samples 64] [--res 480] [--settings settings.json] [--model]

--project holds che.blend, fit.json (face_fit.py winner) and che_landmarks.npz. MPFB (env) points at the MakeHuman /
MPFB2 data directory. The face itself is built by tools/avatar_face/mpfb_dress.py inside the official Blender binary
(via tools/avatar_face/bl_run.py), the same script the CPU tests use, so CPU and GPU previews stay comparable.

Rules:
- GPU only. The device is probed first (OptiX, then CUDA); with no GPU the job stops with exit 3 and a receipt saying
  so. Every render must print a DEVICE line naming the GPU or the view is marked failed; nothing falls back to the CPU.
- Resumable. The job folder is named by a hash of the face code, inputs and settings (no date, no commit); a view whose PNG and receipt already exist
  is not rendered again, so a disconnected Colab session continues where it stopped.
- The pre-render geometry and colour checks in mpfb_dress.py still run; a failed check stops the job (exit 2).
- --model (the Live Studio's person_model jobs): the same Blender run also writes model.glb, a head-and-neck bust of
  this exact face (mpfb_dress.py EXPORT_GLB), before any view renders, so CHE's viewport gets the geometry first. Its
  hash, size and vertex count go in the receipt; a model already verified in Drive is reused; a job asked for a model
  is complete only with one.
Exit codes: 0 done, 2 checks failed, 3 no GPU, 4 render failed.
"""
import argparse
import datetime
import hashlib
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import threading
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FACE = os.path.join(ROOT, 'tools', 'avatar_face')

# The current approved checkpoint of CHE's face (face test v6): the fitted MPFB2 head, her own skin, eyes, lashes,
# brows, hair and the features the owner described in words. Override any key with --settings.
DEFAULTS = {
    'RACE': 'african=0.7,caucasian=0.3', 'MATURE': '0.1', 'TARGET_SRGB': '80,46,32', 'LASH_LEN': '0.55',
    'BROW_N': '700', 'KEY_SIZE': '0.5', 'PORES': '0.22',
    'FACE': 'lr:eyes/eye-eyefold-down=0.4,lr:eyes/eye-corner2-up=0.2,nose/nose-point-width-incr=0.3,'
            'nose/nose-scale-horiz-decr=0.2,mouth/mouth-upperlip-volume-incr=0.3,mouth/mouth-lowerlip-volume-incr=0.5,'
            'mouth/mouth-cupidsbow-incr=0.5,lr:cheek/cheek-volume-incr=0.3,chin/chin-width-decr=0.2',
}
VIEW_NAMES = {0: 'front', 45: 'three-quarter', 90: 'side'}


def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''): h.update(chunk)
    return h.hexdigest()


def write_json(path, data):
    tmp = path + '.tmp'
    with open(tmp, 'w') as f: json.dump(data, f, indent=1)
    os.replace(tmp, path)


def now():
    return datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def face_code_sha256():
    """One hash over the face-building code the render runs (tools/avatar_face and tools/avatar_portraits)."""
    h = hashlib.sha256()
    for d in ('avatar_face', 'avatar_portraits'):
        base = os.path.join(ROOT, 'tools', d)
        for dirpath, dirs, files in sorted(os.walk(base)):
            dirs.sort()
            for n in sorted(files):
                if n.endswith('.py'):
                    rel = os.path.relpath(os.path.join(dirpath, n), ROOT)
                    h.update(rel.encode() + b'\0'); h.update(open(os.path.join(dirpath, n), 'rb').read())
    return h.hexdigest()


def finished_view(job, info, v):
    """None when view v is a verified finished GPU render in this job, else the reason it must be rendered: the receipt
    entry is missing or not ok, the PNG is missing or empty (a Drive disconnect mid-copy), its SHA-256 does not match
    the receipt, or the recorded device line is not a GPU."""
    if not info or info.get('status') != 'ok':
        return 'no finished render recorded'
    path = os.path.join(job, info.get('file') or f'view_{v:02d}.png')
    if not os.path.isfile(path) or os.path.getsize(path) == 0:
        return 'picture missing or empty'
    if info.get('sha256') != sha256(path):
        return 'picture does not match its receipt hash'
    dev = info.get('device', '')
    if not re.match(r'DEVICE (OPTIX|CUDA) \[.+\]', dev) or 'CPU' in dev.split(']')[0]:
        return f'recorded device is not a GPU ({dev!r})'
    return None


MODEL_CONTENTS = 'head-and-neck bust, eyes, hair cards; brows, lashes and strand hair are render-only'


def finished_model(job, info):
    """None when the job's model.glb is the verified export its receipt names, else the reason it must be exported."""
    if not info or info.get('status') != 'ok':
        return 'no finished model recorded'
    path = os.path.join(job, 'model.glb')
    if not os.path.isfile(path) or os.path.getsize(path) < 20:
        return 'model missing or empty'
    with open(path, 'rb') as f:
        if f.read(4) != b'glTF':
            return 'model.glb is not a GLB file'
    if info.get('sha256') != sha256(path):
        return 'model does not match its receipt hash'
    return None


def stop(p, grace=5.0):
    """SIGTERM p, SIGKILL it after `grace` seconds, and reap it."""
    for sig in (signal.SIGTERM, signal.SIGKILL):
        try: p.send_signal(sig)
        except ProcessLookupError: pass
        try:
            p.wait(timeout=grace); return
        except subprocess.TimeoutExpired:
            continue


def run(cmd, env, log, timeout, on_line=None):
    """Run a command, stream its output into the log (and to on_line(seconds, line) as each line arrives), and return
    (exit code, [(seconds since start, line)]). The deadline holds even while the command is silent: past `timeout`
    seconds it is stopped and the code is 124. It stays in this runner's process group, so the worker stopping the
    runner's group (an owner cancel) stops Blender too."""
    lines, t0 = [], time.monotonic()
    with open(log, 'a') as lf:
        lf.write(f'\n$ {" ".join(cmd)}\n')
        p = subprocess.Popen(cmd, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)

        def read():
            for line in p.stdout:
                t = time.monotonic() - t0
                lf.write(line); lf.flush(); lines.append((t, line.rstrip('\n')))
                if on_line: on_line(t, line.rstrip('\n'))
        reader = threading.Thread(target=read, daemon=True); reader.start()
        reader.join(timeout)
        if reader.is_alive():
            stop(p); reader.join(5); lf.write('TIMEOUT\n')
            return 124, lines
        try:
            p.wait(timeout=max(1.0, timeout - (time.monotonic() - t0)))
        except subprocess.TimeoutExpired:
            stop(p); lf.write('TIMEOUT\n'); return 124, lines
    return p.returncode, lines


def probe_gpu(blender, project, device, env, log):
    """Ask Cycles which GPUs it sees, using check_project.py (it also checks Blender 5.0 and CHE's scene)."""
    for kind in (['OPTIX', 'CUDA'] if device == 'auto' else [device]):
        code, lines = run([blender, '-b', '--factory-startup', '-P', os.path.join(FACE, 'bl_run.py'), '--',
                           os.path.join(FACE, 'colab', 'check_project.py'), os.path.join(project, 'che.blend')],
                          dict(env, REQUIRE_GPU=kind), log, 600)
        checks = [l for _, l in lines if l.startswith(('CHECK', 'DEVICES'))]
        names = next((l.split(' ', 2)[2] for l in checks if l.startswith(f'DEVICES {kind} ') and 'none' not in l), '')
        if code == 0:
            return kind, names, checks
    return None, '', checks


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--blender', required=True); ap.add_argument('--project', required=True); ap.add_argument('--out', required=True)
    ap.add_argument('--views', default='0,45,90'); ap.add_argument('--device', default='auto', choices=['auto', 'OPTIX', 'CUDA'])
    ap.add_argument('--samples', type=int, default=64); ap.add_argument('--res', type=int, default=480)
    ap.add_argument('--settings'); ap.add_argument('--timeout', type=int, default=1800)
    ap.add_argument('--model', action='store_true', help='also export the 3D model (model.glb) of this face')
    a = ap.parse_args()

    settings = dict(DEFAULTS, **(json.load(open(a.settings)) if a.settings else {}))
    inputs = {n: sha256(os.path.join(a.project, n)) for n in ('che.blend', 'fit.json')}
    tools_rev = subprocess.run(['git', '-C', ROOT, 'rev-parse', '--short', 'HEAD'], capture_output=True, text=True).stdout.strip() or 'unknown'
    # The job is named by what decides the pictures (face code, inputs, settings, samples, size), not by the date or the
    # commit, so rerunning tomorrow or after an unrelated commit reuses finished views instead of rendering them again.
    code = face_code_sha256()
    spec = {'inputs': inputs, 'settings': settings, 'samples': a.samples, 'res': a.res, 'face_code': code}
    if a.model: spec['model'] = 'glb'   # a model job is its own folder; plain preview jobs keep their names
    key = json.dumps(spec, sort_keys=True)
    job_id = 'face-' + hashlib.sha256(key.encode()).hexdigest()[:12]
    job = os.path.join(a.out, job_id); os.makedirs(job, exist_ok=True)
    print('JOB', job, flush=True)
    log, receipt_path = os.path.join(job, 'log.txt'), os.path.join(job, 'receipt.json')
    receipt = json.load(open(receipt_path)) if os.path.exists(receipt_path) else {
        'job_id': job_id, 'created_at': now(), 'tools_commit': tools_rev, 'face_code_sha256': code, 'inputs_sha256': inputs, 'settings': settings,
        'samples': a.samples, 'long_edge_px': a.res, 'views': {}}
    receipt['resumed_at'] = now() if receipt.get('views') else None
    try:
        smi = subprocess.run(['nvidia-smi', '--query-gpu=name,driver_version,memory.total', '--format=csv,noheader'],
                             capture_output=True, text=True)
        receipt['nvidia_smi'] = smi.stdout.strip() or f'unavailable: {smi.stderr.strip()[:200]}'
    except OSError as e:
        receipt['nvidia_smi'] = f'unavailable: {e}'
    receipt['blender_version'] = subprocess.run([a.blender, '--version'], capture_output=True, text=True).stdout.splitlines()[0]
    env = dict(os.environ, CHE=os.path.join(a.project, 'che.blend'), FIT=os.path.join(a.project, 'fit.json'),
               SAMPLES=str(a.samples), TEST_RES=str(a.res), **settings)
    env.pop('FORCE', None)   # previews always carry every check
    if not settings.get('IDENTITY'): env.pop('NOHAIR', None)   # an identity preset whose hair style is not built yet renders close-cropped

    kind, names, checks = probe_gpu(a.blender, a.project, a.device, env, log)
    receipt['project_checks'] = checks
    if not kind:
        receipt.update(status='gpu_unavailable', finished_at=now()); write_json(receipt_path, receipt)
        print('NO GPU: Cycles found no OptiX or CUDA device; nothing rendered (no CPU fallback).', flush=True)
        return 3
    receipt.update(device=kind, cycles_gpus=names)
    print(f'GPU {kind}: {names}', flush=True)

    views = [int(v) for v in a.views.split(',') if v.strip()]
    model_path = os.path.join(job, 'model.glb')
    why_model = finished_model(job, receipt.get('model')) if a.model else None
    need_model = why_model is not None
    if a.model and not need_model:
        m = receipt['model']
        print(f"SKIP model: verified export from {m.get('exported_at')} ({m.get('bytes')} bytes, {m.get('vertices')} vertices) -> {model_path}", flush=True)
        print('MODEL READY', model_path, flush=True)
    elif need_model and receipt.pop('model', None) is not None:
        print(f'RE-EXPORT model: {why_model}', flush=True)
    todo = []
    for v in views:
        why = finished_view(job, receipt['views'].get(str(v)), v)
        if why is None:
            info = receipt['views'][str(v)]
            print(f"SKIP view {v} ({VIEW_NAMES.get(v, v)}): verified GPU render from {info.get('rendered_at')} "
                  f"({info.get('render_seconds')} s, {info.get('device')}) -> {os.path.join(job, info['file'])}", flush=True)
        else:
            if receipt['views'].pop(str(v), None) is not None:
                print(f'RE-RENDER view {v} ({VIEW_NAMES.get(v, v)}): {why}', flush=True)
            todo.append(v)
    receipt['last_run'] = {'at': now(), 'rendered': todo, 'reused': [v for v in views if v not in todo]}
    if a.model: receipt['last_run']['model'] = 'exported' if need_model else 'reused'
    if todo or need_model:
        tmp = os.path.join(job, 'tmp'); os.makedirs(tmp, exist_ok=True)
        live = {'dev': '', 'last': None}

        def gpu_line(dev):
            return bool(re.match(rf'DEVICE {kind} \[.+\]', dev)) and 'CPU' not in dev.split(']')[0]

        def on_line(t, l):
            # Each view is checkpointed the moment Blender reports it (not when Blender exits), so a Colab disconnect
            # mid-job keeps every finished view and the next run reuses it. Only views from a verified GPU render count.
            if l.startswith('DEVICE ') and not live['dev']:
                live['dev'], live['last'] = l, t
                return
            mm = re.match(r'MODEL (\S+) (\d+) bytes (\d+) vertices', l)
            if mm and need_model and gpu_line(live['dev']) and os.path.isfile(mm.group(1)):
                # The geometry stage: checkpointed and announced before any view renders (the worker uploads it at once).
                if os.path.abspath(mm.group(1)) != model_path: shutil.move(mm.group(1), model_path)
                receipt['model'] = {'status': 'ok', 'file': 'model.glb', 'sha256': sha256(model_path), 'bytes': os.path.getsize(model_path),
                                    'vertices': int(mm.group(3)), 'exported_at': now(), 'contents': MODEL_CONTENTS}
                live['last'] = t
                write_json(receipt_path, receipt)
                print('MODEL READY', model_path, flush=True)
                return
            m = re.match(r'WROTE (.*dress_(\d+)\.png)$', l)
            if not m or not gpu_line(live['dev']) or not os.path.isfile(m.group(1)): return
            v = int(m.group(2)); dst = os.path.join(job, f'view_{v:02d}.png')
            shutil.move(m.group(1), dst)
            secs, live['last'] = round(t - live['last'], 1), t
            receipt['views'][str(v)] = {'status': 'ok', 'name': VIEW_NAMES.get(v, f'{v} deg'), 'file': os.path.basename(dst),
                                       'sha256': sha256(dst), 'render_seconds': secs, 'device': live['dev'], 'rendered_at': now()}
            receipt['render_device_line'] = live['dev']
            write_json(receipt_path, receipt)   # atomic (tmp + rename), after every view
            print(f'VIEW {v} ({VIEW_NAMES.get(v, v)}) {secs:.0f}s -> {dst}', flush=True)

        code, lines = run([a.blender, '-b', '--factory-startup', '-P', os.path.join(FACE, 'bl_run.py'), '--',
                           os.path.join(FACE, 'mpfb_dress.py')],
                          dict(env, OUT_DIR=tmp, VIEWS=','.join(map(str, todo)), CYCLES_DEVICE=kind,
                               **({'EXPORT_GLB': os.path.join(tmp, 'model.glb')} if need_model else {})), log, a.timeout, on_line)
        dev = live['dev'] or next((l for _, l in lines if l.startswith('DEVICE ')), '')
        receipt['render_device_line'] = dev
        receipt['checks'] = [l for _, l in lines if l.startswith('CHECK')]
        if any(l.startswith('CHECKS FAILED') for _, l in lines):
            receipt.update(status='checks_failed', finished_at=now()); write_json(receipt_path, receipt)
            print('CHECKS FAILED: nothing rendered; see receipt.json', flush=True); return 2
        if not gpu_line(dev):
            receipt.update(status='not_gpu', finished_at=now()); write_json(receipt_path, receipt)
            print(f'REFUSED: render did not report a {kind} GPU ({dev!r})', flush=True); return 4
        if code == 124:
            receipt.update(status='timeout', exit_code=code, finished_at=now()); write_json(receipt_path, receipt)
            print(f'TIMEOUT after {a.timeout} s: Blender was stopped; finished views are kept, rerun to resume', flush=True); return 4
        receipt['process_seconds'] = round(lines[-1][0], 1) if lines else None
        if need_model and finished_model(job, receipt.get('model')) is not None:
            receipt.update(status='model_failed', exit_code=code, finished_at=now()); write_json(receipt_path, receipt)
            print(f'MODEL FAILED (exit {code}): no verified model.glb from Blender; finished views are kept, rerun to resume', flush=True); return 4
        if code != 0 or any(str(v) not in receipt['views'] for v in todo):
            receipt.update(status='render_failed', exit_code=code, finished_at=now()); write_json(receipt_path, receipt)
            print(f'RENDER FAILED (exit {code}); finished views are kept, rerun to resume', flush=True); return 4
    receipt.update(status='complete', finished_at=now()); write_json(receipt_path, receipt)
    print('RECEIPT', receipt_path, flush=True)
    return 0


if __name__ == '__main__':
    sys.exit(main())

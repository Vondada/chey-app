"""CHE face preview and Creation Engine model job: one resumable job with an execution receipt.

  python3 scripts/che_gpu_face_preview.py --blender BLENDER --project DIR --out DIR
        [--views 0,45,90] [--device auto|OPTIX|CUDA|cpu] [--samples 64] [--res 480] [--settings settings.json] [--model]
        [--resume-model MODEL.glb --resume-sha SHA256]

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
- MODEL_MODE (a setting): full_body (the default for --model) | bust. full_body builds the clothed, rigged, animated
  character with tools/avatar_body/mpfb_body.py (STAGE model, rig, animate), re-reads the GLB with
  tools/avatar_body/verify_glb.py (STAGE verify; its RIG_RECEIPT becomes receipt.model.rig) and renders the views from
  that GLB with tools/avatar_body/render_glb.py (STAGE render), then saves the receipt (STAGE save). A full_body job is
  complete only with a verified rig (receipt.model.rig.ok). bust is the head-and-neck path above, unchanged.
  After the export: CHECKPOINT model|rig|animate <model.glb> <sha256> <bytes>; after the rig check: CHECKPOINT verify ...
  MODEL READY <path> is printed only for a verified full_body model.
- --resume-model/--resume-sha: a model from an earlier worker (CHE's checkpoint). When the file's sha256 matches it is
  reused (model, rig and animate are skipped; verify always runs again); otherwise the model is built again.
- --device cpu (CHE's GitHub CPU workers): Cycles on the CPU with one thread per core; the receipt says device CPU and
  every view's device line must start with "DEVICE CPU". A CPU job never reuses a GPU job's folder and vice versa.
Only job ids, stage and checkpoint lines are printed; identity settings stay in the receipt and the Blender log.
- Render profile and progressive previews (job settings from server/cloudflare/creation_profiles.js): RENDER_PROFILE
  (legacy | final, tools/avatar_body/render_profiles.py) is passed to the renders; PREVIEW=1 renders a quick look of
  every view still to render first (EEVEE when it can start, else 4-sample Cycles; its own process) and prints
  QUICK <view> <path> for each, so CHE shows the real model in seconds while the final views render. Quick looks are
  kept in the job folder (quick_<view>.png) and the receipt (quick_previews); they never count as finished views.
- EXPORT_ROBLOX=1 (a Roblox character): after the views, tools/avatar_body/roblox_export.py turns the verified GLB into
  an R15 FBX and walk clip, reads them back and validates them (receipt.roblox); EXPORT <format> <path> lines hand the
  files to the worker. Reused while the model's sha256 is unchanged; a failed export is recorded, not hidden.
Exit codes: 0 done, 2 checks failed (also a rig that fails verification), 3 no GPU, 4 render failed.
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
VIEW_NAMES = {0: 'front', 45: 'three-quarter', 90: 'side', 180: 'back'}
BODY = os.path.join(ROOT, 'tools', 'avatar_body')


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


def device_ok(dev, kind):
    """The render's DEVICE line names the device the job runs on: the CPU for a CPU job, else that GPU and no CPU."""
    if kind == 'CPU': return bool(re.match(r'DEVICE CPU\b', dev))
    return bool(re.match(rf'DEVICE {kind} \[.+\]', dev)) and 'CPU' not in dev.split(']')[0]


def finished_view(job, info, v, kind=None):
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
    if kind == 'CPU':
        if not device_ok(dev, 'CPU'): return f'recorded device is not this CPU job ({dev!r})'
        return None
    if not re.match(r'DEVICE (OPTIX|CUDA) \[.+\]', dev) or 'CPU' in dev.split(']')[0]:
        return f'recorded device is not a GPU ({dev!r})'
    return None


MODEL_CONTENTS = 'head-and-neck bust, eyes, hair cards; brows, lashes and strand hair are render-only'
BODY_CONTENTS = ('full-body clothed character (top, trousers, shoes), eyes, scalp-cap hair; 53-bone game_engine skeleton '
                 'with skin weights; clips idle, walk, run, wave, talk; face morphs blink_l, blink_r, mouth_open, smile, brows_up')


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


def rig_summary(rec):
    """The verify receipt as it goes in receipt.model.rig (no local paths)."""
    keep = ('ok', 'failures', 'bones', 'skins', 'required_bones_missing', 'vertices', 'skinned_vertices', 'max_joint_influences',
            'weighted_fraction', 'morphs', 'clips', 'motion', 'bpy_import', 'sha256', 'bytes', 'notes')
    return {k: rec[k] for k in keep if k in rec}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--blender', required=True); ap.add_argument('--project', required=True); ap.add_argument('--out', required=True)
    ap.add_argument('--views', default='0,45,90'); ap.add_argument('--device', default='auto', choices=['auto', 'OPTIX', 'CUDA', 'cpu'])
    ap.add_argument('--samples', type=int, default=64); ap.add_argument('--res', type=int, default=480)
    ap.add_argument('--settings'); ap.add_argument('--timeout', type=int, default=1800)
    ap.add_argument('--model', action='store_true', help='also export the 3D model (model.glb): full body by default')
    ap.add_argument('--resume-model', help='a model.glb from an earlier worker, reused when --resume-sha matches')
    ap.add_argument('--resume-sha', default='')
    a = ap.parse_args()

    settings = dict(DEFAULTS, **(json.load(open(a.settings)) if a.settings else {}))
    mode = (settings.get('MODEL_MODE') or 'full_body') if a.model else None
    if mode not in (None, 'full_body', 'bust'):
        print(f'UNKNOWN MODEL_MODE: only full_body and bust are built', flush=True); return 2
    cpu = a.device == 'cpu'
    inputs = {n: sha256(os.path.join(a.project, n)) for n in ('che.blend', 'fit.json')}
    tools_rev = subprocess.run(['git', '-C', ROOT, 'rev-parse', '--short', 'HEAD'], capture_output=True, text=True).stdout.strip() or 'unknown'
    # The job is named by what decides the pictures (face code, inputs, settings, samples, size), not by the date or the
    # commit, so rerunning tomorrow or after an unrelated commit reuses finished views instead of rendering them again.
    code = face_code_sha256()
    spec = {'inputs': inputs, 'settings': settings, 'samples': a.samples, 'res': a.res, 'face_code': code}
    if mode == 'bust': spec['model'] = 'glb'   # a model job is its own folder; plain preview jobs keep their names
    elif mode == 'full_body': spec['model'] = 'glb-full_body'; spec['body_code'] = body_code_sha256()
    if cpu: spec['device'] = 'cpu'
    key = json.dumps(spec, sort_keys=True)
    job_id = ('body-' if mode == 'full_body' else 'face-') + hashlib.sha256(key.encode()).hexdigest()[:12]
    job = os.path.join(a.out, job_id); os.makedirs(job, exist_ok=True)
    print('JOB', job, flush=True)
    log, receipt_path = os.path.join(job, 'log.txt'), os.path.join(job, 'receipt.json')
    receipt = json.load(open(receipt_path)) if os.path.exists(receipt_path) else {
        'job_id': job_id, 'created_at': now(), 'tools_commit': tools_rev, 'face_code_sha256': code, 'inputs_sha256': inputs, 'settings': settings,
        'samples': a.samples, 'long_edge_px': a.res, 'views': {}}
    receipt['resumed_at'] = now() if receipt.get('views') or receipt.get('model') else None
    try:
        smi = subprocess.run(['nvidia-smi', '--query-gpu=name,driver_version,memory.total', '--format=csv,noheader'],
                             capture_output=True, text=True)
        receipt['nvidia_smi'] = smi.stdout.strip() or f'unavailable: {smi.stderr.strip()[:200]}'
    except OSError as e:
        receipt['nvidia_smi'] = f'unavailable: {e}'
    receipt['blender_version'] = subprocess.run([a.blender, '--version'], capture_output=True, text=True).stdout.splitlines()[0]
    threads = os.cpu_count() or 1
    env = dict(os.environ, CHE=os.path.join(a.project, 'che.blend'), FIT=os.path.join(a.project, 'fit.json'),
               SAMPLES=str(a.samples), TEST_RES=str(a.res), **settings)
    env.pop('FORCE', None)   # previews always carry every check
    if not settings.get('IDENTITY'): env.pop('NOHAIR', None)   # an identity preset whose hair style is not built yet renders close-cropped
    if cpu: env['CPU_THREADS'] = str(threads)

    if cpu:
        # The project check still runs (Blender version, CHE's scene); no GPU is asked for and none is claimed.
        code_c, lines = run([a.blender, '-b', '--factory-startup', '-P', os.path.join(FACE, 'bl_run.py'), '--',
                             os.path.join(FACE, 'colab', 'check_project.py'), os.path.join(a.project, 'che.blend')],
                            dict(env, REQUIRE_GPU=''), log, 600)
        checks = [l for _, l in lines if l.startswith(('CHECK', 'DEVICES'))]
        kind, names = ('CPU', f'CPU ({threads} threads)') if code_c == 0 else (None, '')
    else:
        kind, names, checks = probe_gpu(a.blender, a.project, a.device, env, log)
    receipt['project_checks'] = checks
    if not kind:
        if cpu:
            receipt.update(status='checks_failed', finished_at=now()); write_json(receipt_path, receipt)
            print('CHECKS FAILED: the Blender/project check did not pass; see receipt.json', flush=True); return 2
        receipt.update(status='gpu_unavailable', finished_at=now()); write_json(receipt_path, receipt)
        print('NO GPU: Cycles found no OptiX or CUDA device; nothing rendered (no CPU fallback).', flush=True)
        return 3
    receipt.update(device=kind, cycles_gpus='' if cpu else names)
    if cpu: receipt.update(cores=threads, threads=threads)
    print(f'CPU: {names}' if cpu else f'GPU {kind}: {names}', flush=True)

    views = [int(v) for v in a.views.split(',') if v.strip()]
    if mode == 'full_body':
        return full_body(a, job, receipt, receipt_path, env, log, kind, views, threads)

    model_path = os.path.join(job, 'model.glb')
    why_model = finished_model(job, receipt.get('model')) if a.model else None
    need_model = why_model is not None
    if a.model and not need_model:
        m = receipt['model']
        print(f"SKIP model: verified export from {m.get('exported_at')} ({m.get('bytes')} bytes, {m.get('vertices')} vertices) -> {model_path}", flush=True)
        print('MODEL READY', model_path, flush=True)
    elif need_model and receipt.pop('model', None) is not None:
        print(f'RE-EXPORT model: {why_model}', flush=True)
    todo = views_todo(job, receipt, views, kind)
    receipt['last_run'] = {'at': now(), 'rendered': todo, 'reused': [v for v in views if v not in todo]}
    if a.model: receipt['last_run']['model'] = 'exported' if need_model else 'reused'
    if todo or need_model:
        tmp = os.path.join(job, 'tmp'); os.makedirs(tmp, exist_ok=True)
        live = {'dev': '', 'last': None}

        def on_line(t, l):
            # Each view is checkpointed the moment Blender reports it (not when Blender exits), so a Colab disconnect
            # mid-job keeps every finished view and the next run reuses it. Only views from a verified render count.
            if l.startswith('DEVICE ') and not live['dev']:
                live['dev'], live['last'] = l, t
                return
            mm = re.match(r'MODEL (\S+) (\d+) bytes (\d+) vertices', l)
            if mm and need_model and device_ok(live['dev'], kind) and os.path.isfile(mm.group(1)):
                # The geometry stage: checkpointed and announced before any view renders (the worker uploads it at once).
                if os.path.abspath(mm.group(1)) != model_path: shutil.move(mm.group(1), model_path)
                receipt['model'] = {'status': 'ok', 'mode': 'bust', 'file': 'model.glb', 'sha256': sha256(model_path),
                                    'bytes': os.path.getsize(model_path), 'vertices': int(mm.group(3)), 'exported_at': now(),
                                    'contents': MODEL_CONTENTS}
                live['last'] = t
                write_json(receipt_path, receipt)
                print('MODEL READY', model_path, flush=True)
                return
            view_line(l, t, job, receipt, receipt_path, live, kind)

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
        if not device_ok(dev, kind):
            receipt.update(status='not_gpu' if kind != 'CPU' else 'wrong_device', finished_at=now()); write_json(receipt_path, receipt)
            print(f'REFUSED: render did not report the {kind} device ({dev!r})', flush=True); return 4
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


def body_code_sha256():
    h = hashlib.sha256()
    base = os.path.join(ROOT, 'tools', 'avatar_body')
    for n in sorted(os.listdir(base)):
        if n.endswith('.py'): h.update(n.encode() + b'\0'); h.update(open(os.path.join(base, n), 'rb').read())
    return h.hexdigest()


def views_todo(job, receipt, views, kind):
    todo = []
    for v in views:
        why = finished_view(job, receipt['views'].get(str(v)), v, kind)
        if why is None:
            info = receipt['views'][str(v)]
            what = 'CPU render' if kind == 'CPU' else 'GPU render'
            print(f"SKIP view {v} ({VIEW_NAMES.get(v, v)}): verified {what} from {info.get('rendered_at')} "
                  f"({info.get('render_seconds')} s, {info.get('device')}) -> {os.path.join(job, info['file'])}", flush=True)
        else:
            if receipt['views'].pop(str(v), None) is not None:
                print(f'RE-RENDER view {v} ({VIEW_NAMES.get(v, v)}): {why}', flush=True)
            todo.append(v)
    return todo


def view_line(l, t, job, receipt, receipt_path, live, kind):
    """A WROTE line from a render: the view is moved into the job, hashed and checkpointed in the receipt at once."""
    if l.startswith('DEVICE ') and not live['dev']:
        live['dev'], live['last'] = l, t
        return
    m = re.match(r'WROTE (.*(?:dress|body|creation)_(\d+)\.png)$', l)   # creation_: scripts/che_creation_job.py
    if not m or not device_ok(live['dev'], kind) or not os.path.isfile(m.group(1)): return
    v = int(m.group(2)); dst = os.path.join(job, f'view_{v:02d}.png')
    shutil.move(m.group(1), dst)
    secs, live['last'] = round(t - (live['last'] or 0), 1), t
    receipt['views'][str(v)] = {'status': 'ok', 'name': VIEW_NAMES.get(v, f'{v} deg'), 'file': os.path.basename(dst),
                               'sha256': sha256(dst), 'render_seconds': secs, 'device': live['dev'], 'rendered_at': now()}
    receipt['render_device_line'] = live['dev']
    write_json(receipt_path, receipt)   # atomic (tmp + rename), after every view
    print(f'VIEW {v} ({VIEW_NAMES.get(v, v)}) {secs:.0f}s -> {dst}', flush=True)


def full_body(a, job, receipt, receipt_path, env, log, kind, views, threads):
    """model -> rig -> animate (one Blender run) -> verify (re-read the GLB) -> render (from the GLB) -> save."""
    model_path = os.path.join(job, 'model.glb'); tmp = os.path.join(job, 'tmp'); os.makedirs(tmp, exist_ok=True)
    timings = receipt.setdefault('stage_seconds', {})
    blender = [a.blender, '-b', '--factory-startup', '-P', os.path.join(FACE, 'bl_run.py'), '--']

    def fail(status, msg, code):
        receipt.update(status=status, finished_at=now()); write_json(receipt_path, receipt)
        print(msg, flush=True); return code

    def checkpoint(stage, path):
        print(f'CHECKPOINT {stage} {path} {sha256(path)} {os.path.getsize(path)}', flush=True)

    def record(path, vertices, source, rig_line=''):
        receipt['model'] = {'status': 'ok', 'mode': 'full_body', 'file': 'model.glb', 'sha256': sha256(path), 'bytes': os.path.getsize(path),
                            'vertices': vertices, 'exported_at': now(), 'source': source, 'contents': BODY_CONTENTS}
        if rig_line: receipt['model']['rig_line'] = rig_line
        write_json(receipt_path, receipt)

    # ── model, rig, animate ──────────────────────────────────────────────────────────────────────────────────────────
    resumed = a.resume_model and os.path.isfile(a.resume_model) and re.fullmatch(r'[0-9a-f]{64}', a.resume_sha or '') \
        and sha256(a.resume_model) == a.resume_sha
    why = finished_model(job, receipt.get('model'))
    if why is None and (receipt.get('model') or {}).get('mode') != 'full_body': why = 'the recorded model is not a full-body model'
    have = why is None
    if resumed:
        if os.path.abspath(a.resume_model) != model_path: shutil.copyfile(a.resume_model, model_path)
        record(model_path, (receipt.get('model') or {}).get('vertices'), 'resumed from a checkpoint')
        print(f'RESUME model: checkpoint sha256 matches ({os.path.getsize(model_path)} bytes); model, rig and animate are not built again', flush=True)
        build = False
    elif have:
        m = receipt['model']
        print(f"SKIP model: verified export from {m.get('exported_at')} ({m.get('bytes')} bytes, {m.get('vertices')} vertices) -> {model_path}", flush=True)
        build = False
    else:
        if a.resume_model: print('RESUME refused: the checkpoint model is missing or its sha256 does not match; building it again', flush=True)
        if receipt.pop('model', None) is not None: print(f'RE-EXPORT model: {why}', flush=True)
        build = True
    receipt['last_run'] = {'at': now(), 'model': 'exported' if build else ('resumed' if resumed else 'reused')}
    if build:
        seen = {'t': 0.0}

        def on_model(t, l):
            if re.fullmatch(r'STAGE (model|rig|animate)', l):
                st = l.split()[1]; print(l, flush=True)
                seen['stage'] = st; seen[st] = t
        t0 = time.monotonic()
        code, lines = run(blender + [os.path.join(BODY, 'mpfb_body.py')],
                          dict(env, EXPORT_GLB=os.path.join(tmp, 'model.glb'), VIEWS='', STRIPS='', OUT_DIR=tmp), log, a.timeout, on_model)
        total = round(time.monotonic() - t0, 1)
        marks = {k: seen[k] for k in ('model', 'rig', 'animate') if k in seen}
        ends = list(marks.values())[1:] + [lines[-1][0] if lines else total]
        for (k, st), en in zip(marks.items(), ends): timings[k] = round(en - st, 1)
        mm = next((re.match(r'MODEL (\S+) (\d+) bytes (\d+) vertices', l) for _, l in lines if l.startswith('MODEL ')), None)
        rig_line = next((l for _, l in lines if l.startswith('RIG ')), '')
        if code == 124: return fail('timeout', f'TIMEOUT after {a.timeout} s while building the model; rerun to resume', 4)
        if code != 0 or not mm or not os.path.isfile(mm.group(1)):
            return fail('model_failed', f'MODEL FAILED (exit {code}): no full-body model from Blender; see log.txt', 4)
        shutil.move(mm.group(1), model_path)
        record(model_path, int(mm.group(3)), 'built', rig_line)
        for st in ('model', 'rig', 'animate'): checkpoint(st, model_path)

    # ── verify: the file is re-read and its skeleton, clips, morphs and motion measured ──────────────────────────────
    print('STAGE verify', flush=True)
    t0 = time.monotonic()
    code, lines = run(blender + [os.path.join(BODY, 'verify_glb.py'), model_path], env, log, min(a.timeout, 600))
    timings['verify'] = round(time.monotonic() - t0, 1)
    line = next((l for _, l in reversed(lines) if l.startswith('RIG_RECEIPT ')), '')
    try: rec = json.loads(line[len('RIG_RECEIPT '):]) if line else {'ok': False, 'failures': [f'verify printed no receipt (exit {code})']}
    except ValueError: rec = {'ok': False, 'failures': ['verify receipt is not JSON']}
    rig = rig_summary(rec)
    if rig.get('sha256') and rig['sha256'] != receipt['model']['sha256']: rig.update(ok=False, failures=rig.get('failures', []) + ['verified a different file'])
    rig['ok'] = bool(rig.get('ok')) and code == 0
    receipt['model']['rig'] = rig
    if receipt['model'].get('vertices') is None: receipt['model']['vertices'] = rig.get('vertices')
    write_json(receipt_path, receipt)
    if not rig['ok']:
        receipt['model']['status'] = 'rig_failed'
        return fail('rig_failed', f"RIG FAILED: {'; '.join(rig.get('failures', []))[:300]}", 2)
    checkpoint('verify', model_path)
    clips = ','.join(f"{k} {v.get('duration_s')}s" for k, v in (rig.get('clips') or {}).items())
    print(f"RIG OK: {rig.get('bones')} bones, clips {clips}, morphs {','.join(rig.get('morphs') or [])}", flush=True)
    print('MODEL READY', model_path, flush=True)

    # ── render: the previews come from the verified GLB ──────────────────────────────────────────────────────────────
    todo = views_todo(job, receipt, views, kind)
    receipt['last_run'].update(rendered=todo, reused=[v for v in views if v not in todo])
    receipt['render_profile'] = env.get('RENDER_PROFILE', 'legacy')
    if todo:
        print('STAGE render', flush=True)
        if env.get('PREVIEW', '0') == '1': quick_looks(a, job, receipt, receipt_path, env, log, kind, todo, blender, tmp)
        live = {'dev': '', 'last': None}
        t0 = time.monotonic()
        code, lines = run(blender + [os.path.join(BODY, 'render_glb.py'), model_path],
                          dict(env, OUT_DIR=tmp, VIEWS=','.join(map(str, todo)), STRIPS='', CYCLES_DEVICE=kind),
                          log, a.timeout, lambda t, l: view_line(l, t, job, receipt, receipt_path, live, kind))
        timings['render'] = round(time.monotonic() - t0, 1)
        dev = live['dev'] or next((l for _, l in lines if l.startswith('DEVICE ')), '')
        receipt['render_device_line'] = dev
        if not device_ok(dev, kind):
            return fail('not_gpu' if kind != 'CPU' else 'wrong_device', f'REFUSED: render did not report the {kind} device ({dev!r})', 4)
        if code == 124: return fail('timeout', f'TIMEOUT after {a.timeout} s: finished views are kept, rerun to resume', 4)
        if code != 0 or any(str(v) not in receipt['views'] for v in todo):
            receipt['exit_code'] = code
            return fail('render_failed', f'RENDER FAILED (exit {code}); finished views are kept, rerun to resume', 4)
    print('STAGE save', flush=True)
    if env.get('EXPORT_ROBLOX') == '1': roblox(a, job, receipt, receipt_path, env, log, blender, model_path)
    receipt.update(status='complete', finished_at=now()); write_json(receipt_path, receipt)
    print('RECEIPT', receipt_path, flush=True)
    return 0


def quick_looks(a, job, receipt, receipt_path, env, log, kind, todo, blender, tmp):
    """The progressive preview: every view still to render gets a fast quick look first (render_glb.py RENDER_PROFILE
    preview), printed as QUICK <view> <path> so the worker shows it in CHE at once. EEVEE is tried first when asked
    (PREVIEW_ENGINE auto or eevee) in its own process, because Blender aborts outright where it has no OpenGL/EGL
    context; then the 4-sample Cycles quick look. A quick look that fails never fails the job: the final views follow."""
    quick = receipt.setdefault('quick_previews', {})
    want = [v for v in todo if str(v) not in quick or not os.path.isfile(os.path.join(job, f'quick_{v:02d}.png'))]
    if not want: return
    engines = (['eevee', 'cycles'] if env.get('PREVIEW_ENGINE', 'auto') in ('auto', 'eevee') else ['cycles'])
    for engine in engines:
        seen = {'t': 0.0}

        def on_line(t, l, engine=engine):
            m = re.match(r'PREVIEW_WROTE (.*preview_(-?\d+)\.png)$', l)
            if m and os.path.isfile(m.group(1)):
                v = int(m.group(2)); dst = os.path.join(job, f'quick_{v:02d}.png'); shutil.move(m.group(1), dst)
                quick[str(v)] = {'engine': engine, 'seconds': round(t - seen['t'], 1), 'sha256': sha256(dst), 'at': now()}
                seen['t'] = t; write_json(receipt_path, receipt)
                print(f'QUICK {v} {dst}', flush=True)
        code, _ = run(blender + [os.path.join(BODY, 'render_glb.py'), os.path.join(job, 'model.glb')],
                      dict(env, OUT_DIR=tmp, VIEWS=','.join(map(str, want)), STRIPS='', CYCLES_DEVICE=kind, RENDER_PROFILE='preview', PREVIEW_ENGINE=engine),
                      log, min(a.timeout, 600), on_line)
        want = [v for v in want if str(v) not in quick]
        if not want: return
        print(f'QUICK LOOK {engine} unavailable here (exit {code}); ' + ('trying the Cycles quick look' if engine == 'eevee' else 'the final views follow'), flush=True)


def roblox(a, job, receipt, receipt_path, env, log, blender, model_path):
    """The Roblox Studio export (roblox_export.py) from the verified GLB, reused while the model's sha256 is the same.
    Prints EXPORT <format> <path> for each file so the worker stores it in CHE. A failed export is recorded and said;
    the character itself is still complete."""
    out = os.path.join(job, 'roblox'); have = receipt.get('roblox') or {}
    files = {'fbx_r15': os.path.join(out, 'character_r15.fbx'), 'fbx_r15_walk': os.path.join(out, 'walk_r15.fbx')}
    if have.get('model_sha256') == receipt['model']['sha256'] and have.get('ok') and all(os.path.isfile(p) for p in files.values()):
        print('SKIP roblox: verified export of this model already made', flush=True)
    else:
        print('ROBLOX export: R15 skeleton, 15 parts, triangle budget', flush=True)
        code, lines = run(blender + [os.path.join(BODY, 'roblox_export.py'), model_path], dict(env, OUT_DIR=out, CLIP='walk'), log, min(a.timeout, 900))
        line = next((l for _, l in reversed(lines) if l.startswith('ROBLOX_RECEIPT ')), '')
        try: rec = json.loads(line[len('ROBLOX_RECEIPT '):]) if line else {'ok': False, 'failures': [f'export printed no receipt (exit {code})']}
        except ValueError: rec = {'ok': False, 'failures': ['export receipt is not JSON']}
        rec.pop('measured', None)
        have = dict(rec, model_sha256=receipt['model']['sha256'], exit_code=code)
        receipt['roblox'] = have; write_json(receipt_path, receipt)
        print(f"ROBLOX {'OK' if have.get('ok') else 'FAILED'}: {have.get('triangles_total')} triangles; "
              + ('; '.join(have.get('failures', []))[:300] or 'Studio import ready, not Marketplace ready'), flush=True)
    if have.get('ok'):
        for fmt, p in files.items():
            if os.path.isfile(p): print(f'EXPORT {fmt} {p}', flush=True)


if __name__ == '__main__':
    sys.exit(main())

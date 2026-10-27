"""CHE Creation Engine job for Create Object and Create Room: one resumable job with an execution receipt.

  python3 scripts/che_creation_job.py --kind object_model|room_model|invention_model --blender BLENDER --out DIR --settings settings.json
        [--views 0,45,90] [--device auto|OPTIX|CUDA|cpu] [--samples 32] [--res 480] [--project DIR]
        [--resume-model MODEL.glb --resume-sha SHA256]

settings.json holds SPEC: the object or room spec as JSON text (tools/avatar_body/creation_params.py), the same one
CHE's Worker validated (server/cloudflare/creation_objects.js). It is validated again here; a spec the builders refuse
stops the job with exit 2 before Blender runs.

Stages, each printed as STAGE <name> for the worker to report:
- model: tools/avatar_body/objects.py or rooms.py builds the procedural model in Blender and exports model.glb
  (CHECKPOINT model <path> <sha256> <bytes>). A model verified in this job folder, or a --resume-model whose sha256
  matches CHE's checkpoint, is reused.
- verify: tools/avatar_body/verify_glb.py --static re-reads the GLB and measures meshes, triangles, materials and the
  bounding box in metres against the size the spec asks for (receipt.model.verify). A model that fails is not
  complete (exit 2). Then CHECKPOINT verify and MODEL READY <path> (the worker uploads it at once).
- render: tools/avatar_body/render_creation.py renders the previews from the GLB (WROTE .../creation_<deg>.png);
  each view is hashed and checkpointed in the receipt with its DEVICE line, as in che_gpu_face_preview.py.
- save: the receipt is complete.
Devices: --device cpu (GitHub CPU workers) renders on the CPU and every view's device line must say CPU; otherwise the
GPU is probed with the face project's check (--project) and nothing falls back to the CPU in silence (exit 3).
Only job ids, stage and checkpoint lines are printed. Exit codes: 0 done, 2 spec or verify failed, 3 no GPU, 4 failed.
"""
import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'scripts')); sys.path.insert(0, os.path.join(ROOT, 'tools', 'avatar_body'))
from che_gpu_face_preview import (FACE, device_ok, finished_model, now, probe_gpu, run, sha256, view_line,  # noqa: E402
                                  views_todo, write_json)
import creation_params as P  # noqa: E402
import cc0_textures  # noqa: E402

BODY = os.path.join(ROOT, 'tools', 'avatar_body')
BUILDER = {'object_model': 'objects.py', 'room_model': 'rooms.py', 'invention_model': 'inventions.py'}
CODE = ('creation_params.py', 'objects.py', 'rooms.py', 'inventions.py', 'render_creation.py', 'render_profiles.py', 'verify_glb.py', 'cc0_textures.py')


def code_sha256():
    """One hash over the code that decides the model and its pictures."""
    h = hashlib.sha256()
    for n in CODE + ('../avatar_face/render_device.py',):
        p = os.path.normpath(os.path.join(BODY, n)); h.update(n.encode() + b'\0'); h.update(open(p, 'rb').read())
    return h.hexdigest()


def verify_summary(rec):
    keep = ('ok', 'failures', 'meshes', 'primitives', 'vertices', 'triangles', 'materials', 'primitives_without_material',
            'bbox_m', 'expected_bbox_m', 'tolerance', 'bpy_import', 'sha256', 'bytes')
    return {k: rec[k] for k in keep if k in rec}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--kind', required=True, choices=sorted(BUILDER)); ap.add_argument('--blender', required=True)
    ap.add_argument('--out', required=True); ap.add_argument('--settings', required=True); ap.add_argument('--project', default='')
    ap.add_argument('--views', default='0,45,90'); ap.add_argument('--device', default='auto', choices=['auto', 'OPTIX', 'CUDA', 'cpu'])
    ap.add_argument('--samples', type=int, default=32); ap.add_argument('--res', type=int, default=480)
    ap.add_argument('--timeout', type=int, default=1800)
    ap.add_argument('--resume-model'); ap.add_argument('--resume-sha', default='')
    a = ap.parse_args()

    settings = json.load(open(a.settings))
    try:
        spec = P.validate(a.kind, P.parse(settings.get('SPEC', '')))
    except P.SpecError as e:
        print(f'SPEC FAILED: {e}', flush=True); return 2
    cpu = a.device == 'cpu'
    code = code_sha256()
    key = json.dumps({'kind': a.kind, 'spec': spec, 'samples': a.samples, 'res': a.res, 'code': code, 'device': 'cpu' if cpu else 'gpu'}, sort_keys=True)
    job_id = a.kind.split('_')[0] + '-' + hashlib.sha256(key.encode()).hexdigest()[:12]
    job = os.path.join(a.out, job_id); os.makedirs(job, exist_ok=True)
    print('JOB', job, flush=True)
    log, receipt_path = os.path.join(job, 'log.txt'), os.path.join(job, 'receipt.json')
    receipt = json.load(open(receipt_path)) if os.path.exists(receipt_path) else {
        'job_id': job_id, 'kind': a.kind, 'created_at': now(), 'creation_code_sha256': code, 'spec': spec,
        'samples': a.samples, 'long_edge_px': a.res, 'views': {}}
    receipt['resumed_at'] = now() if receipt.get('views') or receipt.get('model') else None
    try:
        smi = subprocess.run(['nvidia-smi', '--query-gpu=name,driver_version,memory.total', '--format=csv,noheader'], capture_output=True, text=True)
        receipt['nvidia_smi'] = smi.stdout.strip() or f'unavailable: {smi.stderr.strip()[:200]}'
    except OSError as e:
        receipt['nvidia_smi'] = f'unavailable: {e}'
    receipt['blender_version'] = (subprocess.run([a.blender, '--version'], capture_output=True, text=True).stdout.splitlines() or ['unknown'])[0]
    threads = os.cpu_count() or 1
    spec_json = json.dumps(spec, separators=(',', ':'))
    env = dict(os.environ, SPEC_JSON=spec_json, SAMPLES=str(a.samples), TEST_RES=str(a.res), CREATION_KIND=a.kind.split('_')[0])
    # The render profile the Creation Engine chose (creation_profiles.js); a quick look never stands in for a view here.
    env['RENDER_PROFILE'] = settings.get('RENDER_PROFILE') if settings.get('RENDER_PROFILE') in ('legacy', 'final') else 'legacy'
    if cpu: env['CPU_THREADS'] = str(threads)
    if cpu:
        kind, names = 'CPU', f'CPU ({threads} threads)'
    else:
        kind, names, checks = probe_gpu(a.blender, a.project, a.device, env, log) if os.path.isfile(os.path.join(a.project, 'che.blend')) \
            else (None, '', ['no project to probe the GPU with'])
        receipt['project_checks'] = checks
        if not kind:
            receipt.update(status='gpu_unavailable', finished_at=now()); write_json(receipt_path, receipt)
            print('NO GPU: Cycles found no OptiX or CUDA device; nothing rendered (no CPU fallback).', flush=True); return 3
    receipt.update(device=kind, cycles_gpus='' if cpu else names)
    if cpu: receipt.update(cores=threads, threads=threads)
    print(f'CPU: {names}' if cpu else f'GPU {kind}: {names}', flush=True)
    blender = [a.blender, '-b', '--factory-startup', '-P', os.path.join(FACE, 'bl_run.py'), '--']
    timings = receipt.setdefault('stage_seconds', {})
    model_path = os.path.join(job, 'model.glb'); tmp = os.path.join(job, 'tmp'); os.makedirs(tmp, exist_ok=True)
    mode = a.kind.split('_')[0]

    def fail(status, msg, code_):
        receipt.update(status=status, finished_at=now()); write_json(receipt_path, receipt)
        print(msg, flush=True); return code_

    def checkpoint(stage):
        print(f'CHECKPOINT {stage} {model_path} {sha256(model_path)} {os.path.getsize(model_path)}', flush=True)

    # ── model ────────────────────────────────────────────────────────────────────────────────────────────────────
    resumed = bool(a.resume_model and os.path.isfile(a.resume_model) and re.fullmatch(r'[0-9a-f]{64}', a.resume_sha or '')
                   and sha256(a.resume_model) == a.resume_sha)
    why = finished_model(job, receipt.get('model'))
    if why is None and (receipt.get('model') or {}).get('mode') != mode: why = f'the recorded model is not a {mode} model'
    if resumed:
        if os.path.abspath(a.resume_model) != model_path: shutil.copyfile(a.resume_model, model_path)
        old = receipt.get('model') or {}
        receipt['model'] = {'status': 'ok', 'mode': mode, 'file': 'model.glb', 'sha256': sha256(model_path), 'bytes': os.path.getsize(model_path),
                            'vertices': old.get('vertices'), 'exported_at': now(), 'source': 'resumed from a checkpoint',
                            'contents': P.describe(a.kind, spec)}
        print(f'RESUME model: checkpoint sha256 matches ({os.path.getsize(model_path)} bytes); the model is not built again', flush=True)
        build = False
    elif why is None:
        m = receipt['model']
        print(f"SKIP model: verified export from {m.get('exported_at')} ({m.get('bytes')} bytes) -> {model_path}", flush=True)
        build = False
    else:
        if a.resume_model: print('RESUME refused: the checkpoint model is missing or its sha256 does not match; building it again', flush=True)
        if receipt.pop('model', None) is not None: print(f'RE-EXPORT model: {why}', flush=True)
        build = True
    receipt['last_run'] = {'at': now(), 'model': 'exported' if build else ('resumed' if resumed else 'reused')}
    if build:
        print('STAGE model', flush=True)
        # CC0 textures at job time (cc0_textures.py: Poly Haven, CC0 1.0), verified by the API's md5 and cached by
        # SHA-256; a material that could not be fetched is recorded with its reason and built in plain colour.
        wanted = P.textures_wanted(a.kind, spec)
        tex = cc0_textures.fetch(wanted) if wanted else {}
        if tex:
            receipt['textures'] = cc0_textures.receipt_view(tex)
            for m, r in tex.items():
                print(f"TEXTURE {m} {'ok ' + r['asset_id'] + ' ' + r['maps']['diffuse']['sha256'][:16] + (' cached' if r.get('cached') else ' fetched') if r['status'] == 'ok' else 'unavailable: ' + r['reason'][:120]}", flush=True)
        env['TEXTURES_JSON'] = json.dumps({m: {k: v['path'] for k, v in r['maps'].items()} for m, r in tex.items() if r['status'] == 'ok'})
        t0 = time.monotonic()
        code_, lines = run(blender + [os.path.join(BODY, BUILDER[a.kind])], dict(env, EXPORT_GLB=os.path.join(tmp, 'model.glb')), log, a.timeout)
        timings['model'] = round(time.monotonic() - t0, 1)
        if code_ == 124: return fail('timeout', f'TIMEOUT after {a.timeout} s while building the model; rerun to resume', 4)
        if any(l.startswith('SPEC FAILED') for _, l in lines): return fail('checks_failed', 'SPEC FAILED in Blender; see receipt.json', 2)
        mm = next((re.match(r'MODEL (\S+) (\d+) bytes (\d+) vertices', l) for _, l in lines if l.startswith('MODEL ')), None)
        if code_ != 0 or not mm or not os.path.isfile(mm.group(1)):
            return fail('model_failed', f'MODEL FAILED (exit {code_}): no model from Blender; see log.txt', 4)
        shutil.move(mm.group(1), model_path)
        layout = next((l[len('LAYOUT '):] for _, l in lines if l.startswith('LAYOUT ')), '')
        receipt['model'] = {'status': 'ok', 'mode': mode, 'file': 'model.glb', 'sha256': sha256(model_path), 'bytes': os.path.getsize(model_path),
                            'vertices': int(mm.group(3)), 'exported_at': now(), 'source': 'built', 'contents': P.describe(a.kind, spec)}
        if layout:
            try: receipt['model']['layout'] = json.loads(layout)
            except ValueError: pass
        write_json(receipt_path, receipt)
        checkpoint('model')

    # ── verify: the exported file is re-read and measured ──────────────────────────────────────────────────────────
    print('STAGE verify', flush=True)
    bbox, tol = P.expected_bbox(a.kind, spec)
    t0 = time.monotonic()
    code_, lines = run(blender + [os.path.join(BODY, 'verify_glb.py'), model_path, '--static', '--expect-bbox', ','.join(map(str, bbox)),
                                  '--tolerance', str(tol)], env, log, min(a.timeout, 600))
    timings['verify'] = round(time.monotonic() - t0, 1)
    line = next((l for _, l in reversed(lines) if l.startswith('GLB_RECEIPT ')), '')
    try: rec = json.loads(line[len('GLB_RECEIPT '):]) if line else {'ok': False, 'failures': [f'verify printed no receipt (exit {code_})']}
    except ValueError: rec = {'ok': False, 'failures': ['verify receipt is not JSON']}
    ver = verify_summary(rec)
    if ver.get('sha256') and ver['sha256'] != receipt['model']['sha256']: ver.update(ok=False, failures=ver.get('failures', []) + ['verified a different file'])
    ver['ok'] = bool(ver.get('ok')) and code_ == 0
    receipt['model']['verify'] = ver
    write_json(receipt_path, receipt)
    if not ver['ok']:
        receipt['model']['status'] = 'verify_failed'
        return fail('verify_failed', f"VERIFY FAILED: {'; '.join(ver.get('failures', []))[:300]}", 2)
    checkpoint('verify')
    size = ver.get('bbox_m', {}).get('size', [])
    print(f"VERIFIED: {ver.get('meshes')} meshes, {ver.get('triangles')} triangles, {len(ver.get('materials') or [])} materials, "
          f"{' x '.join(f'{x:.2f}' for x in size)} m", flush=True)
    print('MODEL READY', model_path, flush=True)

    # ── render: the previews come from the verified GLB ──────────────────────────────────────────────────────────
    views = [int(v) for v in a.views.split(',') if v.strip()]
    todo = views_todo(job, receipt, views, kind)
    receipt['last_run'].update(rendered=todo, reused=[v for v in views if v not in todo])
    if todo:
        print('STAGE render', flush=True)
        live = {'dev': '', 'last': None}
        t0 = time.monotonic()
        code_, lines = run(blender + [os.path.join(BODY, 'render_creation.py'), model_path],
                           dict(env, OUT_DIR=tmp, VIEWS=','.join(map(str, todo)), CYCLES_DEVICE=kind),
                           log, a.timeout, lambda t, l: view_line(l, t, job, receipt, receipt_path, live, kind))
        timings['render'] = round(time.monotonic() - t0, 1)
        dev = live['dev'] or next((l for _, l in lines if l.startswith('DEVICE ')), '')
        receipt['render_device_line'] = dev
        if not device_ok(dev, kind):
            return fail('not_gpu' if kind != 'CPU' else 'wrong_device', f'REFUSED: render did not report the {kind} device ({dev!r})', 4)
        if code_ == 124: return fail('timeout', f'TIMEOUT after {a.timeout} s: finished views are kept, rerun to resume', 4)
        if code_ != 0 or any(str(v) not in receipt['views'] for v in todo):
            receipt['exit_code'] = code_
            return fail('render_failed', f'RENDER FAILED (exit {code_}); finished views are kept, rerun to resume', 4)
    print('STAGE save', flush=True)
    receipt.update(status='complete', finished_at=now()); write_json(receipt_path, receipt)
    print('RECEIPT', receipt_path, flush=True)
    return 0


if __name__ == '__main__':
    sys.exit(main())

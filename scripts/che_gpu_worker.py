"""CHE GPU worker for an open Colab session: renders queued face-preview requests, one job each, until idle.

  python3 scripts/che_gpu_worker.py --blender BL --project DIR --out DRIVE/jobs --assets CLONE_OF_che-gpu-assets
        [--poll 60] [--idle-minutes 45] [--once]

Requests are JSON files in `queue/` on the `che-gpu-assets` branch, written by Claude:
  {"id": "v7-brows", "views": "0,45,90", "settings": {"BROW_W": "1.8"}, "samples": 64, "res": 480, "note": "..."}
`settings` overrides the face defaults in che_gpu_face_preview.py. Rules:
- Runs only inside a Colab session the owner opened; it never starts or extends a session. With nothing new to do for
  --idle-minutes it exits, so it does not hold the GPU.
- Each request runs once. Its outcome is kept in DRIVE/worker_done.json; a finished request is never rendered again,
  an interrupted one resumes (the job runner skips verified views).
- Results go up with che_gpu_push_results.py when RESULTS_TOKEN is set; otherwise they stay in Drive.
- No GPU (runner exit 3) stops the worker: nothing renders on the CPU.
Exit codes: 0 idle or --once finished, 3 no GPU.
"""
import argparse
import datetime
import json
import os
import subprocess
import sys
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MAX_TRIES = 2


def now():
    return datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def load(path, default):
    try:
        with open(path) as f: return json.load(f)
    except (OSError, ValueError):
        return default


def save(path, data):
    tmp = path + '.tmp'
    with open(tmp, 'w') as f: json.dump(data, f, indent=1)
    os.replace(tmp, path)


def requests(assets):
    """Queued requests, oldest name first; files that are not valid requests are reported and ignored."""
    qdir = os.path.join(assets, 'queue'); out = []
    for name in sorted(os.listdir(qdir)) if os.path.isdir(qdir) else []:
        if not name.endswith('.json'): continue
        req = load(os.path.join(qdir, name), None)
        if not isinstance(req, dict) or not str(req.get('id', '')).strip() or not isinstance(req.get('settings', {}), dict):
            print(f'IGNORED queue/{name}: not a request', flush=True); continue
        out.append(req)
    return out


def run_request(req, a, log):
    """Run one request through the job runner; returns (exit code, job folder or None)."""
    with tempfile.NamedTemporaryFile('w', suffix='.json', delete=False) as f:
        json.dump({k: str(v) for k, v in req.get('settings', {}).items()}, f); settings = f.name
    cmd = [sys.executable, os.path.join(ROOT, 'scripts', 'che_gpu_face_preview.py'), '--blender', a.blender,
           '--project', a.project, '--out', a.out, '--views', str(req.get('views', '0,45,90')),
           '--samples', str(int(req.get('samples', 64))), '--res', str(int(req.get('res', 480))), '--settings', settings]
    job = None
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    for line in p.stdout:
        print(line, end='', flush=True); log.write(line)
        if line.startswith('JOB '): job = line[4:].strip()
    code = p.wait(); os.unlink(settings)
    return code, job


def push(job):
    if not os.environ.get('RESULTS_TOKEN'):
        return 'not pushed (no RESULTS_TOKEN); saved in Drive'
    r = subprocess.run([sys.executable, os.path.join(ROOT, 'scripts', 'che_gpu_push_results.py'), '--job', job],
                       capture_output=True, text=True)
    return (r.stdout + r.stderr).strip().splitlines()[-1] if (r.stdout + r.stderr).strip() else f'push exit {r.returncode}'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--blender', required=True); ap.add_argument('--project', required=True); ap.add_argument('--out', required=True)
    ap.add_argument('--assets', required=True); ap.add_argument('--poll', type=int, default=60)
    ap.add_argument('--idle-minutes', type=float, default=45); ap.add_argument('--once', action='store_true')
    a = ap.parse_args()
    base = os.path.dirname(os.path.normpath(a.out))
    done_path, status_path = os.path.join(base, 'worker_done.json'), os.path.join(base, 'worker_status.json')
    done = load(done_path, {})
    idle_since = time.monotonic()
    with open(os.path.join(base, 'worker_log.txt'), 'a') as log:
        log.write(f'\n== worker started {now()}\n')
        while True:
            pulled = subprocess.run(['git', '-C', a.assets, 'pull', '-q', '--ff-only'], capture_output=True, text=True)
            if pulled.returncode:
                print('QUEUE PULL FAILED (using the last copy):', pulled.stderr.strip()[-300:], flush=True)
            todo = [r for r in requests(a.assets)
                    if done.get(r['id'], {}).get('status') != 'complete' and done.get(r['id'], {}).get('tries', 0) < MAX_TRIES]
            save(status_path, {'at': now(), 'state': 'working' if todo else 'idle', 'pending': [r['id'] for r in todo]})
            for req in todo:
                rid = req['id']; print(f'REQUEST {rid}: {req.get("note", "")}', flush=True)
                code, job = run_request(req, a, log)
                entry = done.setdefault(rid, {'tries': 0}); entry['tries'] += 1
                entry.update(at=now(), exit=code, job=os.path.basename(job) if job else None,
                             status={0: 'complete', 2: 'checks_failed', 3: 'gpu_unavailable'}.get(code, 'render_failed'))
                if job and code in (0, 2, 4): entry['push'] = push(job)
                save(done_path, done)
                print(f'RESULT {rid}: {entry["status"]} (exit {code}); {entry.get("push", "")}', flush=True)
                if code == 3:
                    print('NO GPU: stopping the worker; nothing renders on the CPU.', flush=True); return 3
                if code == 2:
                    entry['tries'] = MAX_TRIES   # a failed face check repeats exactly; wait for a new request
                    save(done_path, done)
                idle_since = time.monotonic()
            if a.once:
                return 0
            if not todo and time.monotonic() - idle_since > a.idle_minutes * 60:
                save(status_path, {'at': now(), 'state': 'stopped_idle', 'pending': []})
                print(f'IDLE {a.idle_minutes:g} min: worker stopped so the GPU is released. Run this cell again to resume.', flush=True)
                return 0
            time.sleep(a.poll)


if __name__ == '__main__':
    sys.exit(main())

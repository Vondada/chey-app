"""CHE GPU worker for a Colab session the owner opened: works CHE's render queue (server/cloudflare/gpu_queue.js).

  CHE_GPU_TOKEN=... python3 scripts/che_gpu_worker.py --che-url https://chey-app.henryjavoni.workers.dev \\
        --blender BL --project DIR --out DRIVE/CHE_GPU/jobs [--poll 30] [--idle-minutes 45] [--once]

The queue lives in CHE's Cloudflare Worker, so jobs survive Colab disconnects. This script:
- reports the GPU (nvidia-smi) with every claim and heartbeat; without a GPU it is handed nothing;
- claims one job at a time (paused jobs first, so a job cut off by a disconnect resumes), heartbeats every 30 s to
  keep its lease, and reports progress per view;
- renders through scripts/che_gpu_face_preview.py, which writes pictures, log and receipt to Google Drive and reuses
  every view already verified there, so resuming never renders finished work again;
- uploads each finished view's PNG into CHE's media library (the Creation Room) and reports the receipt; the Worker
  marks the job completed only with a GPU receipt and every picture;
- stops when the owner cancels the job, and exits after --idle-minutes with nothing to do so the GPU is released.
It never starts, extends or keeps alive a Colab session: it runs only while the owner's session runs.
Exit codes: 0 idle or --once done, 3 no GPU, 5 no CHE_GPU_TOKEN.
"""
import argparse
import datetime
import hashlib
import json
import os
import re
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HEARTBEAT_S = 30


def now():
    return datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def gpu_name():
    try:
        r = subprocess.run(['nvidia-smi', '--query-gpu=name,driver_version,memory.total', '--format=csv,noheader'],
                           capture_output=True, text=True, timeout=20)
        return r.stdout.strip() or f'unavailable: {r.stderr.strip()[:120]}'
    except (OSError, subprocess.TimeoutExpired) as e:
        return f'unavailable: {e}'


class Che:
    """The worker's side of /api/gpu/worker/*. The token goes only in the X-CHE-GPU-Token header and is never printed."""

    def __init__(self, base, token, worker_id, gpu, blender):
        self.base, self.token, self.worker_id, self.gpu, self.blender = base.rstrip('/'), token, worker_id, gpu, blender

    def call(self, route, body=None, data=None, query='', method='POST', tries=4):
        url = f'{self.base}/api/gpu/worker/{route}{query}'
        payload = data if data is not None else json.dumps(dict(body or {}, worker_id=self.worker_id, gpu=self.gpu, blender=self.blender)).encode()
        headers = {'X-CHE-GPU-Token': self.token, 'Content-Type': 'image/png' if data is not None else 'application/json'}
        for attempt in range(tries):
            try:
                with urllib.request.urlopen(urllib.request.Request(url, data=payload, headers=headers, method=method), timeout=60) as r:
                    return json.loads(r.read() or b'{}')
            except urllib.error.HTTPError as e:
                try: return dict(json.loads(e.read() or b'{}'), http_status=e.code)
                except ValueError: return {'ok': False, 'http_status': e.code}
            except (urllib.error.URLError, OSError, ValueError) as e:
                if attempt == tries - 1: return {'ok': False, 'detail': f'CHE unreachable: {str(e)[:120]}'}
                time.sleep(2 ** attempt)


def run_job(che, job, a, log):
    """Render one claimed job; returns (runner exit code, job folder, receipt or None, stopped_by_owner)."""
    with tempfile.NamedTemporaryFile('w', suffix='.json', delete=False) as f:
        json.dump(job.get('settings') or {}, f); settings = f.name
    cmd = [sys.executable, os.path.join(ROOT, 'scripts', 'che_gpu_face_preview.py'), '--blender', a.blender,
           '--project', a.project, '--out', a.out, '--views', ','.join(str(v) for v in job['views']),
           '--samples', str(job.get('samples', 64)), '--res', str(job.get('res', 480)), '--settings', settings]
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    stop = threading.Event(); state = {'stopped': False, 'done': []}

    def beat():
        while not stop.wait(HEARTBEAT_S):
            r = che.call('heartbeat', {'job_id': job['id'], 'state': 'rendering'})
            if r.get('stop'):
                state['stopped'] = True; print(f"STOPPING: {r.get('reason', 'the owner stopped this job')}", flush=True)
                p.terminate(); return
    t = threading.Thread(target=beat, daemon=True); t.start()
    folder = None
    for line in p.stdout:
        print(line, end='', flush=True); log.write(line)
        if line.startswith('JOB '): folder = line[4:].strip()
        m = re.match(r'(?:VIEW|SKIP view) (-?\d+) \(([^)]*)\)', line)
        if m:
            state['done'].append(int(m.group(1)))
            che.call('progress', {'job_id': job['id'], 'views_done': state['done'], 'message': line.strip()[:200]})
        elif line.startswith('GPU '):
            che.call('progress', {'job_id': job['id'], 'views_done': state['done'], 'message': f'Rendering on {line[4:].strip()}'[:200]})
    code = p.wait(); stop.set(); os.unlink(settings)
    receipt = None
    if folder and os.path.exists(os.path.join(folder, 'receipt.json')):
        with open(os.path.join(folder, 'receipt.json')) as f: receipt = json.load(f)
    return code, folder, receipt, state['stopped']


def upload_previews(che, job, folder, receipt):
    sent = 0
    for v, info in (receipt or {}).get('views', {}).items():
        path = os.path.join(folder, info.get('file', ''))
        if info.get('status') != 'ok' or not os.path.isfile(path): continue
        with open(path, 'rb') as f: data = f.read()
        r = che.call('preview', data=data, method='PUT', query=f"?worker={che.worker_id}&job={job['id']}&view={v}")
        print(f"PREVIEW view {v}: {'saved to the Creation Room' if r.get('ok') else r.get('detail', r)}", flush=True)
        sent += bool(r.get('ok'))
    return sent


def push_to_github(folder):
    if not os.environ.get('RESULTS_TOKEN'): return
    r = subprocess.run([sys.executable, os.path.join(ROOT, 'scripts', 'che_gpu_push_results.py'), '--job', folder], capture_output=True, text=True)
    out = (r.stdout + r.stderr).strip().splitlines()
    print('GITHUB:', out[-1] if out else f'exit {r.returncode}', flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--che-url', required=True); ap.add_argument('--blender', required=True); ap.add_argument('--project', required=True)
    ap.add_argument('--out', required=True); ap.add_argument('--poll', type=float, default=30); ap.add_argument('--idle-minutes', type=float, default=45)
    ap.add_argument('--once', action='store_true'); ap.add_argument('--gpu', help='override the nvidia-smi name (tests)')
    a = ap.parse_args()
    token = os.environ.get('CHE_GPU_TOKEN', '').strip()
    if not token:
        print('NO CHE_GPU_TOKEN: create the worker token in CHE (Creation Room, GPU jobs, "Pair Colab") and save it as a Colab secret.', flush=True)
        return 5
    gpu = a.gpu or gpu_name()
    blender = (subprocess.run([a.blender, '--version'], capture_output=True, text=True).stdout.splitlines() or ['unknown'])[0]
    worker_id = 'colab-' + hashlib.sha256(f'{socket.gethostname()}{time.time()}'.encode()).hexdigest()[:10]
    che = Che(a.che_url, token, worker_id, gpu, blender)
    print(f'WORKER {worker_id} on {gpu} with {blender}', flush=True)
    base = os.path.dirname(os.path.normpath(a.out)); os.makedirs(a.out, exist_ok=True)
    idle_since = time.monotonic()
    with open(os.path.join(base, 'worker_log.txt'), 'a') as log:
        log.write(f'\n== worker {worker_id} started {now()} on {gpu}\n')
        while True:
            c = che.call('claim', {'state': 'claiming'})
            if c.get('http_status') == 404:
                print('CHE refused the worker token (not paired, or replaced). Create a new one in CHE and update the Colab secret.', flush=True); return 5
            if not c.get('ok'):
                print('CLAIM:', c.get('detail', c), flush=True)
                if 'No GPU' in str(c.get('detail', '')): return 3
            job = c.get('job') if c.get('ok') else None
            if job:
                print(f"{'RESUME' if c.get('resumed') else 'JOB'} {job['id']}: {job['title']}", flush=True)
                code, folder, receipt, stopped = run_job(che, job, a, log)
                if stopped:
                    print(f"STOPPED {job['id']}: the owner cancelled it; finished views stay in Drive.", flush=True)
                else:
                    if folder and receipt: upload_previews(che, job, folder, receipt)
                    status = {0: 'complete', 2: 'checks_failed', 3: 'gpu_unavailable'}.get(code, 'render_failed')
                    drive = folder.replace('/content/drive/MyDrive', 'My Drive') if folder else None
                    r = che.call('complete', {'job_id': job['id'], 'status': status, 'receipt': receipt, 'drive_path': drive,
                                              'error': f'job runner exit {code}' if code not in (0, 3) else ''})
                    print(f"RESULT {job['id']}: {(r.get('job') or {}).get('state', r.get('detail', r))} (runner exit {code})", flush=True)
                    if folder and code in (0, 2, 4): push_to_github(folder)
                    if code == 3:
                        print('NO GPU in this session: stopping; nothing renders on the CPU.', flush=True); return 3
                idle_since = time.monotonic()
                if a.once: return 0
                continue
            che.call('heartbeat', {'state': 'idle'})
            if a.once: return 0
            if time.monotonic() - idle_since > a.idle_minutes * 60:
                print(f'IDLE {a.idle_minutes:g} min: worker stopped so the GPU is released. Run the cell again to resume.', flush=True)
                return 0
            time.sleep(a.poll)


if __name__ == '__main__':
    sys.exit(main())

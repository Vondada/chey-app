"""CHE Creation Engine worker: works CHE's render queue (server/cloudflare/gpu_queue.js) on a Colab GPU the owner
opened, or on a GitHub-hosted CPU runner CHE started itself (.github/workflows/che-creation-worker.yml).

  CHE_GPU_TOKEN=... python3 scripts/che_gpu_worker.py --che-url https://chey-app.henryjavoni.workers.dev \\
        --blender BL --project DIR --out DRIVE/CHE_GPU/jobs [--poll 30] [--idle-minutes 45] [--once]
  python3 scripts/che_gpu_worker.py --auth oidc --worker-class github_cpu ...   (inside GitHub Actions; no secret)

Two worker classes:
- colab_t4: the owner's Colab session, authenticated with the paired CHE_GPU_TOKEN; renders on the GPU only.
- github_cpu: a GitHub Actions runner. It authenticates with a short-lived GitHub OIDC ID token (audience
  che-creation-engine) that CHE's Worker verifies against GitHub's keys, so no secret is stored anywhere. It renders on
  the CPU and its receipt says CPU. The repository is public, so its logs are public: this worker prints job ids and
  stage lines only, never a job's title, settings or any token.

The queue lives in CHE's Cloudflare Worker, so jobs survive Colab disconnects. This script:
- reports the GPU (nvidia-smi) with every claim and heartbeat; without a GPU it is handed nothing;
- claims one job at a time (paused jobs first, so a job cut off by a disconnect resumes), heartbeats every 30 s to
  keep its lease, and reports progress per view;
- renders through scripts/che_gpu_face_preview.py, which writes pictures, log and receipt to Google Drive and reuses
  every view already verified there, so resuming never renders finished work again;
- streams results while the runner works: each view's PNG goes into CHE's media library (the Creation Room) the moment
  it is verified, and for the Live Studio's person_model jobs the 3D model (model.glb) goes up the moment Blender
  exports it, before any view renders; then it reports the receipt. The Worker marks the job completed only with a GPU
  receipt and every picture (and, for person_model, the model);
- stops when the owner cancels the job, and exits after --idle-minutes with nothing to do so the GPU is released.
It never starts, extends or keeps alive a Colab session: it runs only while the owner's session runs.
Checkpoints: the runner prints CHECKPOINT <stage> <path> <sha256> <bytes> after the model export and after the rig
check; this worker reports each to CHE, so a job that loses its worker resumes on the next compatible one from the last
verified stage: the uploaded model is downloaded, its sha256 checked, and the finished stages are skipped.
Exit codes: 0 idle or --once done, 3 no GPU (colab_t4), 5 no credential.
"""
import argparse
import datetime
import hashlib
import json
import os
import re
import signal
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
OIDC_AUDIENCE = 'che-creation-engine'
OIDC_REFRESH_S = 240          # GitHub ID tokens are short-lived: fetch a fresh one every 4 minutes


def now():
    return datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def cpu_info():
    cores = os.cpu_count() or 1
    try:
        with open('/proc/meminfo') as f: kb = int(re.search(r'MemTotal:\s+(\d+)', f.read()).group(1))
        ram = round(kb / 1048576, 1)
    except (OSError, AttributeError, ValueError):
        ram = None
    return cores, ram


class OidcToken:
    """A GitHub Actions OIDC ID token for CHE's Worker, refreshed before it expires. Inside GitHub Actions only
    (needs `permissions: id-token: write`); the token is never printed."""

    def __init__(self, audience=OIDC_AUDIENCE):
        self.url = os.environ.get('ACTIONS_ID_TOKEN_REQUEST_URL', '')
        self.req = os.environ.get('ACTIONS_ID_TOKEN_REQUEST_TOKEN', '')
        self.audience, self.value, self.at = audience, '', 0.0

    def available(self):
        return bool(self.url and self.req)

    def get(self):
        if self.value and time.monotonic() - self.at < OIDC_REFRESH_S: return self.value
        sep = '&' if '?' in self.url else '?'
        r = urllib.request.Request(f'{self.url}{sep}audience={self.audience}', headers={'Authorization': f'bearer {self.req}'})
        with urllib.request.urlopen(r, timeout=30) as resp: self.value = json.loads(resp.read())['value']
        self.at = time.monotonic()
        return self.value


def gpu_name():
    try:
        r = subprocess.run(['nvidia-smi', '--query-gpu=name,driver_version,memory.total', '--format=csv,noheader'],
                           capture_output=True, text=True, timeout=20)
        return r.stdout.strip() or f'unavailable: {r.stderr.strip()[:120]}'
    except (OSError, subprocess.TimeoutExpired) as e:
        return f'unavailable: {e}'


class Che:
    """The worker's side of /api/gpu/worker/*. The token goes only in the X-CHE-GPU-Token header and is never printed."""

    def __init__(self, base, token, worker_id, gpu, blender, oidc=None, info=None):
        self.base, self.token, self.worker_id, self.gpu, self.blender = base.rstrip('/'), token, worker_id, gpu, blender
        self.oidc, self.info = oidc, dict(info or {})

    def auth(self):
        if self.oidc: return {'Authorization': f'Bearer {self.oidc.get()}'}
        return {'X-CHE-GPU-Token': self.token}

    def fetch(self, route, query=''):
        """GET bytes from a worker route (the model of a job being resumed); None when CHE has none."""
        url = f'{self.base}/api/gpu/worker/{route}{query}'
        for attempt in range(3):
            try:
                with urllib.request.urlopen(urllib.request.Request(url, headers=self.auth()), timeout=120) as r: return r.read()
            except urllib.error.HTTPError:
                return None
            except (urllib.error.URLError, OSError):
                time.sleep(2 ** attempt)
        return None

    def call(self, route, body=None, data=None, query='', method='POST', tries=4, content_type='image/png'):
        url = f'{self.base}/api/gpu/worker/{route}{query}'
        payload = data if data is not None else json.dumps(dict(self.info, **(body or {}), worker_id=self.worker_id, gpu=self.gpu, blender=self.blender)).encode()
        for attempt in range(tries):
            try:
                headers = dict(self.auth(), **{'Content-Type': content_type if data is not None else 'application/json'})
                with urllib.request.urlopen(urllib.request.Request(url, data=payload, headers=headers, method=method), timeout=60) as r:
                    return json.loads(r.read() or b'{}')
            except urllib.error.HTTPError as e:
                try: return dict(json.loads(e.read() or b'{}'), http_status=e.code)
                except ValueError: return {'ok': False, 'http_status': e.code}
            except (urllib.error.URLError, OSError, ValueError, KeyError) as e:
                if attempt == tries - 1: return {'ok': False, 'detail': f'CHE unreachable: {str(e)[:120]}'}
                time.sleep(2 ** attempt)


def stop_group(p, grace=10.0):
    """Stop the runner and everything it started (Blender): SIGTERM the group, SIGKILL it after `grace` s, reap."""
    for sig in (signal.SIGTERM, signal.SIGKILL):
        try: os.killpg(p.pid, sig)
        except (ProcessLookupError, PermissionError): pass
        try:
            p.wait(timeout=grace); break
        except subprocess.TimeoutExpired:
            continue
    try: os.killpg(p.pid, signal.SIGKILL)   # Blender may outlive the runner it belonged to
    except (ProcessLookupError, PermissionError): pass


def send_preview(che, job, v, path, sent):
    """One finished view's PNG into CHE's media library, once per job run (the Live Studio shows it as it arrives)."""
    if v in sent or not os.path.isfile(path): return
    with open(path, 'rb') as f: data = f.read()
    r = che.call('preview', data=data, method='PUT', query=f"?worker={che.worker_id}&job={job['id']}&view={v}")
    print(f"PREVIEW view {v}: {'saved to the Creation Room' if r.get('ok') else r.get('detail', r)}", flush=True)
    if r.get('ok'): sent.add(v)


def send_model(che, job, path, state):
    """The 3D model (GLB) into CHE as soon as Blender exports it: the Live Studio's viewport loads the real geometry
    while the views are still rendering."""
    if state.get('model_sent') or not os.path.isfile(path): return
    with open(path, 'rb') as f: data = f.read()
    r = che.call('model', data=data, method='PUT', query=f"?worker={che.worker_id}&job={job['id']}", content_type='model/gltf-binary')
    print(f"MODEL UPLOAD: {'saved to the Live Studio' if r.get('ok') else r.get('detail', r)} ({len(data)} bytes)", flush=True)
    state['model_sent'] = bool(r.get('ok')); state['model_path'] = path


def run_job(che, job, a, log):
    """Render one claimed job; returns (runner exit code, job folder, receipt or None, stopped_by_owner, streamed).
    Results stream to CHE while the runner works: the model the moment it is exported, each view the moment it is
    verified (or reused from Drive). `streamed` says what already arrived, so nothing is uploaded twice."""
    with tempfile.NamedTemporaryFile('w', suffix='.json', delete=False) as f:
        json.dump(job.get('settings') or {}, f); settings = f.name
    cmd = [sys.executable, os.path.join(ROOT, 'scripts', 'che_gpu_face_preview.py'), '--blender', a.blender,
           '--project', a.project, '--out', a.out, '--views', ','.join(str(v) for v in job['views']),
           '--samples', str(job.get('samples', 64)), '--res', str(job.get('res', 480)), '--settings', settings]
    if job.get('kind') == 'person_model': cmd.append('--model')   # the Live Studio's jobs also export the 3D model
    if a.worker_class == 'github_cpu': cmd += ['--device', 'cpu']
    resume = resume_model(che, job, a)
    if resume: cmd += ['--resume-model', resume[0], '--resume-sha', resume[1]]
    # Its own process group, so stopping the job stops Blender too (Blender is the runner's child, not ours).
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, start_new_session=True)
    stop = threading.Event(); state = {'stopped': False, 'done': [], 'sent': set(), 'model_sent': False}

    def beat():
        while not stop.wait(HEARTBEAT_S):
            r = che.call('heartbeat', {'job_id': job['id'], 'state': 'rendering'})
            if r.get('stop'):
                state['stopped'] = True; print(f"STOPPING: {r.get('reason', 'the owner stopped this job')}", flush=True)
                stop_group(p); return
    t = threading.Thread(target=beat, daemon=True); t.start()
    folder = None
    for line in p.stdout:
        print(line, end='', flush=True); log.write(line)
        if line.startswith('JOB '): folder = line[4:].strip()
        m = re.match(r'(?:VIEW|SKIP view) (-?\d+) \(([^)]*)\).* -> (.+)$', line.strip())
        if m:
            state['done'].append(int(m.group(1)))
            che.call('progress', {'job_id': job['id'], 'views_done': state['done'], 'message': line.strip()[:200]})
            if not state['stopped']: send_preview(che, job, int(m.group(1)), m.group(3), state['sent'])
        elif line.startswith('MODEL READY '):
            che.call('progress', {'job_id': job['id'], 'views_done': state['done'], 'message': 'Geometry ready: the 3D model was exported.'})
            if not state['stopped']: send_model(che, job, line[len('MODEL READY '):].strip(), state)
        elif line.startswith('CHECKPOINT '):
            parts = line.split()
            if len(parts) >= 5 and re.fullmatch(r'[0-9a-f]{64}', parts[3]):
                che.call('progress', {'job_id': job['id'], 'views_done': state['done'], 'message': f'Checkpoint: {parts[1]} verified.',
                                      'checkpoint': {'stage': parts[1], 'sha256': parts[3], 'bytes': int(parts[4]) if parts[4].isdigit() else None}})
        elif line.startswith('STAGE '):
            che.call('progress', {'job_id': job['id'], 'views_done': state['done'], 'stage': line[6:].strip()[:40],
                                  'message': f'Stage: {line[6:].strip()}'[:200]})
        elif line.startswith('GPU '):
            che.call('progress', {'job_id': job['id'], 'views_done': state['done'], 'message': f'Rendering on {line[4:].strip()}'[:200]})
    code = p.wait(); stop.set(); os.unlink(settings)
    receipt = None
    if folder and os.path.exists(os.path.join(folder, 'receipt.json')):
        with open(os.path.join(folder, 'receipt.json')) as f: receipt = json.load(f)
    return code, folder, receipt, state['stopped'], state


def resume_model(che, job, a):
    """A job resumed after its worker was lost: fetch the model CHE already holds and hand the runner its verified
    sha256, so model, rig and animation are not built again. Returns (path, sha256) or None."""
    cp = ((job.get('checkpoints') or {}).get('model') or {}) if isinstance(job.get('checkpoints'), dict) else {}
    sha = cp.get('sha256') or ''
    if job.get('kind') != 'person_model' or not job.get('model_url') or not re.fullmatch(r'[0-9a-f]{64}', sha): return None
    data = che.fetch('model', f"?worker={che.worker_id}&job={job['id']}")
    if not data or hashlib.sha256(data).hexdigest() != sha:
        print(f"RESUME {job['id']}: the saved model did not match its checkpoint; building it again.", flush=True); return None
    path = os.path.join(tempfile.mkdtemp(prefix='che-resume-'), 'model.glb')
    with open(path, 'wb') as f: f.write(data)
    print(f"RESUME {job['id']}: reusing the verified model ({len(data)} bytes).", flush=True)
    return path, sha


def upload_previews(che, job, folder, receipt, streamed=None):
    """What did not stream while the runner worked (a failed upload, an older runner): every verified view, and the
    model for a person_model job, before the outcome is reported."""
    streamed = streamed if streamed is not None else {'sent': set(), 'model_sent': False}
    for v, info in (receipt or {}).get('views', {}).items():
        if info.get('status') == 'ok': send_preview(che, job, int(v), os.path.join(folder, info.get('file', '')), streamed['sent'])
    if job.get('kind') == 'person_model' and (receipt or {}).get('model', {}).get('status') == 'ok':
        send_model(che, job, os.path.join(folder, receipt['model'].get('file', 'model.glb')), streamed)
    return len(streamed['sent'])


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
    ap.add_argument('--auth', choices=['token', 'oidc'], default='token', help='oidc: a GitHub Actions ID token, no secret')
    ap.add_argument('--worker-class', choices=['colab_t4', 'github_cpu'], default='colab_t4')
    a = ap.parse_args()
    token, oidc = os.environ.get('CHE_GPU_TOKEN', '').strip(), None
    if a.auth == 'oidc':
        oidc = OidcToken()
        if not oidc.available():
            print('NO OIDC: this worker needs GitHub Actions with "permissions: id-token: write".', flush=True); return 5
    elif not token:
        print('NO CHE_GPU_TOKEN: create the worker token in CHE (Creation Room, GPU jobs, "Pair Colab") and save it as a Colab secret.', flush=True)
        return 5
    cores, ram = cpu_info()
    if a.worker_class == 'github_cpu':
        gpu = a.gpu or f'CPU ({cores} cores)'
        worker_id = f"gha-{os.environ.get('GITHUB_RUN_ID', '0')}-{os.environ.get('GITHUB_RUN_ATTEMPT', '1')}"
    else:
        gpu = a.gpu or gpu_name()
        worker_id = 'colab-' + hashlib.sha256(f'{socket.gethostname()}{time.time()}'.encode()).hexdigest()[:10]
    blender = (subprocess.run([a.blender, '--version'], capture_output=True, text=True).stdout.splitlines() or ['unknown'])[0]
    info = {'class': a.worker_class, 'device': 'cpu' if a.worker_class == 'github_cpu' else 'gpu', 'cores': cores, 'ram_gb': ram}
    che = Che(a.che_url, token, worker_id, gpu, blender, oidc=oidc, info=info)
    public = a.worker_class == 'github_cpu'   # a public repository's Actions log: ids and stages only
    print(f'WORKER {worker_id} ({a.worker_class}) on {gpu} with {blender}', flush=True)
    base = os.path.dirname(os.path.normpath(a.out)); os.makedirs(a.out, exist_ok=True)
    idle_since = time.monotonic()
    with open(os.path.join(base, 'worker_log.txt'), 'a') as log:
        log.write(f'\n== worker {worker_id} started {now()} on {gpu}\n')
        while True:
            c = che.call('claim', {'state': 'claiming'})
            if c.get('http_status') in (401, 403, 404):
                if oidc: print(f"CHE refused this runner's GitHub identity: {c.get('detail', c.get('http_status'))}", flush=True); return 5
                print('CHE refused the worker token (not paired, or replaced). Create a new one in CHE and update the Colab secret.', flush=True); return 5
            if not c.get('ok'):
                print('CLAIM:', c.get('detail', c), flush=True)
                if 'No GPU' in str(c.get('detail', '')) and not public: return 3
            job = c.get('job') if c.get('ok') else None
            if job:
                print(f"{'RESUME' if c.get('resumed') else 'JOB'} {job['id']}" + ('' if public else f": {job['title']}"), flush=True)
                code, folder, receipt, stopped, streamed = run_job(che, job, a, log)
                if stopped:
                    print(f"STOPPED {job['id']}: the owner cancelled it; finished views stay in Drive.", flush=True)
                else:
                    if folder and receipt: upload_previews(che, job, folder, receipt, streamed)
                    status = {0: 'complete', 2: 'checks_failed', 3: 'gpu_unavailable'}.get(code, 'render_failed')
                    drive = folder.replace('/content/drive/MyDrive', 'My Drive') if folder else None
                    r = che.call('complete', {'job_id': job['id'], 'status': status, 'receipt': receipt, 'drive_path': drive,
                                              'error': f'job runner exit {code}' if code not in (0, 3) else ''})
                    print(f"RESULT {job['id']}: {(r.get('job') or {}).get('state', r.get('detail', r))} (runner exit {code})", flush=True)
                    if folder and code in (0, 2, 4): push_to_github(folder)
                    if code == 3 and not public:
                        print('NO GPU in this session: stopping; nothing renders on the CPU.', flush=True); return 3
                idle_since = time.monotonic()
                if a.once: return 0
                continue
            che.call('heartbeat', {'state': 'idle'})
            if a.once: return 0
            if time.monotonic() - idle_since > a.idle_minutes * 60:
                print(f'IDLE {a.idle_minutes:g} min: worker stopped so the ' + ('runner is released; CHE starts a new one when there is work.' if public else 'GPU is released. Run the cell again to resume.'), flush=True)
                return 0
            time.sleep(a.poll)


if __name__ == '__main__':
    sys.exit(main())

"""End-to-end tests for scripts/che_gpu_worker.py against CHE's real GPU queue code (server/cloudflare/gpu_queue.js,
served locally by tools/gpu_queue_dev_server.mjs) and the stand-in Blender from test_che_gpu_face_preview.py:
claim -> progress -> previews -> GPU receipt -> completed; a Colab disconnect pauses and the next session resumes
without re-rendering finished views; the owner's cancel stops it; no GPU means nothing is claimed.

  python3 -m unittest tools/test_che_gpu_worker.py
"""
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_che_gpu_face_preview import FAKE  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORKER = os.path.join(ROOT, 'scripts', 'che_gpu_worker.py')
RUNNER = os.path.join(ROOT, 'scripts', 'che_gpu_face_preview.py')
# The stand-in Blender, slowed down: it records its pid and sleeps FAKE_SLEEP seconds after each finished view, like a
# real render between views (Codex review of PR #517: checkpointing, timeouts and cancelling while Blender still runs).
SLOW = FAKE.replace("print('WROTE', p, flush=True)",
                    "print('WROTE', p, flush=True); import time; time.sleep(float(os.environ.get('FAKE_SLEEP', '0')))")
SLOW = SLOW.replace("a = sys.argv\n", "a = sys.argv\npf = os.environ.get('FAKE_PIDFILE')\nif pf and any(x.endswith('mpfb_dress.py') for x in a): open(pf, 'w').write(str(os.getpid()))\n", 1)
assert 'FAKE_SLEEP' in SLOW and 'FAKE_PIDFILE' in SLOW


def alive(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    # a zombie (exited, not yet reaped by its parent) counts as gone
    try:
        return open(f'/proc/{pid}/stat').read().split(')')[-1].split()[0] != 'Z'
    except OSError:
        return True


class RenderProcessTest(unittest.TestCase):
    """The job runner while Blender is still running: views are kept as they finish, the deadline holds, and stopping
    a job stops Blender too."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.blender = os.path.join(self.tmp, 'blender')
        open(self.blender, 'w').write(SLOW); os.chmod(self.blender, os.stat(self.blender).st_mode | stat.S_IEXEC)
        self.project = os.path.join(self.tmp, 'project'); os.makedirs(self.project)
        for n in ('che.blend', 'fit.json'): open(os.path.join(self.project, n), 'w').write(n)
        self.out = os.path.join(self.tmp, 'out'); self.calls = os.path.join(self.tmp, 'calls'); self.pidfile = os.path.join(self.tmp, 'blender.pid')
        self.env = dict(os.environ, FAKE_GPUS='OPTIX,CUDA', FAKE_CALLS=self.calls, FAKE_PIDFILE=self.pidfile)

    def runner(self, *args, **env):
        return subprocess.Popen([sys.executable, RUNNER, '--blender', self.blender, '--project', self.project, '--out', self.out, *args],
                                env=dict(self.env, **env), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, start_new_session=True)

    def receipt(self):
        jobs = os.listdir(self.out) if os.path.isdir(self.out) else []
        path = os.path.join(self.out, jobs[0], 'receipt.json') if jobs else ''
        try:
            return json.load(open(path)) if path and os.path.exists(path) else None
        except ValueError:
            return None

    def blender_pid(self):
        deadline = time.time() + 10
        while not os.path.exists(self.pidfile) and time.time() < deadline: time.sleep(0.05)
        return int(open(self.pidfile).read())

    def test_a_finished_view_is_saved_with_its_receipt_while_blender_still_renders(self):
        p = self.runner(FAKE_SLEEP='30')
        try:
            deadline, r = time.time() + 15, None
            while time.time() < deadline:
                r = self.receipt()
                if r and '0' in r.get('views', {}): break
                time.sleep(0.1)
            self.assertIsNone(p.poll(), 'the runner must still be rendering the next view')
            self.assertEqual(r['views']['0']['status'], 'ok'); self.assertIn('Tesla T4', r['views']['0']['device'])
            job = os.path.join(self.out, os.listdir(self.out)[0])
            self.assertTrue(os.path.isfile(os.path.join(job, 'view_00.png')))
        finally:
            os.killpg(p.pid, 9); p.wait()   # Colab disconnects here
            try: os.kill(self.blender_pid(), 9)
            except ProcessLookupError: pass
        # the next session renders only the views that were not finished
        open(self.calls, 'w').close()
        q = self.runner(); out = q.communicate(timeout=60)[0]
        self.assertEqual(q.returncode, 0, out)
        self.assertIn('SKIP view 0', out); self.assertEqual(open(self.calls).read().split(), ['45,90'])

    def test_the_timeout_stops_a_silent_blender_and_keeps_finished_views(self):
        t0 = time.time()
        p = self.runner('--timeout', '3', FAKE_SLEEP='60'); out = p.communicate(timeout=30)[0]
        self.assertLess(time.time() - t0, 20, 'the deadline must hold while Blender prints nothing')
        self.assertEqual(p.returncode, 4, out); self.assertIn('TIMEOUT', out)
        r = self.receipt(); self.assertEqual(r['status'], 'timeout'); self.assertIn('0', r['views'])
        self.assertFalse(alive(self.blender_pid()), 'Blender must be stopped, not left rendering')

    def test_stopping_a_job_stops_blender_too(self):
        sys.path.insert(0, os.path.join(ROOT, 'scripts'))
        import che_gpu_worker
        p = self.runner(FAKE_SLEEP='60')
        try:
            bpid = self.blender_pid(); self.assertTrue(alive(bpid))
            che_gpu_worker.stop_group(p, grace=3)
            self.assertIsNotNone(p.poll())
            deadline = time.time() + 5
            while alive(bpid) and time.time() < deadline: time.sleep(0.05)
            self.assertFalse(alive(bpid), 'the cancelled job left Blender rendering')
        finally:
            try: os.killpg(p.pid, 9)
            except ProcessLookupError: pass

GPU = 'Tesla T4, 550.54.15, 15360 MiB'


@unittest.skipUnless(shutil.which('node'), 'node is needed to serve the real queue code')
class GpuWorkerTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.blender = os.path.join(self.tmp, 'blender')
        open(self.blender, 'w').write(FAKE); os.chmod(self.blender, os.stat(self.blender).st_mode | stat.S_IEXEC)
        self.project = os.path.join(self.tmp, 'project'); os.makedirs(self.project)
        for n in ('che.blend', 'fit.json'): open(os.path.join(self.project, n), 'w').write(n)
        self.out = os.path.join(self.tmp, 'drive', 'CHE_GPU', 'jobs')
        self.calls = os.path.join(self.tmp, 'calls')
        self.server = subprocess.Popen(['node', os.path.join(ROOT, 'tools', 'gpu_queue_dev_server.mjs')], stdout=subprocess.PIPE, text=True)
        info = json.loads(self.server.stdout.readline()); self.url = f"http://127.0.0.1:{info['port']}"; self.token = info['token']

    def tearDown(self):
        self.server.kill(); self.server.wait()

    def api(self, path, body=None):
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(self.url + path, data=data, headers={'Content-Type': 'application/json'}, method='GET' if body is None else 'POST')
        with urllib.request.urlopen(req) as r: return json.loads(r.read() or b'{}')

    def work(self, *args, token=None, gpu=GPU, **env):
        e = dict(os.environ, **dict({'FAKE_GPUS': 'OPTIX,CUDA', 'FAKE_CALLS': self.calls, 'CHE_GPU_TOKEN': self.token if token is None else token}, **env))
        e.pop('RESULTS_TOKEN', None)
        p = subprocess.run([sys.executable, WORKER, '--che-url', self.url, '--blender', self.blender, '--project', self.project,
                            '--out', self.out, '--poll', '0', '--gpu', gpu, *args], env=e, capture_output=True, text=True, timeout=120)
        return p.returncode, p.stdout + p.stderr

    def job(self):
        # the first seeded look (photoreal) is the one a worker claims first
        return next(j for j in self.api('/api/gpu')['jobs'] if (j.get('settings') or {}).get('STYLE') == 'photoreal')

    def calls_made(self):
        return open(self.calls).read().split() if os.path.exists(self.calls) else []

    def test_the_seeded_face_job_renders_once_with_previews_and_completes(self):
        self.assertEqual(self.job()['state'], 'queued')
        code, out = self.work('--once')
        self.assertEqual(code, 0, out)
        self.assertIn("RESULT", out); self.assertIn('completed', out)
        for v in (0, 45, 90): self.assertIn(f'PREVIEW view {v}: saved to the Creation Room', out)
        j = self.job()
        self.assertEqual(j['state'], 'completed'); self.assertEqual(j['progress']['pct'], 100)
        self.assertEqual(sorted(j['previews']), ['0', '45', '90'])
        self.assertIn("DEVICE OPTIX ['Tesla T4']", j['receipt']['views']['0']['device'])
        self.assertTrue(j['drive_path'].startswith(self.out) or 'CHE_GPU/jobs/face-' in j['drive_path'])
        self.assertEqual(self.job()['settings']['BROW_W'], '1.8')
        first = j['id']
        for _ in range(2):                                    # the hybrid and stylized looks are their own jobs
            code, out = self.work('--once')
            self.assertNotIn(first, out, 'the finished photoreal job never renders again')
        looks = {x['settings']['STYLE']: x for x in self.api('/api/gpu')['jobs']}
        self.assertEqual({k: v['state'] for k, v in looks.items()}, {'photoreal': 'completed', 'hybrid': 'completed', 'stylized': 'completed'})
        self.assertEqual(len({v['drive_path'] for v in looks.values()}), 3, 'each look has its own content-named job folder')
        code, out = self.work('--once')                       # nothing left: the next run renders nothing
        self.assertNotIn('JOB gpu_', out); self.assertEqual(self.calls_made(), ['0,45,90'] * 3)

    def test_disconnect_pauses_and_the_next_session_resumes_without_redoing_finished_views(self):
        # A session that dies after the front view: the runner stops mid-job and no outcome reaches CHE.
        code, out = self.work('--once', FAKE_STOP_AFTER='1')
        self.assertIn('RESULT', out)                            # the runner failed (exit 4): one failure counted
        self.assertEqual(self.job()['state'], 'queued')
        # The next session: only the missing views render; the front view is reused from Drive.
        code, out = self.work('--once')
        self.assertEqual(self.job()['state'], 'completed', out)
        self.assertEqual(self.calls_made(), ['0,45,90', '45,90'])

    def test_a_lapsed_lease_reads_paused_and_is_resumed_first(self):
        self.api('/api/gpu/jobs', {'title': 'later', 'views': [0], 'settings': {'IRIS': '2'}})
        claimed = json.loads(urllib.request.urlopen(urllib.request.Request(
            self.url + '/api/gpu/worker/claim', data=json.dumps({'worker_id': 'colab-dead', 'gpu': GPU}).encode(),
            headers={'X-CHE-GPU-Token': self.token, 'Content-Type': 'application/json'}, method='POST')).read())
        self.api('/__advance', {'ms': 4 * 60_000})               # the Colab tab closed: no heartbeat for 4 minutes
        states = {j['id']: j['state'] for j in self.api('/api/gpu')['jobs']}
        self.assertEqual(states[claimed['job']['id']], 'paused')
        code, out = self.work('--once')
        self.assertIn(f"RESUME {claimed['job']['id']}", out)
        states = {j['id']: j['state'] for j in self.api('/api/gpu')['jobs']}
        self.assertEqual(states[claimed['job']['id']], 'completed')

    def test_no_gpu_claims_nothing(self):
        code, out = self.work('--once', gpu='unavailable: [Errno 2] No such file or directory: nvidia-smi')
        self.assertEqual(code, 3); self.assertIn('No GPU', out)
        self.assertEqual(self.job()['state'], 'queued'); self.assertEqual(self.calls_made(), [])

    def test_a_wrong_token_is_refused_and_no_token_is_explained(self):
        code, out = self.work('--once', token='0' * 64)
        self.assertEqual(code, 5); self.assertIn('refused the worker token', out)
        code, out = self.work('--once', token='')
        self.assertEqual(code, 5); self.assertIn('NO CHE_GPU_TOKEN', out)

    def test_a_failed_face_check_fails_the_job_without_rendering(self):
        code, out = self.work('--once', FAKE_CHECK_FAIL='1')
        j = self.job(); self.assertEqual(j['state'], 'failed'); self.assertIn('face check failed', j['history'][-1]['note'])
        self.assertEqual(self.calls_made(), [])

    def test_idle_worker_stops(self):
        self.work('--once')
        code, out = self.work('--idle-minutes', '0')
        self.assertEqual(code, 0); self.assertIn('IDLE 0 min: worker stopped', out)


if __name__ == '__main__':
    unittest.main()

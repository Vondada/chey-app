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
        return self.api('/api/gpu')['jobs'][0]

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
        code, out = self.work('--once')                       # nothing left: the next run renders nothing
        self.assertNotIn('JOB gpu_', out); self.assertEqual(self.calls_made(), ['0,45,90'])

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

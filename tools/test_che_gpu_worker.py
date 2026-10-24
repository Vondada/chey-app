"""Tests for scripts/che_gpu_worker.py with the stand-in Blender from test_che_gpu_face_preview.py and a local queue
repository: queued requests render once, finished ones are never redone, no GPU stops the worker, idle exits.

  python3 -m unittest tools/test_che_gpu_worker.py
"""
import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_che_gpu_face_preview import FAKE  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORKER = os.path.join(ROOT, 'scripts', 'che_gpu_worker.py')


def git(*a, cwd=None):
    return subprocess.run(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', *a], cwd=cwd, capture_output=True, text=True, check=True).stdout


class GpuWorkerTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.blender = os.path.join(self.tmp, 'blender')
        open(self.blender, 'w').write(FAKE); os.chmod(self.blender, os.stat(self.blender).st_mode | stat.S_IEXEC)
        self.project = os.path.join(self.tmp, 'project'); os.makedirs(self.project)
        for n in ('che.blend', 'fit.json'): open(os.path.join(self.project, n), 'w').write(n)
        self.out = os.path.join(self.tmp, 'drive', 'CHE_GPU', 'jobs'); os.makedirs(self.out)
        self.calls = os.path.join(self.tmp, 'calls')
        # the queue: an upstream repo (Claude's side) and the clone the notebook keeps
        self.up = os.path.join(self.tmp, 'up'); os.makedirs(self.up); git('init', '-q', '-b', 'che-gpu-assets', cwd=self.up)
        open(os.path.join(self.up, 'README.md'), 'w').write('assets'); git('add', '-A', cwd=self.up); git('commit', '-qm', 'init', cwd=self.up)
        self.assets = os.path.join(self.tmp, 'assets'); git('clone', '-q', '-b', 'che-gpu-assets', self.up, self.assets)

    def queue(self, rid, **extra):
        os.makedirs(os.path.join(self.up, 'queue'), exist_ok=True)
        json.dump(dict({'id': rid, 'views': '0,45,90', 'settings': {}}, **extra), open(os.path.join(self.up, 'queue', rid + '.json'), 'w'))
        git('add', '-A', cwd=self.up); git('commit', '-qm', rid, cwd=self.up)

    def work(self, *args, **env):
        e = dict(os.environ, **dict({'FAKE_GPUS': 'OPTIX,CUDA', 'FAKE_CALLS': self.calls}, **env)); e.pop('RESULTS_TOKEN', None)
        p = subprocess.run([sys.executable, WORKER, '--blender', self.blender, '--project', self.project, '--out', self.out,
                            '--assets', self.assets, '--poll', '0', *args], env=e, capture_output=True, text=True, timeout=120)
        done = json.load(open(os.path.join(self.tmp, 'drive', 'CHE_GPU', 'worker_done.json'))) if os.path.exists(
            os.path.join(self.tmp, 'drive', 'CHE_GPU', 'worker_done.json')) else {}
        return p.returncode, p.stdout, done

    def calls_made(self):
        return open(self.calls).read().split() if os.path.exists(self.calls) else []

    def test_a_queued_request_renders_once_and_is_recorded(self):
        self.queue('v7-brows', settings={'BROW_W': 1.8, 'IRIS': 2.5}, note='feathered brows')
        code, out, done = self.work('--once')
        self.assertEqual(code, 0, out); self.assertIn('RESULT v7-brows: complete (exit 0)', out)
        self.assertEqual(done['v7-brows']['status'], 'complete'); self.assertIn('no RESULTS_TOKEN', done['v7-brows']['push'])
        receipt = json.load(open(os.path.join(self.out, done['v7-brows']['job'], 'receipt.json')))
        self.assertEqual(receipt['settings']['BROW_W'], '1.8'); self.assertEqual(receipt['status'], 'complete')
        code, out, _ = self.work('--once')                     # running the cell again does not redo finished work
        self.assertNotIn('REQUEST v7-brows', out); self.assertEqual(self.calls_made(), ['0,45,90'])

    def test_new_requests_are_picked_up_from_the_queue(self):
        self.queue('a'); self.work('--once')
        self.queue('b', settings={'IRIS': 2})
        code, out, done = self.work('--once')
        self.assertIn('REQUEST b', out); self.assertNotIn('REQUEST a', out)
        self.assertEqual(sorted(done), ['a', 'b'])

    def test_no_gpu_stops_the_worker_without_rendering(self):
        self.queue('a'); self.queue('b')
        code, out, done = self.work('--once', FAKE_GPUS='')
        self.assertEqual(code, 3); self.assertIn('NO GPU', out); self.assertNotIn('REQUEST b', out)
        self.assertEqual(self.calls_made(), [])

    def test_failed_face_check_is_not_retried(self):
        self.queue('bad')
        self.work('--once', FAKE_CHECK_FAIL='1')
        code, out, done = self.work('--once', FAKE_CHECK_FAIL='1')
        self.assertEqual(done['bad']['status'], 'checks_failed'); self.assertNotIn('REQUEST bad', out)

    def test_idle_worker_stops_and_releases_the_gpu(self):
        code, out, _ = self.work('--idle-minutes', '0')
        self.assertEqual(code, 0); self.assertIn('IDLE 0 min: worker stopped', out)
        status = json.load(open(os.path.join(self.tmp, 'drive', 'CHE_GPU', 'worker_status.json')))
        self.assertEqual(status['state'], 'stopped_idle')

    def test_a_bad_queue_file_is_ignored(self):
        os.makedirs(os.path.join(self.up, 'queue')); open(os.path.join(self.up, 'queue', 'x.json'), 'w').write('[1]')
        git('add', '-A', cwd=self.up); git('commit', '-qm', 'x', cwd=self.up)
        code, out, done = self.work('--once')
        self.assertEqual(code, 0); self.assertIn('IGNORED queue/x.json', out); self.assertEqual(done, {})


if __name__ == '__main__':
    unittest.main()

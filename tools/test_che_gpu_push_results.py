"""Tests for scripts/che_gpu_push_results.py against a local bare repository: only the job's pictures, receipt and
log leave the job folder, reruns push nothing, the token never reaches output, and no token means no push.

  python3 -m unittest tools/test_che_gpu_push_results.py
"""
import json
import os
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PUSH = os.path.join(ROOT, 'scripts', 'che_gpu_push_results.py')
TOKEN = 'github_pat_FAKE_TEST_TOKEN_0123456789'


def git(*a, cwd=None):
    return subprocess.run(['git', *a], cwd=cwd, capture_output=True, text=True, check=True).stdout


class PushResultsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.remote = os.path.join(self.tmp, 'results.git'); git('init', '-q', '--bare', self.remote)
        self.job = self.make_job('20261024-abcdef0123')

    def make_job(self, name):
        job = os.path.join(self.tmp, 'drive', 'jobs', name); os.makedirs(os.path.join(job, 'tmp'))
        for v in ('00', '45', '90'): open(os.path.join(job, f'view_{v}.png'), 'wb').write(b'\x89PNG' + v.encode())
        json.dump({'status': 'complete'}, open(os.path.join(job, 'receipt.json'), 'w'))
        open(os.path.join(job, 'log.txt'), 'w').write('log\n')
        for extra in ('receipt.json.tmp', 'tmp/dress_00.png', 'photo.jpg'): open(os.path.join(job, extra), 'w').write('x')
        return job

    def push(self, job=None, token=TOKEN, repo=None):
        env = dict(os.environ); env.pop('RESULTS_TOKEN', None)
        if token is not None: env['RESULTS_TOKEN'] = token
        p = subprocess.run([sys.executable, PUSH, '--job', job or self.job, '--repo', repo or self.remote],
                           env=env, capture_output=True, text=True)
        return p.returncode, p.stdout + p.stderr

    def files(self):
        return git('ls-tree', '-r', '--name-only', 'main', cwd=self.remote).split()

    def test_first_push_creates_main_with_only_the_results(self):
        code, out = self.push()
        self.assertEqual(code, 0, out); self.assertIn('PUSHED', out)
        self.assertEqual(self.files(), [f'results/20261024-abcdef0123/{n}' for n in
                                        ('log.txt', 'receipt.json', 'view_00.png', 'view_45.png', 'view_90.png')])
        self.assertIn('complete', git('log', '-1', '--format=%s', 'main', cwd=self.remote))

    def test_rerun_with_nothing_new_pushes_nothing(self):
        self.push(); before = git('rev-parse', 'main', cwd=self.remote)
        code, out = self.push()
        self.assertEqual(code, 0, out); self.assertIn('UP TO DATE', out)
        self.assertEqual(git('rev-parse', 'main', cwd=self.remote), before)

    def test_second_job_is_added_beside_the_first(self):
        self.push(); self.push(job=self.make_job('20261025-1111111111'))
        self.assertEqual(sorted({f.split('/')[1] for f in self.files()}), ['20261024-abcdef0123', '20261025-1111111111'])

    def test_no_token_pushes_nothing(self):
        code, out = self.push(token='')
        self.assertEqual(code, 2); self.assertIn('NO RESULTS_TOKEN', out)
        self.assertEqual(git('branch', '--list', cwd=self.remote).strip(), '')

    def test_failed_push_reports_without_the_token(self):
        code, out = self.push(repo='https://127.0.0.1:9/none/che-gpu-results')
        self.assertEqual(code, 3); self.assertIn('PUSH FAILED', out); self.assertNotIn(TOKEN, out)


if __name__ == '__main__':
    unittest.main()

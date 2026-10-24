"""Tests for scripts/che_gpu_face_preview.py with a stand-in Blender: GPU-only, resumable, honest receipts.

  python3 -m unittest tools/test_che_gpu_face_preview.py
"""
import json
import os
import stat
import subprocess
import sys
import tempfile
import textwrap
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RUNNER = os.path.join(ROOT, 'scripts', 'che_gpu_face_preview.py')

# Stands in for the Blender binary: answers --version, the project/GPU check and the face render the way the real
# scripts print, steered by FAKE_* environment variables.
FAKE = textwrap.dedent('''\
    #!/usr/bin/env python3
    import os, sys
    a = sys.argv
    if '--version' in a: print('Blender 5.0.1'); sys.exit(0)
    gpus = os.environ.get('FAKE_GPUS', '')            # e.g. "OPTIX,CUDA"
    if any(x.endswith('check_project.py') for x in a):
        print('CHECK PASS Blender 5.0 (the version CHE was built in) 5.0.1')
        for k in ('OPTIX', 'CUDA'):
            print('DEVICES', k, "['Tesla T4']" if k in gpus else 'none')
        want = os.environ.get('REQUIRE_GPU', '')
        sys.exit(0 if not want or want in gpus else 4)
    if any(x.endswith('mpfb_dress.py') for x in a):
        if os.environ.get('FAKE_CHECK_FAIL'):
            print('CHECK FAIL lip mask on the lips only 3 verts'); print("CHECKS FAILED, no render: ['lip mask']"); sys.exit(2)
        dev = os.environ.get('FAKE_DEVICE_LINE') or f"DEVICE {os.environ['CYCLES_DEVICE']} ['Tesla T4'] 384x480"
        print('CHECK PASS left eye in socket'); print(dev, flush=True)
        stop = int(os.environ.get('FAKE_STOP_AFTER', '99'))
        log = os.environ.get('FAKE_CALLS')
        if log: open(log, 'a').write(os.environ['VIEWS'] + '\\n')
        for i, v in enumerate(os.environ['VIEWS'].split(',')):
            if i == stop: sys.exit(1)
            p = os.path.join(os.environ['OUT_DIR'], f'dress_{int(v):02d}.png')
            open(p, 'wb').write(b'png' + v.encode()); print('WROTE', p, flush=True)
        sys.exit(0)
    sys.exit(9)
''')


class GpuFacePreviewTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.blender = os.path.join(self.tmp, 'blender')
        open(self.blender, 'w').write(FAKE); os.chmod(self.blender, os.stat(self.blender).st_mode | stat.S_IEXEC)
        self.project = os.path.join(self.tmp, 'project'); os.makedirs(self.project)
        for n in ('che.blend', 'fit.json'): open(os.path.join(self.project, n), 'w').write(n)
        self.out = os.path.join(self.tmp, 'out'); self.calls = os.path.join(self.tmp, 'calls')

    def run_job(self, **env):
        e = dict(os.environ, **dict({'FAKE_GPUS': 'OPTIX,CUDA', 'FAKE_CALLS': self.calls}, **env))
        p = subprocess.run([sys.executable, RUNNER, '--blender', self.blender, '--project', self.project, '--out', self.out],
                           env=e, capture_output=True, text=True)
        jobs = os.listdir(self.out) if os.path.isdir(self.out) else []
        receipt = json.load(open(os.path.join(self.out, jobs[0], 'receipt.json'))) if jobs else None
        return p.returncode, p.stdout, receipt

    def test_gpu_render_writes_three_views_and_receipt(self):
        code, out, r = self.run_job()
        self.assertEqual(code, 0, out)
        self.assertEqual(r['status'], 'complete'); self.assertEqual(r['device'], 'OPTIX')
        self.assertEqual(sorted(r['views']), ['0', '45', '90'])
        self.assertEqual({v['name'] for v in r['views'].values()}, {'front', 'three-quarter', 'side'})
        self.assertTrue(all('Tesla T4' in v['device'] for v in r['views'].values()))
        self.assertEqual(r['blender_version'], 'Blender 5.0.1')

    def test_rerun_skips_finished_views(self):
        self.run_job()
        code, out, r = self.run_job()
        self.assertEqual(code, 0); self.assertEqual(out.count('SKIP view'), 3)
        self.assertEqual(open(self.calls).read().split(), ['0,45,90'])   # rendered once only

    def test_interrupted_job_resumes_only_missing_views(self):
        code, _, r = self.run_job(FAKE_STOP_AFTER='1')
        self.assertEqual(code, 4); self.assertEqual(r['status'], 'render_failed'); self.assertEqual(list(r['views']), ['0'])
        code, _, r = self.run_job()
        self.assertEqual(code, 0); self.assertEqual(r['status'], 'complete')
        self.assertEqual(open(self.calls).read().split(), ['0,45,90', '45,90'])

    def test_no_gpu_refuses_without_rendering(self):
        code, out, r = self.run_job(FAKE_GPUS='')
        self.assertEqual(code, 3); self.assertEqual(r['status'], 'gpu_unavailable'); self.assertEqual(r['views'], {})
        self.assertFalse(os.path.exists(self.calls))

    def test_cuda_used_when_optix_missing(self):
        code, _, r = self.run_job(FAKE_GPUS='CUDA')
        self.assertEqual(code, 0); self.assertEqual(r['device'], 'CUDA')

    def test_render_on_cpu_is_refused(self):
        code, out, r = self.run_job(FAKE_DEVICE_LINE="DEVICE CPU ['CPU'] 384x480")
        self.assertEqual(code, 4); self.assertEqual(r['status'], 'not_gpu'); self.assertEqual(r['views'], {})

    def test_failed_face_check_stops_the_job(self):
        code, out, r = self.run_job(FAKE_CHECK_FAIL='1')
        self.assertEqual(code, 2); self.assertEqual(r['status'], 'checks_failed')


if __name__ == '__main__':
    unittest.main()

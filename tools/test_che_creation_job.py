"""Tests for scripts/che_creation_job.py (Create Object / Create Room jobs) with a stand-in Blender, and the worker
(scripts/che_gpu_worker.py) working an object_model job end to end against CHE's real queue code
(tools/gpu_queue_dev_server.mjs): build -> measure -> render from the GLB -> receipt; refused specs, failed
measurements, reuse and resume; the job completes only with the model uploaded and measured.

  python3 -m unittest tools/test_che_creation_job.py
"""
import hashlib
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import textwrap
import unittest
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_che_gpu_face_preview import FAKE  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RUNNER = os.path.join(ROOT, 'scripts', 'che_creation_job.py')
WORKER = os.path.join(ROOT, 'scripts', 'che_gpu_worker.py')
GPU = 'Tesla T4, 550.54.15, 15360 MiB'

# The stand-in Blender also answers the object/room builders, the static verifier and the creation renderer the way
# the real scripts print.
THING = '''\
    if any(x.endswith(('objects.py', 'rooms.py')) for x in a):
        which = next(x for x in a if x.endswith(('objects.py', 'rooms.py'))).rsplit('/', 1)[-1]
        if log: open(log, 'a').write('model:' + which + '\\n')
        print('STAGE model', flush=True)
        if os.environ.get('FAKE_NO_MODEL'): sys.exit(1)
        if which == 'rooms.py': print('LAYOUT {"placed":[{"item":"desk","x":1,"y":1,"rot_deg":0}],"skipped":[{"item":"bed","reason":"no free floor space"}]}', flush=True)
        n = glb(os.environ['EXPORT_GLB'])
        print('MODEL', os.environ['EXPORT_GLB'], n, 'bytes', 321, 'vertices', '(procedural)', flush=True)
        sys.exit(0)
    if any(x.endswith('verify_glb.py') for x in a) and '--static' in a:
        import hashlib, json
        if log: open(log, 'a').write('verify\\n')
        path = next(x for x in a if x.endswith('.glb')); ok = not os.environ.get('FAKE_VERIFY_FAIL')
        bbox = [float(x) for x in a[a.index('--expect-bbox') + 1].split(',')]
        rec = {'ok': ok, 'failures': [] if ok else ['y size 2.000 m, expected 0.860 m (within 25%)'], 'meshes': 11, 'primitives': 11,
               'vertices': 3144, 'triangles': 1540, 'materials': ['Chair (classic)'], 'primitives_without_material': 0,
               'bbox_m': {'min': [0, 0, 0], 'max': bbox, 'size': bbox}, 'expected_bbox_m': bbox, 'tolerance': 0.25,
               'sha256': hashlib.sha256(open(path, 'rb').read()).hexdigest(), 'bytes': os.path.getsize(path)}
        print('GLB_RECEIPT ' + json.dumps(rec)); sys.exit(0 if ok else 1)
    if any(x.endswith('render_creation.py') for x in a):
        print(devline(), flush=True)
        if log: open(log, 'a').write(os.environ['VIEWS'] + '\\n')
        for v in (x for x in os.environ['VIEWS'].split(',') if x):
            p = os.path.join(os.environ['OUT_DIR'], f'creation_{int(v):02d}.png')
            open(p, 'wb').write(b'\\x89PNG\\r\\n\\x1a\\n' + v.encode()); print('WROTE', p, flush=True)
        sys.exit(0)
'''
FAKE_THING = FAKE.replace("log = os.environ.get('FAKE_CALLS')\n", "log = os.environ.get('FAKE_CALLS')\n" + textwrap.dedent(THING), 1)
assert 'render_creation.py' in FAKE_THING


def write_blender(tmp):
    path = os.path.join(tmp, 'blender')
    open(path, 'w').write(FAKE_THING); os.chmod(path, os.stat(path).st_mode | stat.S_IEXEC)
    return path


class CreationJobTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(); self.blender = write_blender(self.tmp)
        self.project = os.path.join(self.tmp, 'project'); os.makedirs(self.project)
        for n in ('che.blend', 'fit.json'): open(os.path.join(self.project, n), 'w').write(n)
        self.out = os.path.join(self.tmp, 'out'); self.calls = os.path.join(self.tmp, 'calls')

    def run_job(self, kind, spec, *args, **env):
        sp = os.path.join(self.tmp, 'settings.json'); json.dump({'SPEC': json.dumps(spec)}, open(sp, 'w'))
        e = dict(os.environ, **dict({'FAKE_GPUS': '', 'FAKE_CALLS': self.calls}, **env))
        p = subprocess.run([sys.executable, RUNNER, '--kind', kind, '--blender', self.blender, '--out', self.out, '--settings', sp, *args],
                           env=e, capture_output=True, text=True, timeout=120)
        jobs = sorted(os.listdir(self.out)) if os.path.isdir(self.out) else []
        receipt = json.load(open(os.path.join(self.out, jobs[-1], 'receipt.json'))) if jobs and os.path.exists(os.path.join(self.out, jobs[-1], 'receipt.json')) else None
        return p.returncode, p.stdout, receipt

    def calls_made(self):
        return open(self.calls).read().split() if os.path.exists(self.calls) else []

    def test_a_room_records_its_cc0_floor_texture_or_why_it_has_none(self):
        # CHE_TEXTURES=0 stands in for "no network": the receipt says so and the room is still built in plain colour.
        code, out, r = self.run_job('room_model', {'type': 'office'}, '--device', 'cpu', CHE_TEXTURES='0', CHE_TEXTURE_CACHE=os.path.join(self.tmp, 'tex'))
        self.assertEqual(code, 0, out)
        self.assertEqual(r['textures']['concrete']['status'], 'unavailable')
        self.assertIn('CHE_TEXTURES=0', r['textures']['concrete']['reason'])
        self.assertIn('TEXTURE concrete unavailable', out)

    def test_an_object_is_built_measured_then_rendered_from_the_glb_on_the_cpu(self):
        code, out, r = self.run_job('object_model', {'family': 'chair', 'style': 'classic'}, '--device', 'cpu')
        self.assertEqual(code, 0, out)
        self.assertEqual(self.calls_made(), ['model:objects.py', 'verify', '0,45,90'])
        stages = [l for l in out.splitlines() if l.startswith('STAGE ')]
        self.assertEqual(stages, ['STAGE model', 'STAGE verify', 'STAGE render', 'STAGE save'])
        self.assertLess(out.index('CHECKPOINT verify'), out.index('MODEL READY'))
        self.assertLess(out.index('MODEL READY'), out.index('VIEW 0'))
        self.assertEqual(r['status'], 'complete'); self.assertEqual(r['device'], 'CPU')
        m = r['model']
        self.assertEqual((m['status'], m['mode'], m['file']), ('ok', 'object', 'model.glb'))
        self.assertEqual(m['sha256'], hashlib.sha256(open(os.path.join(self.out, r['job_id'], 'model.glb'), 'rb').read()).hexdigest())
        self.assertTrue(m['verify']['ok']); self.assertEqual(m['verify']['sha256'], m['sha256'])
        self.assertEqual(m['verify']['expected_bbox_m'], [0.46, 0.86, 0.48])
        self.assertIn('procedural classic chair', m['contents'])
        self.assertEqual(r['spec']['family'], 'chair'); self.assertTrue(r['job_id'].startswith('object-'))
        for v in ('0', '45', '90'):
            self.assertEqual(r['views'][v]['status'], 'ok'); self.assertTrue(r['views'][v]['device'].startswith('DEVICE CPU'))
        self.assertNotIn('#8a5a36', out, 'the spec stays in the receipt, not the (public) log')

    def test_a_room_records_its_layout_and_skipped_pieces(self):
        code, out, r = self.run_job('room_model', {'type': 'office', 'width': 4}, '--device', 'cpu', '--views', '45')
        self.assertEqual(code, 0, out)
        self.assertEqual(self.calls_made(), ['model:rooms.py', 'verify', '45'])
        self.assertEqual(r['model']['mode'], 'room'); self.assertEqual(r['model']['verify']['expected_bbox_m'], [4.1, 2.7, 3.6])
        self.assertEqual(r['model']['layout']['skipped'][0]['item'], 'bed')

    def test_a_spec_the_builders_refuse_stops_before_blender(self):
        code, out, r = self.run_job('object_model', {'family': 'dragon'}, '--device', 'cpu')
        self.assertEqual(code, 2); self.assertIn('SPEC FAILED', out); self.assertIn('not free-form text-to-3D', out)
        self.assertEqual(self.calls_made(), [])

    def test_a_model_that_fails_its_measurement_is_not_complete_and_not_rendered(self):
        code, out, r = self.run_job('object_model', {'family': 'chair'}, '--device', 'cpu', FAKE_VERIFY_FAIL='1')
        self.assertEqual(code, 2); self.assertIn('VERIFY FAILED: y size 2.000 m', out); self.assertNotIn('MODEL READY', out)
        self.assertEqual(r['status'], 'verify_failed'); self.assertEqual(r['model']['status'], 'verify_failed')
        self.assertEqual(self.calls_made(), ['model:objects.py', 'verify'])

    def test_no_model_from_blender_fails_the_job(self):
        code, out, r = self.run_job('object_model', {'family': 'mug'}, '--device', 'cpu', FAKE_NO_MODEL='1')
        self.assertEqual(code, 4); self.assertEqual(r['status'], 'model_failed')

    def test_a_rerun_reuses_the_model_and_views_but_measures_again(self):
        self.run_job('object_model', {'family': 'vase'}, '--device', 'cpu')
        code, out, r = self.run_job('object_model', {'family': 'vase'}, '--device', 'cpu')
        self.assertEqual(code, 0, out)
        self.assertEqual(self.calls_made(), ['model:objects.py', 'verify', '0,45,90', 'verify'])
        self.assertIn('SKIP model', out); self.assertEqual(r['last_run']['reused'], [0, 45, 90])

    def test_a_resumed_model_with_the_checkpoint_hash_is_not_built_again(self):
        self.run_job('object_model', {'family': 'lamp'}, '--device', 'cpu')
        job = os.path.join(self.out, os.listdir(self.out)[0]); model = os.path.join(self.tmp, 'resume.glb')
        shutil.copyfile(os.path.join(job, 'model.glb'), model); shutil.rmtree(self.out); os.remove(self.calls)
        sha = hashlib.sha256(open(model, 'rb').read()).hexdigest()
        code, out, r = self.run_job('object_model', {'family': 'lamp'}, '--device', 'cpu', '--resume-model', model, '--resume-sha', sha)
        self.assertEqual(code, 0, out); self.assertIn('RESUME model', out)
        self.assertEqual(self.calls_made(), ['verify', '0,45,90']); self.assertEqual(r['model']['source'], 'resumed from a checkpoint')
        os.remove(self.calls)
        code, out, r = self.run_job('object_model', {'family': 'shelf'}, '--device', 'cpu', '--resume-model', model, '--resume-sha', '0' * 64)
        self.assertIn('RESUME refused', out); self.assertEqual(self.calls_made()[0], 'model:objects.py')

    def test_a_gpu_job_needs_a_gpu_and_never_falls_back_to_the_cpu(self):
        code, out, r = self.run_job('object_model', {'family': 'chair'}, '--project', self.project)
        self.assertEqual(code, 3); self.assertIn('NO GPU', out); self.assertEqual(r['status'], 'gpu_unavailable')
        self.assertEqual(self.calls_made(), [])
        code, out, r = self.run_job('object_model', {'family': 'chair'}, '--project', self.project, FAKE_GPUS='OPTIX,CUDA')
        self.assertEqual(code, 0, out); self.assertTrue(r['views']['0']['device'].startswith('DEVICE OPTIX'))


@unittest.skipUnless(shutil.which('node'), 'node is needed to serve the real queue code')
class CreationWorkerTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(); self.blender = write_blender(self.tmp)
        self.project = os.path.join(self.tmp, 'project'); os.makedirs(self.project)
        for n in ('che.blend', 'fit.json'): open(os.path.join(self.project, n), 'w').write(n)
        self.out = os.path.join(self.tmp, 'drive', 'CHE_GPU', 'jobs'); self.calls = os.path.join(self.tmp, 'calls')
        self.server = subprocess.Popen(['node', os.path.join(ROOT, 'tools', 'gpu_queue_dev_server.mjs')], stdout=subprocess.PIPE, text=True)
        info = json.loads(self.server.stdout.readline()); self.url = f"http://127.0.0.1:{info['port']}"; self.token = info['token']

    def tearDown(self):
        self.server.kill(); self.server.wait()

    def api(self, path, body=None):
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(self.url + path, data=data, headers={'Content-Type': 'application/json'}, method='GET' if body is None else 'POST')
        with urllib.request.urlopen(req) as r: return json.loads(r.read() or b'{}')

    def test_an_object_model_job_streams_the_measured_model_then_previews_and_completes(self):
        spec = {'family': 'table', 'size': 1, 'color': '#b0302a', 'roughness': 0.45, 'metallic': 0, 'style': 'industrial', 'form': 'coffee'}
        queued = self.api('/api/gpu/jobs', {'title': 'Coffee table', 'kind': 'object_model', 'views': [0, 45, 90], 'settings': {'SPEC': json.dumps(spec)}})
        jid = queued['job']['id']; self.assertEqual(queued['job']['requires'], {'gpu': 'none'})
        for j in self.api('/api/gpu')['jobs']:
            if j['id'] != jid and j['state'] == 'queued': self.api('/api/gpu/jobs/cancel', {'id': j['id']})
        e = dict(os.environ, FAKE_GPUS='OPTIX,CUDA', FAKE_CALLS=self.calls, CHE_GPU_TOKEN=self.token); e.pop('RESULTS_TOKEN', None)
        p = subprocess.run([sys.executable, WORKER, '--che-url', self.url, '--blender', self.blender, '--project', self.project, '--out', self.out,
                            '--poll', '0', '--gpu', GPU, '--once'], env=e, capture_output=True, text=True, timeout=120)
        out = p.stdout + p.stderr
        self.assertEqual(p.returncode, 0, out)
        self.assertEqual(open(self.calls).read().split(), ['model:objects.py', 'verify', '0,45,90'])
        self.assertIn('MODEL UPLOAD: saved to the Live Studio', out)
        self.assertLess(out.index('MODEL UPLOAD'), out.index('PREVIEW view 0'), 'the measured geometry arrives before the first render')
        j = next(x for x in self.api('/api/gpu')['jobs'] if x['id'] == jid)
        self.assertEqual(j['state'], 'completed', j['history'])
        self.assertEqual(j['model']['sha256'], j['receipt']['model']['sha256'])
        self.assertEqual(j['receipt']['model']['verify']['sha256'], j['model']['sha256'])
        self.assertTrue(j['measured']['ok']); self.assertEqual(j['measured']['size_m'], [1.0, 0.42, 0.55])
        self.assertTrue(any(h['note'].startswith('Model verified: 11 meshes, 1,540 triangles') for h in j['history']))
        self.assertEqual(sorted(j['previews']), ['0', '45', '90'])


if __name__ == '__main__':
    unittest.main()

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
    def glb(path):
        import json, struct
        js = json.dumps({'asset': {'version': '2.0'}}).encode(); js += b' ' * (-len(js) % 4)
        data = b'glTF' + struct.pack('<II', 2, 20 + len(js)) + struct.pack('<I', len(js)) + b'JSON' + js
        open(path, 'wb').write(data); return len(data)
    def devline():
        if os.environ.get('FAKE_DEVICE_LINE'): return os.environ['FAKE_DEVICE_LINE']
        d = os.environ['CYCLES_DEVICE']
        return "DEVICE CPU ['CPU'] 320x480" if d == 'CPU' else f"DEVICE {d} ['Tesla T4'] 384x480"
    log = os.environ.get('FAKE_CALLS')
    if any(x.endswith('mpfb_body.py') for x in a):      # full body: model, rig, animate, export; no views
        if log: open(log, 'a').write('+model\\n')
        for st in ('model', 'rig', 'animate'): print('STAGE', st, flush=True)
        if os.environ.get('FAKE_NO_MODEL'): sys.exit(1)
        n = glb(os.environ['EXPORT_GLB'])
        print('MODEL', os.environ['EXPORT_GLB'], n, 'bytes', 12759, 'vertices', '(full-body clothed character)', flush=True)
        print('RIG 53 bones, clips idle,walk,run,wave,talk , morphs blink_l,blink_r,mouth_open,smile,brows_up', flush=True)
        sys.exit(0)
    if any(x.endswith('verify_glb.py') for x in a):
        import hashlib, json
        if log: open(log, 'a').write('verify\\n')
        path = a[-1]; ok = not os.environ.get('FAKE_RIG_FAIL')
        rec = {'ok': ok, 'failures': [] if ok else ['walk: foot_l travels 0.0 m (< 0.2)'], 'bones': 53, 'skins': 1,
               'sha256': hashlib.sha256(open(path, 'rb').read()).hexdigest(), 'bytes': os.path.getsize(path), 'vertices': 12759,
               'clips': {'idle': {'duration_s': 2.0}, 'walk': {'duration_s': 1.0}, 'run': {'duration_s': 0.667},
                         'wave': {'duration_s': 2.0}, 'talk': {'duration_s': 3.0}},
               'morphs': ['blink_l', 'blink_r', 'mouth_open', 'smile', 'brows_up'], 'file': path}
        print('RIG_RECEIPT ' + json.dumps(rec)); sys.exit(0 if ok else 1)
    if any(x.endswith('render_glb.py') for x in a):
        print(devline(), flush=True)
        if log: open(log, 'a').write(os.environ['VIEWS'] + '\\n')
        stop = int(os.environ.get('FAKE_STOP_AFTER', '99'))
        for i, v in enumerate(x for x in os.environ['VIEWS'].split(',') if x):
            if i == stop: sys.exit(1)
            p = os.path.join(os.environ['OUT_DIR'], f'body_{int(v):02d}.png')
            open(p, 'wb').write(b'\\x89PNG\\r\\n\\x1a\\n' + v.encode()); print('WROTE', p, flush=True)
        sys.exit(0)
    if any(x.endswith('mpfb_dress.py') for x in a):
        if os.environ.get('FAKE_CHECK_FAIL'):
            print('CHECK FAIL lip mask on the lips only 3 verts'); print("CHECKS FAILED, no render: ['lip mask']"); sys.exit(2)
        print('CHECK PASS left eye in socket'); print(devline(), flush=True)
        stop = int(os.environ.get('FAKE_STOP_AFTER', '99'))
        if log: open(log, 'a').write(os.environ['VIEWS'] + ('+model' if os.environ.get('EXPORT_GLB') else '') + '\\n')
        if os.environ.get('EXPORT_GLB') and not os.environ.get('FAKE_NO_MODEL'):
            import json, struct
            js = json.dumps({'asset': {'version': '2.0'}}).encode(); js += b' ' * (-len(js) % 4)
            glb = b'glTF' + struct.pack('<II', 2, 20 + len(js)) + struct.pack('<I', len(js)) + b'JSON' + js
            open(os.environ['EXPORT_GLB'], 'wb').write(glb)
            print('MODEL', os.environ['EXPORT_GLB'], len(glb), 'bytes', 1234, 'vertices', '(head-and-neck bust)', flush=True)
        for i, v in enumerate(x for x in os.environ['VIEWS'].split(',') if x):
            if i == stop: sys.exit(1)
            p = os.path.join(os.environ['OUT_DIR'], f'dress_{int(v):02d}.png')
            open(p, 'wb').write(b'\\x89PNG\\r\\n\\x1a\\n' + v.encode()); print('WROTE', p, flush=True)
        sys.exit(0)
    sys.exit(9)
''')


BUST = {'MODEL_MODE': 'bust'}


class GpuFacePreviewTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.blender = os.path.join(self.tmp, 'blender')
        open(self.blender, 'w').write(FAKE); os.chmod(self.blender, os.stat(self.blender).st_mode | stat.S_IEXEC)
        self.project = os.path.join(self.tmp, 'project'); os.makedirs(self.project)
        for n in ('che.blend', 'fit.json'): open(os.path.join(self.project, n), 'w').write(n)
        self.out = os.path.join(self.tmp, 'out'); self.calls = os.path.join(self.tmp, 'calls')

    def run_job(self, *args, settings=None, **env):
        e = dict(os.environ, **dict({'FAKE_GPUS': 'OPTIX,CUDA', 'FAKE_CALLS': self.calls}, **env))
        if settings is not None:
            sp = os.path.join(self.tmp, 'settings.json'); json.dump(settings, open(sp, 'w')); args = (*args, '--settings', sp)
        p = subprocess.run([sys.executable, RUNNER, '--blender', self.blender, '--project', self.project, '--out', self.out, *args],
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

    def test_job_name_depends_on_content_not_date_or_commit(self):
        self.run_job()
        self.assertTrue(os.listdir(self.out)[0].startswith('face-'), os.listdir(self.out))
        self.run_job(); self.assertEqual(len(os.listdir(self.out)), 1)
        open(os.path.join(self.project, 'fit.json'), 'w').write('another fit')   # different inputs: a new job
        self.run_job(); self.assertEqual(len(os.listdir(self.out)), 2)

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

    def test_empty_or_changed_picture_is_rendered_again(self):
        self.run_job()
        job = os.path.join(self.out, os.listdir(self.out)[0])
        open(os.path.join(job, 'view_45.png'), 'wb').close()            # cut short by a Drive disconnect
        open(os.path.join(job, 'view_90.png'), 'wb').write(b'other')   # not the picture the receipt names
        code, out, r = self.run_job()
        self.assertEqual(code, 0, out); self.assertEqual(r['status'], 'complete')
        self.assertIn('RE-RENDER view 45 (three-quarter): picture missing or empty', out)
        self.assertIn('RE-RENDER view 90 (side): picture does not match its receipt hash', out)
        self.assertEqual(open(self.calls).read().split(), ['0,45,90', '45,90'])
        self.assertEqual(r['last_run']['rendered'], [45, 90]); self.assertEqual(r['last_run']['reused'], [0])

    def test_reused_view_names_its_gpu_render(self):
        self.run_job()
        code, out, r = self.run_job()
        self.assertIn("SKIP view 0 (front): verified GPU render from", out)
        self.assertIn("DEVICE OPTIX ['Tesla T4']", out)
        self.assertEqual(r['last_run']['rendered'], [])

    def test_a_view_recorded_on_cpu_is_never_reused(self):
        self.run_job()
        job = os.path.join(self.out, os.listdir(self.out)[0]); rp = os.path.join(job, 'receipt.json')
        rec = json.load(open(rp)); rec['views']['0']['device'] = "DEVICE CPU ['CPU'] 384x480"; json.dump(rec, open(rp, 'w'))
        code, out, r = self.run_job()
        self.assertIn('RE-RENDER view 0 (front): recorded device is not a GPU', out)
        self.assertEqual(open(self.calls).read().split(), ['0,45,90', '0'])
        self.assertIn('Tesla T4', r['views']['0']['device'])

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

    # ── --model with MODEL_MODE bust: the head-and-neck model (model.glb) from the same Blender run ─────────────────
    def test_model_is_exported_before_the_views_and_recorded_in_the_receipt(self):
        code, out, r = self.run_job('--model', settings=BUST)
        self.assertEqual(code, 0, out); self.assertEqual(r['status'], 'complete')
        m = r['model']; job = os.path.join(self.out, os.listdir(self.out)[0])
        self.assertEqual((m['status'], m['file'], m['vertices']), ('ok', 'model.glb', 1234))
        self.assertEqual(m['bytes'], os.path.getsize(os.path.join(job, 'model.glb')))
        self.assertIn('render-only', m['contents'])
        self.assertLess(out.index('MODEL READY'), out.index('VIEW 0 '), 'the geometry stage comes before any render')
        self.assertEqual(open(self.calls).read().split(), ['0,45,90+model'])
        self.assertEqual(r['last_run']['model'], 'exported')

    def test_a_model_job_has_its_own_folder_and_reuses_a_verified_model(self):
        self.run_job(); self.run_job('--model', settings=BUST)
        self.assertEqual(len(os.listdir(self.out)), 2, 'a model job never reuses a previews-only folder')
        code, out, r = self.run_job('--model', settings=BUST)
        self.assertEqual(code, 0, out); self.assertIn('SKIP model: verified export', out); self.assertIn('MODEL READY', out)
        self.assertEqual(open(self.calls).read().split(), ['0,45,90', '0,45,90+model'], 'nothing rendered or exported twice')

    def test_a_missing_or_changed_model_is_exported_again_without_rerendering_views(self):
        self.run_job('--model', settings=BUST)
        job = os.path.join(self.out, os.listdir(self.out)[0])
        open(os.path.join(job, 'model.glb'), 'wb').write(b'glTF' + b'\0' * 30)   # not the file the receipt names
        code, out, r = self.run_job('--model', settings=BUST)
        self.assertEqual(code, 0, out); self.assertIn('RE-EXPORT model: model does not match its receipt hash', out)
        self.assertEqual(open(self.calls).read().split(), ['0,45,90+model', '+model'])
        self.assertEqual(r['status'], 'complete'); self.assertEqual(r['last_run']['model'], 'exported')

    def test_a_model_job_without_a_model_is_not_complete(self):
        code, out, r = self.run_job('--model', settings=BUST, FAKE_NO_MODEL='1')
        self.assertEqual(code, 4, out); self.assertEqual(r['status'], 'model_failed'); self.assertNotIn('model', r)
        self.assertEqual(sorted(r['views']), ['0', '45', '90'], 'finished views are kept')

    def test_views_may_be_empty_for_a_model_only_job(self):
        code, out, r = self.run_job('--model', '--views', '', settings=BUST)
        self.assertEqual(code, 0, out); self.assertEqual(r['views'], {}); self.assertEqual(r['model']['status'], 'ok')


    # ── --model, full body (the default): model -> rig -> animate -> verify -> render from the GLB -> save ─────────────
    def test_full_body_is_the_default_model_and_completes_only_with_a_verified_rig(self):
        code, out, r = self.run_job('--model')
        self.assertEqual(code, 0, out); self.assertEqual(r['status'], 'complete')
        m = r['model']
        self.assertEqual((m['mode'], m['status'], m['vertices']), ('full_body', 'ok', 12759))
        self.assertTrue(m['rig']['ok']); self.assertEqual(m['rig']['bones'], 53)
        self.assertEqual(m['rig']['sha256'], m['sha256'], 'the rig receipt is for this exact file')
        self.assertNotIn('file', m['rig'], 'no local paths in the receipt summary')
        self.assertEqual(open(self.calls).read().split(), ['+model', 'verify', '0,45,90'])
        stages = [l.split()[1] for l in out.splitlines() if l.startswith('STAGE ')]
        self.assertEqual(stages, ['model', 'rig', 'animate', 'verify', 'render', 'save'])
        cps = [l.split() for l in out.splitlines() if l.startswith('CHECKPOINT ')]
        self.assertEqual([c[1] for c in cps], ['model', 'rig', 'animate', 'verify'])
        for c in cps:
            self.assertRegex(c[3], r'^[0-9a-f]{64}$'); self.assertEqual(c[3], m['sha256']); self.assertEqual(int(c[4]), m['bytes'])
        self.assertLess(out.index('CHECKPOINT verify'), out.index('MODEL READY'), 'only a verified model is announced')
        self.assertLess(out.index('MODEL READY'), out.index('VIEW 0 '), 'geometry before the first render')
        self.assertEqual(sorted(r['views']), ['0', '45', '90'])
        self.assertTrue(os.listdir(self.out)[0].startswith('body-'), 'a full-body job has its own folder')

    def test_a_rig_that_fails_verification_is_not_complete(self):
        code, out, r = self.run_job('--model', FAKE_RIG_FAIL='1')
        self.assertEqual(code, 2, out); self.assertEqual(r['status'], 'rig_failed')
        self.assertFalse(r['model']['rig']['ok']); self.assertIn('RIG FAILED: walk', out)
        self.assertNotIn('MODEL READY', out); self.assertEqual(r['views'], {})
        code, out, r = self.run_job('--model')   # a failed rig is never reused: the next run builds it again
        self.assertIn('RE-EXPORT model', out); self.assertEqual(r['status'], 'complete')

    def test_full_body_rerun_reuses_model_and_views_but_verifies_again(self):
        self.run_job('--model')
        code, out, r = self.run_job('--model')
        self.assertEqual(code, 0, out); self.assertIn('SKIP model: verified export', out)
        self.assertEqual(open(self.calls).read().split(), ['+model', 'verify', '0,45,90', 'verify'])
        self.assertEqual(r['last_run']['model'], 'reused')

    def test_resume_model_with_matching_sha_skips_the_build(self):
        self.run_job('--model', '--views', '')
        job = os.path.join(self.out, os.listdir(self.out)[0]); glb = os.path.join(self.tmp, 'from_che.glb')
        open(glb, 'wb').write(open(os.path.join(job, 'model.glb'), 'rb').read())
        sha = json.load(open(os.path.join(job, 'receipt.json')))['model']['sha256']
        os.remove(os.path.join(job, 'model.glb')); os.remove(self.calls)      # a fresh worker: nothing local
        code, out, r = self.run_job('--model', '--resume-model', glb, '--resume-sha', sha)
        self.assertEqual(code, 0, out); self.assertIn('RESUME model: checkpoint sha256 matches', out)
        self.assertEqual(open(self.calls).read().split(), ['verify', '0,45,90'])
        self.assertNotIn('STAGE model', out); self.assertIn('STAGE verify', out)
        self.assertEqual(r['last_run']['model'], 'resumed'); self.assertTrue(r['model']['rig']['ok'])

    def test_resume_model_with_wrong_sha_builds_again(self):
        glb = os.path.join(self.tmp, 'other.glb'); open(glb, 'wb').write(b'glTF not the checkpoint')
        code, out, r = self.run_job('--model', '--resume-model', glb, '--resume-sha', '0' * 64)
        self.assertEqual(code, 0, out); self.assertIn('RESUME refused', out); self.assertIn('STAGE model', out)
        self.assertEqual(r['last_run']['model'], 'exported')

    def test_cpu_device_gives_an_honest_cpu_receipt(self):
        code, out, r = self.run_job('--model', '--device', 'cpu', FAKE_GPUS='')
        self.assertEqual(code, 0, out); self.assertEqual(r['status'], 'complete')
        self.assertEqual(r['device'], 'CPU'); self.assertEqual(r['cycles_gpus'], '')
        self.assertEqual(r['cores'], os.cpu_count()); self.assertEqual(r['threads'], os.cpu_count())
        for v in r['views'].values(): self.assertRegex(v['device'], r'^DEVICE CPU\b')
        self.assertNotIn('GPU', ''.join(l for l in out.splitlines() if l.startswith(('CPU', 'VIEW'))))
        code, out, r = self.run_job('--model', '--device', 'cpu', FAKE_GPUS='')
        self.assertIn('SKIP view 0 (front): verified CPU render', out)

    def test_cpu_job_refuses_a_gpu_device_line(self):
        code, out, r = self.run_job('--model', '--device', 'cpu', FAKE_DEVICE_LINE="DEVICE OPTIX ['Tesla T4'] 384x480")
        self.assertEqual(code, 4, out); self.assertEqual(r['status'], 'wrong_device'); self.assertEqual(r['views'], {})

    def test_stdout_never_carries_identity_settings(self):
        code, out, r = self.run_job('--model', settings={'IDENTITY': 'nova', 'TARGET_SRGB': '201,150,120', 'HAIR_STYLE': 'long_waves'})
        self.assertEqual(code, 0, out)
        for secret in ('nova', '201,150,120', 'long_waves'): self.assertNotIn(secret, out)
        self.assertEqual(r['settings']['IDENTITY'], 'nova', 'the receipt file keeps them')


if __name__ == '__main__':
    unittest.main()

"""Build the Create Room demo's characters with the REAL person_model job (scripts/che_gpu_face_preview.py --model).

  python3 tools/demo/build_models.py --blender BLENDER --project PROJECT_DIR --out OUT_DIR [--only photoreal,hybrid]
        [--samples 48] [--res 720]
  env MPFB = MPFB2 data dir (as the CPU worker sets it)

For each job in tools/demo/characters.json it writes the settings file (base + job overrides), runs the same job script
the free GitHub CPU worker runs (CPU device, views 0,45,90), and links OUT_DIR/<name> to the job folder (model.glb,
view_*.png, receipt.json, log.txt). OUT_DIR/build_times.json records each job's wall time and exit code. Nothing here
changes the pipeline: this is a caller.
"""
import argparse
import json
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--blender', required=True); ap.add_argument('--project', required=True); ap.add_argument('--out', required=True)
    ap.add_argument('--only', default=''); ap.add_argument('--samples', type=int, default=48); ap.add_argument('--res', type=int, default=720)
    a = ap.parse_args()
    spec = json.load(open(os.path.join(HERE, 'characters.json')))
    os.makedirs(os.path.join(a.out, 'jobs'), exist_ok=True)
    times_path = os.path.join(a.out, 'build_times.json')
    times = json.load(open(times_path)) if os.path.exists(times_path) else {}
    only = [x for x in a.only.split(',') if x]
    for name, over in spec['jobs'].items():
        if only and name not in only: continue
        settings = dict(spec['base'], **over)
        sp = os.path.join(a.out, f'settings_{name}.json')
        json.dump(settings, open(sp, 'w'), indent=1, sort_keys=True)
        cmd = [sys.executable, os.path.join(ROOT, 'scripts', 'che_gpu_face_preview.py'), '--blender', a.blender, '--project', a.project,
               '--out', os.path.join(a.out, 'jobs'), '--views', '0,45,90', '--device', 'cpu', '--samples', str(a.samples),
               '--res', str(a.res), '--settings', sp, '--model', '--timeout', '5400']
        t = time.time()
        p = subprocess.run(cmd, capture_output=True, text=True)
        dt = round(time.time() - t, 1)
        job = next((l.split(' ', 1)[1].strip() for l in p.stdout.splitlines() if l.startswith('JOB ')), None)
        print(name, 'exit', p.returncode, f'{dt}s', job, flush=True)
        if p.returncode: print(p.stdout[-2000:], p.stderr[-2000:])
        if job:
            link = os.path.join(a.out, name)
            if os.path.islink(link): os.unlink(link)
            os.symlink(job, link)
        times[name] = {'seconds': dt, 'exit': p.returncode, 'job': os.path.basename(job or ''), 'samples': a.samples, 'res': a.res}
        json.dump(times, open(times_path, 'w'), indent=1)


if __name__ == '__main__':
    main()

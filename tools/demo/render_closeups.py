"""Face close-ups of the three style builds with the pipeline's own renderer (tools/avatar_body/render_glb.py, Cycles,
the job's 'final' profile), so the styles segment shows the faces, where photoreal / hybrid / stylized differ.

  python3 tools/demo/render_closeups.py --blender BLENDER --models MODELS_DIR [--names photoreal,hybrid,stylized]
        [--samples 32] [--size 480x480]

Writes MODELS_DIR/<name>/closeup/body_20.png and records RENDERED seconds in MODELS_DIR/closeup_times.json.
"""
import argparse
import json
import os
import re
import subprocess
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--blender', required=True); ap.add_argument('--models', required=True)
    ap.add_argument('--names', default='photoreal,hybrid,stylized'); ap.add_argument('--samples', default='32'); ap.add_argument('--size', default='480x480')
    a = ap.parse_args()
    times = {}
    for name in a.names.split(','):
        d = os.path.join(a.models, name)
        env = dict(os.environ, OUT_DIR=os.path.join(d, 'closeup'), VIEWS='20', SIZE=a.size, SAMPLES=a.samples, RENDER_PROFILE='final',
                   CAM_DIST='0.75', CAM_Z='1.56', TARGET_Z='1.53', POSE_CLIP='idle', POSE_FRAME='0', CPU_THREADS='4')
        t = time.time()
        p = subprocess.run([a.blender, '-b', '--factory-startup', '-P', os.path.join(ROOT, 'tools', 'avatar_face', 'bl_run.py'), '--',
                            os.path.join(ROOT, 'tools', 'avatar_body', 'render_glb.py'), os.path.join(d, 'model.glb')],
                           env=env, capture_output=True, text=True)
        m = re.search(r'RENDERED 20 ([\d.]+)', p.stdout)
        times[name] = {'exit': p.returncode, 'render_seconds': float(m.group(1)) if m else None, 'wall_seconds': round(time.time() - t, 1),
                       'samples': int(a.samples), 'size': a.size}
        print(name, times[name], flush=True)
        if p.returncode: print(p.stdout[-1500:], p.stderr[-1500:])
    json.dump(times, open(os.path.join(a.models, 'closeup_times.json'), 'w'), indent=1)


if __name__ == '__main__':
    main()

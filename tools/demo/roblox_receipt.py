"""Run the repo's Roblox export (tools/avatar_body/roblox_export.py) on the demo's photoreal GLB and keep its receipt.

  python3 tools/demo/roblox_receipt.py --blender BLENDER --glb MODEL.glb --out BUILD_DIR

Writes BUILD_DIR/roblox/ (character_r15.fbx, walk_r15.fbx) and BUILD_DIR/roblox.json: the exporter's own
ROBLOX_RECEIPT plus 'studio_import_ready', 'summary' and the wall time. Nothing is uploaded to Roblox.
"""
import argparse
import json
import os
import subprocess
import time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--blender', required=True); ap.add_argument('--glb', required=True); ap.add_argument('--out', required=True)
    a = ap.parse_args()
    od = os.path.join(a.out, 'roblox'); os.makedirs(od, exist_ok=True)
    t = time.time()
    p = subprocess.run([a.blender, '-b', '--factory-startup', '-P', os.path.join(ROOT, 'tools', 'avatar_face', 'bl_run.py'), '--',
                        os.path.join(ROOT, 'tools', 'avatar_body', 'roblox_export.py'), a.glb], env=dict(os.environ, OUT_DIR=od, CLIP='walk'),
                       capture_output=True, text=True)
    line = next((l for l in p.stdout.splitlines() if l.startswith('ROBLOX_RECEIPT ')), None)
    rec = json.loads(line.split(' ', 1)[1]) if line else {'error': (p.stdout + p.stderr)[-1500:]}
    ready = bool(rec.get('studio_import_ready'))
    files = rec.get('files') or {}
    rec_out = {'exit': p.returncode, 'wall_seconds': round(time.time() - t, 1), 'studio_import_ready': ready,
               'summary': f"{len((rec.get('measured') or {}).get('bones') or {})} R15 bones, {rec.get('triangles_total')} triangles, Marketplace ready: {rec.get('marketplace_ready')}", 'receipt': rec}
    json.dump(rec_out, open(os.path.join(a.out, 'roblox.json'), 'w'), indent=1)
    print(json.dumps({k: rec_out[k] for k in ('exit', 'wall_seconds', 'studio_import_ready', 'summary')}))


if __name__ == '__main__':
    main()

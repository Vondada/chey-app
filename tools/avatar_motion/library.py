"""CHE's movement clip library: licensed mocap (clips.json), fetched once, verified by sha256, cached, retargeted onto
the MPFB game_engine skeleton, foot-locked and resampled to the scene's frame rate.

  python3 library.py --fetch            download and verify every file in clips.json into the cache
  python3 library.py --list             the clips with source, frames, licence

Cache: $CHE_MOTION_CACHE, else ~/.cache/che-motion. A file whose sha256 differs from the manifest is never used.
"""
import argparse
import hashlib
import json
import os
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import bvh  # noqa: E402
from blend import Clip, breathing, resample  # noqa: E402
from retarget import foot_lock, ground_offset, retarget  # noqa: E402

MANIFEST = os.path.join(HERE, 'clips.json')


def manifest():
    with open(MANIFEST) as f: return json.load(f)


def cache_dir():
    d = os.environ.get('CHE_MOTION_CACHE') or os.path.join(os.path.expanduser('~'), '.cache', 'che-motion')
    os.makedirs(d, exist_ok=True)
    return d


def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for b in iter(lambda: f.read(1 << 20), b''): h.update(b)
    return h.hexdigest()


def fetch(file_id, m=None, timeout=120):
    """Path of a verified local copy of one manifest file (downloads it if needed). Raises on a sha256 mismatch."""
    m = m or manifest()
    spec = m['files'][file_id]; src = m['sources'][spec['source']]
    path = os.path.join(cache_dir(), f"{file_id}.bvh")
    if os.path.exists(path) and sha256(path) == spec['sha256']: return path
    url = src['mirror'] + spec['path']
    req = urllib.request.Request(url, headers={'User-Agent': 'che-motion/1'})
    with urllib.request.urlopen(req, timeout=timeout) as r: data = r.read()
    got = hashlib.sha256(data).hexdigest()
    if got != spec['sha256']:
        raise ValueError(f'{file_id}: sha256 {got} does not match the manifest {spec["sha256"]}; not used')
    tmp = path + '.part'
    with open(tmp, 'wb') as f: f.write(data)
    os.replace(tmp, path)
    return path


_PARSED = {}


def source(file_id, m=None):
    """(joint names, world rotations, positions, ends, frame_time) in Blender axes for one verified file."""
    if file_id not in _PARSED:
        with open(fetch(file_id, m)) as f: J, M, ft = bvh.parse(f.read())
        W, P = bvh.fk(J, M)
        ends = bvh.end_positions(J, W, P)
        R, Pb = bvh.to_blender(W, P)
        ends_b = {k: v @ bvh.BVH_TO_BLENDER.T for k, v in ends.items()}
        _PARSED[file_id] = ([j.name for j in J], R, Pb, ends_b, ft)
    return _PARSED[file_id]


def build(name, rig, fps=30.0, lock=True, breathe=False, m=None):
    """One clip retargeted onto `rig` at `fps`. Returns (Clip, report)."""
    m = m or manifest()
    spec = m['clips'][name]
    names, R, P, ends, ft = source(spec['file'], m)
    a, b = spec['frames']
    import numpy as np
    sel = np.r_[0, np.arange(a, b + 1)]   # frame 0 (T-pose) is the reference
    idx = bvh.resample_index(len(sel) - 1, ft, 1.0 / fps)   # over the selected frames after the reference
    Wseg = np.concatenate([R[0:1], bvh.resample_rotations(R[a:b + 1], idx)])
    Pseg = np.concatenate([P[0:1], bvh.lerp_frames(P[a:b + 1], idx)])
    ends_seg = {k: np.concatenate([v[0:1], bvh.lerp_frames(v[a:b + 1], idx)]) for k, v in ends.items()}
    local, root_loc, info = retarget(rig, names, Wseg, Pseg, ends=ends_seg)
    local = {k: v[1:] for k, v in local.items()}; root_loc = root_loc[1:]
    # start the root at the clip's own first frame (horizontal), keep the height offset
    first = root_loc[0].copy()
    Rp = rig.rest['pelvis']
    world = root_loc @ Rp.T
    world[:, :2] -= (first @ Rp.T)[:2]
    # ground: the planted feet rest on the floor at CHE's own rest ankle/ball heights (proportions differ from the actor)
    world[:, 2] += ground_offset(rig, local, world @ Rp)
    root_loc = world @ Rp
    report = {'clip': name, 'file': spec['file'], 'source_frames': [a, b], 'frames': len(root_loc), 'fps': fps,
              'scale_m_per_unit': round(info['scale_m_per_unit'], 5)}
    if lock and spec.get('foot_lock', True):
        local, fl = foot_lock(rig, local, root_loc, fps=fps)
        report['foot_lock'] = fl
    clip = Clip.from_local(name, rig, local, root_loc, fps, {'source': spec['file'], 'description': spec['description'], 'loop': spec.get('loop', False)})
    if breathe: clip = breathing(clip)
    return clip, report


def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--fetch', action='store_true'); ap.add_argument('--list', action='store_true')
    a = ap.parse_args()
    m = manifest()
    if a.fetch:
        for fid in m['files']:
            p = fetch(fid, m); print('OK', fid, p, os.path.getsize(p), 'bytes', flush=True)
    if a.list or not a.fetch:
        for n, c in m['clips'].items():
            f = m['files'][c['file']]
            print(f"{n:16s} {c['file']} frames {c['frames'][0]}-{c['frames'][1]} ({(c['frames'][1] - c['frames'][0]) / 120:.1f} s) {c['description']}")
        print('licence:', m['sources']['cmu']['licence'])


if __name__ == '__main__':
    main()

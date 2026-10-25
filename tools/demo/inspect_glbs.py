"""Evidence for the demo: what each built GLB really contains, read from the file itself (glTF JSON chunk, no Blender).

  python3 tools/demo/inspect_glbs.py MODELS_DIR > evidence.json

For every MODELS_DIR/<name>/model.glb (the links build_models.py makes): bone names and count (the skin's joints),
animation clip names and durations, morph target names, vertex count, file size and sha256, and the job receipt's
stage seconds and Cycles view seconds. 'same_rig_as_photoreal' is true only when the joint names AND their order equal
the photoreal build's, and 'same_clips_as_photoreal' when the clip names and channel targets (node name + path) match:
then the clips drive the changed model with no retargeting. Joint positions differ when the body changes (the
skeleton is placed on each body's own joints); that is reported as max_joint_offset_m.
"""
import hashlib
import json
import os
import struct
import sys

import numpy as np

COMP = {5126: ('f', 4), 5123: ('H', 2), 5125: ('I', 4), 5121: ('B', 1)}
NCOMP = {'SCALAR': 1, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}


def read_glb(path):
    b = open(path, 'rb').read()
    n = struct.unpack_from('<I', b, 12)[0]
    j = json.loads(b[20:20 + n])
    off = 20 + n
    binlen = struct.unpack_from('<I', b, off)[0]
    return j, b[off + 8:off + 8 + binlen], b


def accessor(j, binc, i):
    a = j['accessors'][i]; bv = j['bufferViews'][a['bufferView']]
    fmt, size = COMP[a['componentType']]; k = NCOMP[a['type']]
    start = bv.get('byteOffset', 0) + a.get('byteOffset', 0)
    arr = np.frombuffer(binc, dtype='<' + fmt, count=a['count'] * k, offset=start)
    return arr.reshape(a['count'], k)


def inspect(path):
    j, binc, raw = read_glb(path)
    nodes = j['nodes']
    skin = j['skins'][0] if j.get('skins') else None
    joints = [nodes[i].get('name') for i in skin['joints']] if skin else []
    ibm = accessor(j, binc, skin['inverseBindMatrices']) if skin and 'inverseBindMatrices' in skin else None
    joint_pos = [np.linalg.inv(m.reshape(4, 4).T)[:3, 3].tolist() for m in ibm] if ibm is not None else []
    clips = {}
    for an in j.get('animations', []):
        dur = max(float(j['accessors'][s['input']]['max'][0]) for s in an['samplers'])
        clips[an['name']] = {'duration_s': round(dur, 3), 'channels': sorted(
            f"{nodes[c['target']['node']].get('name')}.{c['target']['path']}" for c in an['channels'])}
    morphs = sorted({t for m in j['meshes'] for t in (m.get('extras') or {}).get('targetNames', [])})
    verts = sum(j['accessors'][p['attributes']['POSITION']]['count'] for m in j['meshes'] for p in m['primitives'])
    return {'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest(), 'vertices': verts, 'bones': len(joints),
            'joint_names': joints, 'joint_pos': joint_pos, 'clips': clips, 'morphs': morphs,
            'meshes': [m.get('name') for m in j['meshes']], 'materials': [m.get('name') for m in j.get('materials', [])]}


def main():
    d = sys.argv[1]
    out = {}
    for name in sorted(os.listdir(d)):
        p = os.path.join(d, name, 'model.glb')
        if not os.path.exists(p): continue
        r = inspect(p)
        rc = json.load(open(os.path.join(d, name, 'receipt.json')))
        r['job_id'] = rc['job_id']; r['stage_seconds'] = rc.get('stage_seconds')
        r['view_seconds'] = {k: v.get('render_seconds') for k, v in rc.get('views', {}).items()}
        r['settings'] = rc.get('settings'); r['rig_verify_ok'] = (rc.get('model') or {}).get('rig', {}).get('ok')
        out[name] = r
    base = out.get('photoreal')
    for name, r in out.items():
        if not base: break
        r['same_rig_as_photoreal'] = r['joint_names'] == base['joint_names']
        r['same_clips_as_photoreal'] = {k: v['channels'] for k, v in r['clips'].items()} == {k: v['channels'] for k, v in base['clips'].items()}
        r['max_joint_offset_m'] = round(float(np.max(np.linalg.norm(np.array(r['joint_pos']) - np.array(base['joint_pos']), axis=1))), 4)
    for r in out.values():
        r.pop('joint_pos')
    json.dump(out, sys.stdout, indent=1)


if __name__ == '__main__':
    main()

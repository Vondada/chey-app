"""Re-reads a character GLB and measures what it really holds, so "it walks" or "it has 53 joints" is a measurement.

  python3 tools/avatar_body/verify_glb.py MODEL.glb [--expect-bones 53] [--clips idle,walk,wave,talk]
          [--morphs blink_l,blink_r,mouth_open,smile,brows_up] [--no-bpy]

Reads the file itself (GLB header, JSON and binary chunks; numpy only) and plays every clip through its own forward
kinematics from the stored keyframes:
- skin: joint count and names, inverse bind matrices, skinned vertices, the largest number of joints that move one
  vertex, and the share of skinned vertices whose weights sum to 1
- clips: one glTF animation each, with channel count, keyframe count and duration in seconds
- morph targets by name, and per clip the range each animated morph sweeps
- motion, measured on the joints in metres (glTF: Y up): hand_r travel and how far it rises above the head (wave),
  foot travel, foot lift, stance-foot slide and how steady a planted foot's height is (walk; an in-place cycle, so the
  planted foot moves back under the hips at walking speed), the lowest any foot goes (every clip; the floor is y = 0),
  and the jaw/mouth morph range (talk); the lowest skinned vertex near the floor (linear blend skinning) per clip
With the bpy module available (python3 with bpy, or Blender running this file through bl_run.py) it also imports the
file with Blender's own glTF importer and counts the bones, actions and shape keys Blender sees.

Prints one line `RIG_RECEIPT {json}` and exits 0 when every check passes, 1 when any fails (the receipt names them).

  python3 tools/avatar_body/verify_glb.py MODEL.glb --static [--expect-bbox 1.2,0.75,0.75 --tolerance 0.25] [--no-bpy]

--static (Create Object and Create Room, objects.py / rooms.py): a model with no skeleton. Measures mesh nodes,
primitives, vertices, triangles, materials (and primitives without one), and the bounding box in metres from every
vertex through its node's world transform (glTF axes: x width, y height, z depth), plus sha256 and bytes. With
--expect-bbox the box must match each dimension within the tolerance; the model must stand on y = 0 (within 1 cm).
Prints one line `GLB_RECEIPT {json}`; exit 0 when every check passes, 1 when any fails.
"""
import argparse
import hashlib
import json
import math
import os
import struct
import sys

import numpy as np

REQUIRED_BONES = ('pelvis', 'spine_01', 'spine_02', 'spine_03', 'neck_01', 'head', 'clavicle_l', 'clavicle_r',
                  'upperarm_l', 'upperarm_r', 'lowerarm_l', 'lowerarm_r', 'hand_l', 'hand_r', 'thigh_l', 'thigh_r',
                  'calf_l', 'calf_r', 'foot_l', 'foot_r', 'ball_l', 'ball_r')
COMP = {5120: ('b', 1), 5121: ('B', 1), 5122: ('h', 2), 5123: ('H', 2), 5125: ('I', 4), 5126: ('f', 4)}
NCOMP = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}
NORM = {5120: 127.0, 5121: 255.0, 5122: 32767.0, 5123: 65535.0}


def read_glb(path):
    with open(path, 'rb') as f: data = f.read()
    magic, version, length = struct.unpack_from('<4sII', data, 0)
    if magic != b'glTF' or version != 2: raise ValueError('not a glTF 2.0 binary')
    off, js, binary = 12, None, b''
    while off < min(length, len(data)):
        clen, ctype = struct.unpack_from('<I4s', data, off)
        chunk = data[off + 8: off + 8 + clen]
        if ctype == b'JSON': js = json.loads(chunk)
        elif ctype == b'BIN\0': binary = chunk
        off += 8 + clen
    if js is None: raise ValueError('no JSON chunk')
    return js, binary, data


def accessor(gl, binary, i):
    a = gl['accessors'][i]
    fmt, size = COMP[a['componentType']]; nc = NCOMP[a['type']]; count = a['count']
    out = np.zeros((count, nc), np.float64)
    if 'bufferView' in a:
        bv = gl['bufferViews'][a['bufferView']]
        start = bv.get('byteOffset', 0) + a.get('byteOffset', 0)
        stride = bv.get('byteStride') or size * nc
        dt = np.dtype(fmt).newbyteorder('<')
        if stride == size * nc:
            out = np.frombuffer(binary, dtype=dt, count=count * nc, offset=start).reshape(count, nc).astype(np.float64)
        else:
            for k in range(count):
                out[k] = np.frombuffer(binary, dtype=dt, count=nc, offset=start + k * stride)
        if a.get('normalized') and a['componentType'] in NORM: out = out / NORM[a['componentType']]
    if 'sparse' in a:
        s = a['sparse']; idx_bv = gl['bufferViews'][s['indices']['bufferView']]; val_bv = gl['bufferViews'][s['values']['bufferView']]
        ifmt, _ = COMP[s['indices']['componentType']]
        idx = np.frombuffer(binary, dtype=np.dtype(ifmt).newbyteorder('<'), count=s['count'],
                            offset=idx_bv.get('byteOffset', 0) + s['indices'].get('byteOffset', 0))
        vals = np.frombuffer(binary, dtype=np.dtype(fmt).newbyteorder('<'), count=s['count'] * nc,
                             offset=val_bv.get('byteOffset', 0) + s['values'].get('byteOffset', 0)).reshape(-1, nc)
        out[idx] = vals
    return out


def quat_mat(q):
    x, y, z, w = q
    return np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                     [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                     [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])


def trs(t, r, s):
    m = np.eye(4); m[:3, :3] = quat_mat(r) * np.asarray(s)[None, :]; m[:3, 3] = t
    return m


def sample(times, values, t, interp, path):
    """The channel's value at time t (LINEAR, STEP or CUBICSPLINE keys)."""
    if interp == 'CUBICSPLINE': values = values.reshape(len(times), 3, -1)[:, 1, :]   # the key values, not tangents
    else: values = values.reshape(len(times), -1)
    if t <= times[0]: return values[0]
    if t >= times[-1]: return values[-1]
    k = int(np.searchsorted(times, t) - 1); t0, t1 = times[k], times[k + 1]
    if interp == 'STEP': return values[k]
    u = (t - t0) / (t1 - t0) if t1 > t0 else 0.0
    a, b = values[k], values[k + 1]
    if path == 'rotation':
        if np.dot(a, b) < 0: b = -b
        q = a * (1 - u) + b * u
        return q / np.linalg.norm(q)
    return a * (1 - u) + b * u


class Scene:
    def __init__(self, gl):
        self.gl = gl; self.nodes = gl['nodes']
        self.parent = {}
        for i, n in enumerate(self.nodes):
            for c in n.get('children', []): self.parent[c] = i
        self.rest = []
        for n in self.nodes:
            self.rest.append({'translation': np.array(n.get('translation', [0, 0, 0]), float),
                              'rotation': np.array(n.get('rotation', [0, 0, 0, 1]), float),
                              'scale': np.array(n.get('scale', [1, 1, 1]), float), 'matrix': n.get('matrix')})

    def world(self, pose):
        """World matrices of every node for a {node: {path: value}} pose (unanimated channels stay at rest)."""
        out = {}

        def w(i):
            if i in out: return out[i]
            r = self.rest[i]; p = pose.get(i, {})
            if r['matrix'] is not None and not p: local = np.array(r['matrix'], float).reshape(4, 4).T
            else: local = trs(p.get('translation', r['translation']), p.get('rotation', r['rotation']), p.get('scale', r['scale']))
            out[i] = (w(self.parent[i]) @ local) if i in self.parent else local
            return out[i]
        for i in range(len(self.nodes)): w(i)
        return out


def verify(path, expect_bones=53, clips=('idle', 'walk', 'wave', 'talk'),
           morphs=('blink_l', 'blink_r', 'mouth_open', 'smile', 'brows_up'), fps=30):
    gl, binary, data = read_glb(path)
    fails = []
    rec = {'file': os.path.abspath(path), 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest(),
           'generator': gl.get('asset', {}).get('generator', '')}
    nodes = gl.get('nodes', [])
    # ── skin ──────────────────────────────────────────────────────────────────────────────────────────────────────────
    skins = gl.get('skins', [])
    joints = [nodes[j].get('name', f'node{j}') for j in skins[0]['joints']] if skins else []
    rec['skins'] = len(skins); rec['bones'] = len(joints)
    rec['inverse_bind_matrices'] = bool(skins and 'inverseBindMatrices' in skins[0])
    missing = [b for b in REQUIRED_BONES if b not in joints]
    rec['required_bones_missing'] = missing
    if len(joints) != expect_bones: fails.append(f'skeleton has {len(joints)} joints, expected {expect_bones}')
    if missing: fails.append(f'missing bones {missing}')
    if not rec['inverse_bind_matrices']: fails.append('no inverse bind matrices')
    # ── meshes: vertices, skin weights, morph targets ─────────────────────────────────────────────────────────────────
    verts = skinned = weighted = 0; max_inf = 0; names = []; meshes = []
    for ni, n in enumerate(nodes):
        if 'mesh' not in n: continue
        m = gl['meshes'][n['mesh']]; mv = 0
        tn = m.get('extras', {}).get('targetNames', [])
        if tn: names = names or tn
        for p in m['primitives']:
            a = p['attributes']; cnt = gl['accessors'][a['POSITION']]['count']; mv += cnt
            if 'skin' in n and 'WEIGHTS_0' in a:
                w = accessor(gl, binary, a['WEIGHTS_0'])
                for extra in ('WEIGHTS_1', 'WEIGHTS_2'):
                    if extra in a: w = np.concatenate([w, accessor(gl, binary, a[extra])], 1)
                skinned += cnt; weighted += int((np.abs(w.sum(1) - 1) < 0.01).sum())
                max_inf = max(max_inf, int((w > 1e-4).sum(1).max()))
        verts += mv; meshes.append({'name': n.get('name', m.get('name', '')), 'vertices': mv, 'skinned': 'skin' in n,
                                    'morph_targets': len(tn)})
    rec.update(vertices=verts, meshes=meshes, skinned_vertices=skinned, max_joint_influences=max_inf,
               weighted_fraction=round(weighted / skinned, 4) if skinned else 0.0, morphs=names)
    if not skinned: fails.append('no skinned mesh')
    elif weighted / skinned < 0.99: fails.append(f'only {weighted}/{skinned} skinned vertices have weights summing to 1')
    for mname in morphs:
        if mname not in names: fails.append(f'morph {mname} missing')
    # ── clips, played through forward kinematics ─────────────────────────────────────────────────────────────────
    sc = Scene(gl)
    jid = {nodes[j].get('name'): j for j in (skins[0]['joints'] if skins else [])}
    anims = {a.get('name', f'anim{i}'): a for i, a in enumerate(gl.get('animations', []))}
    rec['clips'] = {}; motion = {}; lowest = {}
    # The skinned vertices near the floor (bind pose below 30 cm: shoes, ankles), posed by linear blend skinning each
    # frame, so "never through the floor" is measured on the surface, not on the joints.
    low_parts = []
    if skins:
        ibm = accessor(gl, binary, skins[0]['inverseBindMatrices']).reshape(-1, 4, 4).transpose(0, 2, 1)
        for n in nodes:
            if 'mesh' not in n or 'skin' not in n: continue
            for p in gl['meshes'][n['mesh']]['primitives']:
                a = p['attributes']
                if 'JOINTS_0' not in a: continue
                pos = accessor(gl, binary, a['POSITION']); sel = pos[:, 1] < 0.3
                if sel.any():
                    low_parts.append((np.c_[pos[sel], np.ones(sel.sum())], accessor(gl, binary, a['JOINTS_0'])[sel].astype(int),
                                      accessor(gl, binary, a['WEIGHTS_0'])[sel]))

    def lowest_vertex(W):
        if not low_parts: return None
        J = np.stack([W[j] for j in skins[0]['joints']]) @ ibm
        out = []
        for v, jn, wt in low_parts:
            posed = np.einsum('vkij,vj->vki', J[jn], v)          # each influence's transform of the vertex
            out.append(float((posed[:, :, 1] * wt).sum(1).min()))
        return min(out)
    for name, a in anims.items():
        chans = []
        for c in a['channels']:
            s = a['samplers'][c['sampler']]
            t = accessor(gl, binary, s['input'])[:, 0]; v = accessor(gl, binary, s['output'])
            chans.append((c['target'].get('node'), c['target']['path'], t, v, s.get('interpolation', 'LINEAR')))
        dur = max((float(c[2][-1]) for c in chans), default=0.0)
        rec['clips'][name] = {'duration_s': round(dur, 3), 'channels': len(chans),
                              'keyframes': max((len(c[2]) for c in chans), default=0),
                              'paths': sorted({c[1] for c in chans})}
        frames = max(2, int(round(dur * fps)) + 1)
        track = {b: [] for b in ('hand_r', 'head', 'foot_l', 'foot_r', 'ball_l', 'ball_r') if b in jid}
        mw = {}; low_v = []
        for f in range(frames):
            t = dur * f / (frames - 1)
            pose = {}
            for node, pth, times, vals, interp in chans:
                if pth == 'weights':
                    for k, x in enumerate(sample(times, vals, t, interp, pth)): mw.setdefault(k, []).append(float(x))
                elif node is not None:
                    pose.setdefault(node, {})[pth] = sample(times, vals, t, interp, pth)
            W = sc.world(pose)
            for b in track: track[b].append(W[jid[b]][:3, 3].copy())
            lv = lowest_vertex(W)
            if lv is not None: low_v.append(lv)
        tr = {b: np.array(v) for b, v in track.items()}
        feet = [b for b in ('foot_l', 'foot_r', 'ball_l', 'ball_r') if b in tr]
        if low_v: lowest[name] = round(min(low_v), 4)
        mrange = {names[k] if k < len(names) else str(k): round(max(v) - min(v), 3) for k, v in mw.items()}
        m = {'lowest_vertex_m': lowest.get(name), 'morph_range': {k: v for k, v in mrange.items() if v > 0}}
        if feet: m['lowest_foot_joint_m'] = round(float(min(tr[b][:, 1].min() for b in feet)), 4)
        if 'hand_r' in tr:
            h = tr['hand_r']
            m['hand_r_travel_m'] = round(float(np.linalg.norm(h.max(0) - h.min(0))), 3)
            if 'head' in tr: m['hand_r_above_head_m'] = round(float((h[:, 1] - tr['head'][:, 1]).max()), 3)
        for s in 'lr':
            if f'foot_{s}' not in tr: continue
            p = tr[f'foot_{s}']; hz = p[:, [0, 2]]
            ground = p[:, 1].min(); stance = p[:, 1] < ground + 0.015
            m[f'foot_{s}_travel_m'] = round(float(np.ptp(p[:, 2])), 3)
            m[f'foot_{s}_lift_m'] = round(float(np.ptp(p[:, 1])), 3)
            if stance.sum() > 1:
                d = np.linalg.norm(np.diff(hz[stance], axis=0), axis=1)
                m[f'foot_{s}_stance_slide_m'] = round(float(d.sum()), 3)
                m[f'foot_{s}_stance_height_jitter_m'] = round(float(np.ptp(p[stance, 1])), 4)
                m[f'foot_{s}_stance_frames'] = int(stance.sum())
        motion[name] = m
    rec['motion'] = motion
    rec['notes'] = ('walk and run are in-place cycles (no root motion): a planted foot moves back under the hips at '
                    'walking speed, which is what stance_slide_m measures; game engines add the forward travel')
    for c in clips:
        if c not in anims: fails.append(f'clip {c} missing'); continue
        if rec['clips'][c]['duration_s'] <= 0: fails.append(f'clip {c} has no duration')
    # What each clip must actually do, measured on the joints and morphs.
    if 'walk' in motion:
        w = motion['walk']
        for s in 'lr':
            if w.get(f'foot_{s}_travel_m', 0) < 0.2: fails.append(f'walk: foot_{s} travels {w.get(f"foot_{s}_travel_m")} m (< 0.2)')
            if w.get(f'foot_{s}_lift_m', 0) < 0.03: fails.append(f'walk: foot_{s} lifts {w.get(f"foot_{s}_lift_m")} m (< 0.03)')
    if 'wave' in motion:
        w = motion['wave']
        if w.get('hand_r_travel_m', 0) < 0.25: fails.append(f"wave: hand_r travels {w.get('hand_r_travel_m')} m (< 0.25)")
        if w.get('hand_r_above_head_m', -1) <= 0: fails.append('wave: the right hand never rises above the head')
    if 'talk' in motion:
        r = motion['talk']['morph_range']
        if max(r.get('mouth_open', 0), r.get('jaw_open', 0)) < 0.3: fails.append(f"talk: mouth morph range {r.get('mouth_open', 0)} (< 0.3)")
    # The floor is y = 0; the shoe soles may sink 1.5 cm (sole thickness, skinning) before it counts as through it.
    for c, low in lowest.items():
        if low < -0.015: fails.append(f'{c}: the feet go {-low:.3f} m through the floor')
    rec['bpy_import'] = None
    rec['failures'] = fails
    rec['ok'] = not fails
    return rec


MAX_TRIANGLES = 600_000


def verify_static(path, expect_bbox=None, tolerance=0.25):
    """What a static model (no skin) really holds, measured from the file."""
    gl, binary, data = read_glb(path)
    fails = []
    rec = {'file': os.path.abspath(path), 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest(),
           'generator': gl.get('asset', {}).get('generator', '')}
    W = Scene(gl).world({}) if gl.get('nodes') else {}
    mesh_nodes = prims = verts = tris = unmat = 0
    lo, hi = np.full(3, np.inf), np.full(3, -np.inf)
    used = set()
    for ni, n in enumerate(gl.get('nodes', [])):
        if 'mesh' not in n: continue
        mesh_nodes += 1
        for p in gl['meshes'][n['mesh']]['primitives']:
            prims += 1
            pos = accessor(gl, binary, p['attributes']['POSITION'])
            verts += len(pos)
            if p.get('mode', 4) == 4: tris += (gl['accessors'][p['indices']]['count'] if 'indices' in p else len(pos)) // 3
            if 'material' in p: used.add(p['material'])
            else: unmat += 1
            world = (W[ni] @ np.c_[pos, np.ones(len(pos))].T).T[:, :3]
            lo, hi = np.minimum(lo, world.min(0)), np.maximum(hi, world.max(0))
    names = [m.get('name', f'material{i}') for i, m in enumerate(gl.get('materials', []))]
    rec.update(meshes=mesh_nodes, primitives=prims, vertices=verts, triangles=tris, skins=len(gl.get('skins', [])),
               animations=len(gl.get('animations', [])), materials=sorted({names[i] for i in used if i < len(names)}),
               primitives_without_material=unmat)
    if not mesh_nodes:
        fails.append('no mesh'); lo = hi = np.zeros(3)
    size = hi - lo
    rec['bbox_m'] = {'min': [round(float(x), 4) for x in lo], 'max': [round(float(x), 4) for x in hi],
                     'size': [round(float(x), 4) for x in size]}
    if mesh_nodes and not tris: fails.append('no triangles')
    if tris > MAX_TRIANGLES: fails.append(f'{tris} triangles (more than {MAX_TRIANGLES})')
    if unmat: fails.append(f'{unmat} primitives have no material')
    if mesh_nodes and abs(float(lo[1])) > 0.01: fails.append(f'the model does not stand on the floor (lowest point y = {float(lo[1]):.3f} m)')
    if expect_bbox:
        rec['expected_bbox_m'] = [round(float(x), 4) for x in expect_bbox]; rec['tolerance'] = tolerance
        for axis, want, got in zip('xyz', expect_bbox, size):
            if want > 0 and abs(float(got) - want) > tolerance * want:
                fails.append(f'{axis} size {float(got):.3f} m, expected {want:.3f} m (within {round(tolerance * 100)}%)')
    rec['bpy_import'] = None
    rec['failures'] = fails
    rec['ok'] = not fails
    return rec


def main_static(a):
    try:
        bbox = [float(x) for x in a.expect_bbox.split(',')] if a.expect_bbox else None
        rec = verify_static(a.glb, bbox, a.tolerance)
        if not a.no_bpy:
            imp = bpy_import(os.path.abspath(a.glb))
            if imp is not None:
                import bpy
                n = sum(1 for o in bpy.data.objects if o.type == 'MESH')
                rec['bpy_import'] = {'mesh_objects': n, 'armatures': imp['armatures']}
                if n != rec['meshes']: rec['failures'].append(f"Blender imports {n} mesh objects, the file lists {rec['meshes']}")
                rec['ok'] = not rec['failures']
    except (OSError, ValueError, KeyError, IndexError, struct.error) as e:
        rec = {'ok': False, 'file': os.path.abspath(a.glb), 'failures': [f'unreadable GLB: {type(e).__name__}: {e}']}
    print('GLB_RECEIPT ' + json.dumps(rec, separators=(',', ':')), flush=True)
    return 0 if rec['ok'] else 1


def bpy_import(path):
    """What Blender's own glTF importer sees in the file (None without the bpy module)."""
    try:
        import bpy
    except ImportError:
        return None
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.scene.render.fps = 30
    bpy.ops.import_scene.gltf(filepath=path)
    arms = [o for o in bpy.data.objects if o.type == 'ARMATURE']
    keys = [o for o in bpy.data.objects if o.type == 'MESH' and o.data.shape_keys]
    return {'armatures': len(arms), 'bones': len(arms[0].data.bones) if arms else 0,
            'actions': sorted(a.name for a in bpy.data.actions),
            'shape_keys': [k.name for k in keys[0].data.shape_keys.key_blocks[1:]] if keys else [],
            'meshes': sum(1 for o in bpy.data.objects if o.type == 'MESH' and o.parent in arms)}


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('glb'); ap.add_argument('--expect-bones', type=int, default=53)
    ap.add_argument('--clips', default='idle,walk,wave,talk'); ap.add_argument('--morphs', default='blink_l,blink_r,mouth_open,smile,brows_up')
    ap.add_argument('--no-bpy', action='store_true')
    ap.add_argument('--static', action='store_true', help='a model with no skeleton (objects.py, rooms.py)')
    ap.add_argument('--expect-bbox', default='', help='x,y,z in metres (glTF axes) for --static')
    ap.add_argument('--tolerance', type=float, default=0.25)
    a = ap.parse_args(argv)
    if a.static: return main_static(a)
    try:
        rec = verify(a.glb, a.expect_bones, [c for c in a.clips.split(',') if c], [m for m in a.morphs.split(',') if m])
        if not a.no_bpy:
            imp = bpy_import(os.path.abspath(a.glb))
            rec['bpy_import'] = imp
            if imp is not None:
                if imp['bones'] != rec['bones']: rec['failures'].append(f"Blender imports {imp['bones']} bones, the file lists {rec['bones']}")
                for c in a.clips.split(','):
                    if c and c not in imp['actions']: rec['failures'].append(f'Blender imports no {c} action')
                rec['ok'] = not rec['failures']
    except (OSError, ValueError, KeyError, IndexError, struct.error) as e:
        rec = {'ok': False, 'file': os.path.abspath(a.glb), 'failures': [f'unreadable GLB: {type(e).__name__}: {e}']}
    print('RIG_RECEIPT ' + json.dumps(rec, separators=(',', ':')), flush=True)
    return 0 if rec['ok'] else 1


if __name__ == '__main__':
    sys.exit(main())

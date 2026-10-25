"""Measure a saved character GLB without Blender (pure Python: the GLB container, its glTF JSON and the binary buffer).

  python3 glb_inspect.py MODEL.glb [--json]         prints INSPECT <json>
  python3 glb_inspect.py A.glb --compare B.glb      also prints the per-measure difference (B - A)

What it reports, all read from the file itself:
- meshes: name, vertex count, material names, and each mesh's rest-pose bounding box (POSITION min/max as the file
  stores them, metres, glTF Y up), so a node's mesh can be found by name ("Body", "Hair", "HairBun", "HairLong",
  "Shoes", "Eye_l" ...);
- height_m: the whole character's rest-pose height (max Y - min Y over all mesh positions, node translations applied);
- body: the Body mesh's widths at chest, waist and hip height (the extent along X of the vertices in a 3 cm slab at
  72 %, 61 % and 53 % of the height) and its vertex positions' centroid, for build changes;
- head: width and height of the Body's vertices above the neck (the top 13 % of the height), and the face-region
  vertex count, for face shape changes;
- hair: present, style (from the hair mesh names and the material), meshes and vertex count;
- clothing: garment material names (Top, Trousers, Shoes) found on the meshes;
- rig: joint count, animation names, morph target names.
- materials: each material's base colour as sRGB 0-255 (glTF stores it linear), roughness, specular-free emissive
  factor; skin_srgb is the Skin material's colour (the described skin tone, after the look's saturation);
- face_parts: brows, lashes and hair cards (mesh present, vertex count) and, for brows and lashes, how far each morph
  target moves them at most (mm), so a blink that leaves the lashes behind shows as 0;
- eyes: the eye spheres' centre distance and radius and their ratio to the height (head proportion: the stylized look
  scales the head, so its eyes sit further apart relative to the body).
Nothing is rendered and nothing is estimated: a measure the file does not hold is null.
"""
import json
import struct
import sys

COMP = {5120: ('b', 1), 5121: ('B', 1), 5122: ('h', 2), 5123: ('H', 2), 5125: ('I', 4), 5126: ('f', 4)}
NCOMP = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}


def read_glb(path):
    with open(path, 'rb') as f: data = f.read()
    magic, version, length = struct.unpack_from('<4sII', data, 0)
    if magic != b'glTF': raise ValueError('not a GLB file')
    off, js, binary = 12, None, b''
    while off < len(data):
        n, kind = struct.unpack_from('<I4s', data, off); off += 8
        chunk = data[off:off + n]; off += n
        if kind == b'JSON': js = json.loads(chunk)
        elif kind == b'BIN\x00': binary = chunk
    return js, binary


def accessor(js, binary, i):
    a = js['accessors'][i]
    fmt, size = COMP[a['componentType']]; k = NCOMP[a['type']]
    if 'bufferView' in a:
        bv = js['bufferViews'][a['bufferView']]
        stride = bv.get('byteStride') or size * k
        base = bv.get('byteOffset', 0) + a.get('byteOffset', 0)
        out = [struct.unpack_from('<' + fmt * k, binary, base + n * stride) for n in range(a['count'])]
    else:   # no buffer view: all zeros (glTF 2.0 3.6.2), then the sparse values below
        out = [(0,) * k for _ in range(a['count'])]
    sp = a.get('sparse')
    if sp:   # morph targets are written sparse: only the moved vertices are stored
        ib, vb = sp['indices'], sp['values']
        ifmt, isz = COMP[ib['componentType']]
        ibv, vbv = js['bufferViews'][ib['bufferView']], js['bufferViews'][vb['bufferView']]
        io = ibv.get('byteOffset', 0) + ib.get('byteOffset', 0); vo = vbv.get('byteOffset', 0) + vb.get('byteOffset', 0)
        for n in range(sp['count']):
            j = struct.unpack_from('<' + ifmt, binary, io + n * isz)[0]
            out[j] = struct.unpack_from('<' + fmt * k, binary, vo + n * size * k)
    return out


def world_offsets(js):
    """Node index -> summed translation of the node and its parents (the exporter keeps rotations and scales identity
    on CHE's characters; a node that has them is reported, not silently ignored)."""
    parent = {}
    for i, n in enumerate(js.get('nodes', [])):
        for ch in n.get('children', []): parent[ch] = i
    warn = []

    def off(i):
        t = [0.0, 0.0, 0.0]
        while i is not None:
            n = js['nodes'][i]
            if n.get('rotation', [0, 0, 0, 1]) != [0, 0, 0, 1] or n.get('scale', [1, 1, 1]) != [1, 1, 1]:
                warn.append(n.get('name', str(i)))
            for k, x in enumerate(n.get('translation', [0, 0, 0])): t[k] += x
            i = parent.get(i)
        return t
    return off, warn


def inspect(path):
    js, binary = read_glb(path)
    mats = [m.get('name', '') for m in js.get('materials', [])]
    off, warn = world_offsets(js)
    meshes, allpos, body = [], [], None
    for ni, node in enumerate(js.get('nodes', [])):
        if 'mesh' not in node: continue
        m = js['meshes'][node['mesh']]
        t = off(ni)
        verts, names, pos = 0, set(), []
        for prim in m['primitives']:
            p = [(x + t[0], y + t[1], z + t[2]) for x, y, z in accessor(js, binary, prim['attributes']['POSITION'])]
            pos += p; verts += len(p)
            if 'material' in prim: names.add(mats[prim['material']])
        lo = [min(q[k] for q in pos) for k in range(3)]; hi = [max(q[k] for q in pos) for k in range(3)]
        name = node.get('name') or m.get('name', '')
        meshes.append({'name': name, 'vertices': verts, 'materials': sorted(names),
                       'bbox_min': [round(x, 4) for x in lo], 'bbox_max': [round(x, 4) for x in hi],
                       'morphs': (m.get('extras') or {}).get('targetNames', [])})
        allpos += pos
        if name == 'Body': body = pos
    rep = {'file_bytes': len(binary), 'meshes': meshes, 'vertices': sum(m['vertices'] for m in meshes), 'warnings': sorted(set(warn))}
    if allpos:
        ys = [q[1] for q in allpos]
        rep['height_m'] = round(max(ys) - min(ys), 4)
        rep['floor_y'] = round(min(ys), 4)
    rep['body'] = body_measures(body, rep.get('floor_y', 0.0)) if body else None
    hair = [m for m in meshes if m['name'].lower().startswith('hair') or any('hair' in x.lower() or 'beanie' in x.lower() for x in m['materials'])]
    style = None
    names = {m['name'] for m in hair}
    if 'HairBun' in names: style = 'bun'
    elif 'HairLong' in names: style = 'long'
    elif hair: style = 'cap'
    rep['hair'] = {'present': bool(hair), 'meshes': sorted(names), 'vertices': sum(m['vertices'] for m in hair),
                   'kind': style, 'materials': sorted({x for m in hair for x in m['materials']}),
                   'bbox_max_y': max((m['bbox_max'][1] for m in hair), default=None)}
    garments = sorted({x for m in meshes for x in m['materials'] if x.split('.')[0] in ('Top', 'Trousers', 'Shoes', 'Beanie')})
    rep['clothing'] = {'garment_materials': garments, 'meshes_with_garments': sorted(m['name'] for m in meshes if set(m['materials']) & set(garments))}
    rep['character'] = (js.get('asset', {}).get('extras') or {}).get('che_character')
    rep['materials'] = materials(js)
    rep['skin_srgb'] = (rep['materials'].get('Skin') or {}).get('base_srgb')
    by_name = {m['name']: m for m in meshes}
    mesh_of = {(n.get('name') or ''): js['meshes'][n['mesh']] for n in js.get('nodes', []) if 'mesh' in n}
    rep['face_parts'] = {}
    for part in ('Brows', 'Lashes', 'HairCards'):
        m = by_name.get(part)
        rep['face_parts'][part.lower()] = {'present': bool(m and m['vertices']), 'vertices': m['vertices'] if m else 0,
                                          'morph_max_mm': morph_reach(js, binary, mesh_of[part]) if m and part != 'HairCards' else {}}
    el, er = by_name.get('Eye_l'), by_name.get('Eye_r')
    if el and er:
        cen = lambda m: [(a + b) / 2 for a, b in zip(m['bbox_min'], m['bbox_max'])]
        gap = sum((a - b) ** 2 for a, b in zip(cen(el), cen(er))) ** 0.5
        rep['eyes'] = {'interocular_m': round(gap, 4), 'radius_m': round((el['bbox_max'][0] - el['bbox_min'][0]) / 2, 4),
                       'interocular_per_height': round(gap / rep['height_m'], 5) if rep.get('height_m') else None}
    else:
        rep['eyes'] = None
    skins = js.get('skins', [])
    rep['rig'] = {'joints': len(skins[0]['joints']) if skins else 0,
                  'animations': [a.get('name', '') for a in js.get('animations', [])],
                  'morphs': sorted({x for m in meshes for x in m['morphs']})}
    return rep


def to_srgb(x):
    x = max(0.0, min(1.0, float(x)))
    return int(round((x * 12.92 if x <= 0.0031308 else 1.055 * x ** (1 / 2.4) - 0.055) * 255))


def materials(js):
    out = {}
    for m in js.get('materials', []):
        pbr = m.get('pbrMetallicRoughness', {})
        base = pbr.get('baseColorFactor', [1, 1, 1, 1])
        strength = ((m.get('extensions') or {}).get('KHR_materials_emissive_strength') or {}).get('emissiveStrength', 1.0)
        out[m.get('name', '')] = {'base_srgb': [to_srgb(c) for c in base[:3]], 'base_linear': [round(c, 4) for c in base[:3]],
                                  'roughness': round(pbr.get('roughnessFactor', 1.0), 3),
                                  'emissive': [round(c * strength, 4) for c in m.get('emissiveFactor', [0, 0, 0])]}
    return out


def morph_reach(js, binary, mesh):
    """{target name: largest vertex displacement in mm} for a mesh's morph targets."""
    names = (mesh.get('extras') or {}).get('targetNames', [])
    out = {}
    for prim in mesh['primitives']:
        for k, t in enumerate(prim.get('targets', [])):
            if 'POSITION' not in t: continue
            d = max((sum(c * c for c in v) ** 0.5 for v in accessor(js, binary, t['POSITION'])), default=0.0)
            key = names[k] if k < len(names) else str(k)
            out[key] = max(out.get(key, 0.0), round(d * 1000, 2))
    return out


def body_measures(pos, floor):
    ys = [q[1] for q in pos]; top = max(ys); h = top - floor

    def torso_row(frac, slab=0.015):
        """The slab's vertices on the torso only: the contiguous run of x around the centre line (the hanging arms are
        separated from it by a gap of more than 2 cm)."""
        y = floor + frac * h
        row = sorted((q for q in pos if abs(q[1] - y) < slab), key=lambda q: q[0])
        if not row: return []
        i = min(range(len(row)), key=lambda k: abs(row[k][0]))
        lo = hi = i
        while lo > 0 and row[lo][0] - row[lo - 1][0] < 0.02: lo -= 1
        while hi < len(row) - 1 and row[hi + 1][0] - row[hi][0] < 0.02: hi += 1
        return row[lo:hi + 1]

    def width_at(frac):
        row = torso_row(frac)
        return round(row[-1][0] - row[0][0], 4) if row else None

    def depth_at(frac):
        row = torso_row(frac)
        return round(max(q[2] for q in row) - min(q[2] for q in row), 4) if row else None
    head = [q for q in pos if q[1] > top - 0.13 * h]
    out = {'height_m': round(h, 4), 'chest_w': width_at(0.72), 'waist_w': width_at(0.61), 'hip_w': width_at(0.53),
           'chest_d': depth_at(0.72), 'waist_d': depth_at(0.61),
           'centroid': [round(sum(q[k] for q in pos) / len(pos), 4) for k in range(3)]}
    if head:
        out['head_w'] = round(max(q[0] for q in head) - min(q[0] for q in head), 4)
        out['head_h'] = round(max(q[1] for q in head) - min(q[1] for q in head), 4)
        out['head_d'] = round(max(q[2] for q in head) - min(q[2] for q in head), 4)
        out['face'] = face_measures(head)
    return out


def face_measures(head):
    """The face (front half of the head, glTF +Z forward): its widths at the cheek and jaw, length from the nose tip
    to the chin, and how far the nose tip stands out. Rest pose, metres."""
    zmax = max(q[2] for q in head); zmid = (zmax + min(q[2] for q in head)) / 2
    front = [q for q in head if q[2] > zmid]
    tip = max(front, key=lambda q: q[2])                      # the nose tip: the front-most point
    chin = min((q for q in front if abs(q[0]) < 0.01), key=lambda q: q[1] if q[2] > tip[2] - 0.06 else 9, default=tip)

    def width(y, slab=0.006):
        row = [q[0] for q in front if abs(q[1] - y) < slab]
        return round(max(row) - min(row), 4) if row else None
    return {'nose_tip_y': round(tip[1], 4), 'nose_tip_z': round(tip[2], 4), 'chin_y': round(chin[1], 4),
            'nose_to_chin': round(tip[1] - chin[1], 4), 'cheek_w': width(tip[1] + 0.01), 'jaw_w': width((tip[1] + chin[1]) / 2),
            'nose_w': nose_width(front, tip)}


def nose_width(front, tip):
    """Width of the nose wings: the extent in x of the front vertices within 1.2 cm behind the tip, 0.5-1.5 cm below it."""
    row = [q[0] for q in front if tip[2] - 0.022 < q[2] and tip[1] - 0.02 < q[1] < tip[1] + 0.002 and abs(q[0]) < 0.03]
    return round(max(row) - min(row), 4) if row else None


def compare(a, b):
    """B - A for every numeric measure both reports hold (body, height, hair vertices)."""
    out = {'height_m': round(b['height_m'] - a['height_m'], 4) if a.get('height_m') and b.get('height_m') else None}
    for k, v in (a.get('body') or {}).items():
        w = (b.get('body') or {}).get(k)
        if isinstance(v, (int, float)) and isinstance(w, (int, float)): out[f'body.{k}'] = round(w - v, 4)
    for k, v in ((a.get('body') or {}).get('face') or {}).items():
        w = ((b.get('body') or {}).get('face') or {}).get(k)
        if isinstance(v, (int, float)) and isinstance(w, (int, float)): out[f'face.{k}'] = round(w - v, 4)
    out['hair.vertices'] = b['hair']['vertices'] - a['hair']['vertices']
    out['vertices'] = b['vertices'] - a['vertices']
    return out


def face_shift(path_a, path_b, top_frac=0.13):
    """Mean and max distance (metres) between the Body's head vertices in two GLBs with the same topology (the face
    region moves when face sliders change). None when the vertex counts differ."""
    pa, pb = [], []
    for path, out in ((path_a, pa), (path_b, pb)):
        js, binary = read_glb(path)
        for node in js['nodes']:
            if node.get('name') == 'Body' and 'mesh' in node:
                for prim in js['meshes'][node['mesh']]['primitives']:
                    out += accessor(js, binary, prim['attributes']['POSITION'])
    if len(pa) != len(pb) or not pa: return None
    top = max(q[1] for q in pa); low = min(q[1] for q in pa); cut = top - top_frac * (top - low)
    d = [sum((x - y) ** 2 for x, y in zip(p, q)) ** 0.5 for p, q in zip(pa, pb) if p[1] > cut]
    return {'head_vertices': len(d), 'mean_m': round(sum(d) / len(d), 5), 'max_m': round(max(d), 5),
            'moved_over_1mm': sum(1 for x in d if x > 0.001)}


def main():
    args = sys.argv[1:]
    if not args: print(__doc__); return 2
    rep = inspect(args[0])
    print('INSPECT ' + json.dumps(rep))
    if '--compare' in args:
        other = args[args.index('--compare') + 1]
        rb = inspect(other)
        print('COMPARE ' + json.dumps({'delta': compare(rep, rb), 'face_shift': face_shift(args[0], other)}))
    return 0


if __name__ == '__main__':
    sys.exit(main())

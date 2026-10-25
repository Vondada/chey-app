"""Create Room: a procedural parametric room built in Blender from a small spec and exported as GLB.

  python3 rooms.py      env: SPEC_JSON (the spec, JSON text; see creation_params.py), EXPORT_GLB (model.glb path)
  blender -b --factory-startup -P ../avatar_face/bl_run.py -- rooms.py

Four room types (living room, bedroom, office, studio) with width, depth and ceiling height in metres, wall colour,
floor (oak or walnut planks, tile, concrete, carpet), a furniture list and warm, neutral or cool light. The floor and
two walls (back and left, with a window and skirting) are built and the front and right are left open, with no
ceiling, so the viewport and the previews can look in. Furniture comes from the object families (objects.py: lamp,
chair, table, desk, mug, vase, shelf) plus the pieces only rooms have (sofa, bed, rug, plant), at true size, placed by
fixed rules against the walls; a piece that does not fit without overlapping another is left out and named.

Prints LAYOUT {json} (placed and skipped pieces) and MODEL <path> <bytes> bytes <vertices> vertices (<contents>).
The light colour is kept in the GLB as the lamp bulbs' and window's emission; render_creation.py adds the matching
lamps for the previews.
"""
import json
import math
import os
import sys

import bpy
import bmesh  # noqa: E402
from mathutils import Matrix

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import objects as O  # noqa: E402
from creation_params import NOMINAL, WALL, SpecError, describe, hex_rgb, validate_room  # noqa: E402

LIGHT = {'warm': (1.0, 0.78, 0.55), 'neutral': (1.0, 0.95, 0.88), 'cool': (0.8, 0.9, 1.0)}
WINDOW = {'warm': (1.0, 0.86, 0.68), 'neutral': (0.92, 0.95, 1.0), 'cool': (0.82, 0.9, 1.0)}
FLOOR = {'oak': ((0.30, 0.17, 0.08), 0.4), 'walnut': ((0.12, 0.06, 0.03), 0.38), 'tile': ((0.62, 0.62, 0.6), 0.22),
         'concrete': ((0.33, 0.33, 0.32), 0.8), 'carpet': ((0.36, 0.34, 0.31), 1.0)}
FLOOR_TEXTURE = {'oak': 'wood', 'walnut': 'wood', 'tile': 'tile', 'concrete': 'concrete', 'carpet': 'fabric'}
FLOOR_REPEAT_M = {'oak': 1.0, 'walnut': 1.0, 'tile': 1.2, 'concrete': 2.0, 'carpet': 1.0}   # metres one image covers
SOFA = {'modern': '#4a5a60', 'classic': '#7a2a2a', 'industrial': '#5a4030'}


def boxes(name, mat_, items):
    """Many boxes as one mesh object: items are (centre, size) in metres."""
    me = bpy.data.meshes.new(name); bm = bmesh.new()
    for c, s in items:
        m = Matrix.Translation(c) @ Matrix.Diagonal((s[0], s[1], s[2], 1.0))
        bmesh.ops.create_cube(bm, size=1.0, matrix=m)
    bm.to_mesh(me); bm.free()
    o = bpy.data.objects.new(name, me); bpy.context.scene.collection.objects.link(o); me.materials.append(mat_)
    return o


def shell(spec):
    """Floor, back wall (+Y) and left wall (-X), skirting and a window; open to the front and right, no ceiling."""
    W, D, H = spec['width'], spec['depth'], spec['height']
    rgb, rough = FLOOR[spec['floor']]
    floor = O.mat(f"Floor ({spec['floor']})", rgb, rough)
    t = 0.008
    if spec['floor'] in ('oak', 'walnut'):    # planks 18 cm wide running front to back, 2 mm gaps
        n = max(1, int(W / 0.18)); pw = W / n
        planks = [((-W / 2 + pw * (k + 0.5), 0, -t / 2), (pw - 0.002, D, t)) for k in range(n)]
        boxes('room_floor', floor, planks)
        boxes('room_floor_gaps', O.mat('Floor gaps', (0.03, 0.02, 0.01), 0.9), [((0, 0, -t / 2), (W, D, 0.002))])
    elif spec['floor'] == 'tile':             # 60 cm tiles, 4 mm grout
        nx, ny = max(1, round(W / 0.6)), max(1, round(D / 0.6)); tx, ty = W / nx, D / ny
        boxes('room_floor', floor, [((-W / 2 + tx * (i + 0.5), -D / 2 + ty * (j + 0.5), -t / 2), (tx - 0.004, ty - 0.004, t))
                                    for i in range(nx) for j in range(ny)])
        boxes('room_floor_grout', O.mat('Grout', (0.3, 0.3, 0.29), 0.9), [((0, 0, -t / 2), (W, D, 0.002))])
    else:
        boxes('room_floor', floor, [((0, 0, -t / 2), (W, D, t))])
    # A CC0 floor texture when the job fetched one (cc0_textures.py: oak and walnut take wood, tile, concrete, carpet
    # takes fabric), tiled at real scale by box-projected UVs; otherwise the plain floor colour above stays.
    tex = O.textured(FLOOR_TEXTURE[spec['floor']], rgb, rough, metres=FLOOR_REPEAT_M[spec['floor']])
    if tex is not None:
        fo = bpy.data.objects['room_floor']; fo.data.materials.clear(); fo.data.materials.append(tex)
        bpy.context.view_layer.update(); O.box_uv(fo)
    wall = O.mat('Walls', hex_rgb(spec['wall_color']), 0.85)
    boxes('room_wall_back', wall, [((-WALL / 2, D / 2 + WALL / 2, H / 2), (W + WALL, WALL, H))])
    boxes('room_wall_left', wall, [((-W / 2 - WALL / 2, 0, H / 2), (WALL, D, H))])
    skirt = O.fixed('Ceramic white') if spec['style'] != 'industrial' else O.fixed('Dark metal')
    boxes('room_skirting', skirt, [((0, D / 2 - 0.006, 0.05), (W, 0.012, 0.1)), ((-W / 2 + 0.006, 0, 0.05), (0.012, D, 0.1))])
    # The window: glowing glass with a frame and one mullion, on the back wall right of centre.
    ww, wh = min(1.4, W * 0.32), min(1.3, H * 0.45); wx, wz = W * 0.12, min(H - wh / 2 - 0.35, 1.55)
    glow = O.mat('Window light', (1, 1, 1), 0.5, emit=WINDOW[spec['lighting']], strength=4)
    boxes('room_window_glass', glow, [((wx, D / 2 - 0.004, wz), (ww, 0.008, wh))])
    frame = O.fixed('Oak') if spec['style'] == 'classic' else O.fixed('Dark metal') if spec['style'] == 'industrial' else O.fixed('Ceramic white')
    f = 0.05
    boxes('room_window_frame', frame, [((wx, D / 2 - 0.02, wz + wh / 2), (ww + 2 * f, 0.04, f)), ((wx, D / 2 - 0.02, wz - wh / 2), (ww + 2 * f, 0.04, f)),
                                       ((wx - ww / 2, D / 2 - 0.02, wz), (f, 0.04, wh)), ((wx + ww / 2, D / 2 - 0.02, wz), (f, 0.04, wh)),
                                       ((wx, D / 2 - 0.02, wz), (0.03, 0.03, wh))])
    return wx, ww


# ── room-only pieces (front facing -Y, standing on z = 0, centred) ──────────────────────────────────────────────────


def sofa(style, at, rot):
    fab = O.mat(f'Sofa fabric ({style})', hex_rgb(SOFA[style]), 0.9)
    legs = O.fixed('Dark metal') if style == 'industrial' else O.fixed('Walnut')
    parts = [O.box(fab, (0, 0.05, 0.3), (1.9, 0.8, 0.2), bevel=0.04, name='sofa_seat'),
             O.box(fab, (0, 0.36, 0.6), (1.9, 0.18, 0.5), bevel=0.05, name='sofa_back')]
    for k, x in enumerate((-0.95, 0.95)): parts.append(O.box(fab, (x, 0.05, 0.38), (0.12, 0.8, 0.36), bevel=0.04, name=f'sofa_arm_{k}'))
    for k, x in enumerate((-0.45, 0.45)): parts.append(O.box(fab, (x, 0.02, 0.45), (0.86, 0.66, 0.12), bevel=0.05, name=f'sofa_cushion_{k}'))
    for k, (x, y) in enumerate(((-0.9, -0.3), (0.9, -0.3), (-0.9, 0.4), (0.9, 0.4))):
        parts.append(O.prim('cylinder', legs, (x, y, 0.1), vertices=12, radius=0.025, depth=0.2, name=f'sofa_leg_{k}'))
    return group('sofa', parts, at, rot)


def bed(style, at, rot):
    frame = O.fixed('Dark metal') if style == 'industrial' else O.fixed('Oak' if style == 'modern' else 'Walnut')
    linen = O.fixed('Linen'); blanket = O.mat(f'Blanket ({style})', hex_rgb('#1f6f78' if style != 'classic' else '#6a2e1a'), 0.95)
    parts = [O.box(frame, (0, 0, 0.18), (1.6, 2.1, 0.16), bevel=0.01, name='bed_frame'),
             O.box(frame, (0, 1.02, 0.55), (1.6, 0.06, 1.1), bevel=0.01, name='bed_headboard'),
             O.box(linen, (0, -0.02, 0.36), (1.52, 2.0, 0.2), bevel=0.04, name='bed_mattress'),
             O.box(blanket, (0, -0.32, 0.47), (1.56, 1.4, 0.04), bevel=0.015, name='bed_blanket')]
    for k, x in enumerate((-0.4, 0.4)): parts.append(O.box(linen, (x, 0.78, 0.52), (0.6, 0.32, 0.12), bevel=0.05, name=f'bed_pillow_{k}'))
    for k, (x, y) in enumerate(((-0.75, -1.0), (0.75, -1.0), (-0.75, 1.0), (0.75, 1.0))):
        parts.append(O.box(frame, (x, y, 0.05), (0.06, 0.06, 0.1), name=f'bed_leg_{k}'))
    return group('bed', parts, at, rot)


def rug(style, at, size):
    m = O.mat(f'Rug ({style})', hex_rgb({'modern': '#9a958c', 'classic': '#7a3a2a', 'industrial': '#4a4440'}[style]), 1.0)
    if style == 'classic':
        o = O.prim('cylinder', m, (0, 0, 0.005), vertices=64, radius=1, depth=0.01, name='rug'); o.scale = (size[0] / 2, size[1] / 2, 1)
        return group('rug', [o], at, 0)
    return group('rug', [O.box(m, (0, 0, 0.005), (size[0], size[1], 0.01), name='rug')], at, 0)


def plant(style, at, rot):
    pot = O.fixed('Ceramic white') if style != 'industrial' else O.fixed('Dark metal')
    leaf = O.mat('Leaves', (0.08, 0.28, 0.08), 0.6)
    parts = [O.lathe(pot, [(0.0, 0.0), (0.15, 0.0), (0.2, 0.38), (0.18, 0.38), (0.13, 0.03), (0.0, 0.03)], 32, name='plant_pot')]
    for k, (dx, dy, dz, r) in enumerate(((0, 0, 0.6, 0.22), (0.1, -0.06, 0.82, 0.17), (-0.09, 0.06, 0.88, 0.15), (0.02, 0.03, 1.05, 0.12))):
        parts.append(O.prim('ico_sphere', leaf, (dx, dy, dz), radius=r, subdivisions=2, name=f'plant_leaves_{k}'))
    parts.append(O.rod(O.fixed('Walnut'), (0, 0, 0.3), (0, 0, 0.6), 0.015, 'plant_stem'))
    return group('plant', parts, at, rot)


def group(name, parts, at, rot):
    root = bpy.data.objects.new(name, None); bpy.context.scene.collection.objects.link(root)
    for o in parts: o.parent = root
    root.location = at; root.rotation_euler = (0, 0, rot)
    return root


# ── layout: fixed rules, checked for overlaps ─────────────────────────────────────────────────────────────────────
FOOT = {'sofa': (2.02, 0.9), 'bed': (1.6, 2.1), 'plant': (0.4, 0.4), 'lamp': NOMINAL[('lamp', 'floor')][::2],
        'shelf': (0.94, 0.32), 'chair': (0.46, 0.5), 'desk': (1.2, 0.6), 'table_dining': (1.2, 0.75), 'table_coffee': (1.0, 0.55),
        'vase_floor': (0.18, 0.18)}


def layout(spec):
    """Where each piece goes: [(item, x, y, rot, extra)] and [(item, reason)] for pieces that do not fit."""
    W, D = spec['width'], spec['depth']; items = spec['furniture']
    placed, skipped, rects = [], [], []
    left, right, front, back = -W / 2, W / 2, -D / 2, D / 2

    def fits(cx, cy, w, d):
        x0, x1, y0, y1 = cx - w / 2, cx + w / 2, cy - d / 2, cy + d / 2
        if x0 < left - 1e-6 or x1 > right + 1e-6 or y0 < front - 1e-6 or y1 > back + 1e-6: return False
        return all(x1 <= a0 + 0.02 or x0 >= a1 - 0.02 or y1 <= b0 + 0.02 or y0 >= b1 - 0.02 for a0, a1, b0, b1 in rects)

    def put(item, cands, foot, extra=None):
        for cx, cy, rot in cands:
            w, d = foot if round(math.degrees(rot)) % 180 == 0 else foot[::-1]
            if fits(cx, cy, w, d):
                rects.append((cx - w / 2, cx + w / 2, cy - d / 2, cy + d / 2)); placed.append((item, cx, cy, rot, extra or {}))
                return True
        skipped.append((item, f'no free floor space for the {item} in a {W:g} x {D:g} m room')); return False

    R90, R180 = math.radians(90), math.radians(180)
    get = lambda name: next((p for p in placed if p[0] == name), None)  # noqa: E731
    if 'bed' in items:
        put('bed', [(0, back - 1.05, 0), (left + 0.8 + 0.05, back - 1.05, 0)], FOOT['bed'])
    if 'sofa' in items:
        put('sofa', [(left + 0.45 + 0.02, 0, R90), (0, back - 0.45 - 0.02, 0), (0, front + 0.45, R180)], FOOT['sofa'])
    if 'desk' in items:
        put('desk', [(right - 0.62, back - 0.31, 0), (left + 0.31, back - 1.0, R90), (right - 0.31, 0, -R90)], FOOT['desk'], {'form': 'desk'})
    if 'table' in items:
        s = get('sofa')
        if spec['type'] == 'living_room':
            cands = ([(s[1] + 0.45 + 0.4 + 0.275, s[2], R90)] if s and round(math.degrees(s[3])) == 90 else []) + [(0, 0, 0), (0, front + 0.8, 0)]
            put('table', cands, FOOT['table_coffee'], {'form': 'coffee'})
        else:
            put('table', [(0, -0.1, 0), (0, front + 0.6, 0)], FOOT['table_dining'], {'form': 'dining'})
    if 'chair' in items:
        dk, tb = get('desk'), get('table')
        cands = []
        if dk:
            if round(math.degrees(dk[3])) == 0: cands.append((dk[1], dk[2] - 0.3 - 0.33, R180))
            else: cands.append((dk[1] + (0.3 + 0.33) * (1 if dk[3] > 0 else -1), dk[2], dk[3] + R180))
        if tb and tb[4].get('form') == 'dining': cands.append((tb[1], tb[2] - 0.375 - 0.33, R180))
        cands += [(right - 0.4, front + 0.4, R180), (left + 0.4, front + 0.4, R180)]
        put('chair', cands, FOOT['chair'])
    if 'shelf' in items:
        put('shelf', [(left + 0.75 + 0.47, back - 0.17, 0), (right - 0.6, back - 0.17, 0), (left + 0.17, back - 1.4, R90), (left + 0.17, front + 0.6, R90)],
            FOOT['shelf'])
    if 'lamp' in items:
        dk = get('desk')
        if dk:
            dx = -0.45 if round(math.degrees(dk[3])) == 0 else 0
            dy = 0 if round(math.degrees(dk[3])) == 0 else (0.45 if dk[3] > 0 else -0.45)
            placed.append(('lamp', dk[1] + dx, dk[2] + dy + 0.05, dk[3], {'form': 'desk', 'z': 0.75, 'on': 'desk'}))
        else:
            put('lamp', [(left + 0.3, back - 0.3, 0), (left + 0.3, front + 0.3, 0), (right - 0.3, back - 0.3, 0)], FOOT['lamp'], {'form': 'floor'})
    if 'plant' in items:
        put('plant', [(right - 0.3, back - 0.3, 0), (left + 0.3, front + 0.3, 0), (right - 0.3, front + 0.3, 0)], FOOT['plant'])
    for small in ('vase', 'mug'):
        if small not in items: continue
        hosts = [(n, z) for n, z in (('table', None), ('desk', 0.75), ('shelf', 1.6)) if get(n)]
        if small == 'mug': hosts = [h for h in hosts if h[0] != 'shelf']
        if hosts:
            n, z = hosts[0]; h = get(n)
            if z is None: z = 0.42 if h[4].get('form') == 'coffee' else 0.75
            off = 0.2 if small == 'vase' else -0.25
            if n == 'desk' and small == 'mug': off = 0.15
            ox, oy = (off, 0) if round(math.degrees(h[3])) % 180 == 0 else (0, off)
            placed.append((small, h[1] + ox, h[2] + oy, 0, {'z': z, 'on': n}))
        elif small == 'vase':
            put('vase', [(right - 0.2, front + 0.2, 0), (left + 0.2, front + 0.2, 0)], FOOT['vase_floor'], {'on': 'floor'})
        else:
            skipped.append(('mug', 'a mug needs a table or desk to stand on'))
    if 'rug' in items:
        anchor = get('table') or get('bed') or get('sofa')
        cx, cy = (anchor[1], anchor[2] - (0.6 if anchor[0] == 'bed' else 0)) if anchor else (0, 0)
        rw, rd = max(1.2, min(2.4, W - 1.6)), max(0.9, min(1.7, D - 1.4))
        if anchor and anchor[0] == 'sofa' and round(math.degrees(anchor[3])) == 90: cx += 0.9
        if anchor and round(math.degrees(anchor[3])) % 180 == 90: rw, rd = rd, rw
        cx = max(left + rw / 2, min(right - rw / 2, cx)); cy = max(front + rd / 2, min(back - rd / 2, cy))
        placed.append(('rug', cx, cy, 0, {'size': (round(rw, 2), round(rd, 2))}))
    order = {k: i for i, k in enumerate(items)}
    placed.sort(key=lambda p: order.get(p[0], 99))
    return placed, skipped


def build_room(spec):
    spec = validate_room(spec)
    shell(spec)
    placed, skipped = layout(spec)
    st = spec['style']
    for item, x, y, rot, extra in placed:
        if item == 'sofa': sofa(st, (x, y, 0), rot)
        elif item == 'bed': bed(st, (x, y, 0), rot)
        elif item == 'plant': plant(st, (x, y, 0), rot)
        elif item == 'rug': rug(st, (x, y, 0), extra['size'])
        else:
            fam = 'table' if item == 'desk' else item
            o = {'family': fam, 'style': st}
            if fam in ('lamp', 'table'): o['form'] = extra.get('form', 'desk' if fam == 'lamp' else 'dining')
            O.build_object(o, at=(x, y, extra.get('z', 0)), rot=rot, name=item)
    # The light colour lives in the bulbs' emission (render_creation.py adds lamps of the same colour).
    for m in bpy.data.materials:
        if m.name == 'Bulb':
            m.node_tree.nodes['Principled BSDF'].inputs['Emission Color'].default_value = (*LIGHT[spec['lighting']], 1)
    info = {'placed': [{'item': i, 'x': round(x, 2), 'y': round(y, 2), 'rot_deg': round(math.degrees(r)) % 360,
                        **({'on': e['on']} if e.get('on') else {})} for i, x, y, r, e in placed],
            'skipped': [{'item': i, 'reason': why} for i, why in skipped]}
    return spec, info


def main():
    try:
        spec = validate_room(O.spec_from_env())
    except (SpecError, ValueError) as e:
        print(f'SPEC FAILED: {e}', flush=True); sys.exit(2)
    print('STAGE model', flush=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    spec, info = build_room(spec)
    print('LAYOUT ' + json.dumps(info, separators=(',', ':')), flush=True)
    path = os.environ.get('EXPORT_GLB') or os.path.join(os.environ.get('OUT_DIR', '.'), 'model.glb')
    n = O.export(path, spec, 'room')
    print('MODEL', path, n, 'bytes', O.mesh_stats(), 'vertices', f"({describe('room', spec)}; two walls, open front and right, no ceiling)", flush=True)


if __name__ == '__main__':
    main()

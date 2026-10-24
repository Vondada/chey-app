"""A full-body, clothed, rigged and animated character from an identity preset (owner, 2026-10-24: "complete, animated
characters with skeletons, joints, facial expressions and realistic body movement"; full body is the default).

  python3 mpfb_body.py            env: identity settings (tools/avatar_face/identity.py: RACE, SEX, MATURE, FACE, FIT_W,
                                  TARGET_SRGB, IRIS_SRGB, HAIR_SRGB, HAIR_STYLE, STYLE, IDENTITY) plus OUTFIT_SRGB,
                                  LIGHTING (studio | cinematic), EXPORT_GLB, VIEWS ("0,30"), OUT_DIR, SAMPLES, TEST_RES,
                                  FIT (face_fit.py json, applied with FIT_W), SAVE (a .blend copy), STRIPS ("walk:4"),
                                  POSE_CLIP, POSE_FRAME, CPU_THREADS (the last four as render_glb.py reads them)

Everything is MakeHuman / MPFB2 data (CC0): the base body with the preset's ethnic mix, sex, age and face targets; the
MPFB "game_engine" skeleton (53 bones: pelvis, spine x3, neck, head, clavicles, arms, every finger joint, thighs, calves,
feet and balls) placed on the body's own joint groups, and MPFB's own skin weights for it; face shape keys from
MakeHuman's expression units (blink left/right, mouth open, smile, brows up).
- Clothing is required and built in: a long-sleeved top and trousers are the body surface itself in the covered
  regions (smoothed so cloth does not follow every bump, pushed out along the normals, clean crew neck, cuffs and hem),
  and shoes are a closed shell over each foot (the foot's convex hull). No skin exists under the clothes or shoes, so
  nothing pokes through when the body moves, and no unclothed body is ever exported or rendered. Skin shows only on the
  head, neck and hands.
- Hair is a scalp-cap mesh cut from the body's own scalp (thicker at the crown) in the preset's hair colour: no strands
  in the 3D model.
- Clips (30 fps), each its own NLA track so the GLB holds one animation per clip: idle, walk, run, wave, talk. Bone
  rotations are keyed about axes measured on this rig (a probe checks which way each one moves the limb), the walk and
  run cycles are in place with the pelvis lowered each frame so a foot stays on the floor, and talk keys the mouth and blink shape keys with head nods.
- EXPORT_GLB writes skin, skeleton, morph targets and every clip, then prints
  MODEL <path> <bytes> bytes <verts> vertices   and   RIG <bones> bones, clips <names>, morphs <names>
  tools/avatar_body/verify_glb.py re-reads the file and measures the motion; only its receipt says the model moves.
- VIEWS renders full-body previews (head to feet) from the exported GLB (render_glb.py) and prints
  WROTE <OUT_DIR>/body_<deg>.png for each. STAGE model / rig / animate lines mark the build stages.
"""
import json
import math
import os
import sys

import bpy
import bmesh  # noqa: E402  (bmesh is importable once bpy is)
import numpy as np
from mathutils import Matrix, Quaternion, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
FACE_DIR = os.path.join(HERE, '..', 'avatar_face')
sys.path.insert(0, FACE_DIR)
from mpfb_base import MPFB, apply_sliders, load_base, macro_woman, slider_deltas, target, to_blender  # noqa: E402

FPS = 30
CLIPS = ('idle', 'walk', 'run', 'wave', 'talk')
MORPHS = {   # shape key -> MakeHuman expression unit(s)
    'blink_l': ['expression/units/african/eye-left-closure'],
    'blink_r': ['expression/units/african/eye-right-closure'],
    'mouth_open': ['expression/units/african/mouth-open'],
    'smile': ['expression/units/african/mouth-corner-puller'],
    'brows_up': ['expression/units/african/eyebrows-left-up', 'expression/units/african/eyebrows-right-up'],
}
# Which body region each bone's skin belongs to. Long-sleeved top, trousers, shoes; skin on head, neck and hands.
REGION = {'spine_01': 'top', 'spine_02': 'top', 'spine_03': 'top', 'clavicle_l': 'top', 'clavicle_r': 'top',
          'upperarm_l': 'top', 'upperarm_r': 'top', 'lowerarm_l': 'top', 'lowerarm_r': 'top',
          'pelvis': 'trousers', 'thigh_l': 'trousers', 'thigh_r': 'trousers', 'calf_l': 'trousers', 'calf_r': 'trousers',
          'foot_l': 'shoes', 'foot_r': 'shoes', 'ball_l': 'shoes', 'ball_r': 'shoes', 'Root': 'shoes'}
OFFSET = {'skin': 0.0, 'top': 0.008, 'trousers': 0.005, 'shoes': 0.0}


def srgb_lin(c):
    c /= 255.0
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def rgb_env(name, default):
    return [srgb_lin(float(x)) for x in os.environ.get(name, default).split(',')]


def material(name, rgb, rough=0.6, spec=0.4, cull=True):
    m = bpy.data.materials.new(name); m.use_nodes = True; p = m.node_tree.nodes['Principled BSDF']
    p.inputs['Base Color'].default_value = (*rgb, 1); p.inputs['Roughness'].default_value = rough
    p.inputs['Specular IOR Level'].default_value = spec
    m.use_backface_culling = cull
    return m


def build():
    """Builds the clothed, rigged character in an empty scene and returns (scene, armature, meshes, info)."""
    print('STAGE model', flush=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    sc.render.fps = FPS
    verts, uvs, faces, groups = load_base()
    n = len(verts)
    race = {k: float(x) for k, x in (kv.split('=') for kv in os.environ.get('RACE', 'african=0.7,caucasian=0.3').split(','))}
    fitw = float(os.environ.get('FIT_W', '0' if os.environ.get('IDENTITY') else '1'))   # as mpfb_dress.py: CHE's own fit
    win = json.load(open(os.environ['FIT']))['winner'] if fitw and os.environ.get('FIT') and os.path.exists(os.environ['FIT']) else {'weights': {}, 'youth': 0.0}
    v = apply_sliders(macro_woman(verts, race, youth=win.get('youth', 0.0) * fitw, mature=float(os.environ.get('MATURE', '0')),
                                  sex=float(os.environ.get('SEX', '0'))),
                      slider_deltas(n), {k: w * fitw for k, w in win.get('weights', {}).items()})
    style_face = {
        'photoreal': '',
        'hybrid': 'lr:eyes/eye-scale-incr=0.6,nose/nose-scale-horiz-decr=0.15,chin/chin-width-decr=0.1',
        'stylized': 'lr:eyes/eye-scale-incr=1.6,nose/nose-scale-horiz-decr=0.6,nose/nose-scale-vert-decr=0.5,'
                    'lr:cheek/cheek-volume-incr=0.45,head/head-round=0.45,chin/chin-height-decr=0.35,mouth/mouth-scale-horiz-decr=0.15',
    }.get(os.environ.get('STYLE', 'photoreal'), '')
    for item in [x for x in (os.environ.get('FACE', '') + ',' + style_face).split(',') if x.strip()]:
        tname, tw = item.split('='); v = v + target(tname.strip(), n) * float(tw)
    co = to_blender(v)
    co[:, 2] -= co[sorted(groups['body']), 2].min()   # feet on the floor (z = 0)

    print('STAGE rig', flush=True)
    # ── Skeleton: MPFB's game_engine rig on this body's joint groups ─────────────────────────────────────────────────
    rig = json.load(open(os.path.join(MPFB, 'rigs', 'standard', 'rig.game_engine.json')))
    weights = json.load(open(os.path.join(MPFB, 'rigs', 'standard', 'weights.game_engine.json')))['weights']

    def point(spec):
        if spec.get('strategy') == 'CUBE' and spec.get('cube_name') in groups:
            return Vector(co[sorted(groups[spec['cube_name']])].mean(0))
        if spec.get('strategy') == 'MEAN' and spec.get('vertex_indices'):
            return Vector(co[spec['vertex_indices']].mean(0))
        p = Vector(spec['default_position']); p.z -= to_blender(verts)[sorted(groups['body']), 2].min()
        return p

    arm_data = bpy.data.armatures.new('Skeleton')
    arm = bpy.data.objects.new('Skeleton', arm_data); sc.collection.objects.link(arm)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode='EDIT')
    for name, b in rig.items():
        eb = arm_data.edit_bones.new(name); eb.head = point(b['head']); eb.tail = point(b['tail'])
        if (eb.tail - eb.head).length < 1e-4: eb.tail = eb.head + Vector((0, 0, 0.02))
        eb.roll = float(b.get('roll', 0.0))
    for name, b in rig.items():
        if b.get('parent'):
            eb = arm_data.edit_bones[name]; eb.parent = arm_data.edit_bones[b['parent']]; eb.use_connect = bool(b.get('use_connect'))
    bpy.ops.object.mode_set(mode='OBJECT')

    # Dominant bone per base vertex (for the clothing regions) and the weight table.
    dom = {}
    for bone, pairs in weights.items():
        for i, w in pairs:
            if w > dom.get(i, ('', 0.0))[1]: dom[i] = (bone, w)

    def mesh_from(name, face_list, region_of=None):
        used = sorted({i for vi in face_list for i in vi}); remap = {o: k for k, o in enumerate(used)}
        me = bpy.data.meshes.new(name)
        me.from_pydata([Vector(co[i]) for i in used], [], [[remap[i] for i in vi] for vi in face_list])
        for p in me.polygons: p.use_smooth = True
        ob = bpy.data.objects.new(name, me); sc.collection.objects.link(ob)
        for bone, pairs in weights.items():
            vg = None
            for i, w in pairs:
                if i in remap and w > 0:
                    vg = vg or ob.vertex_groups.new(name=bone); vg.add([remap[i]], w, 'REPLACE')
        mod = ob.modifiers.new('Armature', 'ARMATURE'); mod.object = arm
        ob.parent = arm
        return ob, me, used, remap

    # ── Body with clothing regions ────────────────────────────────────────────────────────────────────────────────
    body_faces = [vi for g, vi, ti in faces if g == 'body']
    body, me, used, remap = mesh_from('Body', body_faces)
    skin_rgb = rgb_env('TARGET_SRGB', '80,46,32')
    mats = {'skin': material('Skin', skin_rgb, 0.55, 0.32),
            'top': material('Top', rgb_env('OUTFIT_SRGB', '31,111,120'), 0.75, 0.2),
            'trousers': material('Trousers', rgb_env('TROUSERS_SRGB', '28,30,36'), 0.8, 0.15),
            'shoes': material('Shoes', rgb_env('SHOES_SRGB', '18,18,20'), 0.45, 0.5)}
    order = list(mats)
    for m in mats.values(): me.materials.append(m)
    vregion = [REGION.get(dom.get(i, ('', 0))[0], 'skin') for i in used]
    # Garment edges follow clean lines instead of the zig-zag where one bone's weights hand over to the next: a crew
    # neck dipping at the front, cuffs just above the wrists, shoes up to just above the ankles.
    B = {b.name: (b.head_local.copy(), b.tail_local.copy()) for b in arm_data.bones}
    neck = B['neck_01'][0]
    hem = B['pelvis'][0].z + 0.03

    def garment(c, bones, majority):
        if bones & {'neck_01', 'spine_03', 'clavicle_l', 'clavicle_r', 'head'}:
            collar = neck.z + 0.012 - 0.03 * min(1.0, max(0.0, (neck.y - c.y) / 0.08)) ** 2
            return 'top' if c.z < collar else 'skin'
        for s in 'lr':
            if bones & {f'lowerarm_{s}', f'hand_{s}'}:
                h, t = B[f'lowerarm_{s}']; d = t - h
                return 'top' if (c - h).dot(d) / d.length_squared < 0.9 else 'skin'
            if bones & {f'calf_{s}', f'foot_{s}'}:
                return 'shoes' if c.z < B[f'foot_{s}'][0].z + 0.035 else 'trousers'
        if majority in ('top', 'trousers') and not any(b.startswith(('upperarm', 'lowerarm', 'hand')) for b in bones) \
                and abs(c.z - hem) < 0.15:
            return 'top' if c.z > hem else 'trousers'
        return majority
    face_region = []
    for p in me.polygons:
        rs = [vregion[k] for k in p.vertices]
        bones = {dom.get(used[k], ('', 0))[0] for k in p.vertices}
        face_region.append(garment(p.center, bones, max(set(rs), key=rs.count)))
        p.material_index = order.index(face_region[-1])
    # Vertices on a hem or collar line are moved onto the line, so the edge is straight instead of following the
    # staircase of the body's quads.
    touch = [set() for _ in me.vertices]
    for p, r in zip(me.polygons, face_region):
        for k in p.vertices: touch[k].add(r)
    hem = B['pelvis'][0].z + 0.03
    for k, vx in enumerate(me.vertices):
        if touch[k] == {'top', 'trousers'} and abs(vx.co.z - hem) < 0.06:
            vx.co.z = hem
        elif touch[k] == {'top', 'skin'} and vx.co.z > neck.z - 0.08 and abs(vx.co.x) < 0.12:
            vx.co.z = neck.z + 0.012 - 0.03 * min(1.0, max(0.0, (neck.y - vx.co.y) / 0.08)) ** 2
    vregion = ['skin'] * len(me.vertices)   # a vertex takes the garment of any face it touches (clothes win over skin)
    for p, r in zip(me.polygons, face_region):
        for k in p.vertices:
            if r != 'skin' and (vregion[k] == 'skin' or r == 'shoes'): vregion[k] = r
    # Cloth does not follow every bump of the skin: the clothed surface is Laplacian-smoothed, lightly for the top and
    # trousers (the push-out below restores the volume), strongly for the shoes so the toes merge into one rounded toe
    # box. Garment edges stay put.
    edges = np.array([e.vertices[:] for e in me.edges])
    pos = np.array([vx.co[:] for vx in me.vertices])
    deg = np.bincount(edges.ravel(), minlength=len(pos)).astype(float)[:, None]
    vr = np.array(vregion)
    edge_v = np.zeros(len(pos), bool)
    for p, r in zip(me.polygons, face_region):
        for k in p.vertices:
            if vregion[k] != r: edge_v[k] = True
    torso = np.array([dom.get(used[k], ('', 0))[0].startswith(('spine', 'clavicle')) or abs(pos[k, 0]) < 0.13
                      for k in range(len(pos))])
    vr = np.where((vr == 'top') & torso, 'torso', vr)   # the chest is smoothed longest: a top hangs over it
    passes = {'top': 14, 'torso': 14, 'trousers': 3}
    for it in range(max(passes.values())):
        for lam in (0.6,):
            acc_p = np.zeros_like(pos); np.add.at(acc_p, edges[:, 0], pos[edges[:, 1]]); np.add.at(acc_p, edges[:, 1], pos[edges[:, 0]])
            d = acc_p / np.maximum(deg, 1) - pos
            for r, n_it in passes.items():
                sel = (vr == r) & ~edge_v if it < n_it else None
                if sel is not None: pos[sel] += lam * d[sel]
    # The chest: a spatial Gaussian average (5 cm, twice), which does not care how dense the skin's quads are, so a
    # top hangs over the bust as one soft shape and never shows chest detail through the fabric.
    tsel = np.where((vr == 'torso') & ~edge_v)[0]; samp = np.where(np.isin(vr, ('torso', 'top')))[0]
    for _ in range(2):
        ref = pos.copy()
        for chunk in np.array_split(tsel, max(1, len(tsel) // 400)):
            d2 = ((ref[chunk, None, :] - ref[None, samp, :]) ** 2).sum(-1)
            w = np.exp(-d2 / (2 * 0.05 ** 2)); w[d2 > 0.12 ** 2] = 0
            smooth = (w @ ref[samp]) / w.sum(1, keepdims=True)
            # Fade out toward the collar (full effect 8 cm below the neck), so the neckline meets the fabric cleanly.
            fade = np.clip((neck.z - 0.02 - ref[chunk, 2]) / 0.06, 0.0, 1.0)[:, None]
            pos[chunk] = ref[chunk] * (1 - fade) + smooth * fade
    pos[:, 2] = np.maximum(pos[:, 2], 0.0)
    for k, vx in enumerate(me.vertices):
        if vregion[k] != 'skin': vx.co = Vector(pos[k])
    # Push the clothed surface out along the normals; a vertex on a sleeve or collar edge moves half as far.
    me.update(); acc = [[0.0, 0] for _ in me.vertices]
    for p, r in zip(me.polygons, face_region):
        for k in p.vertices: acc[k][0] += OFFSET[r]; acc[k][1] += 1
    normals = [vx.normal.copy() for vx in me.vertices]
    for k, vx in enumerate(me.vertices):
        if acc[k][1]: vx.co += normals[k] * (acc[k][0] / acc[k][1])
    covered = sum(1 for r in face_region if r != 'skin') / len(face_region)
    skin_bones = sorted({dom.get(used[k], ('?', 0))[0] for k, r in enumerate(vregion) if r == 'skin'})

    # Shoes: the convex hull of each foot (a closed, rounded shoe over the toes), weighted with the foot's own weights.
    # The bare foot under it is removed from the body below, so a shoe can never show toes.
    shoe_me = bpy.data.meshes.new('Shoes')
    bm = bmesh.new(); src = bm.verts.layers.int.new('src')
    for left in (True, False):
        vs = []
        for k, vx in enumerate(me.vertices):
            if vregion[k] == 'shoes' and (vx.co.x > 0) == left:
                bv = bm.verts.new(vx.co); bv[src] = k; vs.append(bv)
        if len(vs) > 3:
            res = bmesh.ops.convex_hull(bm, input=vs)
            bmesh.ops.delete(bm, geom=[g for g in res['geom_interior'] if isinstance(g, bmesh.types.BMVert)], context='VERTS')
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context='VERTS')
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    bm.verts.ensure_lookup_table(); origin = [v[src] for v in bm.verts]
    bm.to_mesh(shoe_me); bm.free()
    shoe_me.materials.append(mats['shoes'])
    shoe_me.update()
    sn = [vx.normal.copy() for vx in shoe_me.vertices]
    for vx, nn in zip(shoe_me.vertices, sn): vx.co += nn * 0.004; vx.co.z = max(vx.co.z, 0.0)
    for p in shoe_me.polygons: p.use_smooth = True
    shoes = bpy.data.objects.new('Shoes', shoe_me); sc.collection.objects.link(shoes)
    for j, k in enumerate(origin):
        for g in me.vertices[k].groups:
            name = body.vertex_groups[g.group].name
            (shoes.vertex_groups.get(name) or shoes.vertex_groups.new(name=name)).add([j], g.weight, 'REPLACE')
    mod = shoes.modifiers.new('Armature', 'ARMATURE'); mod.object = arm; shoes.parent = arm

    # Face shape keys (MakeHuman expression units), made on the body's own vertices.
    body.shape_key_add(name='Basis')
    for key, units in MORPHS.items():
        d = sum(target(u, n) for u in units)
        kb = body.shape_key_add(name=key)
        for k, i in enumerate(used):
            if d[i].any(): kb.data[k].co = kb.data[k].co + Vector((d[i][0] * 0.1, -d[i][2] * 0.1, d[i][1] * 0.1))
        kb.value = 0.0
    bm = bmesh.new(); bm.from_mesh(me)   # the bare feet go: the shoes replace them (shape keys and weights are kept)
    bmesh.ops.delete(bm, geom=[f for f, r in zip(bm.faces, face_region) if r == 'shoes'], context='FACES')
    bm.to_mesh(me); bm.free(); me.update()

    # ── Eyes (iris colour as vertex colours, glTF-safe) and the scalp-cap hair ───────────────────────────────────────
    iris = rgb_env('IRIS_SRGB', '94,62,40')
    eye_m = material('Eye', (1, 1, 1), 0.15, 0.5)   # white x the vertex colours (glTF COLOR_0), the same in Cycles
    vc = eye_m.node_tree.nodes.new('ShaderNodeVertexColor'); vc.layer_name = 'Col'
    eye_m.node_tree.links.new(vc.outputs['Color'], eye_m.node_tree.nodes['Principled BSDF'].inputs['Base Color'])
    eyes = []
    for gname, name in (('helper-l-eye', 'Eye_l'), ('helper-r-eye', 'Eye_r')):
        pts = co[sorted(groups[gname])]; c = Vector(pts.mean(0)); r = float(np.linalg.norm(pts - pts.mean(0), axis=1).max()) * 0.97
        em = bpy.data.meshes.new(name)
        bm = bmesh.new(); bmesh.ops.create_uvsphere(bm, u_segments=32, v_segments=16, radius=r); bm.to_mesh(em); bm.free()
        cols = []
        for vx in em.vertices:
            p = vx.co / r   # unit sphere; the eye looks along -Y
            rad = math.hypot(p.x, p.z)
            if p.y > 0: c3 = (0.82, 0.8, 0.78)
            elif rad < 0.19: c3 = (0.01, 0.01, 0.01)
            elif rad < 0.6: c3 = tuple(min(1.0, x * (1.0 if rad > 0.3 else 0.75)) for x in iris)
            elif rad < 0.67: c3 = tuple(x * 0.35 for x in iris)
            else: c3 = (0.82, 0.8, 0.78)
            cols.append(c3)
        a = em.color_attributes.new('Col', 'FLOAT_COLOR', 'POINT'); a.data.foreach_set('color', [x for c3 in cols for x in (*c3, 1.0)])
        em.materials.append(eye_m)
        for p in em.polygons: p.use_smooth = True
        eo = bpy.data.objects.new(name, em); sc.collection.objects.link(eo); eo.location = c
        eo.vertex_groups.new(name='head').add(list(range(len(em.vertices))), 1.0, 'REPLACE')
        mod = eo.modifiers.new('Armature', 'ARMATURE'); mod.object = arm; eo.parent = arm
        eyes.append(eo)
    # Hair: a close cap made from the body's own scalp (above the hairline, around the back of the head), thicker at the
    # crown and thinning to the edge so it reads as short hair, not a helmet. Weighted to the head like the skin under it.
    eye_mid = (co[sorted(groups['helper-l-eye'])].mean(0) + co[sorted(groups['helper-r-eye'])].mean(0)) / 2
    head_bones = {'head', 'neck_01'}

    def scalp(i):
        if dom.get(i, ('', 0))[0] not in head_bones: return False
        x, y, z = co[i] - eye_mid
        if abs(x) > 0.062 and -0.045 < z < 0.035 and 0.04 < y < 0.13: return False   # the ears stay skin
        return z > 0.052 - 0.25 * max(0.0, y - 0.01) or (y > 0.105 and z > -0.075)
    hair_faces = [vi for vi in body_faces if all(scalp(i) for i in vi)]
    hair, hme, hused, _ = mesh_from('Hair', hair_faces)
    hme.materials.append(material('Hair', rgb_env('HAIR_SRGB', '28,18,16'), 0.7, 0.25, cull=False))
    hme.update()
    edge_count = {}
    for e in hme.edges: edge_count[e.key] = 0
    for p in hme.polygons:
        for k in p.edge_keys: edge_count[k] += 1
    rim = {i for k, c in edge_count.items() if c == 1 for i in k}
    hnorm = [vx.normal.copy() for vx in hme.vertices]
    for k, vx in enumerate(hme.vertices):
        rz = vx.co.z - eye_mid[2]
        thick = 0.005 + 0.012 * min(1.0, max(0.0, (rz + 0.02) / 0.12))
        vx.co += hnorm[k] * (0.003 if k in rim else thick)

    info = {'covered_fraction': round(covered, 3), 'skin_bones': skin_bones, 'body_vertices': len(me.vertices),
            'hair': 'scalp-cap hair mesh in the preset colour (strand hair is not in the 3D model)'}
    return sc, arm, [body, shoes, hair, *eyes], info


# ── Animation ─────────────────────────────────────────────────────────────────────────────────────────────────────
def animate(sc, arm, body):
    print('STAGE animate', flush=True)
    pbs = arm.pose.bones
    for pb in pbs: pb.rotation_mode = 'QUATERNION'
    rest = {pb.name: pb.bone.matrix_local.to_quaternion() for pb in pbs}

    def local(name, axis, deg):
        """A rotation of `deg` about a rest-pose armature axis, as the bone's own pose rotation."""
        q = Quaternion(Vector(axis), math.radians(deg))
        r = rest[name]
        return r.inverted() @ q @ r

    def tip(name):
        bpy.context.view_layer.update()
        return arm.matrix_world @ pbs[name].tail

    def sign(name, axis, probe, coord, want):
        """+1 or -1: which way rotating `name` about `axis` moves `probe`'s tip along `coord` in the `want` direction."""
        for pb in pbs: pb.rotation_quaternion = Quaternion()
        before = tip(probe)[coord]
        pbs[name].rotation_quaternion = local(name, axis, 20)
        after = tip(probe)[coord]
        pbs[name].rotation_quaternion = Quaternion()
        return 1 if (after - before) * want > 0 else -1

    X, Y = (1, 0, 0), (0, 1, 0)
    # Measured on this rig: forward is -Y, up is +Z.
    s_thigh = {s: sign(f'thigh_{s}', X, f'calf_{s}', 1, -1) for s in 'lr'}          # leg forward
    s_calf = {s: sign(f'calf_{s}', X, f'calf_{s}', 1, +1) for s in 'lr'}            # knee bends: shin swings back
    s_down = {s: sign(f'upperarm_{s}', Y, f'lowerarm_{s}', 2, -1) for s in 'lr'}    # arm down to the side
    s_fwd = {s: sign(f'upperarm_{s}', X, f'lowerarm_{s}', 1, -1) for s in 'lr'}     # arm swings forward
    # The elbow bends about the axis across the rest pose's own elbow (MakeHuman's forearms already bend ~39 degrees
    # forward); a positive angle bends it further, a negative one straightens it. Relaxed arms keep 10 degrees.
    e_axis, e_rest = {}, {}
    for s in 'lr':
        du = (pbs[f'upperarm_{s}'].bone.tail_local - pbs[f'upperarm_{s}'].bone.head_local).normalized()
        dl = (pbs[f'lowerarm_{s}'].bone.tail_local - pbs[f'lowerarm_{s}'].bone.head_local).normalized()
        e_axis[s] = tuple(du.cross(dl).normalized()); e_rest[s] = math.degrees(du.angle(dl))

    def elbow(s, deg):
        return (e_axis[s], deg - e_rest[s])
    s_nod = sign('neck_01', X, 'head', 1, -1)                                      # head tips forward
    # How far each upper arm hangs from vertical in the rest (A) pose: "arms down" leaves it 9 degrees off the body.
    hang = {}
    for s in 'lr':
        d = pbs[f'upperarm_{s}'].bone.tail_local - pbs[f'upperarm_{s}'].bone.head_local
        hang[s] = math.degrees(math.atan2(abs(d.x), -d.z)) - 9
    down = sum(hang.values()) / 2

    def pose_frame(f, rot, loc=None):
        for name, parts in rot.items():
            q = Quaternion()
            for axis, deg in parts: q = local(name, axis, deg) @ q
            pbs[name].rotation_quaternion = q
            pbs[name].keyframe_insert('rotation_quaternion', frame=f)
        for name, world in (loc or {}).items():
            pbs[name].location = rest[name].inverted() @ Vector(world)
            pbs[name].keyframe_insert('location', frame=f)

    def base(extra=None):
        """Arms relaxed at the sides, elbows a little bent."""
        rot = {f'upperarm_{s}': [(Y, s_down[s] * down)] for s in 'lr'}
        rot.update({f'lowerarm_{s}': [elbow(s, 10)] for s in 'lr'})
        for k, v in (extra or {}).items(): rot[k] = rot.get(k, []) + v
        return rot

    keys = body.data.shape_keys
    clips = {}

    contacts = [(f'foot_{s}', 'head') for s in 'lr'] + [(f'ball_{s}', e) for s in 'lr' for e in ('head', 'tail')]

    def contact_heights():
        bpy.context.view_layer.update()
        return [(arm.matrix_world @ getattr(pbs[b], e)).z for b, e in contacts]
    for pb in pbs: pb.rotation_quaternion = Quaternion(); pb.location = Vector()
    rest_contact = contact_heights()

    def clip(name, frames, fn, morph=None, ground=False):
        """ground=True plants the gait: each frame the pelvis is lowered or raised so the lowest point of either foot
        (ankle, ball or toe) sits exactly at its rest height, i.e. on the floor, never through it."""
        act = bpy.data.actions.new(name); arm.animation_data_create(); arm.animation_data.action = act
        for f in range(frames + 1):
            rot, loc = fn(f / frames, f)
            pose_frame(f, rot, loc)
            if ground:
                dz = -min(h - r for h, r in zip(contact_heights(), rest_contact))
                world = rest['pelvis'] @ pbs['pelvis'].location + Vector((0, 0, dz))
                pose_frame(f, {}, {'pelvis': tuple(world)})
        arm.animation_data.action = None
        tr = arm.animation_data.nla_tracks.new(); tr.name = name; tr.strips.new(name, 0, act); tr.mute = True
        if morph:
            mact = bpy.data.actions.new(name + '_face'); keys.animation_data_create(); keys.animation_data.action = mact
            for f in range(frames + 1):
                for kname, val in morph(f / frames, f).items():
                    kb = keys.key_blocks[kname]; kb.value = val; kb.keyframe_insert('value', frame=f)
            keys.animation_data.action = None
            mt = keys.animation_data.nla_tracks.new(); mt.name = name; mt.strips.new(name, 0, mact); mt.mute = True
        for pb in pbs: pb.rotation_quaternion = Quaternion(); pb.location = Vector()
        clips[name] = frames / FPS

    def blink(t, at, width=0.06):
        b = max(0.0, 1 - abs(t - at) / width)
        return {'blink_l': b, 'blink_r': b}

    def idle(t, f):
        p = 2 * math.pi * t
        return base({'spine_03': [(X, 1.5 * math.sin(p))], 'neck_01': [((0, 0, 1), 3 * math.sin(p))]}), None

    def gait(amp_thigh, amp_knee, amp_arm, bend, bob):
        def fn(t, f):
            p = 2 * math.pi * t
            rot = {}
            for s, ph in (('l', 0.0), ('r', math.pi)):
                rot[f'thigh_{s}'] = [(X, s_thigh[s] * amp_thigh * math.sin(p + ph))]
                rot[f'calf_{s}'] = [(X, s_calf[s] * (5 + amp_knee * max(0.0, math.cos(p + ph))))]
                rot[f'upperarm_{s}'] = [(Y, s_down[s] * (down + 3)), (X, s_fwd[s] * amp_arm * math.sin(p + ph + math.pi))]
                rot[f'lowerarm_{s}'] = [elbow(s, bend)]
            rot['spine_02'] = [((0, 0, 1), 4 * math.sin(p))]
            return rot, {'pelvis': (0, 0, -bob * (1 + math.cos(2 * p)) / 2)}
        return fn

    # Wave: the upper arm rises to just above shoulder height and turns about its own length so the elbow bends
    # upward (forearm vertical, palm out); the probe picks the turn direction that lifts the hand on this rig.
    ua = pbs['upperarm_r'].bone; long_axis = tuple((ua.tail_local - ua.head_local).normalized())
    raise_deg = down - 105

    def hand_height(twist):
        for pb in pbs: pb.rotation_quaternion = Quaternion()
        pbs['upperarm_r'].rotation_quaternion = local('upperarm_r', Y, s_down['r'] * raise_deg) @ local('upperarm_r', long_axis, twist)
        ax, deg = elbow('r', 95); pbs['lowerarm_r'].rotation_quaternion = local('lowerarm_r', ax, deg)
        return tip('hand_r').z
    s_twist = 1 if hand_height(90) > hand_height(-90) else -1
    for pb in pbs: pb.rotation_quaternion = Quaternion()

    def wave(t, f):
        up = min(1.0, t / 0.2) if t < 0.8 else max(0.0, (1 - t) / 0.2)
        w = math.sin(2 * math.pi * 3 * (t - 0.2) / 0.6) if 0.2 <= t <= 0.8 else 0.0
        rot = base()
        rot['upperarm_r'] = [(long_axis, s_twist * 90 * up), (Y, s_down['r'] * (down + (raise_deg - down) * up))]
        rot['lowerarm_r'] = [elbow('r', 10 + 85 * up), ((0, 0, 1), 20 * w * up)]
        rot['neck_01'] = [((0, 0, 1), -6 * up)]
        return rot, None

    rng = np.random.default_rng(7)
    syll = rng.uniform(0.15, 0.75, 40)

    def talk(t, f):
        return base({'neck_01': [(X, s_nod * 4 * math.sin(2 * math.pi * 2 * t))],
                     'spine_03': [((0, 0, 1), 2 * math.sin(2 * math.pi * t))]}), None

    def talk_face(t, f):
        k = f // 4
        open_ = 0.0 if (k % 9) in (7, 8) else float(syll[k % len(syll)]) * (0.6 + 0.4 * math.sin(math.pi * (f % 4) / 4))
        return {'mouth_open': open_, 'smile': 0.15, 'brows_up': 0.2 * max(0.0, math.sin(2 * math.pi * t)), **blink(t, 0.45)}

    clip('idle', 60, idle, lambda t, f: {**blink(t, 0.8), 'smile': 0.1})
    clip('walk', 30, gait(24, 40, 18, 20, 0.0), ground=True)
    clip('run', 20, gait(40, 75, 35, 85, 0.0), ground=True)
    clip('wave', 60, wave, lambda t, f: {'smile': 0.5 * min(1.0, t / 0.2), **blink(t, 0.6)})
    clip('talk', 90, talk, talk_face)
    return clips


def export(path, arm, meshes, clips, info):
    for ad in (arm.animation_data, meshes[0].data.shape_keys.animation_data):
        if ad:
            for tr in ad.nla_tracks: tr.mute = False
    bpy.ops.object.select_all(action='DESELECT')
    for o in (arm, *meshes): o.select_set(True)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True, export_yup=True, export_apply=False,
                              export_skins=True, export_morph=True, export_animations=True, export_animation_mode='NLA_TRACKS',
                              export_vertex_color='ACTIVE', export_materials='EXPORT', export_cameras=False, export_lights=False,
                              export_force_sampling=True)
    nv = sum(len(o.data.vertices) for o in meshes)
    print('MODEL', os.path.abspath(path), os.path.getsize(path), 'bytes', nv, 'vertices',
          f"(full-body clothed character, {len(arm.data.bones)}-bone skeleton, skin weights, face shape keys, clips; hair: {info['hair']})", flush=True)
    print('RIG', len(arm.data.bones), 'bones, clips', ','.join(clips), ', morphs', ','.join(MORPHS), flush=True)


def stage(sc, arm, lighting):
    """Studio (or cinematic) light, a floor and a camera framing the whole body."""
    floor = bpy.data.objects.new('Floor', bpy.data.meshes.new('Floor')); sc.collection.objects.link(floor)
    floor.data.from_pydata([(-4, -4, 0), (4, -4, 0), (4, 4, 0), (-4, 4, 0)], [], [(0, 1, 2, 3)])
    floor.data.materials.append(material('FloorM', (0.06, 0.065, 0.07) if lighting == 'studio' else (0.03, 0.03, 0.035), 0.7, 0.3))
    tgt = bpy.data.objects.new('Target', None); sc.collection.objects.link(tgt); tgt.location = (0, 0, 0.88)

    def area(name, pos, size, energy, color=(1, 1, 1)):
        l = bpy.data.objects.new(name, bpy.data.lights.new(name, 'AREA')); sc.collection.objects.link(l)
        l.data.size = size; l.data.energy = energy; l.data.color = color; l.location = pos
        c = l.constraints.new('TRACK_TO'); c.target = tgt; c.track_axis = 'TRACK_NEGATIVE_Z'; c.up_axis = 'UP_Y'
    if lighting == 'cinematic':
        area('Key', (2.2, -2.4, 2.6), 1.2, 650, (1.0, 0.86, 0.72))
        area('Fill', (-2.6, -2.0, 1.4), 2.0, 60, (0.6, 0.72, 1.0))
        area('Rim', (-1.2, 2.6, 2.4), 0.8, 700, (0.35, 0.95, 0.9))
        bg = (0.01, 0.012, 0.016)
    else:
        area('Key', (2.0, -2.8, 2.6), 2.0, 520)
        area('Fill', (-2.6, -2.2, 1.6), 2.5, 220)
        area('Rim', (-0.8, 2.6, 2.4), 1.0, 300, (0.75, 0.95, 1.0))
        bg = (0.11, 0.115, 0.125)
    w = bpy.data.worlds.new('W'); sc.world = w; w.use_nodes = True
    w.node_tree.nodes['Background'].inputs['Color'].default_value = (*bg, 1)
    w.node_tree.nodes['Background'].inputs['Strength'].default_value = 0.5
    cam = bpy.data.objects.new('Cam', bpy.data.cameras.new('Cam')); sc.collection.objects.link(cam); sc.camera = cam
    cam.data.lens = 50
    tr = cam.constraints.new('TRACK_TO'); tr.target = tgt; tr.track_axis = 'TRACK_NEGATIVE_Z'; tr.up_axis = 'UP_Y'
    return cam, tgt


def main():
    sc, arm, meshes, info = build()
    clips = animate(sc, arm, meshes[0])
    print('BODY', json.dumps(info), flush=True)
    if os.environ.get('SAVE'):
        bpy.ops.wm.save_as_mainfile(filepath=os.environ['SAVE'])
    path = os.environ.get('EXPORT_GLB') or os.path.join(os.environ.get('OUT_DIR', '.'), 'body.glb')
    export(path, arm, meshes, clips, info)
    if [v for v in os.environ.get('VIEWS', '0,30').split(',') if v.strip()] or os.environ.get('STRIPS'):
        # The previews are rendered from the exported file itself (render_glb.py), so they show what CHE delivers.
        from render_glb import render
        os.environ.setdefault('VIEWS', '0,30')
        render(os.path.abspath(path))


if __name__ == '__main__':
    main()

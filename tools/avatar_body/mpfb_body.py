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
- The suit is refined, not left at the base mesh's density (creation-gaps, 2026-10-25: "less blocky"): every top and
  trousers face is split in four (weights, UVs and shape keys interpolated, so it still bends with the skeleton), then
  Taubin-smoothed (shrink-free: a +0.5 pass, a -0.53 pass) on the garment's inner vertices, so the sleeves, chest and legs
  read as rounded cloth instead of facets. Garment edges (neckline, cuffs, hem, shoe line) do not move. The SUIT line
  prints the garment's vertex and face counts before and after: a measurement, not a description. SUIT_REFINE=0 skips it.
- Hair is a scalp-cap mesh cut from the body's own scalp (thicker at the crown) in the preset's hair colour: no strands
  in the 3D model.
- Clips (30 fps), each its own NLA track so the GLB holds one animation per clip: idle, walk, run, wave, talk. Bone
  rotations are keyed about axes measured on this rig (a probe checks which way each one moves the limb). Walk and
  run are in-place cycles whose legs are solved by two-bone IK from foot targets: a planted foot stays flat on the
  floor and moves back under the hips at the clip's declared ground speed (glTF animation extras ground_speed_mps,
  forward +Z), so it does not slide once the engine moves the character at that speed. Talk keys the mouth and blink
  shape keys with head nods.
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
from mpfb_base import MPFB, apply_sliders, load_base, macro_from_settings, slider_deltas, target, to_blender  # noqa: E402

FPS = 30
CLIPS = ('idle', 'walk', 'run', 'wave', 'talk')
CLIP_EXTRAS = {}   # clip -> glTF animation extras (the gaits' declared ground speed), written into the GLB on export
CHARACTER = {}     # what built this character (face sliders, body macros, hair style, reference), in the GLB asset extras
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
    fitw = float(os.environ.get('FIT_W', '0' if os.environ.get('IDENTITY') else '1'))   # as mpfb_dress.py: CHE's own fit
    win = json.load(open(os.environ['FIT']))['winner'] if fitw and os.environ.get('FIT') and os.path.exists(os.environ['FIT']) else {'weights': {}, 'youth': 0.0}
    # Body macros (BODY_GENDER, BODY_AGE, BODY_HEIGHT, BODY_WEIGHT, BODY_MUSCLE, BODY_PROPORTIONS; MakeHuman 0..1 values):
    # with none set this is exactly the previous macro_woman body, so existing presets build the same model.
    v = apply_sliders(macro_from_settings(verts, os.environ, youth=win.get('youth', 0.0) * fitw),
                      slider_deltas(n), {k: w * fitw for k, w in win.get('weights', {}).items()})
    style_face = {
        'photoreal': '',
        'hybrid': 'lr:eyes/eye-scale-incr=0.6,nose/nose-scale-horiz-decr=0.15,chin/chin-width-decr=0.1',
        'stylized': 'lr:eyes/eye-scale-incr=1.6,nose/nose-scale-horiz-decr=0.6,nose/nose-scale-vert-decr=0.5,'
                    'lr:cheek/cheek-volume-incr=0.45,head/head-round=0.45,chin/chin-height-decr=0.35,mouth/mouth-scale-horiz-decr=0.15',
    }.get(os.environ.get('STYLE', 'photoreal'), '')
    for item in [x for x in (os.environ.get('FACE', '') + ',' + style_face).split(',') if x.strip()]:
        tname, tw = item.split('='); v = v + target(tname.strip(), n) * float(tw)
    from mpfb_base import body_values, has_body_macros
    ref = os.environ.get('REFERENCE') or ''
    try: ref_sha = json.loads(ref).get('sha256') if ref else None
    except ValueError: ref_sha = None
    CHARACTER.clear(); CHARACTER.update({   # written into the GLB (asset.extras.che_character) by export()
        'face_sliders': {k: round(w * fitw, 4) for k, w in win.get('weights', {}).items() if w * fitw},
        'face_targets': [x.strip() for x in os.environ.get('FACE', '').split(',') if x.strip()],
        'style': os.environ.get('STYLE', 'photoreal'), 'race': os.environ.get('RACE', 'african=0.7,caucasian=0.3'),
        'body_macros': {k: round(x, 4) for k, x in body_values(os.environ, win.get('youth', 0.0) * fitw).items()},
        'body_macro_system': 'makehuman_full' if has_body_macros(os.environ) else 'legacy_macro_woman',
        'hair_style': os.environ.get('HAIR_STYLE') or 'close_crop', 'reference_sha256': ref_sha,
        'outfit_top': os.environ.get('OUTFIT_TOP') or 'long_sleeved_top',
        'outfit_top_built': 't_shirt' if os.environ.get('OUTFIT_TOP') == 't_shirt' else 'long_sleeved_top'})
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
        if os.environ.get('OUTFIT_TOP') == 't_shirt':   # short sleeves ending half-way down the upper arm
            for s in 'lr':
                if bones & {f'upperarm_{s}', f'lowerarm_{s}', f'hand_{s}'}:
                    h, t = B[f'upperarm_{s}']; d = t - h
                    return 'top' if (c - h).dot(d) / d.length_squared < 0.45 and not bones & {f'lowerarm_{s}', f'hand_{s}'} else 'skin'
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
        # The sphere's pole looks forward (-Y), so its rings are concentric with the pupil and iris: the vertex colours
        # then draw a round pupil, iris and limbal ring instead of a smear across a few coarse rows (realism pass,
        # 2026-10-25: the 32x16 sphere with a vertical pole rendered the eye as one orange blot).
        bm = bmesh.new(); bmesh.ops.create_uvsphere(bm, u_segments=48, v_segments=40, radius=r)
        bmesh.ops.rotate(bm, verts=bm.verts, cent=(0, 0, 0), matrix=Matrix.Rotation(math.radians(90), 3, 'X'))
        bm.to_mesh(em); bm.free()
        cols = []
        for vx in em.vertices:
            p = vx.co / r   # unit sphere; the eye looks along -Y
            rad = math.hypot(p.x, p.z)
            if p.y > 0: c3 = (0.66, 0.62, 0.58)
            elif rad < 0.15: c3 = (0.01, 0.01, 0.01)
            elif rad < 0.44: c3 = tuple(min(1.0, x * (1.0 if rad > 0.26 else 0.75)) for x in iris)
            elif rad < 0.5: c3 = tuple(x * 0.35 for x in iris)
            else: c3 = (0.66, 0.62, 0.58)
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
    adj = {}
    for (a, b) in edge_count: adj.setdefault(a, []).append(b); adj.setdefault(b, []).append(a)
    ring_of = {i: 0 for i in rim}; todo = list(rim)
    while todo:
        nxt = []
        for i in todo:
            for j in adj.get(i, []):
                if j not in ring_of: ring_of[j] = ring_of[i] + 1; nxt.append(j)
        todo = nxt
    for k, vx in enumerate(hme.vertices):
        rz = vx.co.z - eye_mid[2]
        thick = 0.005 + 0.012 * min(1.0, max(0.0, (rz + 0.02) / 0.12))
        # The edge thins over two rings of vertices instead of stepping from 3 mm straight to the full thickness (the
        # step drew a saw-tooth hairline; realism pass 2026-10-25).
        r = ring_of.get(k, 9)
        vx.co += hnorm[k] * (0.003 + (thick - 0.003) * min(1.0, r / 3.0))
    style = os.environ.get('HAIR_STYLE') or 'close_crop'
    extra, hair_info = hair_style(style, sc, arm, hair, hme, Vector(eye_mid))

    suit = refine_suit(me, [order.index('top'), order.index('trousers')]) if os.environ.get('SUIT_REFINE', '1') != '0' else None
    if suit: print('SUIT ' + json.dumps(suit, separators=(',', ':')), flush=True)
    info = {'covered_fraction': round(covered, 3), 'skin_bones': skin_bones, 'body_vertices': len(me.vertices), 'suit': suit,
            'hair': hair_info, 'hair_style': hair_info.split(':')[0]}
    print('HAIR ' + json.dumps({'style': hair_info.split(':')[0], 'objects': [o.name for o in [hair, *extra]],
                                'vertices': sum(len(o.data.vertices) for o in [hair, *extra])}), flush=True)
    return sc, arm, [body, shoes, hair, *eyes, *extra], info


# ── Hair styles (owner, 2026-10-25: real hair for every style, in the GLB, following the head) ─────────────────────
HAIR_STYLES = ('close_crop', 'curly_short', 'afro', 'bun_high', 'bun_low', 'long_wavy', 'wavy_medium', 'beanie')


def sphere_fit(P):
    """Least-squares sphere through points P (n, 3): (centre, radius)."""
    A = np.c_[2 * P, np.ones(len(P))]; b = (P ** 2).sum(1)
    x = np.linalg.lstsq(A, b, rcond=None)[0]
    return Vector(x[:3]), float(np.sqrt(x[3] + (x[:3] ** 2).sum()))


def _rigid_to_head(ob, arm):
    for vg in list(ob.vertex_groups): ob.vertex_groups.remove(vg)
    ob.vertex_groups.new(name='head').add(list(range(len(ob.data.vertices))), 1.0, 'REPLACE')
    if not any(m.type == 'ARMATURE' for m in ob.modifiers):
        mod = ob.modifiers.new('Armature', 'ARMATURE'); mod.object = arm
    ob.parent = arm


def _curl(p, f=1.0):
    """Deterministic lumpy noise in -1..1 (tight curls), from the vertex position."""
    return (math.sin(p.x * 210 * f + 1.3) * math.sin(p.y * 190 * f + 0.7) * math.sin(p.z * 230 * f + 2.1)
            + 0.5 * math.sin((p.x + p.z) * 330 * f + 0.4) * math.sin((p.y - p.z) * 290 * f + 1.9)) / 1.5


def smooth_hairline(hme, iters=8):
    """The cap's edge follows the body's quads, so the hairline rendered as a saw-tooth (realism pass 2026-10-25). Each
    pass moves every edge vertex half-way to the mean of its two neighbours along the edge loop, which rounds the
    hairline without moving the rest of the cap."""
    count = {}
    for p in hme.polygons:
        for k in p.edge_keys: count[k] = count.get(k, 0) + 1
    nb = {}
    for (a, b), c in count.items():
        if c == 1: nb.setdefault(a, []).append(b); nb.setdefault(b, []).append(a)
    loop = {v: n for v, n in nb.items() if len(n) == 2}
    for _ in range(iters):
        new = {v: hme.vertices[v].co * 0.5 + (hme.vertices[n[0]].co + hme.vertices[n[1]].co) * 0.25 for v, n in loop.items()}
        for v, co in new.items(): hme.vertices[v].co = co
    hme.update()


def hair_style(style, sc, arm, hair, hme, eye_mid):
    """Shapes the scalp cap (built above) into `style` and adds any separate pieces (a bun, a long curtain). Every
    piece is a mesh in the hair material, rigidly weighted to the head bone, so it is exported in the GLB and moves
    with the head. close_crop is the cap exactly as before. Returns (extra objects, description)."""
    smooth_hairline(hme)
    if style not in HAIR_STYLES:
        return [], f'close_crop: hair style {style!r} is not one CHE builds; close-cropped cap instead'
    if style == 'close_crop':
        return [], 'close_crop: scalp-cap hair mesh in the preset colour'
    mat = hme.materials[0]
    P = np.array([v.co[:] for v in hme.vertices])
    c, R = sphere_fit(P)
    bm = bmesh.new(); bm.from_mesh(hme)
    if style in ('curly_short', 'afro', 'beanie'):
        bmesh.ops.subdivide_edges(bm, edges=list(bm.edges), cuts=1, use_grid_fill=True, smooth=0.6)
    bm.verts.ensure_lookup_table(); bm.normal_update()
    rim_edges = [e for e in bm.edges if e.is_boundary]
    rim = {v for e in rim_edges for v in e.verts}
    orig = {v: v.co.copy() for v in bm.verts}
    ring = {v: 0 for v in rim}; front_ = list(rim)   # rings of vertices counted in from the edge (the afro tapers)
    while front_:
        nxt = []
        for v in front_:
            for e in v.link_edges:
                o = e.other_vert(v)
                if o not in ring: ring[o] = ring[v] + 1; nxt.append(o)
        front_ = nxt
    for v in bm.verts:
        d = (v.co - c); dist = d.length; d.normalize()
        front = max(0.0, -d.y)                      # the face looks along -Y: less hair over the forehead
        edge = (0.35 if v in rim else 1.0) if style != "afro" else min(1.0, 0.3 + 0.14 * ring[v])
        if style == 'curly_short':
            v.co = v.co + v.normal * edge * (0.010 + 0.006 * _curl(v.co))
        elif style == 'afro':
            # Rounder than a beret: full volume on top, tapering toward the lower edge over the ears and the nape.
            low = min(1.0, max(0.2, (d.z + 0.15) / 0.55))
            bulk = (0.05 + 0.012 * max(0.0, d.z)) * (1.0 - 0.55 * front) * low
            v.co = c + d * max(dist, R + edge * bulk) + v.normal * 0.006 * _curl(v.co, 0.6) * edge
        elif style == 'beanie':
            v.co = v.co + v.normal * (0.004 if v in rim else 0.011)
        else:   # buns and long hair: hair pulled back close to the head
            v.co = v.co + v.normal * (-0.004 if v not in rim else -0.001)
    if style in ('curly_short', 'afro', 'beanie'):
        # A skirt from the outer edge back to the scalp, so no gap shows under the volume from below or the side.
        inner = {v: bm.verts.new(orig[v] - (orig[v] - c).normalized() * 0.002) for v in rim}
        for e in rim_edges:
            a, b = e.verts
            try: bm.faces.new((a, b, inner[b], inner[a]))
            except ValueError: pass
    bm.normal_update(); bm.to_mesh(hme); bm.free(); hme.update()
    for p in hme.polygons: p.use_smooth = True
    _rigid_to_head(hair, arm)
    extra = []
    if style == 'beanie':
        knit = material('Beanie', rgb_env('BEANIE_SRGB', os.environ.get('OUTFIT_SRGB', '31,111,120')), 0.85, 0.15, cull=False)
        hme.materials[0] = knit
    if style in ('bun_high', 'bun_low'):
        dirn = Vector((0, 0.45, 0.89) if style == 'bun_high' else (0, 0.97, -0.25)).normalized()
        bme = bpy.data.meshes.new('HairBun'); b2 = bmesh.new()
        bmesh.ops.create_uvsphere(b2, u_segments=32, v_segments=20, radius=0.042)
        for v in b2.verts:
            v.co = Vector((v.co.x, v.co.y * 0.9, v.co.z * 0.78))
            v.co += v.co.normalized() * 0.003 * math.sin(math.atan2(v.co.y, v.co.x) * 9 + v.co.z * 120)   # twisted strands
        b2.to_mesh(bme); b2.free()
        bme.materials.append(mat)
        for p in bme.polygons: p.use_smooth = True
        bun = bpy.data.objects.new('HairBun', bme); sc.collection.objects.link(bun)
        bun.location = c + dirn * (R + 0.022)
        bun.rotation_euler = dirn.to_track_quat('Z', 'Y').to_euler()
        bpy.context.view_layer.update()
        bme.transform(bun.matrix_world); bun.matrix_world = Matrix.Identity(4)   # bake, so the skin binds at rest
        _rigid_to_head(bun, arm); extra.append(bun)
    if style in ('long_wavy', 'wavy_medium'):
        length = 0.34 if style == 'long_wavy' else 0.17
        loops = []   # rim vertices at the sides and back (behind the eyes), in order around the head
        hme.update()
        bmr = bmesh.new(); bmr.from_mesh(hme); bmr.verts.ensure_lookup_table()
        pts = [v.co.copy() for v in bmr.verts if v.is_boundary and v.co.y > eye_mid.y + 0.035]
        bmr.free()
        pts.sort(key=lambda p: math.atan2(p.x, p.y - c.y))
        if len(pts) > 4:
            seg = 14
            cme = bpy.data.meshes.new('HairLong'); cb = bmesh.new()
            grid = []
            for i, p in enumerate(pts):
                out = Vector((p.x - c.x, p.y - c.y, 0)); out = out.normalized() if out.length > 1e-6 else Vector((0, 1, 0))
                col = []
                for s in range(seg + 1):
                    t = s / seg
                    wave = 0.012 * math.sin(t * math.pi * 3.0 + i * 0.35) * t
                    q = p + out * (0.006 + 0.05 * t + wave) + Vector((0, 0, -length * t))
                    col.append(cb.verts.new(q))
                grid.append(col)
            for i in range(len(grid) - 1):
                if (pts[i] - pts[i + 1]).length > 0.05: continue   # a gap in the rim (the face side): no sheet across it
                for s in range(seg):
                    cb.faces.new((grid[i][s], grid[i + 1][s], grid[i + 1][s + 1], grid[i][s + 1]))
            cb.to_mesh(cme); cb.free()
            cme.materials.append(mat)
            for p in cme.polygons: p.use_smooth = True
            curtain = bpy.data.objects.new('HairLong', cme); sc.collection.objects.link(curtain)
            _rigid_to_head(curtain, arm); extra.append(curtain)
    names = {'curly_short': 'tight curls, a lumpy volume 1-1.6 cm deep', 'afro': 'a rounded volume about 6-7 cm deep',
             'beanie': 'a knit cap over the scalp', 'bun_high': 'hair pulled back into a bun on top',
             'bun_low': 'hair pulled back into a bun at the nape', 'long_wavy': 'long wavy hair to the shoulders',
             'wavy_medium': 'medium wavy hair to the jaw'}
    return extra, f'{style}: {names[style]}, mesh in the preset colour, rigid to the head bone'


def refine_suit(me, garment_mats, passes=4):
    """Splits each garment face in four and Taubin-smooths the garment's inner vertices; returns the measured counts.

    The mesh keeps its shape keys and skin weights: bmesh interpolates both onto the new vertices. Only vertices whose
    faces are all one garment material move, and each smoothed vertex keeps its own shape-key offsets (morph targets
    are face-only, so the suit's offsets are zero and stay zero)."""
    bm = bmesh.new(); bm.from_mesh(me)
    G = set(garment_mats)
    gfaces = [f for f in bm.faces if f.material_index in G]
    before_v = len({v for f in gfaces for v in f.verts}); before_f = len(gfaces)
    edges = list({e for f in gfaces for e in f.edges})
    bmesh.ops.subdivide_edges(bm, edges=edges, cuts=1, use_grid_fill=True, smooth=0.0)
    bm.verts.ensure_lookup_table(); bm.faces.ensure_lookup_table()
    gfaces = [f for f in bm.faces if f.material_index in G]
    for f in gfaces: f.smooth = True
    inner = [v for v in {v for f in gfaces for v in f.verts}
             if v.link_faces and len({f.material_index for f in v.link_faces}) == 1 and all(f.material_index in G for f in v.link_faces)
             and not v.is_boundary]
    idx = {v: i for i, v in enumerate(inner)}
    keys = list(bm.verts.layers.shape.values())
    basis = bm.verts.layers.shape.get('Basis') if keys else None
    offsets = [{k.name: v[k] - v.co for k in keys} for v in inner] if keys else None
    pos = np.array([v.co[:] for v in inner])
    nbrs = [[e.other_vert(v) for e in v.link_edges] for v in inner]
    for _ in range(passes):
        for lam in (0.5, -0.53):
            allpos = {v: (pos[idx[v]] if v in idx else np.array(v.co[:])) for v in {n for ns in nbrs for n in ns} | set(inner)}
            avg = np.array([np.mean([allpos[n] for n in ns], axis=0) for ns in nbrs])
            pos = pos + lam * (avg - pos)
    for v, p in zip(inner, pos): v.co = Vector(p)
    if keys:
        for v, off in zip(inner, offsets):
            for k in keys: v[k] = v.co + off[k.name]
        if basis is not None:
            for v in inner: v[basis] = v.co.copy()
    after_v = len({v for f in gfaces for v in f.verts}); after_f = len(gfaces)
    bm.normal_update(); bm.to_mesh(me); bm.free(); me.update()
    return {'garment_vertices_before': before_v, 'garment_vertices_after': after_v, 'garment_faces_before': before_f, 'garment_faces_after': after_f,
            'smoothed_vertices': len(inner), 'method': f'each garment face split in four, then {passes} Taubin passes (0.5 / -0.53) on inner vertices'}


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

    for pb in pbs: pb.rotation_quaternion = Quaternion(); pb.location = Vector()

    def clip(name, frames, fn, morph=None, after=None, extras=None):
        """One clip as its own NLA track. `after(t, f)` keys more bones once fn's pose is set (the gait's leg IK);
        `extras` become custom properties of the action, which the glTF exporter writes as the animation's extras."""
        act = bpy.data.actions.new(name); arm.animation_data_create(); arm.animation_data.action = act
        for k, val in (extras or {}).items(): act[k] = val
        if extras: CLIP_EXTRAS[name] = dict(extras)
        for f in range(frames + 1):
            rot, loc = fn(f / frames, f)
            pose_frame(f, rot, loc)
            if after: after(f / frames, f)
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

    # ── Walk and run: planted feet from foot targets and two-bone leg IK ─────────────────────────────────────────────
    # The cycles are in place (the hips stay over the origin, as a looping game-engine clip expects), so a planted
    # foot must move backward under the hips at exactly the ground speed, in a straight line on the floor: when the
    # engine moves the character forward at that speed, the foot then stays still on the ground. Each frame each ankle
    # gets a target (planted: at its rest height, moving back at constant speed, the foot held flat; swing: lifted and
    # carried forward on a Hermite curve whose end speeds match the planted phase), the pelvis is lowered wherever a
    # planted leg could not reach, and thigh and calf are solved analytically (knee forward) so the ankle lands on the
    # target. The speed goes into the clip (glTF animation extras: ground_speed_mps along forward, +Z in glTF), and
    # verify_glb.py measures a planted foot's slip against it.
    legs = {}
    for s in 'lr':
        b = {k: pbs[f'{k}_{s}'].bone for k in ('thigh', 'calf', 'foot')}
        hip, knee, ank = (b[k].head_local.copy() for k in ('thigh', 'calf', 'foot'))
        legs[s] = {'hip': hip, 'knee': knee, 'ankle': ank, 'a': (knee - hip).length, 'b': (ank - knee).length,
                   'rot': {k: b[k].matrix_local.to_quaternion() for k in b}}

    def set_world(s, part, q):
        """Poses bone part_s so its armature-space rotation is q @ its rest rotation (the head stays where the parent
        puts it)."""
        bpy.context.view_layer.update()
        pb = pbs[f'{part}_{s}']
        m = (q @ legs[s]['rot'][part]).to_matrix().to_4x4(); m.translation = pb.head
        pb.matrix = m
        pb.location = Vector(); pb.scale = Vector((1, 1, 1))

    def leg_ik(s, target, pitch, f):
        L = legs[s]
        bpy.context.view_layer.update()
        H = pbs[f'thigh_{s}'].head.copy(); d = target - H
        dist = min(d.length, 0.9995 * (L['a'] + L['b'])); u = d.normalized()
        th = math.acos(max(-1.0, min(1.0, (L['a'] ** 2 + dist ** 2 - L['b'] ** 2) / (2 * L['a'] * dist))))
        fwd = Vector((0, -1, 0)); pole = (fwd - fwd.dot(u) * u).normalized()
        K = H + L['a'] * (math.cos(th) * u + math.sin(th) * pole)
        set_world(s, 'thigh', (L['knee'] - L['hip']).rotation_difference(K - H))
        bpy.context.view_layer.update()
        set_world(s, 'calf', (L['ankle'] - L['knee']).rotation_difference(H + u * dist - pbs[f'calf_{s}'].head))
        set_world(s, 'foot', Quaternion((1, 0, 0), -math.radians(pitch)))   # a positive pitch lifts the toes
        for part in ('thigh', 'calf', 'foot'):
            pbs[f'{part}_{s}'].keyframe_insert('rotation_quaternion', frame=f)

    def stride(cycle_s, duty, step, lift, reach, sink, bob, amp_arm, bend, twist):
        """A looping gait: each foot is planted for `duty` of the cycle and moves `step` metres back under the hips
        while planted, so the ground speed is step / (duty * cycle_s). Returns (fn, after, extras) for clip()."""
        speed = step / (duty * cycle_s)

        def foot(s, t):
            """(y offset from the rest ankle, lift, toe pitch in degrees, planted) at cycle time t; forward is -Y."""
            u = (t + (0.0 if s == 'l' else 0.5)) % 1.0
            if u < duty: return -step / 2 + step * u / duty, 0.0, 0.0, True
            w = (u - duty) / (1 - duty); m = step * (1 - duty) / duty   # Hermite tangents: the planted speed
            h00, h10, h01, h11 = 2 * w ** 3 - 3 * w ** 2 + 1, w ** 3 - 2 * w ** 2 + w, -2 * w ** 3 + 3 * w ** 2, w ** 3 - w ** 2
            y = h00 * step / 2 + h10 * m - h01 * step / 2 + h11 * m
            return y, lift * math.sin(math.pi * w) ** 1.5, 10 * math.sin(math.pi * w), False

        def targets(t):
            out = {}
            for s in 'lr':
                y, z, pitch, planted = foot(s, t); a = legs[s]['ankle']
                out[s] = (Vector((a.x, a.y + y, a.z + z)), pitch, planted)
            return out

        def hips(t):
            """The pelvis height offset: the design bob (lowest at mid-stance), lowered further wherever a planted
            leg would otherwise stretch beyond `reach` of its length."""
            z = -sink - bob * math.cos(4 * math.pi * (t - duty / 2))
            for s, (tg, _, planted) in targets(t).items():
                if planted:
                    L = legs[s]; dh = tg - L['hip']
                    z = min(z, tg.z + math.sqrt(max(0.0, (reach * (L['a'] + L['b'])) ** 2 - dh.x ** 2 - dh.y ** 2)) - L['hip'].z)
            return z

        def fn(t, f):
            c = math.cos(2 * math.pi * t)
            rot = {'spine_02': [((0, 0, 1), twist * c)]}
            for s, sw in (('l', -c), ('r', c)):   # each arm swings forward with the opposite foot
                rot[f'upperarm_{s}'] = [(Y, s_down[s] * (down + 3)), (X, s_fwd[s] * amp_arm * sw)]
                rot[f'lowerarm_{s}'] = [elbow(s, bend)]
            return rot, {'pelvis': (0, 0, hips(t))}

        def after(t, f):
            for s, (tg, pitch, _) in targets(t).items(): leg_ik(s, tg, pitch, f)
        return fn, after, {'ground_speed_mps': round(speed, 4), 'forward': [0.0, 0.0, 1.0], 'in_place': True,
                           'stance_fraction': duty, 'step_m': step}

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
    walk = stride(cycle_s=1.0, duty=0.62, step=0.62, lift=0.11, reach=0.985, sink=0.01, bob=0.0, amp_arm=18, bend=20, twist=4)
    clip('walk', 30, walk[0], after=walk[1], extras=walk[2])
    run = stride(cycle_s=20 / FPS, duty=0.38, step=0.75, lift=0.30, reach=0.96, sink=0.05, bob=0.02, amp_arm=35, bend=85, twist=6)
    clip('run', 20, run[0], after=run[1], extras=run[2])
    clip('wave', 60, wave, lambda t, f: {'smile': 0.5 * min(1.0, t / 0.2), **blink(t, 0.6)})
    clip('talk', 90, talk, talk_face)
    return clips


def annotate_glb(path, extras_by_clip, character=None):
    """Adds extras to the GLB's animations by name, and what built the character to asset.extras.che_character.
    Blender's exporter does not write an action's custom properties in NLA-track mode, so the declared ground speed is
    put into the JSON chunk here (the binary chunk is unchanged)."""
    if not extras_by_clip and not character: return
    import struct
    with open(path, 'rb') as f: data = f.read()
    clen, ctype = struct.unpack_from('<I4s', data, 12)
    if ctype != b'JSON': raise ValueError('GLB without a leading JSON chunk')
    gl = json.loads(data[20:20 + clen])
    named = {a.get('name'): a for a in gl.get('animations', [])}
    missing = sorted(set(extras_by_clip) - set(named))
    if missing: raise ValueError(f'no exported animation for {missing}')
    for name, ex in extras_by_clip.items(): named[name].setdefault('extras', {}).update(ex)
    if character: gl.setdefault('asset', {}).setdefault('extras', {})['che_character'] = character
    js = json.dumps(gl, separators=(',', ':')).encode()
    js += b' ' * (-len(js) % 4)
    rest = data[20 + clen:]
    out = struct.pack('<4sII', b'glTF', 2, 12 + 8 + len(js) + len(rest)) + struct.pack('<I4s', len(js), b'JSON') + js + rest
    with open(path, 'wb') as f: f.write(out)


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
    annotate_glb(path, CLIP_EXTRAS, dict(CHARACTER, hair=info.get('hair')))
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

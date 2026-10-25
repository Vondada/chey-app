"""Cinematic-profile realism for a character built by tools/cinematic/character.py (Blender/Cycles only; the interactive
GLB keeps its own light materials).

  capture(mpfb_body)        before build(): records the body's final vertex positions and MakeHuman groups, so the
                            helper geometry (teeth, tongue) can be built at the same face shape (no mpfb_body change)
  add_mouth(c)              upper/lower teeth and tongue from MakeHuman's helper meshes, with the expression units as
                            shape keys (mouth_open lowers the lower teeth with the jaw), weighted to the head bone
  skin(c), eyes(c), cloth(c)  cinematic materials: subsurface skin with pores, T-zone shine, peach-fuzz sheen and glossy
                            lips; a wet clear coat on the eyes; woven micro-normal and sheen on cloth
  brows_lashes(c)           strand brows and lashes (tools/avatar_face/eyes_brows.py), following the head bone
  head_hair(c, ...)         strand hair grown over the hair meshes (guides follow the surface, children clump and
                            wave around them), Principled Hair BSDF; the mesh hair stays in the GLB, hidden in renders
Texture coordinates are Generated (the undeformed rest shape), so pores and weave stay on the skin while she moves.
"""
import math
import random

import bpy
import numpy as np
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

CAPTURE = {}
FWD, UP = Vector((0, -1, 0)), Vector((0, 0, 1))


def capture(mpfb_body):
    """Wraps mpfb_body.load_base and mpfb_body.to_blender for the next build() (first to_blender call = final body)."""
    lb, tb = mpfb_body.load_base, mpfb_body.to_blender
    CAPTURE.clear()

    def load_base(*a, **k):
        r = lb(*a, **k); CAPTURE['base'] = r; return r

    def to_blender(v):
        r = tb(v)
        if 'co' not in CAPTURE and len(v) == len(CAPTURE.get('base', ([],))[0]): CAPTURE['co'] = r
        return r
    mpfb_body.load_base, mpfb_body.to_blender = load_base, to_blender


def parent_to_bone(ob, arm, bone='head'):
    """Parents ob to a bone, keeping its current world placement (the armature must be in its rest pose)."""
    b = arm.data.bones[bone]
    M = arm.matrix_world @ b.matrix_local @ Matrix.Translation((0, b.length, 0))
    ob.parent = arm; ob.parent_type = 'BONE'; ob.parent_bone = bone
    ob.matrix_parent_inverse = M.inverted()


def _mat(name, rgb, rough, sss=0.0, coat=0.0, spec=0.5):
    m = bpy.data.materials.new(name); m.use_nodes = True; p = m.node_tree.nodes['Principled BSDF']
    p.inputs['Base Color'].default_value = (*rgb, 1); p.inputs['Roughness'].default_value = rough
    p.inputs['Subsurface Weight'].default_value = sss; p.inputs['Subsurface Radius'].default_value = (1.0, 0.3, 0.2)
    p.inputs['Subsurface Scale'].default_value = 0.002; p.inputs['Coat Weight'].default_value = coat
    p.inputs['Specular IOR Level'].default_value = spec
    return m


def add_mouth(c):
    """Teeth and tongue meshes (in the GLB as well: 136 + 226 vertices)."""
    from mpfb_base import target
    verts, uvs, faces, groups = CAPTURE['base']; co = CAPTURE['co']; n = len(verts)
    arm, mb = c['arm'], c['mpfb_body']
    deltas = {k: sum(target(u, n) for u in units) for k, units in mb.MORPHS.items()}
    made = []
    for g, name, mat in (('helper-upper-teeth', 'TeethUpper', _mat('Teeth', (0.78, 0.72, 0.62), 0.22, 0.25, 0.4)),
                         ('helper-lower-teeth', 'TeethLower', bpy.data.materials['Teeth']),
                         ('helper-tongue', 'Tongue', _mat('Tongue', (0.42, 0.11, 0.1), 0.38, 0.3, 0.1))):
        fl = [vi for gg, vi, ti in faces if gg == g]
        used = sorted({i for vi in fl for i in vi}); remap = {o: k for k, o in enumerate(used)}
        me = bpy.data.meshes.new(name); me.from_pydata([Vector(co[i]) for i in used], [], [[remap[i] for i in vi] for vi in fl])
        for p in me.polygons: p.use_smooth = True
        me.materials.append(mat)
        ob = bpy.data.objects.new(name, me); c['scene'].collection.objects.link(ob)
        ob.shape_key_add(name='Basis')
        for k, d in deltas.items():
            dd = d[used]
            if not np.abs(dd).max() > 1e-6: continue
            kb = ob.shape_key_add(name=k)
            for j, (x, y, z) in enumerate(dd): kb.data[j].co = kb.data[j].co + Vector((x * 0.1, -z * 0.1, y * 0.1))
            kb.value = 0.0
        ob.vertex_groups.new(name='head').add(list(range(len(me.vertices))), 1.0, 'REPLACE')
        mod = ob.modifiers.new('Armature', 'ARMATURE'); mod.object = arm; ob.parent = arm
        sub = ob.modifiers.new('Smooth', 'SUBSURF'); sub.levels = 1; sub.render_levels = 2
        made.append(ob)
    c['mouth'] = made
    return [o.name for o in made]


def _principled(m):
    return next(n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')


def _noise_bump(nt, p, scale, strength, distance=0.0005, stretch=None, detail=8.0, extra=None):
    tc = nt.nodes.new('ShaderNodeTexCoord'); src = tc.outputs['Generated']
    mp = nt.nodes.new('ShaderNodeMapping'); mp.inputs['Scale'].default_value = stretch or (1, 1, 1)
    nt.links.new(src, mp.inputs['Vector'])
    nz = nt.nodes.new('ShaderNodeTexNoise'); nz.inputs['Scale'].default_value = scale; nz.inputs['Detail'].default_value = detail
    nz.inputs['Roughness'].default_value = 0.6
    nt.links.new(mp.outputs['Vector'], nz.inputs['Vector'])
    h = nz.outputs['Fac']
    if extra is not None:
        add = nt.nodes.new('ShaderNodeMath'); add.operation = 'ADD'
        nt.links.new(h, add.inputs[0]); nt.links.new(extra, add.inputs[1]); h = add.outputs['Value']
    bump = nt.nodes.new('ShaderNodeBump'); bump.inputs['Strength'].default_value = strength; bump.inputs['Distance'].default_value = distance
    nt.links.new(h, bump.inputs['Height']); nt.links.new(bump.outputs['Normal'], p.inputs['Normal'])
    return bump, nz


def _face_frame(c):
    eyes = c['eyes']
    el, er = (sum((o.matrix_world @ v.co for v in o.data.vertices), Vector()) / len(o.data.vertices) for o in eyes)
    return (el + er) / 2, (el - er).length


def skin(c):
    """Skin: SSS tuned for deep skin, pore + fine-wrinkle bump, roughness that is lower on the T-zone and lips, a thin
    oily coat and a faint sheen (vellus hair). The base colour stays the preset's skin tone, with soft mottling."""
    body = c['body']; m = bpy.data.materials['Skin']; nt = m.node_tree; p = _principled(m)
    eye_mid, gap = _face_frame(c)
    # Point attributes (they deform with the mesh): T-zone shine and a soft cheek blush.
    basis = body.data.shape_keys.key_blocks[0].data if body.data.shape_keys else body.data.vertices
    tz, blush = [], []
    for v in basis:
        q = v.co - eye_mid
        nose = math.exp(-((q.x / (0.35 * gap)) ** 2 + ((q.z + 0.035) / 0.035) ** 2)) * (q.y < 0)
        fore = math.exp(-((q.x / (0.9 * gap)) ** 2 + ((q.z - 0.045) / 0.022) ** 2)) * (q.y < 0.02)
        chin = math.exp(-((q.x / (0.4 * gap)) ** 2 + ((q.z + 0.105) / 0.018) ** 2)) * (q.y < 0)
        tz.append(min(1.0, nose + 0.8 * fore + 0.6 * chin))
        ch = math.exp(-(((abs(q.x) - 0.75 * gap) / (0.35 * gap)) ** 2 + ((q.z + 0.03) / 0.025) ** 2)) * (q.y < 0)
        blush.append(ch)
    for name, vals in (('tzone', tz), ('blush', blush)):
        a = body.data.attributes.get(name) or body.data.attributes.new(name, 'FLOAT', 'POINT'); a.data.foreach_set('value', vals)
    base = tuple(p.inputs['Base Color'].default_value)
    # mottling and blush on the base colour
    tc = nt.nodes.new('ShaderNodeTexCoord')
    mott = nt.nodes.new('ShaderNodeTexNoise'); mott.inputs['Scale'].default_value = 60.0; mott.inputs['Detail'].default_value = 4.0
    nt.links.new(tc.outputs['Generated'], mott.inputs['Vector'])
    mr = nt.nodes.new('ShaderNodeMapRange'); mr.inputs['To Min'].default_value = 0.9; mr.inputs['To Max'].default_value = 1.08
    nt.links.new(mott.outputs['Fac'], mr.inputs['Value'])
    tint = nt.nodes.new('ShaderNodeMix'); tint.data_type = 'RGBA'; tint.blend_type = 'MULTIPLY'; tint.inputs['Factor'].default_value = 1.0
    tint.inputs[6].default_value = base
    comb = nt.nodes.new('ShaderNodeCombineColor')
    for k in range(3): nt.links.new(mr.outputs['Result'], comb.inputs[k])
    nt.links.new(comb.outputs['Color'], tint.inputs[7])
    bl = nt.nodes.new('ShaderNodeAttribute'); bl.attribute_name = 'blush'
    blm = nt.nodes.new('ShaderNodeMix'); blm.data_type = 'RGBA'
    blf = nt.nodes.new('ShaderNodeMath'); blf.operation = 'MULTIPLY'; blf.inputs[1].default_value = 0.35
    nt.links.new(bl.outputs['Fac'], blf.inputs[0]); nt.links.new(blf.outputs['Value'], blm.inputs['Factor'])
    nt.links.new(tint.outputs[2], blm.inputs[6]); blm.inputs[7].default_value = (base[0] * 1.35, base[1] * 0.85, base[2] * 0.8, 1)
    nt.links.new(blm.outputs[2], p.inputs['Base Color'])
    # subsurface: deep skin scatters less visibly (melanin absorbs), still red-weighted
    p.inputs['Subsurface Weight'].default_value = 0.3
    p.inputs['Subsurface Radius'].default_value = (1.0, 0.35, 0.18)
    p.inputs['Subsurface Scale'].default_value = 0.006
    p.inputs['Subsurface Anisotropy'].default_value = 0.8
    p.inputs['Specular IOR Level'].default_value = 0.35; p.inputs['IOR'].default_value = 1.4
    # roughness: 0.5 base, 0.3 on the T-zone, noise-varied
    tza = nt.nodes.new('ShaderNodeAttribute'); tza.attribute_name = 'tzone'
    rough = nt.nodes.new('ShaderNodeMapRange'); rough.inputs['To Min'].default_value = 0.62; rough.inputs['To Max'].default_value = 0.42
    nt.links.new(tza.outputs['Fac'], rough.inputs['Value'])
    rn = nt.nodes.new('ShaderNodeTexNoise'); rn.inputs['Scale'].default_value = 300.0
    nt.links.new(tc.outputs['Generated'], rn.inputs['Vector'])
    rmix = nt.nodes.new('ShaderNodeMath'); rmix.operation = 'MULTIPLY_ADD'; rmix.inputs[1].default_value = 0.12
    nt.links.new(rn.outputs['Fac'], rmix.inputs[0]); nt.links.new(rough.outputs['Result'], rmix.inputs[2])
    off = nt.nodes.new('ShaderNodeMath'); off.operation = 'SUBTRACT'; off.inputs[1].default_value = 0.06
    nt.links.new(rmix.outputs['Value'], off.inputs[0]); nt.links.new(off.outputs['Value'], p.inputs['Roughness'])
    p.inputs['Coat Weight'].default_value = 0.0; p.inputs['Coat Roughness'].default_value = 0.3
    p.inputs['Sheen Weight'].default_value = 0.06; p.inputs['Sheen Roughness'].default_value = 0.35
    p.inputs['Sheen Tint'].default_value = (1.0, 0.9, 0.85, 1)
    # pores (fine) + creases (coarser), on the rest shape; the bump feeds lip_gloss's lip lines
    fine = nt.nodes.new('ShaderNodeTexNoise'); fine.inputs['Scale'].default_value = 120.0; fine.inputs['Detail'].default_value = 3.0
    nt.links.new(tc.outputs['Generated'], fine.inputs['Vector'])
    fm = nt.nodes.new('ShaderNodeMath'); fm.operation = 'MULTIPLY'; fm.inputs[1].default_value = 0.4
    nt.links.new(fine.outputs['Fac'], fm.inputs[0])
    _noise_bump(nt, p, 2600.0, 0.22, distance=0.0004, detail=2.0, extra=fm.outputs['Value'])
    import lips_hairline
    lips_hairline.lip_gloss()
    return {'skin': 'SSS 0.3 (radius 1/0.35/0.18, 6 mm), pores + crease bump, T-zone roughness 0.36-0.62, specular 0.35, sheen 0.06, blush, lip gloss'}


def eyes(c):
    m = bpy.data.materials['Eye']; p = _principled(m)
    p.inputs['Coat Weight'].default_value = 0.8; p.inputs['Coat IOR'].default_value = 1.376
    p.inputs['Coat Roughness'].default_value = 0.02; p.inputs['Roughness'].default_value = 0.35
    p.inputs['Specular IOR Level'].default_value = 0.0
    p.inputs['Subsurface Weight'].default_value = 0.15; p.inputs['Subsurface Radius'].default_value = (0.8, 0.4, 0.3)
    p.inputs['Subsurface Scale'].default_value = 0.002
    return {'eyes': 'wet clear coat (IOR 1.376, roughness 0.02) over the iris and sclera; light sclera SSS'}


def cloth(c):
    out = []
    for name, sheen, rough, scale, stretch in (('Top', 0.35, 0.8, 900.0, (1, 1, 5)), ('Trousers', 0.25, 0.75, 1200.0, (1, 1, 6))):
        m = bpy.data.materials.get(name)
        if not m: continue
        nt = m.node_tree; p = _principled(m)
        p.inputs['Sheen Weight'].default_value = sheen; p.inputs['Sheen Roughness'].default_value = 0.5
        p.inputs['Sheen Tint'].default_value = p.inputs['Base Color'].default_value
        p.inputs['Roughness'].default_value = rough; p.inputs['Specular IOR Level'].default_value = 0.25
        if not p.inputs['Normal'].is_linked: _noise_bump(nt, p, scale, 0.18, stretch=stretch, detail=3.0)
        out.append(name)
    m = bpy.data.materials.get('Shoes')
    if m:
        p = _principled(m); p.inputs['Coat Weight'].default_value = 0.35; p.inputs['Coat Roughness'].default_value = 0.2; out.append('Shoes')
    return {'cloth': out}


def brows_lashes(c):
    import eyes_brows
    br = eyes_brows.brow_strands(FWD, UP, per_brow=int(float(c.get('brow_n', 1000))), width_scale=float(c.get('brow_w', 1.8)))
    la = eyes_brows.lash_strands(FWD, UP, length_scale=float(c.get('lash_len', 0.8)))
    for o in (br, la): parent_to_bone(o, c['arm'])
    return {'brows': len(br.data.curves), 'lashes': len(la.data.curves)}


def _bvh(objs):
    dg = bpy.context.evaluated_depsgraph_get()
    V, P = [], []
    for o in objs:
        ev = o.evaluated_get(dg); me = ev.to_mesh(); base = len(V)
        V += [o.matrix_world @ v.co for v in me.vertices]; P += [[base + i for i in p.vertices] for p in me.polygons]
        ev.to_mesh_clear()
    return BVHTree.FromPolygons(V, P)


def _sample_surface(ob, n, rng):
    me = ob.data
    tris = [(p.vertices[0], p.vertices[k], p.vertices[k + 1]) for p in me.polygons for k in range(1, len(p.vertices) - 1)]
    V = np.array([ob.matrix_world @ v.co for v in me.vertices])
    T = np.array(tris); a, b, cc = V[T[:, 0]], V[T[:, 1]], V[T[:, 2]]
    area = 0.5 * np.linalg.norm(np.cross(b - a, cc - a), axis=1)
    pick = rng.choice(len(T), n, p=area / area.sum())
    u, v = rng.random(n), rng.random(n); flip = u + v > 1; u[flip], v[flip] = 1 - u[flip], 1 - v[flip]
    return a[pick] + (b[pick] - a[pick]) * u[:, None] + (cc[pick] - a[pick]) * v[:, None]


def head_hair(c, n_guides=420, children=60, seed=5, step=0.006, max_len=0.42, melanin=0.92, redness=0.2,
              root_r=0.00006, tip_r=0.00002, hide_mesh=True, lite_every=4):
    """Strand hair over the hair meshes. Guides start on the scalp cap, flow down and back over the hair surface
    (kept a few mm above it), and stop where the hair mesh ends; each guide gets `children` clumped, waved strands."""
    rng = np.random.default_rng(seed)
    hair_objs = [o for o in c['meshes'] if o.name.startswith('Hair')]
    cap = next(o for o in hair_objs if o.name == 'Hair')
    bvh = _bvh(hair_objs)
    head_bvh = _bvh([c['body']])
    eye_mid, gap = _face_frame(c)
    roots = _sample_surface(cap, n_guides, rng)
    lo = min((o.matrix_world @ Vector(b)).z for o in hair_objs for b in o.bound_box)
    guides = []
    for r0 in roots:
        p = Vector(r0); loc, nrm, _, _ = bvh.find_nearest(p)
        lift = rng.uniform(0.002, 0.007)
        side = 1.0 if p.x > 0 else -1.0
        front = max(0.0, min(1.0, ((eye_mid.y + 0.07) - p.y) / 0.05))   # hairline roots are combed back over the scalp
        # (sweeping them sideways laid strands across the forehead like a visor in the first close-up renders)
        d = (Vector((side * (0.5 - 0.25 * front), 0.25 + 1.1 * front, -1.0 + 0.85 * front))).normalized()
        pts = [p + nrm * 0.0015]
        for k in range(int(max_len / step)):
            q = pts[-1] + d * step
            loc, nrm, _, dist = bvh.find_nearest(q)
            if loc is None or dist > 0.03: break
            h = lift * (0.3 + 0.7 * min(1.0, k / 12))
            q = loc + nrm * h
            # keep outside the head/body skin
            hl, hn, _, hd = head_bvh.find_nearest(q)
            if hl is not None and (q - hl).dot(hn) < 0.003: q = hl + hn * 0.003
            g = Vector((0, 0, -1)); t = (d + g * 0.35); t = t - nrm * t.dot(nrm)
            if t.length < 1e-6: break
            d = t.normalized()
            pts.append(q)
            if q.z < lo + 0.01: break
        if len(pts) >= 4: guides.append(np.array([tuple(x) for x in pts]))
    strands = []
    for G in guides:
        L = len(G)
        s = np.linspace(0, 1, L)[:, None]
        tang = np.gradient(G, axis=0); tang /= np.linalg.norm(tang, axis=1, keepdims=True) + 1e-9
        side = np.cross(tang, [0, 0, 1.0]); side /= np.linalg.norm(side, axis=1, keepdims=True) + 1e-9
        nrm = np.cross(side, tang)
        for _ in range(children):
            off = rng.normal(0, 0.006, 3)
            spread = off[None, :] * (1 - 0.55 * s ** 1.3)        # clump toward the guide at the tips
            ph, lam, amp = rng.uniform(0, 6.3), rng.uniform(0.035, 0.06), rng.uniform(0.002, 0.006)
            arc = np.cumsum(np.r_[0, np.linalg.norm(np.diff(G, axis=0), axis=1)])[:, None]
            wave = amp * (s ** 0.8) * (np.sin(2 * np.pi * arc / lam + ph) * side + 0.6 * np.cos(2 * np.pi * arc / lam + ph) * nrm)
            cut = L if rng.random() > 0.25 else max(4, int(L * rng.uniform(0.6, 1.0)))
            pts = (G + spread + wave)[:cut]
            if rng.random() < 0.03:   # flyaways
                pts = pts + (s[:cut] ** 2) * rng.normal(0, 0.012, 3)
            strands.append(pts)
    if not strands: raise RuntimeError('head_hair: no guide stayed on the hair surface (is the armature in its rest pose?)')
    hc = bpy.data.hair_curves.new('HeadHair')
    hc.add_curves([len(s) for s in strands])
    hc.points.foreach_set('position', np.concatenate(strands).ravel())
    rad = np.concatenate([root_r + (tip_r - root_r) * np.linspace(0, 1, len(s)) for s in strands])
    hc.points.foreach_set('radius', rad)
    m = bpy.data.materials.new('HeadHairStrands'); m.use_nodes = True; nt = m.node_tree; nt.nodes.clear()
    hb = nt.nodes.new('ShaderNodeBsdfHairPrincipled'); hb.parametrization = 'MELANIN'
    for k, v in (('Melanin', melanin), ('Melanin Redness', redness), ('Roughness', 0.32), ('Radial Roughness', 0.3),
                 ('Coat', 0.12), ('Random Roughness', 0.2), ('Random Color', 0.15)):
        if k in hb.inputs: hb.inputs[k].default_value = v
    out = nt.nodes.new('ShaderNodeOutputMaterial'); nt.links.new(hb.outputs[0], out.inputs['Surface'])
    hc.materials.append(m)
    ob = bpy.data.objects.new('HeadHair', hc); c['scene'].collection.objects.link(ob)
    parent_to_bone(ob, c['arm'])
    lite_scale = lite_every ** 0.5   # thicker strands keep roughly the coverage of the thinned set
    # a thinned copy (every `lite_every`-th strand, thicker) for wide shots, where the full set costs render time for detail
    # nobody can see; the sample switches between them per shot
    lite = strands[::lite_every]
    hl = bpy.data.hair_curves.new('HeadHairLite'); hl.add_curves([len(s) for s in lite])
    hl.points.foreach_set('position', np.concatenate(lite).ravel())
    hl.points.foreach_set('radius', np.concatenate([lite_scale * (root_r + (tip_r - root_r) * np.linspace(0, 1, len(s))) for s in lite]))
    hl.materials.append(m)
    obl = bpy.data.objects.new('HeadHairLite', hl); c['scene'].collection.objects.link(obl)
    parent_to_bone(obl, c['arm']); obl.hide_render = True
    c['hair_lite'] = obl
    c['hair_follow'] = HairFollow(c['arm'], [ob, obl], [strands, lite])
    if hide_mesh:
        for o in hair_objs:
            if o.name != 'Hair': o.hide_render = True
        capm = cap.data.materials[0]; cp = _principled(capm)
        cp.inputs['Roughness'].default_value = 0.85; cp.inputs['Specular IOR Level'].default_value = 0.1
    c['hair_strands'] = ob
    return {'guides': len(guides), 'strands': len(strands), 'points': int(sum(len(s) for s in strands))}


class HairFollow:
    """Long hair is not rigid: strand roots follow the head, the lengths below blend toward the upper spine (linear
    blend of the two bones' deform transforms by arc length), so hair hangs onto the shoulders and back instead of
    swinging out like a helmet when she tilts her head. Not a physics simulation: no collisions, no inertia beyond an
    optional lag of the spine transform. Call update() after each frame_set(); the objects are unparented and their
    points rewritten in world space."""

    def __init__(self, arm, objs, strand_sets, tip_bone='spine_03', max_w=0.85):
        self.arm, self.objs, self.tip_bone = arm, objs, tip_bone
        self.rest, self.w = [], []
        for o, ss in zip(objs, strand_sets):
            o.parent = None; o.matrix_world = Matrix.Identity(4)
            P = np.concatenate(ss); self.rest.append(np.c_[P, np.ones(len(P))])
            w = np.concatenate([max_w * _smooth01(np.linspace(0, 1, len(s)) * 1.6 - 0.25) for s in ss])
            self.w.append(w[:, None])

    def _deform(self, name):
        pb = self.arm.pose.bones[name]
        return np.array(self.arm.matrix_world @ pb.matrix @ pb.bone.matrix_local.inverted())

    def update(self):
        Mh, Ms = self._deform('head'), self._deform(self.tip_bone)
        for o, P, w in zip(self.objs, self.rest, self.w):
            if o.hide_render: continue
            ph = P @ Mh.T; ps = P @ Ms.T
            o.data.points.foreach_set('position', ((1 - w) * ph[:, :3] + w * ps[:, :3]).ravel())
            o.data.update_tag()


def _smooth01(x):
    x = np.clip(x, 0, 1)
    return x * x * (3 - 2 * x)


def apply_all(c, guides=420, children=60):
    """Every cinematic layer, in order; returns a receipt dict."""
    rec = {}
    arm = c['arm']; was = arm.data.pose_position
    arm.data.pose_position = 'REST'   # strands are grown on, and parented from, the rest pose
    bpy.context.view_layer.update()
    try:
        rec.update(skin(c)); rec.update(eyes(c)); rec.update(cloth(c))
        if not c.get('mouth'):
            rec['mouth'] = add_mouth(c) if CAPTURE.get('co') is not None else 'not built (capture() was not installed before build)'
        rec['brows_lashes'] = brows_lashes(c)
        rec['hair'] = head_hair(c, n_guides=guides, children=children)
    finally:
        arm.data.pose_position = was; bpy.context.view_layer.update()
    return rec

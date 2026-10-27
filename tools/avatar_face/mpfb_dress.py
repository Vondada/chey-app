"""Face rebuild, stage 2 (features in neutral light): the fitted MPFB2 head placed where CHE's head is, with skin, eyes,
lashes, brows and her own strand hair, rendered under the same neutral studio light as the clay stage.

  python3 mpfb_dress.py      env: CHE (che.blend), FIT (face_fit.py json), OUT_DIR, SAMPLES (32), VIEWS ("0,30"), FACE,
                             TARGET_SRGB ("96,55,38": skin albedo from the reference's cheek, corrected for its warm light)

CHE's scene supplies the rig, her hair cards and the camera space; her old body, eyes and clothes are hidden. The new
head is moved, turned and scaled so its eye centres sit exactly on hers, so her hair fits. Before rendering, checks
fail loudly: eyes inside their sockets, lash/brow/hair strand counts, skin albedo against the target.
"""
import math
import os
import sys

import bpy
import numpy as np
from mathutils import Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE); sys.path.insert(0, os.path.join(HERE, '..', 'avatar_portraits'))
import json  # noqa: E402

from mpfb_base import load_base, macro_woman, slider_deltas, apply_sliders, to_blender, target  # noqa: E402

OUT = os.environ.get('OUT_DIR', '.')
CHECKS = []


def check(name, ok, detail=''):
    CHECKS.append((name, bool(ok), detail))
    print('CHECK', 'PASS' if ok else 'FAIL', name, detail, flush=True)


bpy.ops.wm.open_mainfile(filepath=os.environ['CHE'])
sc = bpy.context.scene
rig = bpy.data.objects['Rig']
if rig.animation_data: rig.animation_data.action = None
for pb in rig.pose.bones: pb.matrix_basis.identity()
bpy.context.view_layer.update()


def centre(ob):
    dg = bpy.context.evaluated_depsgraph_get(); ev = ob.evaluated_get(dg); me = ev.to_mesh()
    pts = [ob.matrix_world @ v.co for v in me.vertices]; ev.to_mesh_clear()
    c = sum(pts, Vector()) / len(pts)
    return c, max((p - c).length for p in pts)


cel, cer = centre(bpy.data.objects['Eye_l'])[0], centre(bpy.data.objects['Eye_r'])[0]
che_mid, che_gap = (cel + cer) / 2, (cel - cer).length
fwd = che_mid - rig.matrix_world @ rig.pose.bones['head'].head; fwd.z = 0; fwd.normalize()
up = Vector((0, 0, 1))
for o in sc.objects:  # CHE's old head, eyes, lashes and clothes step aside; her rig and hair cards stay
    if o.type in ('MESH', 'CURVES') and o.name != 'Hair':
        o.hide_render = True; o.hide_viewport = True
    if o.type == 'LIGHT': o.hide_render = True
for name in ('Body', 'Eye_l', 'Eye_r', 'Lashes'):
    if name in bpy.data.objects: bpy.data.objects[name].name = name + '_old'
for name in ('Skin', 'Eyes'):  # the shared steps look these up by name
    if name in bpy.data.materials: bpy.data.materials[name].name = name + '_old'

# ── The fitted head, placed on CHE's eye centres ──────────────────────────────────────────────────────────────────
win = json.load(open(os.environ['FIT']))['winner']
verts, uvs, faces, groups = load_base()
n = len(verts)
# RACE ("african=0.7,caucasian=0.3"): MakeHuman's own ethnic mix; MATURE (0.1 is about 31 years old).
race = {k: float(x) for k, x in (kv.split('=') for kv in os.environ.get('RACE', 'african=1').split(','))}
# SEX (0 woman .. 1 man) and FIT_W (how much of CHE's own landmark fit to apply: 1 for CHE, 0 for the crew, whose faces
# come only from their preset sliders) come from the identity preset (tools/avatar_face/identity.py). Without an
# IDENTITY the old single-face behaviour (full fit) holds.
fitw = float(os.environ.get('FIT_W', '0' if os.environ.get('IDENTITY') else '1'))
v = apply_sliders(macro_woman(verts, race, youth=win.get('youth', 0.0) * fitw, mature=float(os.environ.get('MATURE', '0')),
                              sex=float(os.environ.get('SEX', '0'))),
                  slider_deltas(n), {k: w * fitw for k, w in win['weights'].items()})
print('IDENTITY', os.environ.get('IDENTITY', '(none)'), 'fit', fitw, flush=True)
# FACE ("lr:eyes/eye-eyefold-down=0.4,mouth/mouth-cupidsbow-incr=0.5"): extra MakeHuman targets on top of the fit,
# for features written out in words; "lr:" applies the l- and r- versions.
# STYLE (owner, 2026-10-24): one CHE, three looks from the same fitted head, rig and face keys. photoreal is the
# approved face unchanged; hybrid is a realistic game character (slightly larger eyes, smoother skin); stylized is an
# expressive animated look (large eyes, small nose, round cheeks and head, soft shading). Only MakeHuman targets and
# material values change, so every look keeps the same topology, shape keys and lip sync.
STYLE = os.environ.get('STYLE', 'photoreal')
STYLE_FACE = {
    'photoreal': '',
    'hybrid': 'lr:eyes/eye-scale-incr=0.6,nose/nose-scale-horiz-decr=0.15,chin/chin-width-decr=0.1',
    'stylized': 'lr:eyes/eye-scale-incr=1.6,nose/nose-scale-horiz-decr=0.6,nose/nose-scale-vert-decr=0.5,'
                'lr:cheek/cheek-volume-incr=0.45,head/head-round=0.45,chin/chin-height-decr=0.35,mouth/mouth-scale-horiz-decr=0.15',
}
if STYLE not in STYLE_FACE: raise SystemExit(f'unknown STYLE {STYLE!r}: photoreal, hybrid or stylized')
print('STYLE', STYLE, flush=True)
for item in [x for x in os.environ.get('FACE', '').split(',') if x.strip()]:
    tname, tw = item.split('='); v = v + target(tname.strip(), n) * float(tw)
# The head is placed and scaled by its eye centres. They are measured before the style targets, so a style that
# enlarges the eyes or rounds the head changes the face instead of being scaled away with the whole head.
co0 = to_blender(v)
el, er = co0[sorted(groups['helper-l-eye'])].mean(0), co0[sorted(groups['helper-r-eye'])].mean(0)
mid, gap = (el + er) / 2, float(np.linalg.norm(el - er))
for item in [x for x in STYLE_FACE[STYLE].split(',') if x.strip()]:
    tname, tw = item.split('='); v = v + target(tname.strip(), n) * float(tw)
co = to_blender(v)
yaw = math.atan2(fwd.y, fwd.x) - math.atan2(-1.0, 0.0)   # the MPFB face looks along -Y
place = Matrix.Translation(che_mid) @ Matrix.Rotation(yaw, 4, 'Z') @ Matrix.Scale(che_gap / gap, 4) @ Matrix.Translation(Vector(-mid))
opened = target('expression/units/african/mouth-open', n)
body_faces = [(vi, ti) for g, vi, ti in faces if g == 'body']
used = sorted({i for vi, _ in body_faces for i in vi}); remap = {o: k for k, o in enumerate(used)}
me = bpy.data.meshes.new('Body')
me.from_pydata([place @ Vector(co[i]) for i in used], [], [[remap[i] for i in vi] for vi, _ in body_faces])
uvl = me.uv_layers.new(name='UVMap'); k = 0
for vi, ti in body_faces:
    for t in ti: uvl.data[k].uv = uvs[t]; k += 1
for p in me.polygons: p.use_smooth = True
body = bpy.data.objects.new('Body', me); sc.collection.objects.link(body)
# mouth_open (from MakeHuman's own expression unit) lets lip_gloss find the lips, as on CHE's old head.
body.shape_key_add(name='Basis')
kb = body.shape_key_add(name='mouth_open')
s_rot = Matrix.Rotation(yaw, 4, 'Z').to_3x3() * (che_gap / gap)
for k, i in enumerate(used):
    d = opened[i]
    kb.data[k].co = kb.data[k].co + s_rot @ Vector((d[0] * 0.1, -d[2] * 0.1, d[1] * 0.1))
kb.value = 0.0
# Lips for the gloss: the vertices MakeHuman's lip-volume targets move (the mouth-open unit also moves the jaw).
lipd = np.linalg.norm(target('mouth/mouth-upperlip-volume-incr', n), axis=1) + np.linalg.norm(target('mouth/mouth-lowerlip-volume-incr', n), axis=1)
lipd = lipd[used]; lip_mask = list(np.clip(lipd / (np.quantile(lipd[lipd > 0], 0.6) + 1e-9), 0, 1))
sub = body.modifiers.new('FaceSubd', 'SUBSURF'); sub.levels = 1; sub.render_levels = 2

# ── Eyes: procedural iris, pupil, limbus and sclera, facing forward; cornea from eyes_brows ─────────────────────
eye_mat = bpy.data.materials.new('Eyes'); eye_mat.use_nodes = True; nt = eye_mat.node_tree
eb = nt.nodes['Principled BSDF']
tc = nt.nodes.new('ShaderNodeTexCoord')
sep = nt.nodes.new('ShaderNodeSeparateXYZ'); nt.links.new(tc.outputs['Object'], sep.inputs[0])
# radial distance across the eye front, normalised to the sphere radius (object Z points out of the eye)
rad = nt.nodes.new('ShaderNodeVectorMath'); rad.operation = 'LENGTH'
comb = nt.nodes.new('ShaderNodeCombineXYZ'); nt.links.new(sep.outputs['X'], comb.inputs['X']); nt.links.new(sep.outputs['Y'], comb.inputs['Y'])
nt.links.new(comb.outputs[0], rad.inputs[0])
ramp = nt.nodes.new('ShaderNodeValToRGB'); nt.links.new(rad.outputs['Value'], ramp.inputs['Fac'])
cr = ramp.color_ramp; cr.interpolation = 'LINEAR'
# A human iris is about 11.7 mm across on a 24 mm eye (radius 0.49 of the eye's); the sclera is an off-white that
# darkens toward the corners, never paper white.
iw = float(os.environ.get('IRIS', '1.0'))   # iris brightness: 1.0 is the v6 near-black brown; 2-3 reads brown at a distance
if os.environ.get('IRIS_SRGB'):
    # The preset's iris colour (sRGB) is the iris body; the ring by the pupil is darker and warmer, the limbal ring at the
    # edge is a dark rim. Scaled so CHE's brown at IRIS 2.5 matches the v7 iris she was approved with.
    # The MakeHuman eyeball is larger than its lid opening, so at the old 0.47 radius the iris filled only a quarter of
    # the opening and the eye read as all white; the iris now reaches 0.64 of the sphere radius (about 40% of the
    # opening, as on a real face), the pupil 0.2, and the sclera is a clean warm white that greys toward the corners.
    ic = [((c / 255) / 12.92 if c / 255 <= 0.04045 else ((c / 255 + 0.055) / 1.055) ** 2.4) * iw * 0.4
          for c in (float(x) for x in os.environ['IRIS_SRGB'].split(','))]
    stops = [(0.0, (0.004, 0.003, 0.003)), (0.19, (0.004, 0.003, 0.003)), (0.22, tuple(x * 0.55 for x in ic)), (0.5, tuple(ic)),
             (0.62, tuple(x * 0.3 for x in ic)), (0.67, (0.62, 0.56, 0.52)), (0.82, (0.58, 0.5, 0.46)), (1.0, (0.36, 0.26, 0.23))]
else:
    stops = [(0.0, (0.004, 0.003, 0.003)), (0.15, (0.004, 0.003, 0.003)), (0.17, (0.018 * iw, 0.008 * iw, 0.004 * iw)), (0.38, (0.035 * iw, 0.016 * iw, 0.007 * iw)),
             (0.47, (0.018 * iw, 0.011 * iw, 0.008 * iw)), (0.52, (0.42, 0.36, 0.32)), (0.75, (0.40, 0.33, 0.29)), (1.0, (0.24, 0.15, 0.13))]
cr.elements[0].position, cr.elements[0].color = stops[0][0], (*stops[0][1], 1)
cr.elements[1].position, cr.elements[1].color = stops[1][0], (*stops[1][1], 1)
for pos, col in stops[2:]:
    e = cr.elements.new(pos); e.color = (*col, 1)
# iris fibres: a stretched noise mixed in over the iris
nz = nt.nodes.new('ShaderNodeTexNoise'); nz.inputs['Scale'].default_value = 60; nz.inputs['Detail'].default_value = 4
nt.links.new(tc.outputs['Object'], nz.inputs['Vector'])
mix = nt.nodes.new('ShaderNodeMix'); mix.data_type = 'RGBA'; mix.blend_type = 'OVERLAY'; mix.inputs['Factor'].default_value = 0.2
nt.links.new(ramp.outputs['Color'], mix.inputs[6]); nt.links.new(nz.outputs['Color'], mix.inputs[7])
nt.links.new(mix.outputs[2], eb.inputs['Base Color']); eb.inputs['Roughness'].default_value = 0.3
eyes = []
for gname, name in (('helper-l-eye', 'Eye_l'), ('helper-r-eye', 'Eye_r')):
    pts = [place @ Vector(co[i]) for i in groups[gname]]
    c = sum(pts, Vector()) / len(pts); r = max((p - c).length for p in pts) * 0.97
    # unit sphere scaled to the eye, so object coordinates are normalised for the iris ramp
    bpy.ops.mesh.primitive_uv_sphere_add(segments=48, ring_count=24, radius=1.0, location=c)
    e = bpy.context.active_object; e.name = name; e.scale = (r, r, r)
    e.rotation_euler = fwd.to_track_quat('Z', 'Y').to_euler()   # local +Z looks out of the face
    e.data.materials.append(eye_mat)
    for p in e.data.polygons: p.use_smooth = True
    eyes.append((c, r))
bpy.context.view_layer.update()
eye_mid = (eyes[0][0] + eyes[1][0]) / 2

# Check: each eye sits in its socket (skin within 4 mm of the eye front, and the eye front not poking through).
from mathutils.bvhtree import BVHTree  # noqa: E402
dg = bpy.context.evaluated_depsgraph_get(); bev = body.evaluated_get(dg); bme = bev.to_mesh(); bme.transform(body.matrix_world)
bvh = BVHTree.FromPolygons([x.co.copy() for x in bme.vertices], [p.vertices[:] for p in bme.polygons]); bev.to_mesh_clear()
for (c, r), name in zip(eyes, ('left', 'right')):
    front = c + fwd * r
    near = bvh.find_nearest(front)[3]
    # 4 mm on a real-size eye (radius about 12 mm); larger stylized eyes get the same limit relative to their size
    check(f'{name} eye in socket', near < max(0.004, r / 3), f'nearest skin to eye front {near * 1000:.1f} mm (eye radius {r * 1000:.1f} mm)')
# Aim each eye through the middle of its lid opening (looking straight at it, the heights where no skin covers the
# eyeball), so the iris sits centred between the lids instead of tucked under the upper lid.
for (c, r), name in zip(eyes, ('Eye_l', 'Eye_r')):
    seen = []
    for k in range(-40, 41):
        h = r * k / 42
        loc, _, _, dist = bvh.ray_cast(c + up * h + fwd * 2 * r, -fwd, 4 * r)
        if loc is None or dist >= 2 * r - math.sqrt(r * r - h * h) - 0.0002: seen.append(h)
    if seen:
        hm = (min(seen) + max(seen)) / 2
        gaze = (up * hm + fwd * math.sqrt(r * r - hm * hm)).normalized()
        bpy.data.objects[name].rotation_euler = gaze.to_track_quat('Z', 'Y').to_euler()
        print('GAZE', name, f'opening {min(seen) * 1000:.1f}..{max(seen) * 1000:.1f} mm, tilt {math.degrees(math.asin(hm / r)):.1f} deg', flush=True)

# ── Skin: reference-matched albedo, subsurface, pores, lips, tone variation ──────────────────────────────────────
from lips_hairline import lip_gloss, clear_face_strands, baby_hairs  # noqa: E402
from eyes_brows import add_corneas, lash_strands, brow_strands  # noqa: E402
from strand_hair import build_strand_hair  # noqa: E402


def lin(c):
    c /= 255.0
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


albedo = [lin(float(x)) for x in os.environ.get('TARGET_SRGB', '96,55,38').split(',')]
skin = bpy.data.materials.new('Skin'); skin.use_nodes = True; nt = skin.node_tree
b = nt.nodes['Principled BSDF']
tc = nt.nodes.new('ShaderNodeTexCoord')
mott = nt.nodes.new('ShaderNodeTexNoise'); mott.inputs['Scale'].default_value = 30; mott.inputs['Detail'].default_value = 3
nt.links.new(tc.outputs['Object'], mott.inputs['Vector'])
mr = nt.nodes.new('ShaderNodeMapRange'); mr.inputs['To Min'].default_value = 0.9; mr.inputs['To Max'].default_value = 1.08
nt.links.new(mott.outputs['Fac'], mr.inputs['Value'])
ao = nt.nodes.new('ShaderNodeAmbientOcclusion'); ao.samples = 8; ao.inputs['Distance'].default_value = 0.012
aom = nt.nodes.new('ShaderNodeMapRange'); aom.inputs['To Min'].default_value = 0.7
nt.links.new(ao.outputs['AO'], aom.inputs['Value'])
f = nt.nodes.new('ShaderNodeMath'); f.operation = 'MULTIPLY'
nt.links.new(mr.outputs['Result'], f.inputs[0]); nt.links.new(aom.outputs['Result'], f.inputs[1])
base = nt.nodes.new('ShaderNodeRGB'); base.outputs[0].default_value = (*albedo, 1)
lips_col = nt.nodes.new('ShaderNodeRGB'); lips_col.outputs[0].default_value = (albedo[0] * 0.62, albedo[1] * 0.42, albedo[2] * 0.55, 1)
lipat = nt.nodes.new('ShaderNodeAttribute'); lipat.attribute_name = 'lipmask'
# Lips: the lip mask runs 0 at the skin to 1 in the lip centre. The colour follows it through a ramp: a darker rim
# (the natural lip line), the lip colour, and a lighter, rosier centre of each lip, broken up by a fine noise.
lip_ramp = nt.nodes.new('ShaderNodeValToRGB'); lr_ = lip_ramp.color_ramp
lr_.elements[0].position, lr_.elements[0].color = 0.0, (*albedo, 1)
lr_.elements[1].position, lr_.elements[1].color = 1.0, (albedo[0] * 0.95, albedo[1] * 0.55, albedo[2] * 0.6, 1)
for pos, col in ((0.25, (albedo[0] * 0.55, albedo[1] * 0.3, albedo[2] * 0.32)), (0.6, tuple(lips_col.outputs[0].default_value[:3]))):
    e = lr_.elements.new(pos); e.color = (*col, 1)
lipn = nt.nodes.new('ShaderNodeTexNoise'); lipn.inputs['Scale'].default_value = 400; lipn.inputs['Detail'].default_value = 4
nt.links.new(tc.outputs['Object'], lipn.inputs['Vector'])
lipv = nt.nodes.new('ShaderNodeMath'); lipv.operation = 'MULTIPLY'   # noise on the lips only, none on the skin
nt.links.new(lipn.outputs['Fac'], lipv.inputs[0]); nt.links.new(lipat.outputs['Fac'], lipv.inputs[1])
lipf = nt.nodes.new('ShaderNodeMath'); lipf.operation = 'MULTIPLY_ADD'; lipf.inputs[1].default_value = 0.15; lipf.use_clamp = True
nt.links.new(lipv.outputs['Value'], lipf.inputs[0]); nt.links.new(lipat.outputs['Fac'], lipf.inputs[2])
nt.links.new(lipf.outputs['Value'], lip_ramp.inputs['Fac'])
lm = nt.nodes.new('ShaderNodeMix'); lm.data_type = 'RGBA'
nt.links.new(lipat.outputs['Fac'], lm.inputs['Factor']); nt.links.new(base.outputs[0], lm.inputs[6]); nt.links.new(lip_ramp.outputs['Color'], lm.inputs[7])
lm.inputs['Factor'].default_value = 1.0; nt.links.remove(lm.inputs['Factor'].links[0])
mul = nt.nodes.new('ShaderNodeMix'); mul.data_type = 'RGBA'; mul.blend_type = 'MULTIPLY'; mul.inputs['Factor'].default_value = 1.0
grey = nt.nodes.new('ShaderNodeCombineColor')
for k in range(3): nt.links.new(f.outputs['Value'], grey.inputs[k])
nt.links.new(lm.outputs[2], mul.inputs[6]); nt.links.new(grey.outputs[0], mul.inputs[7])
nt.links.new(mul.outputs[2], b.inputs['Base Color'])
b.subsurface_method = 'RANDOM_WALK_SKIN'
b.inputs['Subsurface Weight'].default_value = 0.2
b.inputs['Subsurface Radius'].default_value = (1.0, 0.35, 0.18)
b.inputs['Subsurface Scale'].default_value = 0.0025
b.inputs['Specular IOR Level'].default_value = 0.32   # less mirror-like sheen on the forehead and cheeks
# Skin shine varies across the face (oilier and smoother in places): roughness 0.46..0.62 from a broad noise.
rn = nt.nodes.new('ShaderNodeTexNoise'); rn.inputs['Scale'].default_value = 45; rn.inputs['Detail'].default_value = 3
nt.links.new(tc.outputs['Object'], rn.inputs['Vector'])
rmr = nt.nodes.new('ShaderNodeMapRange'); rmr.inputs['To Min'].default_value = 0.5; rmr.inputs['To Max'].default_value = 0.66
nt.links.new(rn.outputs['Fac'], rmr.inputs['Value']); nt.links.new(rmr.outputs['Result'], b.inputs['Roughness'])
b.inputs['Coat Weight'].default_value = 0.0
b.inputs['Sheen Weight'].default_value = 0.04
# pores and fine bumps in object space (the MakeHuman UVs are fine, but object space needs no texel tuning)
vor = nt.nodes.new('ShaderNodeTexVoronoi'); vor.inputs['Scale'].default_value = 2600; vor.feature = 'F1'
nt.links.new(tc.outputs['Object'], vor.inputs['Vector'])
fine = nt.nodes.new('ShaderNodeTexNoise'); fine.inputs['Scale'].default_value = 900; fine.inputs['Detail'].default_value = 6
nt.links.new(tc.outputs['Object'], fine.inputs['Vector'])
hsum = nt.nodes.new('ShaderNodeMath'); hsum.operation = 'MULTIPLY_ADD'; hsum.inputs[1].default_value = 0.5
nt.links.new(fine.outputs['Fac'], hsum.inputs[0]); nt.links.new(vor.outputs['Distance'], hsum.inputs[2])
bump = nt.nodes.new('ShaderNodeBump'); bump.inputs['Distance'].default_value = 0.0004
bump.inputs['Strength'].default_value = {'photoreal': 1.0, 'hybrid': 0.3, 'stylized': 0.0}[STYLE] * float(os.environ.get('PORES', '0.12'))
if STYLE != 'photoreal':   # smoother, even skin: no tone mottling, one roughness, softer subsurface
    mr.inputs['To Min'].default_value = mr.inputs['To Max'].default_value = 1.0
    rmr.inputs['To Min'].default_value = rmr.inputs['To Max'].default_value = 0.52 if STYLE == 'hybrid' else 0.62
    b.inputs['Subsurface Weight'].default_value = 0.25 if STYLE == 'hybrid' else 0.35
nt.links.new(hsum.outputs['Value'], bump.inputs['Height']); nt.links.new(bump.outputs['Normal'], b.inputs['Normal'])
body.data.materials.append(skin)
# Scalp under the hair: where CHE's hair cards lie within about 1-2 cm of the skin above the brows, the skin is tinted to
# a dark scalp, so the part and any thin patch show dark scalp instead of bare face-coloured skin.
hair_o = bpy.data.objects.get('Hair'); scalp = [0.0] * len(body.data.vertices)
if hair_o and hair_o.type == 'MESH':
    dg = bpy.context.evaluated_depsgraph_get(); hev = hair_o.evaluated_get(dg); hme = hev.to_mesh(); hme.transform(hair_o.matrix_world)
    hb = BVHTree.FromPolygons([x.co.copy() for x in hme.vertices], [q.vertices[:] for q in hme.polygons]); hev.to_mesh_clear()
    for vt in body.data.vertices:
        wco = body.matrix_world @ vt.co
        rise = (wco.z - che_mid.z - 0.95 * che_gap) / (0.3 * che_gap)   # fades in above the forehead, never on it
        if rise > 0:
            d = hb.find_nearest(wco)[3]
            scalp[vt.index] = max(0.0, min(1.0, (0.022 - d) / 0.012)) * min(1.0, rise) if d is not None else 0.0
sat = body.data.attributes.new('scalp', 'FLOAT', 'POINT'); sat.data.foreach_set('value', scalp)
sca = nt.nodes.new('ShaderNodeAttribute'); sca.attribute_name = 'scalp'
scm = nt.nodes.new('ShaderNodeMix'); scm.data_type = 'RGBA'; scm.inputs[7].default_value = (0.012, 0.008, 0.006, 1)
nt.links.new(sca.outputs['Fac'], scm.inputs['Factor']); nt.links.new(mul.outputs[2], scm.inputs[6])
nt.links.new(scm.outputs[2], b.inputs['Base Color'])
check('scalp tinted under the hair', sum(1 for x in scalp if x > 0.5) > 40, f'{sum(1 for x in scalp if x > 0.5)} verts')
lip_gloss(lip_mask)
check('lip mask on the lips only', 60 < sum(1 for x in lip_mask if x > 0.5) < 400, f'{sum(1 for x in lip_mask if x > 0.5)} verts')
# Any human skin tone: linear albedo between very deep (about 0.01) and very fair (about 0.6), red >= green >= blue.
check('skin albedo is a human skin tone', 0.008 < sum(albedo) / 3 < 0.6 and albedo[0] >= albedo[1] >= albedo[2],
      'linear ' + ', '.join(f'{x:.3f}' for x in albedo))

# ── Eyes, lashes, brows, hair ─────────────────────────────────────────────────────────────────────────────────────
# The glass cornea from eyes_brows encloses the whole eye, so it acts as a ball lens on this larger MakeHuman eye
# (pupil pushed up, iris washed grey). The wet corneal shine comes from a clear coat on the eye instead; CORNEA=1 keeps
# the glass for comparison.
if os.environ.get('CORNEA'):
    add_corneas(fwd)
else:
    eb.inputs['Coat Weight'].default_value = 0.7; eb.inputs['Coat IOR'].default_value = 1.376
    eb.inputs['Coat Roughness'].default_value = 0.03; eb.inputs['Roughness'].default_value = 0.35
    # The iris and sclera lie under the cornea, so all the shine comes from the clear coat; a base specular layer as
    # well put a grey haze over the pupil (it rendered as a blue-grey disc) and washed the iris out.
    eb.inputs['Specular IOR Level'].default_value = 0.0
lashes = lash_strands(fwd, up, length_scale=float(os.environ.get('LASH_LEN', '0.7'))); brows = brow_strands(fwd, up, per_brow=int(os.environ.get('BROW_N', '420')), width_scale=float(os.environ.get('BROW_W', '1.0')))
check('lashes built', len(lashes.data.curves) > 100, f'{len(lashes.data.curves)} strands')
check('brows built', len(brows.data.curves) > 300, f'{len(brows.data.curves)} strands')
# The bust has only CHE's own long_wavy hair cards; any other style is close-cropped here (the full-body model,
# tools/avatar_body/mpfb_body.py, builds every style in identity.HAIR_BUILT as a mesh).
BUST_NOHAIR = bool(os.environ.get('NOHAIR')) or (os.environ.get('HAIR_STYLE') or 'long_wavy') != 'long_wavy'
if BUST_NOHAIR:
    # Hair styles whose strand sets are not built yet render close-cropped: CHE's hair cards are hidden and the dark
    # scalp tint stays (HAIR_STYLE names the style the preset asks for; the job receipt reports it as not built).
    if hair_o: hair_o.hide_render = True
    print('HAIR', os.environ.get('HAIR_STYLE', 'none'), 'not built: close-cropped', flush=True)
else:
    hair = build_strand_hair(sc, strands_per_card=int(os.environ.get('STRANDS', '90')), parent_bone=None)
    check('hair built', len(hair.data.curves) > 2000, f'{len(hair.data.curves)} strands')
    if os.environ.get('HAIR_SRGB'):
        # The preset's hair colour: dark natural colours stay on the melanin model (realistic dark hair), anything
        # brighter or dyed uses the direct colour model.
        hc = [float(x) / 255 for x in os.environ['HAIR_SRGB'].split(',')]
        hn = hair.data.materials[0].node_tree.nodes['Principled Hair BSDF']
        if max(hc) - min(hc) < 0.12 and max(hc) < 0.35:
            hn.inputs['Melanin'].default_value = min(1.0, 1.0 - sum(hc) / 3 * 0.5)   # near-black stays near-black (0.96 for CHE)
            hn.inputs['Melanin Redness'].default_value = min(1.0, max(0.0, (hc[0] - hc[2]) * 6))
        else:
            hn.parametrization = 'COLOR'
            hn.inputs['Color'].default_value = (*[(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4) for c in hc], 1)
        hn.inputs['Roughness'].default_value = 0.35
    print('cleared face strands', clear_face_strands(fwd, up, eye_mid), flush=True)
    print('baby hairs', baby_hairs(fwd, up, eye_mid), flush=True)

# ── Neutral studio light (same as the clay stage) ──────────────────────────────────────────────────────────────────
right = fwd.cross(up).normalized()
tgt = bpy.data.objects.new('HeadTarget', None); sc.collection.objects.link(tgt); tgt.location = eye_mid - up * float(os.environ.get('AIM_DROP', '0.035')) * (che_gap / 0.06)


def area(name, pos, size, energy):
    l = bpy.data.objects.new(name, bpy.data.lights.new(name, 'AREA')); sc.collection.objects.link(l)
    l.data.size = size; l.data.energy = energy; l.location = pos
    c = l.constraints.new('TRACK_TO'); c.target = tgt; c.track_axis = 'TRACK_NEGATIVE_Z'; c.up_axis = 'UP_Y'


k = che_gap / 0.06
area('Key', eye_mid + (fwd * 1.2 + right * 0.8 + up * 0.6) * k, float(os.environ.get('KEY_SIZE', '1.2')) * k, 60 * k * k)
area('Fill', eye_mid + (fwd * 1.2 - right * 0.9 + up * 0.1) * k, 1.5 * k, 28 * k * k)
area('Rim', eye_mid + (-fwd * 1.0 + right * 0.3 + up * 0.7) * k, 0.6 * k, {'photoreal': 25, 'hybrid': 40, 'stylized': 70}[STYLE] * k * k)
if STYLE == 'stylized':   # CHE's glowing-blue rim from the other side, as in the app's look
    area('RimBlue', eye_mid + (-fwd * 1.0 - right * 0.6 + up * 0.3) * k, 0.6 * k, 45 * k * k)
    bpy.data.objects['RimBlue'].data.color = (0.35, 0.6, 1.0)
w = sc.world or bpy.data.worlds.new('W'); sc.world = w; w.use_nodes = True
w.node_tree.nodes['Background'].inputs['Color'].default_value = (0.18, 0.18, 0.19, 1) if STYLE == 'photoreal' else (0.03, 0.05, 0.12, 1)
w.node_tree.nodes['Background'].inputs['Strength'].default_value = 0.6
cam = bpy.data.objects.new('Cam', bpy.data.cameras.new('Cam')); sc.collection.objects.link(cam); sc.camera = cam
cam.data.lens = 85
tr = cam.constraints.new('TRACK_TO'); tr.target = tgt; tr.track_axis = 'TRACK_NEGATIVE_Z'; tr.up_axis = 'UP_Y'
from render_device import setup as render_setup  # noqa: E402
render_setup(sc, (400, 500)); sc.cycles.samples = int(os.environ.get('SAMPLES', '32')); sc.cycles.use_denoising = True
sc.view_settings.view_transform = 'AgX'; sc.view_settings.look = 'None'

sub.show_viewport = False; bpy.context.view_layer.update()  # compare vertex for vertex, without the subdivision
dg = bpy.context.evaluated_depsgraph_get(); ev = body.evaluated_get(dg); em = ev.to_mesh()
moved = max(((body.matrix_world @ em.vertices[i].co) - (body.matrix_world @ body.data.vertices[i].co)).length for i in range(0, len(body.data.vertices)))
ev.to_mesh_clear(); sub.show_viewport = True
check('mouth at rest (no shape key applied)', moved < 0.001, f'largest vertex offset {moved * 1000:.2f} mm')
failed = [c for c in CHECKS if not c[1]]
if failed and not os.environ.get('FORCE'):
    print('CHECKS FAILED, no render:', [c[0] for c in failed], flush=True); sys.exit(2)
if os.environ.get('SAVE'):
    bpy.ops.wm.save_as_mainfile(filepath=os.environ['SAVE'], copy=True)


def export_glb(path):
    """The Live Studio's 3D model (owner, 2026-10-24): a GLB of this exact face, written before any view renders so the
    viewport gets the geometry first. A head-and-neck bust only (the rest of the MakeHuman body is never exported), both
    eyes and CHE's hair cards. glTF cannot carry Cycles node trees, so the look is baked into vertex colours from the
    same values the shaders use: skin albedo, lips from the lip mask, dark scalp, and the iris ramp (pupil, iris, limbus,
    sclera). Brows, lashes and strand hair are curves: render-only."""
    srgb = lambda c: c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4  # noqa: E731
    keep = bpy.data.collections.new('GLBExport'); sc.collection.children.link(keep)
    dg = bpy.context.evaluated_depsgraph_get()

    def flat(name, rough, spec=0.5):
        m = bpy.data.materials.new(name); m.use_nodes = True; p = m.node_tree.nodes['Principled BSDF']
        p.inputs['Base Color'].default_value = (1, 1, 1, 1); p.inputs['Roughness'].default_value = rough
        p.inputs['Specular IOR Level'].default_value = spec   # exported as KHR_materials_specular; dark hair turns grey at 0.5
        return m

    def paint(me, cols):
        a = me.color_attributes.new('Col', 'FLOAT_COLOR', 'POINT'); a.data.foreach_set('color', [x for c in cols for x in (*c, 1.0)])
        me.color_attributes.active_color = a

    def copy(src, name, mat, cut=None, whole=min):
        me = bpy.data.meshes.new_from_object(src.evaluated_get(dg)); me.transform(src.matrix_world)
        if cut is not None:   # drop the faces below the neck cut (whole=min: any vertex below; max: all of them), then loose vertices
            import bmesh
            bm = bmesh.new(); bm.from_mesh(me)
            bmesh.ops.delete(bm, geom=[f for f in bm.faces if whole(v.co.z for v in f.verts) < cut], context='FACES')
            bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context='VERTS')
            bm.to_mesh(me); bm.free()
        me.materials.clear(); me.materials.append(mat)
        ob = bpy.data.objects.new(name, me); keep.objects.link(ob)
        return ob, me

    cut = eye_mid.z - 0.16 * k
    bust, me = copy(body, 'CHE_Head', flat('GLB_Skin', 0.55, 0.32), cut)
    lipc = (albedo[0] * 0.62, albedo[1] * 0.42, albedo[2] * 0.55)
    la, sa = me.attributes.get('lipmask'), me.attributes.get('scalp')
    lv = [d.value for d in la.data] if la else [0.0] * len(me.vertices)
    sv = [d.value for d in sa.data] if sa else [0.0] * len(me.vertices)
    cols = []
    for lm, s in zip(lv, sv):
        c = [albedo[i] + (lipc[i] - albedo[i]) * max(0.0, min(1.0, lm)) for i in range(3)]
        cols.append(tuple(c[i] + ((0.012, 0.008, 0.006)[i] - c[i]) * max(0.0, min(1.0, s)) for i in range(3)))
    paint(me, cols)
    eye_glb = flat('GLB_Eye', 0.15)

    def ramp(x):
        for (p0, c0), (p1, c1) in zip(stops, stops[1:]):
            if x <= p1: t = (x - p0) / max(p1 - p0, 1e-6); return tuple(c0[i] + (c1[i] - c0[i]) * t for i in range(3))
        return stops[-1][1]
    for name in ('Eye_l', 'Eye_r'):
        src = bpy.data.objects[name]; inv = src.matrix_world.inverted()
        eo, eme = copy(src, 'CHE_' + name, eye_glb)
        local = [inv @ v.co for v in eme.vertices]   # unit-sphere object space, +Z out of the face, as the shader sees it
        paint(eme, [ramp(math.hypot(p.x, p.y)) if p.z > 0 else stops[-1][1] for p in local])
    parts = 'head-and-neck bust, eyes'
    if hair_o and hair_o.type == 'MESH' and not BUST_NOHAIR:
        hc = [srgb(float(x) / 255) for x in os.environ.get('HAIR_SRGB', '28,18,16').split(',')]
        hm = flat('GLB_Hair', 0.6, 0.15); hm.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (*hc, 1)
        hm.use_backface_culling = False
        copy(hair_o, 'CHE_Hair', hm, cut, max)   # the long cards end at the bust's neck cut instead of hanging in the air
        parts += ', hair cards'
    bpy.ops.object.select_all(action='DESELECT')
    for o in keep.objects: o.hide_viewport = False; o.hide_set(False); o.select_set(True)
    bpy.context.view_layer.objects.active = bust
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True, export_apply=True, export_yup=True,
                              export_vertex_color='ACTIVE', export_animations=False, export_skins=False, export_morph=False,
                              export_materials='EXPORT', export_cameras=False, export_lights=False)
    nv = sum(len(o.data.vertices) for o in keep.objects)
    for o in list(keep.objects): bpy.data.objects.remove(o)
    bpy.data.collections.remove(keep)
    print('MODEL', os.path.abspath(path), os.path.getsize(path), 'bytes', nv, 'vertices', f'({parts}; brows, lashes and strand hair are render-only)', flush=True)


if os.environ.get('EXPORT_GLB'):
    export_glb(os.environ['EXPORT_GLB'])
for deg in [int(d) for d in os.environ.get('VIEWS', '0,30').split(',') if d.strip()]:
    a = math.radians(deg)
    cam.location = tgt.location + (fwd * math.cos(a) + right * math.sin(a)) * float(os.environ.get('CAM_DIST', '0.75')) * k + up * 0.02 * k
    sc.render.filepath = os.path.join(OUT, f'dress_{deg:02d}.png')
    bpy.ops.render.render(write_still=True)
    print('WROTE', sc.render.filepath, flush=True)

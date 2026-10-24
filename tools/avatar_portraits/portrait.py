# CHE portraits v2: same as portrait.py, with the hair fixed after the first strand batch was reviewed.
#  - thinner strands (0.18 mm root -> 0.06 mm tip) and more of them, so hair stops reading as grey wire
#  - darker, rougher hair shader with no coat, so the specular sheen does not wash the colour to silver
#  - cards whose root row floats away from the scalp are dropped (the temple clump, the side stragglers)
#  - rim light halved
# Env: BLEND, OUTDIR, VIEWS, EXPRS, SAMPLES, RES, STRANDS, FRAMING, ROOTMAX (m, default 0.025)
import bpy, bmesh, math, os, random, time
from mathutils import Vector
from mathutils.bvhtree import BVHTree
random.seed(3)
bpy.ops.wm.open_mainfile(filepath=os.environ['BLEND'])
sc = bpy.context.scene
rig = bpy.data.objects['Rig']
OUT = os.environ['OUTDIR']; os.makedirs(OUT, exist_ok=True)

act = bpy.data.actions['idle_relaxed']
rig.animation_data_create(); rig.animation_data.action = act
if getattr(act, 'slots', None): rig.animation_data.action_slot = act.slots[0]
sc.frame_set(12); bpy.context.view_layer.update()

dg = bpy.context.evaluated_depsgraph_get()
# Scalp proximity test against the posed body.
body = bpy.data.objects['Body']
bev = body.evaluated_get(dg); bme = bev.to_mesh()
bme.transform(body.matrix_world)
bvh = BVHTree.FromPolygons([v.co.copy() for v in bme.vertices], [p.vertices[:] for p in bme.polygons])
bev.to_mesh_clear()
ROOTMAX = float(os.environ.get('ROOTMAX', '0.025'))

hair = bpy.data.objects['Hair']
ev = hair.evaluated_get(dg); me = ev.to_mesh()
mw = hair.matrix_world.copy()
bm = bmesh.new(); bm.from_mesh(me); bm.verts.ensure_lookup_table()
uvl = bm.loops.layers.uv.active
vuv = {}
for f in bm.faces:
    for l in f.loops: vuv[l.vert.index] = tuple(l[uvl].uv)
seen = set(); islands = []
for v in bm.verts:
    if v.index in seen: continue
    st = [v]; cur = []; seen.add(v.index)
    while st:
        x = st.pop(); cur.append(x.index)
        for e in x.link_edges:
            o = e.other_vert(x)
            if o.index not in seen: seen.add(o.index); st.append(o)
    islands.append(cur)
N = int(os.environ.get('STRANDS', '110'))
strands = []; dropped = 0; card_of = []
# 141 and 142 are the two front-left hairline cards that render as the floating temple clump (found with DIAG=1).
SKIP = {int(x) for x in os.environ.get('SKIPCARDS', '141,142').split(',') if x}
for ci, isl in enumerate(islands):
    if ci in SKIP: dropped += 1; continue
    rows = {}
    for i in isl:
        rows.setdefault(round(vuv[i][1], 4), []).append(i)
    pairs = []
    for k in sorted(rows):
        vs = sorted(rows[k], key=lambda i: vuv[i][0])
        if len(vs) >= 2: pairs.append((mw @ bm.verts[vs[0]].co, mw @ bm.verts[vs[-1]].co, mw @ bm.verts[vs[0]].normal.copy()))
    if len(pairs) < 3: continue
    if (pairs[0][0].z + pairs[0][1].z) < (pairs[-1][0].z + pairs[-1][1].z): pairs.reverse()
    root = (pairs[0][0] + pairs[0][1]) / 2
    hit = bvh.find_nearest(root)
    if hit[0] is None or hit[3] > ROOTMAX:
        dropped += 1; continue
    # Cards that peel away from the head within the first few rows render as a floating clump at the temple.
    early = bvh.find_nearest((pairs[3][0] + pairs[3][1]) / 2)[3] if len(pairs) > 3 else 0.0
    if early > float(os.environ.get('EARLYMAX', '0.03')):
        dropped += 1; print('DROP card (early peel-off)', round(early, 3), flush=True); continue
    L = len(pairs)
    for s in range(N):
        u = random.uniform(-0.06, 1.06)
        depth = random.gauss(0.0015, 0.005)
        phase = random.random() * 6.28; amp = random.uniform(0.0, 0.004)
        pts = []
        for r, (a, b, n) in enumerate(pairs):
            t = r / (L - 1)
            uu = 0.5 + (u - 0.5) * (1.0 - 0.45 * t)
            p = a.lerp(b, uu) + n.normalized() * (abs(depth) if t < 0.15 else depth) * (1 - 0.5 * t)
            p += Vector((math.sin(phase + t * 9) * amp * t, math.cos(phase + t * 7) * amp * t, 0))
            pts.append(p)
        strands.append(pts); card_of.append(ci)
ev.to_mesh_clear()
print('CARDS', len(islands), 'dropped', dropped, flush=True)
hc = bpy.data.hair_curves.new('HairStrands')
hc.add_curves([len(p) for p in strands])
flat = [c for p in strands for v in p for c in v]
hc.position_data.foreach_set('vector', flat)
radius = []
for p in strands:
    L = len(p)
    radius += [0.00018 * (1 - 0.67 * (i / (L - 1))) for i in range(L)]
if 'radius' not in hc.attributes: hc.attributes.new('radius', 'FLOAT', 'POINT')
hc.attributes['radius'].data.foreach_set('value', radius)
hob = bpy.data.objects.new('HairStrands', hc); sc.collection.objects.link(hob)
hm = bpy.data.materials.new('HairStrand'); hm.use_nodes = True
nt = hm.node_tree; nt.nodes.clear()
hb = nt.nodes.new('ShaderNodeBsdfHairPrincipled')
hb.parametrization = 'MELANIN'
for k, v in (('Melanin', 1.0), ('Melanin Redness', 0.2), ('Roughness', 0.45), ('Radial Roughness', 0.4), ('Coat', 0.0), ('Random Roughness', 0.2), ('Random Color', 0.08)):
    if k in hb.inputs: hb.inputs[k].default_value = v
o = nt.nodes.new('ShaderNodeOutputMaterial'); nt.links.new(hb.outputs[0], o.inputs['Surface'])
hc.materials.append(hm)
hair.hide_render = True
if os.environ.get('DIAG'):
    # Diagnostic: each card emits its id as a colour (r=ci%16, g=ci//16), so a clump in the render maps back to a card.
    hc.attributes.new('cardid', 'FLOAT_COLOR', 'CURVE')
    cols = []
    for ci in card_of: cols += [(ci % 16) / 15.0, (ci // 16) / 15.0, 0.0, 1.0]
    hc.attributes['cardid'].data.foreach_set('color', cols)
    nt.nodes.clear()
    at = nt.nodes.new('ShaderNodeAttribute'); at.attribute_name = 'cardid'
    em = nt.nodes.new('ShaderNodeEmission'); o = nt.nodes.new('ShaderNodeOutputMaterial')
    nt.links.new(at.outputs['Color'], em.inputs['Color']); nt.links.new(em.outputs[0], o.inputs['Surface'])
    for ob in sc.objects:
        if ob.type == 'MESH': ob.hide_render = True
print('STRANDS', len(strands), 'points', len(flat) // 3, flush=True)

if os.environ.get('SKIN') == 'v3':
    import sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from skin_v3 import upgrade_skin
    print('SKIN v3', bool(upgrade_skin()), flush=True)

eye = (rig.matrix_world @ rig.pose.bones['eye_l'].head + rig.matrix_world @ rig.pose.bones['eye_r'].head) / 2
tgt = bpy.data.objects.new('T', None); sc.collection.objects.link(tgt); tgt.location = eye + Vector((0, 0, -0.06))
cam = bpy.data.objects.new('Cam', bpy.data.cameras.new('Cam')); sc.collection.objects.link(cam); sc.camera = cam
BODY = os.environ.get('FRAMING') == 'body'
cam.data.lens = 50 if BODY else 85
if BODY: tgt.location = eye + Vector((0, 0, -0.62))
tr = cam.constraints.new('TRACK_TO'); tr.target = tgt; tr.track_axis = 'TRACK_NEGATIVE_Z'; tr.up_axis = 'UP_Y'
def light(name, off, size, energy, color):
    l = bpy.data.objects.new(name, bpy.data.lights.new(name, 'AREA')); sc.collection.objects.link(l)
    l.data.size = size; l.data.energy = energy; l.data.color = color; l.location = eye + off
    c = l.constraints.new('TRACK_TO'); c.target = tgt; c.track_axis = 'TRACK_NEGATIVE_Z'; c.up_axis = 'UP_Y'
for o in [o for o in sc.objects if o.type == 'LIGHT' and o.name not in ('Key', 'Fill', 'Rim')]: o.hide_render = True
light('Key', Vector((-0.9, -1.2, 0.5)), 1.2, 150, (1.0, 0.95, 0.9))
light('Fill', Vector((1.1, -1.0, 0.0)), 1.5, 45, (0.9, 0.95, 1.0))
light('Rim', Vector((0.6, 1.0, 0.6)), 0.8, 60, (0.85, 0.95, 1.0))
w = sc.world or bpy.data.worlds.new('W'); sc.world = w; w.use_nodes = True
w.node_tree.nodes['Background'].inputs['Color'].default_value = (0.05, 0.055, 0.065, 1)
w.node_tree.nodes['Background'].inputs['Strength'].default_value = 1.0
sc.render.engine = 'CYCLES'; sc.cycles.device = 'CPU'
sc.cycles.samples = int(os.environ.get('SAMPLES', '48')); sc.cycles.use_denoising = True
rx, ry = (int(x) for x in os.environ.get('RES', '540x675').split('x'))
sc.render.resolution_x, sc.render.resolution_y = rx, ry
sc.view_settings.view_transform = 'AgX'
if os.environ.get('DIAG'): sc.view_settings.view_transform = 'Standard'; sc.cycles.use_denoising = False
VIEWS = {'front': 0, 'threequarter': 35, 'side': 85}
EXPR = {'neutral': {}, 'smile': {'smile': 0.8, 'eyes_wide': 0.1}, 'talk': {'mouth_open': 0.45, 'mouth_wide': 0.2, 'brows_up': 0.3},
        'think': {'brows_frown': 0.5, 'mouth_press': 0.4, 'squint': 0.3}}
skin_objs = [o for o in (bpy.data.objects.get('Body'), bpy.data.objects.get('Lashes')) if o and o.data.shape_keys]
t0 = time.time()
for ex in os.environ.get('EXPRS', 'neutral').split(','):
    for o in skin_objs:
        for kb in o.data.shape_keys.key_blocks[1:]: kb.value = EXPR[ex].get(kb.name, 0.0)
    for view in os.environ.get('VIEWS', 'front').split(','):
        a = math.radians(VIEWS[view])
        # CLOSE=1: a tight face crop (135 mm at the same distance) where pores and the eye surface are visible.
        if os.environ.get('CLOSE'): cam.data.lens = 135
        dist = 3.3 if BODY else 1.05
        cam.location = tgt.location + Vector((-math.sin(a) * dist, -math.cos(a) * dist, 0.04 + (0.0 if BODY else 0.04)))
        sc.render.filepath = os.path.join(OUT, f"che_{'body_' if BODY else ''}{view}_{ex}.png")
        bpy.ops.render.render(write_still=True)
        print('RENDERED', view, ex, round(time.time() - t0, 1), flush=True)

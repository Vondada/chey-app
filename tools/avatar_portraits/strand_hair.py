# Strand hair for CHE's Route-B model: grows Cycles hair curves across the posed hair cards and hides the
# cards. Shared by portrait.py and the cinematic sample. Call after the pose for the build frame is set.
import bmesh, bpy, math, os, random
from mathutils import Vector
from mathutils.bvhtree import BVHTree

# 141 and 142 are the two front-left hairline cards that render as a floating temple clump (found with DIAG=1).
DEFAULT_SKIP = '141,142'


def build_strand_hair(sc, *, strands_per_card=110, root_max=0.025, early_max=0.03, skip=None, seed=3,
                      parent_bone='head', diag=False):
    random.seed(seed)
    rig = bpy.data.objects['Rig']
    dg = bpy.context.evaluated_depsgraph_get()
    body = bpy.data.objects['Body']
    bev = body.evaluated_get(dg); bme = bev.to_mesh(); bme.transform(body.matrix_world)
    bvh = BVHTree.FromPolygons([v.co.copy() for v in bme.vertices], [p.vertices[:] for p in bme.polygons])
    bev.to_mesh_clear()
    skip = {int(x) for x in (DEFAULT_SKIP if skip is None else skip).split(',') if x}

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
    strands = []; card_of = []; dropped = 0
    for ci, isl in enumerate(islands):
        if ci in skip: dropped += 1; continue
        rows = {}
        for i in isl: rows.setdefault(round(vuv[i][1], 4), []).append(i)
        pairs = []
        for k in sorted(rows):
            vs = sorted(rows[k], key=lambda i: vuv[i][0])
            if len(vs) >= 2:
                pairs.append((mw @ bm.verts[vs[0]].co, mw @ bm.verts[vs[-1]].co, mw @ bm.verts[vs[0]].normal.copy()))
        if len(pairs) < 3: continue
        # Root is the row nearest the scalp: the end whose midpoint is highest.
        if (pairs[0][0].z + pairs[0][1].z) < (pairs[-1][0].z + pairs[-1][1].z): pairs.reverse()
        root = (pairs[0][0] + pairs[0][1]) / 2
        hit = bvh.find_nearest(root)
        if hit[0] is None or hit[3] > root_max: dropped += 1; continue
        # Cards that peel away from the head within the first few rows render as a floating clump.
        early = bvh.find_nearest((pairs[3][0] + pairs[3][1]) / 2)[3] if len(pairs) > 3 else 0.0
        if early > early_max: dropped += 1; continue
        L = len(pairs)
        for _ in range(strands_per_card):
            u = random.uniform(-0.06, 1.06)
            depth = random.gauss(0.0015, 0.005)
            phase = random.random() * 6.28; amp = random.uniform(0.0, 0.004)
            pts = []
            for r, (a, b, n) in enumerate(pairs):
                t = r / (L - 1)
                # strands clump toward the card centre at the tips, spread at the root
                uu = 0.5 + (u - 0.5) * (1.0 - 0.45 * t)
                p = a.lerp(b, uu) + n.normalized() * (abs(depth) if t < 0.15 else depth) * (1 - 0.5 * t)
                p += Vector((math.sin(phase + t * 9) * amp * t, math.cos(phase + t * 7) * amp * t, 0))
                pts.append(p)
            strands.append(pts); card_of.append(ci)
    ev.to_mesh_clear()

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
    for k, v in (('Melanin', 1.0), ('Melanin Redness', 0.2), ('Roughness', 0.45), ('Radial Roughness', 0.4),
                 ('Coat', 0.0), ('Random Roughness', 0.2), ('Random Color', 0.08)):
        if k in hb.inputs: hb.inputs[k].default_value = v
    o = nt.nodes.new('ShaderNodeOutputMaterial'); nt.links.new(hb.outputs[0], o.inputs['Surface'])
    hc.materials.append(hm)
    hair.hide_render = True
    if diag:
        # Each card emits its id as a colour (r=ci%16, g=ci//16), so a clump in the render maps back to a card.
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
    if parent_bone == 'torso':
        # Rigid parenting to the head swings 60 cm of hair forward whenever the head pitches down, covering
        # the face. The bone above the neck keeps the hair hanging with the body; the scalp slips a few mm.
        parent_bone = rig.pose.bones['neck_01'].parent.name
    if parent_bone:
        # The strands are built in world space at this frame; following a bone keeps them on the body
        # while it moves in an animated shot.
        from mathutils import Matrix
        hob.parent = rig; hob.parent_type = 'BONE'; hob.parent_bone = parent_bone
        bpy.context.view_layer.update()
        # Assigning the world matrix after parenting makes Blender solve the local transform, so the
        # strands stay exactly where they were built at this frame.
        hob.matrix_world = Matrix.Identity(4)
        bpy.context.view_layer.update()
    print('STRANDS', len(strands), 'cards dropped', dropped, 'points', len(flat) // 3, flush=True)
    return hob

# Lists each hair card: root distance to body, max row distance, forward-most y relative to the eyes, z range.
import bpy, bmesh, os
from mathutils.bvhtree import BVHTree
bpy.ops.wm.open_mainfile(filepath=os.environ['BLEND'])
sc = bpy.context.scene; rig = bpy.data.objects['Rig']
act = bpy.data.actions['idle_relaxed']; rig.animation_data_create(); rig.animation_data.action = act
if getattr(act, 'slots', None): rig.animation_data.action_slot = act.slots[0]
sc.frame_set(12); bpy.context.view_layer.update()
dg = bpy.context.evaluated_depsgraph_get()
body = bpy.data.objects['Body']; bev = body.evaluated_get(dg); bme = bev.to_mesh(); bme.transform(body.matrix_world)
bvh = BVHTree.FromPolygons([v.co.copy() for v in bme.vertices], [p.vertices[:] for p in bme.polygons]); bev.to_mesh_clear()
eye = (rig.matrix_world @ rig.pose.bones['eye_l'].head + rig.matrix_world @ rig.pose.bones['eye_r'].head) / 2
print('EYE', [round(c, 3) for c in eye])
hair = bpy.data.objects['Hair']; ev = hair.evaluated_get(dg); me = ev.to_mesh(); mw = hair.matrix_world.copy()
bm = bmesh.new(); bm.from_mesh(me); bm.verts.ensure_lookup_table(); uvl = bm.loops.layers.uv.active
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
for ci, isl in enumerate(islands):
    rows = {}
    for i in isl: rows.setdefault(round(vuv[i][1], 4), []).append(i)
    mids = []
    for k in sorted(rows):
        vs = sorted(rows[k], key=lambda i: vuv[i][0])
        if len(vs) >= 2: mids.append((mw @ bm.verts[vs[0]].co + mw @ bm.verts[vs[-1]].co) / 2)
    if len(mids) < 3: continue
    if mids[0].z < mids[-1].z: mids.reverse()
    ds = [bvh.find_nearest(m)[3] for m in mids]
    rel = [m - eye for m in mids]
    print('ROWD', ci, ' '.join(f'{d:.3f}' for d in ds[:10]))
    print('CARD', ci, 'rootd', round(ds[0], 3), 'maxd', round(max(ds), 3), 'root', [round(c, 3) for c in rel[0]],
          'miny', round(min(r.y for r in rel), 3), 'xr', round(min(r.x for r in rel), 3), round(max(r.x for r in rel), 3),
          'zr', round(min(r.z for r in rel), 3), round(max(r.z for r in rel), 3), 'n', len(mids))

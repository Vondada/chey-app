"""Face step 3: eyes, lashes and brows for CHE's Route-B model.

  add_corneas(fwd)       a clear corneal shell over each eye (IOR 1.376, glossy, slight bulge), and the eye's own
                         coat removed so the reflection sits on the cornea like a real wet eye
  brow_strands(fwd)      eyebrows as hair strands rooted on the brow ridge (the painted brows stay underneath as
                         the skin's shadow), growing outward and slightly up, denser and shorter at the inner end
  lash_strands(fwd)      upper and lower lashes as strands in small clumps along each lid rim, curling out and up
All geometry is found from CHE's own eye objects and the posed body surface (BVH ray casts); nothing is downloaded.
"""
import math
import random

import bpy
from mathutils import Vector
from mathutils.bvhtree import BVHTree


def _body_bvh():
    dg = bpy.context.evaluated_depsgraph_get()
    body = bpy.data.objects['Body']
    ev = body.evaluated_get(dg); me = ev.to_mesh(); me.transform(body.matrix_world)
    bvh = BVHTree.FromPolygons([v.co.copy() for v in me.vertices], [p.vertices[:] for p in me.polygons])
    ev.to_mesh_clear()
    return bvh


def _eye(name):
    ob = bpy.data.objects[name]
    dg = bpy.context.evaluated_depsgraph_get()
    ev = ob.evaluated_get(dg); me = ev.to_mesh()
    pts = [ob.matrix_world @ v.co for v in me.vertices]
    ev.to_mesh_clear()
    c = sum(pts, Vector()) / len(pts)
    r = max((p - c).length for p in pts)
    return c, r


def _outward(name, fwd):
    """Sideways direction from this eye toward its own temple (away from the other eye)."""
    side = Vector((fwd.y, -fwd.x, 0)).normalized()
    other = _eye('Eye_r' if name.endswith('l') else 'Eye_l')[0]
    return side if (_eye(name)[0] - other).dot(side) > 0 else -side


def _hair_material(name, melanin=1.0, rough=0.4):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.use_nodes = True; nt = m.node_tree; nt.nodes.clear()
    hb = nt.nodes.new('ShaderNodeBsdfHairPrincipled'); hb.parametrization = 'MELANIN'
    for k, v in (('Melanin', melanin), ('Melanin Redness', 0.15), ('Roughness', rough), ('Radial Roughness', 0.35), ('Coat', 0.0), ('Random Roughness', 0.15)):
        if k in hb.inputs: hb.inputs[k].default_value = v
    out = nt.nodes.new('ShaderNodeOutputMaterial'); nt.links.new(hb.outputs[0], out.inputs['Surface'])
    return m


def _curves(name, strands, r_root, r_tip, mat):
    hc = bpy.data.hair_curves.new(name)
    hc.add_curves([len(s) for s in strands])
    flat = [c for s in strands for p in s for c in p]
    hc.points.foreach_set('position', flat)
    rad = []
    for s in strands:
        n = len(s)
        rad += [r_root + (r_tip - r_root) * (i / (n - 1)) for i in range(n)]
    hc.points.foreach_set('radius', rad)
    hc.materials.append(mat)
    ob = bpy.data.objects.new(name, hc); bpy.context.scene.collection.objects.link(ob)
    return ob


def _bezier(p0, d0, length, curl, up, n=6):
    """A short strand from p0 along d0, curling toward `up` by `curl` (0..1)."""
    pts = []
    d = d0.normalized()
    for i in range(n):
        t = i / (n - 1)
        bend = (up * curl * t * t)
        pts.append(tuple(p0 + d * length * t + bend * length))
    return pts


def add_corneas(fwd):
    glass = bpy.data.materials.get('Cornea') or bpy.data.materials.new('Cornea')
    glass.use_nodes = True; nt = glass.node_tree
    b = nt.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = (1, 1, 1, 1); b.inputs['Roughness'].default_value = 0.0
    b.inputs['IOR'].default_value = 1.376; b.inputs['Transmission Weight'].default_value = 1.0
    eyes_mat = bpy.data.materials.get('Eyes')
    if eyes_mat:
        eb = next(n for n in eyes_mat.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
        eb.inputs['Coat Weight'].default_value = 0.0; eb.inputs['Roughness'].default_value = 0.25
    made = []
    for name in ('Eye_l', 'Eye_r'):
        c, r = _eye(name)
        bpy.ops.mesh.primitive_uv_sphere_add(segments=48, ring_count=32, radius=r * 1.03, location=c)
        sh = bpy.context.active_object; sh.name = f'Cornea_{name[-1]}'
        # Bulge the front cap a little: the cornea sits proud of the sclera.
        for v in sh.data.vertices:
            d = v.co.normalized(); front = max(0.0, d.dot(fwd))
            v.co = v.co * (1.0 + 0.06 * front ** 6)
        sh.data.materials.append(glass)
        for p in sh.data.polygons: p.use_smooth = True
        sh.visible_shadow = False
        made.append(sh)
    return made


def _lid_edge(bvh, c, r, fwd, up, side, x, upper):
    """Where the lid margin really is at sideways offset x: looking straight at the eye, step up (or down) from its
    centre until skin first covers the eyeball; the lashes root on that skin. None when no margin is found."""
    sgn = 1 if upper else -1
    for k in range(1, 60):
        h = sgn * r * k / 60
        q2 = x * x + h * h
        if q2 >= r * r: return None
        start = c + side * x + up * h + fwd * 2 * r
        loc, _, _, dist = bvh.ray_cast(start, -fwd, 4 * r)
        if loc is not None and dist < 2 * r - math.sqrt(r * r - q2) - 0.0002:
            return loc
    return None


def lash_strands(fwd, up, seed=11, length_scale=1.0):
    random.seed(seed)
    bvh = _body_bvh()
    strands = []
    for name in ('Eye_l', 'Eye_r'):
        c, r = _eye(name)
        side = _outward(name, fwd)
        for upper in (True, False):
            n_clumps = 26 if upper else 14
            for k in range(n_clumps):
                # Along the rim from the inner corner (-1) to the outer corner (+1).
                t = -0.9 + 1.8 * (k + 0.5) / n_clumps
                ang = t * math.radians(70)
                lift = (math.cos(ang) * (0.62 if upper else -0.45))
                rim = c + fwd * r * 0.92 + side * math.sin(ang) * r * 0.98 + up * lift * r
                hit = bvh.find_nearest(rim)
                root = hit[0] if hit and hit[0] is not None and (hit[0] - rim).length < r * 0.6 else rim
                edge = _lid_edge(bvh, c, r, fwd, up, side, math.sin(ang) * r * 0.9, upper)
                if edge is not None: root = edge
                outer = 0.5 + 0.5 * (t + 0.9) / 1.8  # longer toward the outer corner
                length = (0.0115 if upper else 0.006) * (0.7 + 0.6 * outer) * length_scale
                d = (fwd * 0.9 + up * (0.35 if upper else -0.25) + side * 0.25 * t).normalized()
                for _ in range(5 if upper else 3):
                    j = Vector((random.gauss(0, 0.0003), random.gauss(0, 0.0003), random.gauss(0, 0.0002)))
                    strands.append(_bezier(root + j, d, length * random.uniform(0.8, 1.1), 0.5 if upper else -0.2, up if upper else -up))
    return _curves('Lashes_strands', strands, 0.00009, 0.00002, _hair_material('LashHair', 1.0, 0.35))


def brow_strands(fwd, up, seed=12, per_brow=420):
    random.seed(seed)
    bvh = _body_bvh()
    strands = []
    for name in ('Eye_l', 'Eye_r'):
        c, r = _eye(name)
        side = _outward(name, fwd)
        for _ in range(per_brow):
            t = random.random()  # 0 inner end, 1 tail
            # Brow arc: rises over the iris, falls at the tail.
            arc_h = r * (1.45 + 0.35 * math.sin(math.pi * min(1.0, t * 1.2)) - 0.25 * t)
            width = r * (0.17 - 0.11 * t)
            p = c + side * (r * (-0.9 + 2.4 * t)) + up * (arc_h + random.uniform(-width, width)) + fwd * r * 2.5
            hit = bvh.ray_cast(p, -fwd, r * 6)
            if not hit or hit[0] is None:
                continue
            root, normal = hit[0], hit[1]
            # Inner hairs stand up; the rest lie toward the tail.
            d = (up * (0.9 - 0.75 * t) + side * (0.15 + 0.8 * t) + normal * 0.25).normalized()
            length = (0.005 if t < 0.15 else 0.008) * random.uniform(0.8, 1.15)
            strands.append(_bezier(root + normal * 0.0002, d, length, 0.35, normal))
    return _curves('Brow_strands', strands, 0.000045, 0.000012, _hair_material('BrowHair', 1.0, 0.5))

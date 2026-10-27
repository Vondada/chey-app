"""Face step 4: glossy lips with fine vertical lines, baby hairs along the hairline, and no hair strands across
the face.

  lip_gloss()                 lips are found from CHE's own 'mouth_open' shape key (the vertices that move most when
                              she opens her mouth), stored as a 'lipmask' point attribute, and the Skin shader uses it
                              for lower roughness, a clear coat and fine vertical lip lines
  baby_hairs(fwd, up)         short, fine, curling strands lying flat along the front hairline and temples
  clear_face_strands(fwd)     removes strand-hair curves that pass in front of the face (the strand across her cheek)
"""
import math
import random

import bpy
from mathutils import Vector
from mathutils.bvhtree import BVHTree


def lip_gloss(mask=None):
    """mask: per-vertex lip weights (0..1); by default found from the 'mouth_open' shape key's strongest movers."""
    body = bpy.data.objects['Body']
    if mask is None:
        keys = body.data.shape_keys
        kb = keys.key_blocks.get('mouth_open') if keys else None
        if not kb:
            return False
        basis = keys.key_blocks[0]
        deltas = [(kb.data[i].co - basis.data[i].co).length for i in range(len(basis.data))]
        top = sorted(deltas)[int(len(deltas) * 0.995)] or 1e-6
        # Lips move most; the chin and jaw move too, so only the strongest movers count, softly.
        mask = [max(0.0, min(1.0, (d / top - 0.35) / 0.4)) for d in deltas]
    attr = body.data.attributes.get('lipmask') or body.data.attributes.new('lipmask', 'FLOAT', 'POINT')
    attr.data.foreach_set('value', mask)
    m = bpy.data.materials['Skin']; nt = m.node_tree
    b = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
    at = nt.nodes.new('ShaderNodeAttribute'); at.attribute_name = 'lipmask'
    # Roughness: whatever drives it now, pulled down toward 0.18 on the lips.
    mix_r = nt.nodes.new('ShaderNodeMix'); mix_r.data_type = 'FLOAT'
    nt.links.new(at.outputs['Fac'], mix_r.inputs['Factor'])
    if b.inputs['Roughness'].is_linked:
        nt.links.new(b.inputs['Roughness'].links[0].from_socket, mix_r.inputs['A'])
    else:
        mix_r.inputs['A'].default_value = b.inputs['Roughness'].default_value
    mix_r.inputs['B'].default_value = 0.3
    nt.links.new(mix_r.outputs['Result'], b.inputs['Roughness'])
    # Coat: the gloss layer, on the lips only (plus whatever the skin already had).
    coat = nt.nodes.new('ShaderNodeMath'); coat.operation = 'MULTIPLY_ADD'
    coat.inputs[1].default_value = 0.3; coat.inputs[2].default_value = b.inputs['Coat Weight'].default_value
    nt.links.new(at.outputs['Fac'], coat.inputs[0]); nt.links.new(coat.outputs['Value'], b.inputs['Coat Weight'])
    b.inputs['Coat Roughness'].default_value = 0.16
    # Fine vertical lip lines: a stretched wave texture added to the existing bump on the lips.
    if b.inputs['Normal'].is_linked:
        bump = b.inputs['Normal'].links[0].from_node
        if bump.type == 'BUMP' and bump.inputs['Height'].is_linked:
            src = bump.inputs['Height'].links[0].from_socket
            tc = nt.nodes.new('ShaderNodeTexCoord')
            wave = nt.nodes.new('ShaderNodeTexWave'); wave.wave_type = 'BANDS'; wave.bands_direction = 'X'
            wave.inputs['Scale'].default_value = 900.0; wave.inputs['Distortion'].default_value = 6.0
            nt.links.new(tc.outputs['Object'], wave.inputs['Vector'])
            lines = nt.nodes.new('ShaderNodeMath'); lines.operation = 'MULTIPLY'
            nt.links.new(wave.outputs['Fac'], lines.inputs[0]); nt.links.new(at.outputs['Fac'], lines.inputs[1])
            add = nt.nodes.new('ShaderNodeMath'); add.operation = 'MULTIPLY_ADD'; add.inputs[1].default_value = 0.6
            nt.links.new(lines.outputs['Value'], add.inputs[0]); nt.links.new(src, add.inputs[2])
            nt.links.new(add.outputs['Value'], bump.inputs['Height'])
    return True


def _bvh():
    dg = bpy.context.evaluated_depsgraph_get()
    body = bpy.data.objects['Body']
    ev = body.evaluated_get(dg); me = ev.to_mesh(); me.transform(body.matrix_world)
    t = BVHTree.FromPolygons([v.co.copy() for v in me.vertices], [p.vertices[:] for p in me.polygons])
    ev.to_mesh_clear()
    return t


def baby_hairs(fwd, up, eye_mid, n=520, seed=21):
    random.seed(seed)
    bvh = _bvh()
    side = Vector((fwd.y, -fwd.x, 0)).normalized()
    strands = []
    for _ in range(n):
        # Hairline arc: from one temple over the forehead to the other, about 6-7 cm above the eyes.
        a = random.uniform(-1.0, 1.0)
        h = 0.062 + 0.008 * (1 - a * a) + random.gauss(0, 0.003)
        p = eye_mid + side * a * 0.068 + up * (h - 0.02 * a * a) + fwd * 0.2
        hit = bvh.ray_cast(p, -fwd, 0.4)
        if not hit or hit[0] is None:
            continue
        root, nrm = hit[0], hit[1]
        # Lie flat on the skin, curling sideways and down like edges.
        tang = (side * (1 if a >= 0 else -1) * 0.7 - up * 0.5 + side * random.gauss(0, 0.3)).normalized()
        tang = (tang - nrm * tang.dot(nrm)).normalized()
        length = random.uniform(0.004, 0.011)
        pts = []
        for i in range(6):
            t = i / 5
            curl = tang.cross(nrm) * math.sin(t * math.pi * random.uniform(0.6, 1.4)) * 0.25
            pts.append(tuple(root + nrm * 0.00015 + (tang + curl) * length * t))
        strands.append(pts)
    hc = bpy.data.hair_curves.new('BabyHairs')
    hc.add_curves([len(s) for s in strands])
    hc.points.foreach_set('position', [c for s in strands for p in s for c in p])
    hc.points.foreach_set('radius', [0.00003 * (1 - 0.7 * (i / 5)) for s in strands for i in range(len(s))])
    src = next((m for m in bpy.data.materials if m.name.startswith('HairStrand')), None)
    if src: hc.materials.append(src)
    ob = bpy.data.objects.new('BabyHairs', hc); bpy.context.scene.collection.objects.link(ob)
    return len(strands)


def clear_face_strands(fwd, up, eye_mid, half_width=0.08):
    """Drops strand-hair curves with any point in front of the face (inside the face's width, below the hairline)."""
    removed = 0
    for ob in [o for o in bpy.context.scene.objects if o.type == 'CURVES' and o.name not in ('BabyHairs', 'Lashes_strands', 'Brow_strands')]:
        cv = ob.data
        side = Vector((fwd.y, -fwd.x, 0)).normalized()
        mw = ob.matrix_world
        offs = [0] * (len(cv.curves) + 1)
        cv.curve_offset_data.foreach_get('value', offs) if hasattr(cv, 'curve_offset_data') else None
        pos = [0.0] * (len(cv.points) * 3)
        cv.points.foreach_get('position', pos)
        bad = []
        for ci in range(len(cv.curves)):
            a, b = offs[ci], offs[ci + 1]
            for pi in range(a, b):
                p = mw @ Vector(pos[pi * 3:pi * 3 + 3]) - eye_mid
                if abs(p.dot(side)) < half_width and -0.2 < p.dot(up) < 0.045 and p.dot(fwd) > 0.01:
                    bad.append(ci); break
        if bad and hasattr(cv, 'remove_curves'):
            cv.remove_curves(indices=bad)
            removed += len(bad)
    return removed

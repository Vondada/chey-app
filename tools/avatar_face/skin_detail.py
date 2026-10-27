"""Face step 2b: skin detail that makes the colour read as real skin rather than paint.

  hide_painted_brows(fwd, up)   CHE's texture has grey brows painted on; a 'browmask' point attribute (from the same
                                brow arc the strand brows use) blends them back to the surrounding skin tone, so only the
                                strand brows show
  tone_variation()              darker skin in creases and folds (ambient occlusion) and a faint large-scale mottling,
                                so the colour is not one even orange-brown
"""
import math

import bpy
from mathutils import Vector

from eyes_brows import _outward


def _eye(name):
    ob = bpy.data.objects[name]
    dg = bpy.context.evaluated_depsgraph_get()
    ev = ob.evaluated_get(dg); me = ev.to_mesh()
    pts = [ob.matrix_world @ v.co for v in me.vertices]
    ev.to_mesh_clear()
    c = sum(pts, Vector()) / len(pts)
    return c, max((p - c).length for p in pts)


def _skin_bsdf():
    m = bpy.data.materials['Skin']
    return m, m.node_tree, next(n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')


def hide_painted_brows(fwd, up):
    body = bpy.data.objects['Body']
    # Positions with the armature but without the subdivision, so there is one value per base vertex.
    subs = [m for m in body.modifiers if m.type == 'SUBSURF']
    for m in subs: m.show_viewport = False
    bpy.context.view_layer.update()
    dg = bpy.context.evaluated_depsgraph_get()
    ev = body.evaluated_get(dg); me = ev.to_mesh()
    pos = [body.matrix_world @ v.co for v in me.vertices]
    ev.to_mesh_clear()
    for m in subs: m.show_viewport = True
    arcs = []
    for name in ('Eye_l', 'Eye_r'):
        c, r = _eye(name)
        side = _outward(name, fwd)
        for i in range(40):
            t = i / 39
            arc_h = r * (1.45 + 0.35 * math.sin(math.pi * min(1.0, t * 1.2)) - 0.25 * t)
            arcs.append(c + side * (r * (-0.9 + 2.4 * t)) + up * arc_h)
    reach = 0.011
    mask = []
    eye_mid = (_eye('Eye_l')[0] + _eye('Eye_r')[0]) / 2
    flat = lambda v: v - fwd * v.dot(fwd)  # distance across the face, ignoring depth (the arc runs inside the head)
    arcs_f = [flat(a) for a in arcs]
    for p in pos:
        if (p - eye_mid).dot(fwd) < 0.0 or abs((p - eye_mid).dot(up)) > 0.06:
            mask.append(0.0); continue
        pf = flat(p)
        d = min((pf - a).length for a in arcs_f)
        mask.append(max(0.0, min(1.0, 1.0 - (d - reach * 0.5) / (reach * 0.5))))
    attr = body.data.attributes.get('browmask') or body.data.attributes.new('browmask', 'FLOAT', 'POINT')
    attr.data.foreach_set('value', mask)
    m, nt, b = _skin_bsdf()
    src = b.inputs['Base Color'].links[0].from_socket
    at = nt.nodes.new('ShaderNodeAttribute'); at.attribute_name = 'browmask'
    # The cover colour is the skin's own colour sampled a little above the brow (the forehead), by shifting the UVs.
    mix = nt.nodes.new('ShaderNodeMix'); mix.data_type = 'RGBA'
    nt.links.new(at.outputs['Fac'], mix.inputs['Factor'])
    nt.links.new(src, mix.inputs[6])
    mix.inputs[7].default_value = (0.105, 0.036, 0.018, 1.0)  # linear warm brown close to the toned skin
    nt.links.new(mix.outputs[2], b.inputs['Base Color'])
    return sum(1 for x in mask if x > 0.5)


def tone_variation():
    m, nt, b = _skin_bsdf()
    src = b.inputs['Base Color'].links[0].from_socket
    ao = nt.nodes.new('ShaderNodeAmbientOcclusion'); ao.samples = 8; ao.inputs['Distance'].default_value = 0.015
    dark = nt.nodes.new('ShaderNodeMapRange')
    dark.inputs['To Min'].default_value = 0.72; dark.inputs['To Max'].default_value = 1.0
    nt.links.new(ao.outputs['AO'], dark.inputs['Value'])
    tc = nt.nodes.new('ShaderNodeTexCoord')
    mott = nt.nodes.new('ShaderNodeTexNoise'); mott.inputs['Scale'].default_value = 35.0; mott.inputs['Detail'].default_value = 3.0
    nt.links.new(tc.outputs['Object'], mott.inputs['Vector'])
    mr = nt.nodes.new('ShaderNodeMapRange'); mr.inputs['To Min'].default_value = 0.93; mr.inputs['To Max'].default_value = 1.06
    nt.links.new(mott.outputs['Fac'], mr.inputs['Value'])
    f = nt.nodes.new('ShaderNodeMath'); f.operation = 'MULTIPLY'
    nt.links.new(dark.outputs['Result'], f.inputs[0]); nt.links.new(mr.outputs['Result'], f.inputs[1])
    mul = nt.nodes.new('ShaderNodeMix'); mul.data_type = 'RGBA'; mul.blend_type = 'MULTIPLY'; mul.inputs['Factor'].default_value = 1.0
    nt.links.new(src, mul.inputs[6])
    comb = nt.nodes.new('ShaderNodeCombineColor')
    for k in range(3): nt.links.new(f.outputs['Value'], comb.inputs[k])
    nt.links.new(comb.outputs['Color'], mul.inputs[7])
    nt.links.new(mul.outputs[2], b.inputs['Base Color'])
    return True

"""Skin pass v3 for CHE's Route-B model: random-walk skin subsurface, procedural pores and micro-wrinkles,
roughness variation, a thin oil coat and peach-fuzz sheen. Everything is procedural (no downloaded or paid textures).

Pores live in UV space so they stick to the skin while the rig deforms it (Object coordinates would swim).
`upgrade_skin(sc)` changes only the 'Skin' material and returns the nodes it added, so a test can render before/after.
Knobs (env): SKIN_SSS (subsurface scale in metres, default 0.004), PORE_SCALE (UV voronoi scale, default 2600),
PORE_DEPTH (bump strength, default 0.22), SKIN_COAT (oil coat weight, default 0.08), SKIN_SHEEN (fuzz weight, 0.12).
"""
import os

import bpy


def _f(name, default):
    return float(os.environ.get(name, default))


def upgrade_skin(material_name='Skin'):
    m = bpy.data.materials.get(material_name)
    if not m or not m.use_nodes:
        return None
    nt = m.node_tree
    b = next((n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED'), None)
    if not b:
        return None
    # Subsurface: full weight with the skin random walk, a short warm radius (darker skin scatters less far).
    b.subsurface_method = 'RANDOM_WALK_SKIN' if 'RANDOM_WALK_SKIN' in [i.identifier for i in b.bl_rna.properties['subsurface_method'].enum_items] else 'RANDOM_WALK'
    b.inputs['Subsurface Weight'].default_value = 1.0
    b.inputs['Subsurface Radius'].default_value = (1.0, 0.38, 0.2)
    b.inputs['Subsurface Scale'].default_value = _f('SKIN_SSS', '0.004')
    if 'Subsurface IOR' in b.inputs:
        b.inputs['Subsurface IOR'].default_value = 1.4
    if 'Subsurface Anisotropy' in b.inputs:
        b.inputs['Subsurface Anisotropy'].default_value = 0.8

    uv = nt.nodes.new('ShaderNodeUVMap'); uv.uv_map = 'UVMap'
    # Pores: inverted Voronoi F1 distance, so each cell centre is a small pit.
    pores = nt.nodes.new('ShaderNodeTexVoronoi'); pores.feature = 'F1'
    pores.inputs['Scale'].default_value = _f('PORE_SCALE', '2600')
    pores.inputs['Randomness'].default_value = 0.9
    nt.links.new(uv.outputs['UV'], pores.inputs['Vector'])
    pit = nt.nodes.new('ShaderNodeMapRange')
    pit.inputs['From Min'].default_value = 0.0; pit.inputs['From Max'].default_value = 0.35
    pit.inputs['To Min'].default_value = 0.0; pit.inputs['To Max'].default_value = 1.0
    nt.links.new(pores.outputs['Distance'], pit.inputs['Value'])
    # Micro-wrinkles: stretched fine noise layered over the pores.
    fine = nt.nodes.new('ShaderNodeTexNoise')
    fine.inputs['Scale'].default_value = _f('PORE_SCALE', '2600') * 0.45
    fine.inputs['Detail'].default_value = 6.0
    fine.inputs['Roughness'].default_value = 0.6
    nt.links.new(uv.outputs['UV'], fine.inputs['Vector'])
    mix = nt.nodes.new('ShaderNodeMath'); mix.operation = 'MULTIPLY_ADD'
    mix.inputs[1].default_value = 0.35
    nt.links.new(fine.outputs['Fac'], mix.inputs[0])
    nt.links.new(pit.outputs['Result'], mix.inputs[2])
    bump = nt.nodes.new('ShaderNodeBump')
    bump.inputs['Strength'].default_value = _f('PORE_DEPTH', '0.22')
    bump.inputs['Distance'].default_value = 0.0004
    nt.links.new(mix.outputs['Value'], bump.inputs['Height'])
    nt.links.new(bump.outputs['Normal'], b.inputs['Normal'])

    # Roughness: keep the painted map and vary it at pore scale (pits read slightly rougher, skin between them shinier).
    rough_src = b.inputs['Roughness'].links[0].from_socket if b.inputs['Roughness'].is_linked else None
    var = nt.nodes.new('ShaderNodeMath'); var.operation = 'MULTIPLY_ADD'
    var.inputs[1].default_value = 0.12
    nt.links.new(pit.outputs['Result'], var.inputs[0])
    if rough_src is not None:
        nt.links.new(rough_src, var.inputs[2])
    else:
        var.inputs[2].default_value = b.inputs['Roughness'].default_value
    clamp = nt.nodes.new('ShaderNodeClamp')
    clamp.inputs['Min'].default_value = 0.28; clamp.inputs['Max'].default_value = 0.75
    nt.links.new(var.outputs['Value'], clamp.inputs['Value'])
    nt.links.new(clamp.outputs['Result'], b.inputs['Roughness'])

    # A thin oil layer and peach fuzz: what makes skin catch light at grazing angles.
    if 'Coat Weight' in b.inputs:
        b.inputs['Coat Weight'].default_value = _f('SKIN_COAT', '0.08')
        b.inputs['Coat Roughness'].default_value = 0.32
        b.inputs['Coat IOR'].default_value = 1.45
    if 'Sheen Weight' in b.inputs:
        b.inputs['Sheen Weight'].default_value = _f('SKIN_SHEEN', '0.12')
        b.inputs['Sheen Roughness'].default_value = 0.45
        b.inputs['Sheen Tint'].default_value = (0.95, 0.85, 0.8, 1.0)
    if 'Specular IOR Level' in b.inputs:
        b.inputs['Specular IOR Level'].default_value = 0.42
    return {'bump': bump, 'pores': pores}

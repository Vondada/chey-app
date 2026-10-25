"""Create Object: a procedural parametric object built in Blender from a small spec and exported as GLB.

  python3 objects.py      env: SPEC_JSON (the spec, JSON text; see creation_params.py), EXPORT_GLB (model.glb path)
  blender -b --factory-startup -P ../avatar_face/bl_run.py -- objects.py

A fixed family list (lamp, chair, table, mug, vase, shelf), each in three styles (modern, classic, industrial), with
size, colour, roughness and metallic as parameters: honest procedural modelling, not free-form text-to-3D. The colour,
roughness and metallic go on each family's main material; the other parts keep their style's fixed materials (oak,
steel, brass). Built at size 1 in metres (Z up, front facing -Y) and scaled by `size`, standing on z = 0.

Prints MODEL <path> <bytes> bytes <vertices> vertices (<contents>). The previews are rendered from the exported file
itself by render_creation.py, and verify_glb.py --static measures it (meshes, triangles, bounding box, materials).
Also the shared building blocks for rooms.py and thumbs.py: mat, prim, lathe, light, camera, world, build_object.
"""
import json
import math
import os
import sys

import bpy
import bmesh  # noqa: E402  (bmesh is importable once bpy is)
from mathutils import Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from creation_params import SpecError, describe, hex_rgb, validate_object  # noqa: E402

# CC0 textures the job fetched before Blender ran (cc0_textures.py via scripts/che_creation_job.py): TEXTURES_JSON is
# {material: {"diffuse": path, "normal": path?}}. A material without a verified file stays a plain colour.
try:
    TEXTURE_FILES = json.loads(os.environ.get('TEXTURES_JSON') or '{}')
except ValueError:
    TEXTURE_FILES = {}

# ── building blocks ───────────────────────────────────────────────────────────────────────────────────────────────


def mat(name, rgb, rough=0.5, metal=0.0, emit=None, strength=0.0):
    m = bpy.data.materials.new(name); m.use_nodes = True; p = m.node_tree.nodes['Principled BSDF']
    p.inputs['Base Color'].default_value = (*rgb, 1); p.inputs['Roughness'].default_value = rough
    p.inputs['Metallic'].default_value = metal
    if emit:
        p.inputs['Emission Color'].default_value = (*emit, 1); p.inputs['Emission Strength'].default_value = strength
    return m


def prim(kind, mat_, loc=(0, 0, 0), rot=(0, 0, 0), scale=(1, 1, 1), bevel=0.0, name=None, **kw):
    getattr(bpy.ops.mesh, f'primitive_{kind}_add')(location=loc, rotation=rot, **kw)
    o = bpy.context.active_object; o.scale = scale; o.data.materials.append(mat_)
    if name: o.name = name; o.data.name = name
    if bevel:
        b = o.modifiers.new('Bevel', 'BEVEL'); b.width = bevel; b.segments = 3
    for p in o.data.polygons: p.use_smooth = kind in ('uv_sphere', 'cylinder', 'cone', 'torus', 'ico_sphere')
    return o


def box(mat_, centre, size, bevel=0.0, name=None):
    """A box by its centre and full size in metres (the primitive cube is 2 m)."""
    return prim('cube', mat_, centre, scale=tuple(s / 2 for s in size), bevel=bevel, name=name)


def rod(mat_, a, b, radius, name=None, vertices=16):
    """A cylinder from point a to point b."""
    a, b = Vector(a), Vector(b); d = b - a
    o = prim('cylinder', mat_, (a + b) / 2, vertices=vertices, radius=radius, depth=d.length, name=name)
    o.rotation_mode = 'QUATERNION'; o.rotation_quaternion = Vector((0, 0, 1)).rotation_difference(d.normalized())
    return o


def lathe(mat_, profile, segments=48, loc=(0, 0, 0), name='Lathe'):
    """A surface of revolution about Z from a list of (radius, height) points, smooth shaded."""
    me = bpy.data.meshes.new(name); bm = bmesh.new()
    verts = [bm.verts.new((r, 0, z)) for r, z in profile]
    edges = [bm.edges.new((verts[i], verts[i + 1])) for i in range(len(verts) - 1)]
    bmesh.ops.spin(bm, geom=verts + edges, cent=(0, 0, 0), axis=(0, 0, 1), angle=math.tau, steps=segments, use_duplicate=False)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    bm.to_mesh(me); bm.free()
    o = bpy.data.objects.new(name, me); bpy.context.scene.collection.objects.link(o); o.location = loc
    me.materials.append(mat_)
    for p in me.polygons: p.use_smooth = True
    return o


def textured(material, rgb=(0.5, 0.5, 0.5), rough=0.6, metal=0.0, metres=1.0):
    """One shared material per CC0 texture: the Diffuse image as base colour (and the OpenGL normal map), repeating
    every `metres` through a Mapping node (exported as KHR_texture_transform). None when no file was fetched."""
    files = TEXTURE_FILES.get(material) or {}
    if not files.get('diffuse') or not os.path.isfile(files['diffuse']): return None
    name = f'CC0 {material}'
    if name in bpy.data.materials: return bpy.data.materials[name]
    m = mat(name, rgb, rough, metal); nt = m.node_tree; p = nt.nodes['Principled BSDF']
    uv = nt.nodes.new('ShaderNodeTexCoord'); mp = nt.nodes.new('ShaderNodeMapping'); mp.inputs['Scale'].default_value = (1 / metres, 1 / metres, 1)
    nt.links.new(uv.outputs['UV'], mp.inputs['Vector'])
    img = nt.nodes.new('ShaderNodeTexImage'); img.image = bpy.data.images.load(files['diffuse']); nt.links.new(mp.outputs['Vector'], img.inputs['Vector'])
    nt.links.new(img.outputs['Color'], p.inputs['Base Color'])
    if files.get('normal') and os.path.isfile(files['normal']):
        ni = nt.nodes.new('ShaderNodeTexImage'); ni.image = bpy.data.images.load(files['normal']); ni.image.colorspace_settings.name = 'Non-Color'
        nm = nt.nodes.new('ShaderNodeNormalMap'); nt.links.new(mp.outputs['Vector'], ni.inputs['Vector'])
        nt.links.new(ni.outputs['Color'], nm.inputs['Color']); nt.links.new(nm.outputs['Normal'], p.inputs['Normal'])
    m['che_texture'] = material
    return m


def box_uv(o):
    """UVs in metres by box projection (each face takes the two world axes across it), so a texture tiles at real scale
    on any part, whatever its size, instead of stretching one image over it."""
    me = o.data
    uvl = me.uv_layers.get('UVMap') or me.uv_layers.new(name='UVMap'); me.uv_layers.active = uvl
    mw = o.matrix_world
    for poly in me.polygons:
        n = (mw.to_3x3() @ poly.normal); ax = max(range(3), key=lambda k: abs(n[k]))
        a, b = [(1, 2), (0, 2), (0, 1)][ax]
        for li in poly.loop_indices:
            w = mw @ me.vertices[me.loops[li].vertex_index].co
            uvl.data[li].uv = (w[a], w[b])


def camera(sc, loc, target, lens=50):
    cam = bpy.data.objects.new('Cam', bpy.data.cameras.new('Cam')); sc.collection.objects.link(cam); sc.camera = cam
    cam.data.lens = lens; cam.location = loc
    tgt = bpy.data.objects.new('Tgt', None); sc.collection.objects.link(tgt); tgt.location = target
    c = cam.constraints.new('TRACK_TO'); c.target = tgt; c.track_axis = 'TRACK_NEGATIVE_Z'; c.up_axis = 'UP_Y'
    return cam


def light(sc, kind, loc, energy, size=1.0, color=(1, 1, 1), target=None):
    l = bpy.data.objects.new(kind, bpy.data.lights.new(kind, kind)); sc.collection.objects.link(l)
    l.location = loc; l.data.energy = energy; l.data.color = color
    if kind == 'AREA': l.data.size = size
    if kind == 'POINT': l.data.shadow_soft_size = size
    if target is not None:
        t = bpy.data.objects.new('LT', None); sc.collection.objects.link(t); t.location = target
        c = l.constraints.new('TRACK_TO'); c.target = t; c.track_axis = 'TRACK_NEGATIVE_Z'; c.up_axis = 'UP_Y'
    return l


def world(sc, rgb, strength=1.0):
    w = bpy.data.worlds.new('W'); sc.world = w; w.use_nodes = True
    bg = w.node_tree.nodes['Background']; bg.inputs['Color'].default_value = (*rgb, 1); bg.inputs['Strength'].default_value = strength


# ── the style's fixed materials ───────────────────────────────────────────────────────────────────────────────────
FINISHES = {'Oak': ((0.30, 0.17, 0.08), 0.45, 0.0), 'Walnut': ((0.12, 0.06, 0.03), 0.4, 0.0),
            'Steel': ((0.62, 0.63, 0.65), 0.28, 1.0), 'Brass': ((0.78, 0.56, 0.24), 0.3, 1.0),
            'Dark metal': ((0.03, 0.03, 0.035), 0.4, 0.8), 'Linen': ((0.78, 0.74, 0.66), 0.85, 0.0),
            'Ceramic white': ((0.86, 0.85, 0.82), 0.2, 0.0)}


def fixed(name):
    """One shared material per fixed finish (oak, steel, brass, dark metal, linen, bulb, ...), made once per scene."""
    if name in bpy.data.materials: return bpy.data.materials[name]
    if name == 'Bulb': return mat('Bulb', (1, 0.92, 0.75), 0.2, emit=(1.0, 0.8, 0.55), strength=12)
    rgb, r, m = FINISHES[name]
    return mat(name, rgb, r, m)


def main_material(spec, label):
    return mat(f"{label} ({spec['style']})", hex_rgb(spec['color']), spec['roughness'], spec['metallic'])


# ── families (size 1, metres, front facing -Y, standing on z = 0) ───────────────────────────────────────────────────


def lamp(spec, m):
    st, form, parts = spec['style'], spec.get('form', 'desk'), []
    metal = fixed({'modern': 'Steel', 'classic': 'Brass', 'industrial': 'Dark metal'}[st])
    if form == 'floor':
        if st == 'industrial':   # tripod legs and a metal dome
            for k in range(3):
                a = k * math.tau / 3
                parts.append(rod(metal, (0.2 * math.cos(a), 0.2 * math.sin(a), 0), (0, 0, 1.15), 0.012, f'lamp_leg_{k}'))
            parts.append(rod(metal, (0, 0, 1.15), (0, 0, 1.3), 0.012, 'lamp_neck'))
            parts.append(prim('cone', m, (0, 0, 1.4), vertices=48, radius1=0.2, radius2=0.05, depth=0.2, end_fill_type='NOTHING', name='lamp_shade'))
        else:
            parts.append(prim('cylinder', metal, (0, 0, 0.015), vertices=48, radius=0.18, depth=0.03, bevel=0.006, name='lamp_base'))
            parts.append(rod(metal, (0, 0, 0.03), (0, 0, 1.33), 0.012, 'lamp_pole'))
            r = 0.22 if st == 'classic' else 0.2
            parts.append(prim('cylinder' if st == 'classic' else 'cone', m, (0, 0, 1.45), vertices=48,
                              **({'radius': r} if st == 'classic' else {'radius1': r, 'radius2': 0.14}), depth=0.3,
                              end_fill_type='NOTHING', name='lamp_shade'))
        parts.append(prim('uv_sphere', fixed('Bulb'), (0, 0, 1.33), radius=0.04, segments=24, ring_count=12, name='Bulb'))
    elif st == 'classic':   # a column table lamp with a drum shade
        parts.append(prim('cylinder', metal, (0, 0, 0.015), vertices=48, radius=0.09, depth=0.03, bevel=0.005, name='lamp_base'))
        parts.append(lathe(metal, [(0.0, 0.03), (0.035, 0.03), (0.02, 0.12), (0.03, 0.2), (0.012, 0.34), (0.0, 0.34)], 32, name='lamp_column'))
        parts.append(prim('cylinder', m, (0, 0, 0.44), vertices=48, radius=0.13, depth=0.24, end_fill_type='NOTHING', name='lamp_shade'))
        parts.append(prim('uv_sphere', fixed('Bulb'), (0, 0, 0.38), radius=0.03, segments=24, ring_count=12, name='Bulb'))
    else:   # an arm desk lamp: two arm segments with joints, the shade looking down at the desk
        parts.append(prim('cylinder', fixed('Dark metal'), (0, 0.05, 0.012), vertices=48, radius=0.1, depth=0.024, bevel=0.004, name='lamp_base'))
        j0, j1, j2 = Vector((0, 0.06, 0.03)), Vector((0, 0.12, 0.36)), Vector((0, -0.06, 0.5))
        jr = 0.017 if st == 'modern' else 0.026
        for k, (p, q) in enumerate(((j0, j1), (j1, j2))): parts.append(rod(metal, p, q, 0.009 if st == 'modern' else 0.013, f'lamp_arm_{k}'))
        for k, p in enumerate((j0, j1, j2)):
            parts.append(prim('uv_sphere', fixed('Dark metal'), p, radius=jr, segments=24, ring_count=12, name=f'lamp_joint_{k}'))
        sh = prim('cone', m, j2 + Vector((0, -0.05, -0.04)), vertices=48, radius1=0.085 if st == 'modern' else 0.1,
                  radius2=0.03, depth=0.13, end_fill_type='NOTHING', name='lamp_shade')
        sh.rotation_euler = (math.radians(-35), 0, 0); parts.append(sh)
        parts.append(prim('uv_sphere', fixed('Bulb'), j2 + Vector((0, -0.08, -0.09)), radius=0.025, segments=24, ring_count=12, name='Bulb'))
    for o in parts:
        if o.name == 'lamp_shade':
            s = o.modifiers.new('Solid', 'SOLIDIFY'); s.thickness = 0.003
    return parts


def chair(spec, m):
    st, parts = spec['style'], []
    seat_h, w, d = 0.45, 0.46, 0.46
    legs = {'modern': fixed('Oak'), 'classic': m, 'industrial': fixed('Dark metal')}[st]
    parts.append(box(m, (0, 0, seat_h - 0.025), (w, d, 0.05), bevel=0.008, name='chair_seat'))
    ix, iy = w / 2 - 0.035, d / 2 - 0.035
    for k, (sx, sy) in enumerate(((-1, -1), (1, -1), (-1, 1), (1, 1))):
        x, y = sx * ix, sy * iy
        if st == 'classic': parts.append(box(legs, (x, y, (seat_h - 0.05) / 2), (0.04, 0.04, seat_h - 0.05), bevel=0.004, name=f'chair_leg_{k}'))
        else: parts.append(rod(legs, (x * (1.08 if st == 'modern' else 1), y * (1.08 if st == 'modern' else 1), 0), (x, y, seat_h - 0.05), 0.016, f'chair_leg_{k}'))
    yb = d / 2 - 0.02 + 0.02   # the back stands on the rear edge (+Y) and leans back a little
    if st == 'modern':
        b = box(m, (0, yb, 0.72), (w * 0.96, 0.03, 0.26), bevel=0.012, name='chair_back'); b.rotation_euler = (math.radians(-8), 0, 0); parts.append(b)
        for k, sx in enumerate((-1, 1)): parts.append(rod(legs, (sx * ix, iy, seat_h - 0.02), (sx * ix, yb + 0.01, 0.62), 0.012, f'chair_post_{k}'))
    elif st == 'classic':
        for k, sx in enumerate((-1, 1)): parts.append(box(m, (sx * ix, iy + 0.01, 0.63), (0.04, 0.04, 0.36), bevel=0.004, name=f'chair_post_{k}'))
        parts.append(box(m, (0, iy + 0.01, 0.84), (w, 0.04, 0.06), bevel=0.006, name='chair_top_rail'))
        for k, x in enumerate((-0.1, 0, 0.1)): parts.append(box(m, (x, iy + 0.01, 0.65), (0.035, 0.02, 0.32), name=f'chair_slat_{k}'))
    else:
        for k, sx in enumerate((-1, 1)): parts.append(rod(legs, (sx * ix, iy, seat_h), (sx * ix, iy + 0.02, 0.85), 0.012, f'chair_post_{k}'))
        parts.append(box(m, (0, iy + 0.02, 0.76), (w * 0.9, 0.025, 0.16), bevel=0.006, name='chair_back'))
        parts.append(rod(legs, (-ix, -iy, 0.12), (ix, -iy, 0.12), 0.01, 'chair_rail_f'))
        parts.append(rod(legs, (-ix, iy, 0.12), (ix, iy, 0.12), 0.01, 'chair_rail_b'))
    return parts


TABLES = {'dining': (1.2, 0.75, 0.75), 'coffee': (1.0, 0.55, 0.42), 'desk': (1.2, 0.6, 0.75)}


def table(spec, m):
    st, form, parts = spec['style'], spec.get('form', 'dining'), []
    w, d, h = TABLES[form]
    top_t = {'modern': 0.03, 'classic': 0.05, 'industrial': 0.045}[st]
    parts.append(box(m, (0, 0, h - top_t / 2), (w, d, top_t), bevel=0.006 if st != 'classic' else 0.012, name='table_top'))
    legh = h - top_t
    ix, iy = w / 2 - 0.06, d / 2 - 0.06
    if st == 'industrial':
        steel = fixed('Dark metal')
        for k, sx in enumerate((-1, 1)):
            x = sx * ix
            for sy in (-1, 1): parts.append(box(steel, (x, sy * iy, legh / 2), (0.04, 0.04, legh), name=f'table_leg_{k}_{sy}'))
            parts.append(box(steel, (x, 0, legh - 0.02), (0.04, 2 * iy, 0.04), name=f'table_frame_{k}'))
            parts.append(box(steel, (x, 0, 0.08), (0.04, 2 * iy, 0.03), name=f'table_foot_{k}'))
    else:
        legm = fixed('Oak') if st == 'modern' else m
        for k, (sx, sy) in enumerate(((-1, -1), (1, -1), (-1, 1), (1, 1))):
            if st == 'modern': parts.append(rod(legm, (sx * ix, sy * iy, 0), (sx * ix, sy * iy, legh), 0.02, f'table_leg_{k}'))
            else: parts.append(lathe(legm, [(0.0, 0.0), (0.028, 0.0), (0.02, legh * 0.2), (0.032, legh * 0.5), (0.022, legh * 0.8), (0.03, legh), (0.0, legh)],
                                     24, loc=(sx * ix, sy * iy, 0), name=f'table_leg_{k}'))
        if st == 'classic':
            for k, (cx, cy, sx_, sy_) in enumerate(((0, iy, 2 * ix, 0.02), (0, -iy, 2 * ix, 0.02), (ix, 0, 0.02, 2 * iy), (-ix, 0, 0.02, 2 * iy))):
                parts.append(box(m, (cx, cy, legh - 0.05), (sx_, sy_, 0.08), name=f'table_apron_{k}'))
    if form == 'desk':   # a drawer unit under the right end
        parts.append(box(m if st != 'industrial' else fixed('Dark metal'), (w / 2 - 0.22, 0, legh - 0.08), (0.36, d - 0.1, 0.14), bevel=0.004, name='desk_drawer'))
        parts.append(box(fixed('Steel'), (w / 2 - 0.22, -(d - 0.1) / 2 - 0.006, legh - 0.08), (0.1, 0.012, 0.015), name='desk_handle'))
    return parts


def mug(spec, m):
    st = spec['style']
    r, h, t = 0.045, 0.1, 0.005
    top = r + (0.006 if st == 'classic' else 0)
    prof = [(0.0, 0.0), (r - 0.004, 0.0), (r, 0.004), (top, h), (top - t, h), (r - t, 0.008), (0.0, 0.008)]
    parts = [lathe(m, prof, 12 if st == 'industrial' else 48, name='mug_body')]
    handle = prim('torus', m, (r + 0.012, 0, h * 0.52), rot=(math.radians(90), 0, 0), major_radius=0.026, minor_radius=0.0065,
                  major_segments=32, minor_segments=12, name='mug_handle')
    parts.append(handle)
    return parts


def vase(spec, m):
    st = spec['style']
    prof = {'modern': [(0.0, 0.0), (0.06, 0.0), (0.075, 0.08), (0.08, 0.3), (0.072, 0.32), (0.064, 0.3), (0.068, 0.08), (0.0, 0.012)],
            'classic': [(0.0, 0.0), (0.055, 0.0), (0.06, 0.03), (0.09, 0.13), (0.075, 0.22), (0.035, 0.27), (0.04, 0.3), (0.055, 0.32),
                        (0.048, 0.32), (0.03, 0.28), (0.068, 0.21), (0.08, 0.13), (0.0, 0.012)],
            'industrial': [(0.0, 0.0), (0.08, 0.0), (0.08, 0.32), (0.072, 0.32), (0.072, 0.012), (0.0, 0.012)]}[st]
    return [lathe(m, prof, 8 if st == 'industrial' else 64, name='vase_body')]


BOOKS = [(0.45, 0.08, 0.06), (0.85, 0.82, 0.74), (0.08, 0.2, 0.35), (0.1, 0.32, 0.22), (0.7, 0.55, 0.2), (0.25, 0.1, 0.3)]


def shelf(spec, m):
    st, parts = spec['style'], []
    w, d, h, t = 0.9, 0.3, 1.6, 0.022
    levels = [0.06, 0.42, 0.78, 1.14, 1.5]
    if st == 'industrial':
        steel = fixed('Dark metal')
        for k, (sx, sy) in enumerate(((-1, -1), (1, -1), (-1, 1), (1, 1))):
            parts.append(box(steel, (sx * (w / 2 - 0.01), sy * (d / 2 - 0.01), h / 2), (0.02, 0.02, h), name=f'shelf_post_{k}'))
        for k, z in enumerate(levels): parts.append(box(m, (0, 0, z), (w, d, 0.03), name=f'shelf_board_{k}'))
    else:
        for k, sx in enumerate((-1, 1)): parts.append(box(m, (sx * (w / 2 - t / 2), 0, h / 2), (t, d, h), bevel=0.002, name=f'shelf_side_{k}'))
        for k, z in enumerate(levels): parts.append(box(m, (0, 0, z), (w - 2 * t, d - 0.01, t), name=f'shelf_board_{k}'))
        if st == 'classic':
            parts.append(box(m, (0, d / 2 - 0.006, h / 2), (w - 2 * t, 0.012, h), name='shelf_back'))
            parts.append(box(m, (0, 0.0, h - 0.02), (w + 0.04, d + 0.02, 0.04), bevel=0.006, name='shelf_crown'))
    # Books on three shelves: fixed widths and colours (deterministic, no randomness), leaning none.
    for lvl, z in enumerate(levels[1:4]):
        x = -w / 2 + 0.06
        for k in range(7 - lvl):
            bw, bh = 0.03 + 0.008 * ((k * 3 + lvl) % 4), 0.2 + 0.03 * ((k + lvl) % 3)
            if x + bw > w / 2 - 0.06: break
            book = mat(f'Book {(k + lvl) % len(BOOKS) + 1}', BOOKS[(k + lvl) % len(BOOKS)], 0.7) if f'Book {(k + lvl) % len(BOOKS) + 1}' not in bpy.data.materials \
                else bpy.data.materials[f'Book {(k + lvl) % len(BOOKS) + 1}']
            parts.append(box(book, (x + bw / 2, -0.01, z + t / 2 + bh / 2), (bw, 0.2, bh), name=f'shelf_book_{lvl}_{k}'))
            x += bw + 0.004
    return parts


TEXTURE_TINT = {'wood': ((0.30, 0.17, 0.08), 0.5, 0.0), 'stone': ((0.4, 0.4, 0.38), 0.8, 0.0), 'metal': ((0.6, 0.6, 0.62), 0.35, 1.0),
                'fabric': ((0.4, 0.38, 0.35), 0.95, 0.0), 'brick': ((0.45, 0.18, 0.12), 0.85, 0.0), 'concrete': ((0.35, 0.35, 0.34), 0.85, 0.0),
                'tile': ((0.6, 0.6, 0.58), 0.25, 0.0)}


def custom(spec, m):
    """A described object (creation_freeform.js): each part is an exact primitive filling its box. c and s are glTF
    axes (x right, y up, z front); Blender gets (x, -z, y). A cylinder, cone or torus runs along `axis` (glTF y by
    default); a cone may point down (`flip`) or have few sides (a pyramid has 4, its faces square to the box). A part
    without its own colour takes the object's material, so recolouring the object recolours its main parts. A part with
    a texture gets the CC0 image when the job fetched it, else its plain colour."""
    parts, mats = [], {}
    for p in spec['parts']:
        shape, (cx, cy, cz), (w, h, d) = p['shape'], p['c'], p['s']
        axis = p.get('axis', 'y'); sides = p.get('sides')
        if p.get('texture'):
            rgb, r, mt = TEXTURE_TINT[p['texture']]
            mm = textured(p['texture'], hex_rgb(p['color']) if p.get('color') else rgb, p.get('roughness', r), p.get('metallic', mt))
        else: mm = None
        if mm is None and (p.get('color') or 'metallic' in p or 'roughness' in p):
            key = (p.get('color', spec['color']), p.get('roughness', spec['roughness']), p.get('metallic', spec['metallic']))
            if key not in mats: mats[key] = mat(f'Part {len(mats) + 1}', hex_rgb(key[0]), key[1], key[2])
            mm = mats[key]
        mm = mm or m
        bm = bmesh.new()
        if shape == 'box': bmesh.ops.create_cube(bm, size=1.0)
        elif shape == 'sphere': bmesh.ops.create_uvsphere(bm, u_segments=32, v_segments=16, radius=0.5)
        elif shape == 'cylinder': bmesh.ops.create_cone(bm, cap_ends=True, segments=sides or 40, radius1=0.5, radius2=0.5, depth=1.0)
        elif shape == 'cone': bmesh.ops.create_cone(bm, cap_ends=True, segments=sides or 40, radius1=0.5, radius2=0.0, depth=1.0)
        else:
            # A torus filling a unit box: outer diameter 1 across, thickness 1 along its axis; the tube's radius across
            # the ring is the real thickness over the real outer diameter, so the scaled ring is round, not squashed.
            t = (h if axis == 'y' else (w if axis == 'x' else d)); outer = max(w, d) if axis == 'y' else max(h, d if axis == 'x' else w)
            minor = min(0.5, t / max(outer, 1e-6) / 2); major = 0.5 - minor
            for i in range(48):
                a = i / 48 * math.tau
                for j in range(12):
                    b = j / 12 * math.tau
                    bm.verts.new(((major + minor * math.cos(b)) * math.cos(a), (major + minor * math.cos(b)) * math.sin(a), 0.5 * math.sin(b)))
            bm.verts.ensure_lookup_table()
            for i in range(48):
                for j in range(12):
                    bm.faces.new([bm.verts[((i + di) % 48) * 12 + (j + dj) % 12] for di, dj in ((0, 0), (1, 0), (1, 1), (0, 1))])
            bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        if shape in ('cone',) and sides == 4:   # a pyramid: faces square to the box, corners filling it
            bmesh.ops.rotate(bm, verts=bm.verts, cent=(0, 0, 0), matrix=Matrix.Rotation(math.pi / 4, 3, 'Z'))
            bmesh.ops.scale(bm, vec=(math.sqrt(2), math.sqrt(2), 1), verts=bm.verts)
        if shape == 'cone' and p.get('flip'): bmesh.ops.scale(bm, vec=(1, 1, -1), verts=bm.verts); bmesh.ops.reverse_faces(bm, faces=bm.faces)
        # The shape's own axis (Blender Z) turned to the glTF axis asked for: glTF x = Blender X, glTF z = Blender -Y.
        if shape != 'sphere' and shape != 'box' and axis != 'y':
            bmesh.ops.rotate(bm, verts=bm.verts, cent=(0, 0, 0), matrix=Matrix.Rotation(math.pi / 2, 3, 'Y' if axis == 'x' else 'X'))
        me = bpy.data.meshes.new(p['name']); bm.to_mesh(me); bm.free()
        o = bpy.data.objects.new(p['name'], me); bpy.context.scene.collection.objects.link(o)
        o.location = (cx, -cz, cy); o.scale = (w, d, h)
        me.materials.append(mm)
        smooth = shape in ('sphere', 'torus') or (shape in ('cylinder', 'cone') and not sides)
        for poly in me.polygons: poly.use_smooth = smooth
        if shape == 'box':
            b = o.modifiers.new('Bevel', 'BEVEL'); b.width = min(0.01, min(w, h, d) * 0.08); b.segments = 2; b.affect = 'EDGES'
            b.use_clamp_overlap = True
        o['che_part'] = p['name']
        if p.get('texture'):
            bpy.context.view_layer.update(); box_uv(o)
        parts.append(o)
    return parts


BUILDERS = {'lamp': lamp, 'chair': chair, 'table': table, 'mug': mug, 'vase': vase, 'shelf': shelf, 'custom': custom}
MAIN = {'lamp': 'Lamp shade', 'chair': 'Chair', 'table': 'Table', 'mug': 'Mug glaze', 'vase': 'Vase glaze', 'shelf': 'Shelf', 'custom': 'Object'}


def build_object(spec, at=(0, 0, 0), rot=0.0, name=None):
    """Builds one validated object spec, groups it under an empty and places it (metres, rotation about Z in
    radians). Returns the empty."""
    spec = validate_object(spec)
    parts = BUILDERS[spec['family']](spec, main_material(spec, MAIN[spec['family']]))
    root = bpy.data.objects.new(name or spec['family'], None); bpy.context.scene.collection.objects.link(root)
    for o in parts: o.parent = root
    s = spec['size']; root.scale = (s, s, s); root.location = at; root.rotation_euler = (0, 0, rot)
    return root


def mesh_stats():
    dg = bpy.context.evaluated_depsgraph_get(); verts = 0
    for o in bpy.context.scene.objects:
        if o.type == 'MESH': verts += len(o.evaluated_get(dg).data.vertices)
    return verts


def export(path, spec, kind):
    """The scene's meshes as a GLB (modifiers applied, no lights or cameras), with the spec in the scene extras."""
    sc = bpy.context.scene; sc['che_spec'] = json.dumps(spec, sort_keys=True); sc['che_kind'] = kind
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', export_apply=True, export_lights=False, export_cameras=False,
                              export_extras=True, export_yup=True, use_selection=False)
    return os.path.getsize(path)


def spec_from_env():
    raw = os.environ.get('SPEC_JSON') or (open(os.environ['SPEC_FILE']).read() if os.environ.get('SPEC_FILE') else '')
    return json.loads(raw)


def main():
    try:
        spec = validate_object(spec_from_env())
    except (SpecError, ValueError) as e:
        print(f'SPEC FAILED: {e}', flush=True); sys.exit(2)
    print('STAGE model', flush=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    build_object(spec)
    path = os.environ.get('EXPORT_GLB') or os.path.join(os.environ.get('OUT_DIR', '.'), 'model.glb')
    n = export(path, spec, 'object')
    print('MODEL', path, n, 'bytes', mesh_stats(), 'vertices', f"({describe('object', spec)})", flush=True)


if __name__ == '__main__':
    main()

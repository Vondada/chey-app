"""Interactive export profile: the GLB CHE's Office and Live Studio load in three.js, kept separate from the
cinematic render path. Mesh hair (cards/shell, no strands), vertex-colour eyes, no textures above 1024 px, no
subdivision, one animation per clip (the original five plus the licensed mocap clips), face morph targets for
expressions and visemes. The budget is checked and measured, not assumed.

  export(path, c, clips)  -> receipt {bytes, vertices, triangles, morph_targets, animations, textures, budget_ok}
"""
import json
import os
import struct

import bpy

BUDGET = {'vertices': 40000, 'triangles': 70000, 'texture_px': 1024, 'bytes': 12 * 1024 * 1024}
SKIP_PREFIX = ('HeadHair', 'Brow_strands', 'Lashes_strands', 'ov_', 'oj_', 'Cornea')


def glb_json(path):
    with open(path, 'rb') as f: data = f.read()
    clen, ctype = struct.unpack_from('<I4s', data, 12)
    return json.loads(data[20:20 + clen])


def export(path, c, extra_clips=()):
    arm = c['arm']
    meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH' and o.parent == arm and not o.name.startswith(SKIP_PREFIX)]
    for ad in [arm.animation_data] + [o.data.shape_keys.animation_data for o in meshes if o.data.shape_keys]:
        if ad:
            for tr in ad.nla_tracks: tr.mute = False
            ad.action = None
    bpy.ops.object.select_all(action='DESELECT')
    for o in (arm, *meshes): o.select_set(True)
    bpy.context.view_layer.objects.active = arm
    # subdivision is a cinematic-only modifier
    saved = []
    for o in meshes:
        for m in o.modifiers:
            if m.type == 'SUBSURF': saved.append((m, m.show_viewport)); m.show_viewport = False
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True, export_yup=True, export_apply=False,
                              export_skins=True, export_morph=True, export_animations=True, export_animation_mode='NLA_TRACKS',
                              export_vertex_color='ACTIVE', export_materials='EXPORT', export_cameras=False, export_lights=False,
                              export_force_sampling=True)
    for m, v in saved: m.show_viewport = v
    for ad in [arm.animation_data] + [o.data.shape_keys.animation_data for o in meshes if o.data.shape_keys]:
        if ad:
            for tr in ad.nla_tracks: tr.mute = True
    gl = glb_json(path)
    nv = sum(len(o.data.vertices) for o in meshes)
    tris = sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in meshes)
    morphs = sorted({t for m in gl.get('meshes', []) for t in (m.get('extras', {}).get('targetNames') or [])})
    imgs = [o for o in bpy.data.images if o.users and o.size[0] > 0 and any(o.name in str(n.image) for m in bpy.data.materials if m.use_nodes for n in m.node_tree.nodes if n.type == 'TEX_IMAGE')]
    rec = {'file': os.path.abspath(path), 'bytes': os.path.getsize(path), 'vertices': nv, 'triangles': tris,
           'meshes': [o.name for o in meshes], 'bones': len(arm.data.bones),
           'animations': [a['name'] for a in gl.get('animations', [])], 'morph_targets': morphs,
           'textures': [{'name': i.name, 'px': list(i.size)} for i in imgs], 'images_in_glb': len(gl.get('images', []))}
    rec['budget'] = BUDGET
    rec['budget_ok'] = nv <= BUDGET['vertices'] and tris <= BUDGET['triangles'] and rec['bytes'] <= BUDGET['bytes'] \
        and all(max(t['px']) <= BUDGET['texture_px'] for t in rec['textures'])
    return rec

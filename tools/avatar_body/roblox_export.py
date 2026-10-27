"""Roblox Studio export of a CHE full-body character: the verified GLB becomes an R15 FBX that Studio's 3D Importer /
Avatar Importer reads, then the FBX is read back and measured, and the rules in roblox_rig.py judge what was measured.

  python3 roblox_export.py MODEL.glb     env: OUT_DIR (default: next to the GLB), CLIP (walk; "" for none)

Writes OUT_DIR/character_r15.fbx (mesh + skeleton, no animation), OUT_DIR/<clip>_r15.fbx (the clip on the same skeleton,
baked: Roblox takes one animation per file) and prints
  ROBLOX_RECEIPT {json}   the validator's verdict plus what was measured, the files and their sha256.
Exit 0 when every hard rule holds (studio_import_ready), 2 when a rule fails.

What it does, in order:
1. Skeleton: MPFB's 53 game_engine bones become Roblox's 17 R15 joints (roblox_rig.PRIMARY): each joint keeps its
   primary bone (renamed), the other bones' skin weights are added to their joint's weights and the bones are removed
   (fingers into the hand, the upper spine and clavicles into UpperTorso, the head into Head at the neck's base, the
   toe into the foot). HumanoidRootNode is added at the pelvis between Root and LowerTorso.
2. Geometry: body, eyes, hair and shoes are joined, each face goes to the R15 part that owns most of its skin weight,
   and the 15 parts are separated into <Part>_Geo meshes. Each is decimated (collapse) to its share of Roblox's
   triangle budget (roblox_rig.PART_BUDGET), weights are limited to 4 per vertex and normalized, and nothing is weighted
   to Root or HumanoidRootNode.
3. FBX with Roblox's Blender settings: FBX unit scale, no leaf bones, textures embedded, scale applied.
CHE's face morphs (blink, mouth open, smile, brows up) are left out: Roblox Dynamic Heads animate with their own FACS
pose set, which CHE does not build yet. Not built either (said in the receipt): outer cages and _Att attachments (needed for layered clothing and the Marketplace), and
capped, watertight parts. Finger and spine motion is merged into the hand and torso, so those joints do not bend.
"""
import json
import os
import sys

import bpy
import hashlib

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import roblox_rig as R  # noqa: E402


def sha256(path):
    return hashlib.sha256(open(path, 'rb').read()).hexdigest()


def load(path):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=path)
    sc = bpy.context.scene
    arm = next(o for o in sc.objects if o.type == 'ARMATURE')
    for o in list(sc.objects):   # the importer's bone-display sphere is not part of the character
        if o.type == 'MESH' and o.name.startswith('Icosphere') and not o.vertex_groups: bpy.data.objects.remove(o)
    return sc, arm


def remap_skeleton(arm, meshes):
    joints = R.mapping([b.name for b in arm.data.bones])
    # Weights first, while every bone still exists: each vertex's weight on a merged bone goes to its joint's group.
    for o in meshes:
        groups = {g.index: g.name for g in o.vertex_groups}
        targets = {}
        for v in o.data.vertices:
            acc = {}
            for ge in v.groups:
                j = joints.get(groups.get(ge.group))
                if j and ge.weight > 0: acc[j] = acc.get(j, 0.0) + ge.weight
            targets[v.index] = acc
        for g in list(o.vertex_groups): o.vertex_groups.remove(g)
        new = {}
        for vi, acc in targets.items():
            for j, w in acc.items():
                if j in R.UNWEIGHTED: continue
                g = new.get(j) or o.vertex_groups.new(name=j); new[j] = g
                g.add([vi], min(w, 1.0), 'REPLACE')
    # Bones: keep each joint's primary bone (renamed), remove the rest, add HumanoidRootNode, set R15 parents.
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode='EDIT')
    eb = arm.data.edit_bones
    primary = {v: k for k, v in R.PRIMARY.items()}
    for b in list(eb):
        if b.name not in primary: eb.remove(b)
    for b in list(eb): b.name = primary[b.name]
    root, lower = eb['Root'], eb['LowerTorso']
    hrn = eb.new('HumanoidRootNode'); hrn.head = lower.head.copy(); hrn.tail = lower.head.copy(); hrn.tail.z += 0.1
    for name, parent in R.R15_PARENTS.items():
        b = eb[name]; b.use_connect = False; b.parent = eb[parent] if parent else None
    bpy.ops.object.mode_set(mode='OBJECT')
    for o in meshes:
        for mod in o.modifiers:
            if mod.type == 'ARMATURE': mod.object = arm
    return joints


def split_parts(arm, meshes):
    """Join the meshes, give each face to its dominant R15 part, separate, name <Part>_Geo, decimate to budget."""
    bpy.ops.object.select_all(action='DESELECT')
    for o in meshes: o.select_set(True)
    body = max(meshes, key=lambda o: len(o.data.polygons))
    bpy.context.view_layer.objects.active = body
    if len(meshes) > 1: bpy.ops.object.join()
    if body.data.shape_keys:   # CHE's 5 face morphs; a Roblox Dynamic Head uses its own FACS poses instead
        body.shape_key_clear()
    names = {g.index: g.name for g in body.vertex_groups}
    dom = []
    for v in body.data.vertices:
        best = max(((names[g.group], g.weight) for g in v.groups if g.weight > 0), key=lambda x: x[1], default=('UpperTorso', 0))
        dom.append(best[0])
    part_faces = {p: [] for p in R.PARTS}
    for f in body.data.polygons:
        votes = {}
        for vi in f.vertices: votes[dom[vi]] = votes.get(dom[vi], 0) + 1
        part_faces[max(votes, key=votes.get)].append(f.index)
    out = {}
    for part in R.PARTS:
        idx = set(part_faces[part])
        if not idx: continue
        dup = body.copy(); dup.data = body.data.copy(); bpy.context.scene.collection.objects.link(dup)
        bpy.ops.object.select_all(action='DESELECT'); dup.select_set(True); bpy.context.view_layer.objects.active = dup
        bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.select_all(action='DESELECT'); bpy.ops.object.mode_set(mode='OBJECT')
        for f in dup.data.polygons: f.select = f.index not in idx
        bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.delete(type='FACE'); bpy.ops.object.mode_set(mode='OBJECT')
        dup.name = dup.data.name = f'{part}_Geo'
        tris = sum(len(p.vertices) - 2 for p in dup.data.polygons)
        budget = R.PART_BUDGET[part]
        if tris > budget:
            mod = dup.modifiers.new('Budget', 'DECIMATE'); mod.decimate_type = 'COLLAPSE'; mod.ratio = budget / tris * 0.97
            mod.use_collapse_triangulate = True
            bpy.ops.object.modifier_move_to_index(modifier='Budget', index=0)
            bpy.ops.object.modifier_apply(modifier='Budget')
        bpy.ops.object.vertex_group_limit_total(group_select_mode='ALL', limit=R.MAX_INFLUENCES)
        bpy.ops.object.vertex_group_normalize_all(group_select_mode='BONE_DEFORM', lock_active=False)
        out[part] = dup
    bpy.data.objects.remove(body)
    return out


def measure_fbx(path):
    """Read the FBX back in a clean scene and measure what Roblox will see."""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.fbx(filepath=path, ignore_leaf_bones=False)
    sc = bpy.context.scene
    arms = [o for o in sc.objects if o.type == 'ARMATURE']
    m = {'bones': {}, 'meshes': {}, 'textures': {}, 'cages': False, 'attachments': False, 'watertight': False}
    if arms:
        a = arms[0]
        m['bones'] = {b.name: (b.parent.name if b.parent else None) for b in a.data.bones}
        m['armature_scale'] = [round(s, 5) for s in a.scale]
    for o in sc.objects:
        if o.type != 'MESH': continue
        names = {g.index: g.name for g in o.vertex_groups}
        infl = [sum(1 for g in v.groups if g.weight > 1e-4) for v in o.data.vertices]
        rootw = sum(1 for v in o.data.vertices if any(names.get(g.group) in R.UNWEIGHTED and g.weight > 1e-4 for g in v.groups))
        m['meshes'][o.name] = {'triangles': sum(len(p.vertices) - 2 for p in o.data.polygons), 'vertices': len(o.data.vertices),
                               'max_influences': max(infl, default=0), 'unweighted_vertices': sum(1 for n in infl if n == 0),
                               'root_weighted_vertices': rootw, 'scale': [round(s, 5) for s in o.scale]}
    for img in bpy.data.images:
        if img.size[0]: m['textures'][img.name] = list(img.size)
    m['actions'] = [a.name for a in bpy.data.actions]
    return m


def main(glb):
    out = os.environ.get('OUT_DIR') or os.path.dirname(os.path.abspath(glb)); os.makedirs(out, exist_ok=True)
    clip = os.environ.get('CLIP', 'walk')
    sc, arm = load(glb)
    meshes = [o for o in sc.objects if o.type == 'MESH']
    tris_in = sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in meshes)
    remap_skeleton(arm, meshes)
    parts = split_parts(arm, meshes)
    for o in parts.values():
        o.parent = arm
        if not any(md.type == 'ARMATURE' for md in o.modifiers):
            md = o.modifiers.new('Armature', 'ARMATURE'); md.object = arm
    files = {}
    bpy.ops.object.select_all(action='DESELECT')
    arm.select_set(True)
    for o in parts.values(): o.select_set(True)
    bpy.context.view_layer.objects.active = arm
    ad = arm.animation_data
    if ad:
        ad.action = None
        for tr in ad.nla_tracks: tr.mute = True
    char = os.path.join(out, 'character_r15.fbx')
    bpy.ops.export_scene.fbx(filepath=char, use_selection=True, object_types={'ARMATURE', 'MESH'}, apply_scale_options='FBX_SCALE_UNITS',
                             add_leaf_bones=False, bake_anim=False, path_mode='COPY', embed_textures=True, use_armature_deform_only=True)
    files['character'] = char
    if clip and ad:
        track = next((t for t in ad.nla_tracks if t.name == clip and t.strips), None)
        if track:
            ad.action = track.strips[0].action
            sc.frame_start, sc.frame_end = int(track.strips[0].frame_start), int(track.strips[0].frame_end)
            bpy.ops.object.select_all(action='DESELECT'); arm.select_set(True); bpy.context.view_layer.objects.active = arm
            anim = os.path.join(out, f'{clip}_r15.fbx')
            bpy.ops.export_scene.fbx(filepath=anim, use_selection=True, object_types={'ARMATURE'}, apply_scale_options='FBX_SCALE_UNITS',
                                     add_leaf_bones=False, bake_anim=True, bake_anim_use_all_actions=False, bake_anim_use_nla_strips=False,
                                     use_armature_deform_only=True)
            files['animation'] = anim
    measured = measure_fbx(char)
    verdict = R.validate(measured)
    rec = dict(verdict, triangles_in=tris_in, measured=measured,
               files={k: {'file': os.path.basename(p), 'bytes': os.path.getsize(p), 'sha256': sha256(p)} for k, p in files.items()},
               studio_path='Roblox Studio > Avatar tab > Import 3D (or File > Import 3D): choose character_r15.fbx, rig type R15.')
    rec['not_exported'] = ['face morphs (Roblox Dynamic Heads need FACS poses)', 'outer cages', '_Att attachments', 'finger and spine bends (merged into hand and torso)']
    if 'animation' in files: rec['animation_note'] = f'{clip}_r15.fbx holds the {clip} clip on the same R15 skeleton (Animation Editor > Import > From FBX).'
    print('ROBLOX_RECEIPT', json.dumps(rec), flush=True)
    return 0 if verdict['ok'] else 2


if __name__ == '__main__':
    sys.exit(main(os.path.abspath(sys.argv[-1])))

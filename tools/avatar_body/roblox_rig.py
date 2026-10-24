"""Roblox R15 rules for CHE's characters: the bone mapping from MPFB's game_engine skeleton, the per-part triangle
budgets, and the validator for what tools/avatar_body/roblox_export.py measured in the exported FBX. Pure Python (no
Blender), so the rules are unit-tested (tools/test_roblox_rig.py).

Sources (Roblox Creator Docs, github.com/Roblox/creator-docs, read 2026-10-24):
- avatar/character-bodies/specifications.md: joints Root > HumanoidRootNode > LowerTorso > UpperTorso > Head, arms and
  legs as below; 15 meshes named <Part>_Geo; triangle budget Head 4,000, torso (UpperTorso + LowerTorso) 1,750, each
  arm and each leg 1,248, total 10,742; at most 4 influences per vertex; no influence on the Root; body textures at most
  2048 x 2048; outer cages (<Part>_OuterCage) and _Att attachments are needed for layered clothing and the Marketplace.
- art/modeling/specifications.md: one mesh at most 20,000 triangles; bones frozen at scale 1 and rotation 0.
- art/modeling/texture-specifications.md: PBR maps up to 1024 x 1024; 1024 recommended for humanoid characters.
- art/modeling/export-requirements.md (Blender): Apply Scalings "FBX Unit Scale", Add Leaf Bones off, Path Mode Copy
  with Embed Textures, Bake Animation only for an animation export.
"""

R15_PARENTS = {
    'Root': None, 'HumanoidRootNode': 'Root', 'LowerTorso': 'HumanoidRootNode', 'UpperTorso': 'LowerTorso', 'Head': 'UpperTorso',
    'LeftUpperArm': 'UpperTorso', 'LeftLowerArm': 'LeftUpperArm', 'LeftHand': 'LeftLowerArm',
    'RightUpperArm': 'UpperTorso', 'RightLowerArm': 'RightUpperArm', 'RightHand': 'RightLowerArm',
    'LeftUpperLeg': 'LowerTorso', 'LeftLowerLeg': 'LeftUpperLeg', 'LeftFoot': 'LeftLowerLeg',
    'RightUpperLeg': 'LowerTorso', 'RightLowerLeg': 'RightUpperLeg', 'RightFoot': 'RightLowerLeg',
}
PARTS = [b for b in R15_PARENTS if b not in ('Root', 'HumanoidRootNode')]   # the 15 body parts, each a <Part>_Geo mesh
UNWEIGHTED = ('Root', 'HumanoidRootNode')

# The primary MPFB bone for each R15 joint (its head becomes the joint), then every MPFB bone merged into a joint: its
# skin weights are added to that joint's, and the bone itself is removed. HumanoidRootNode is new (at the pelvis).
PRIMARY = {'Root': 'Root', 'LowerTorso': 'pelvis', 'UpperTorso': 'spine_01', 'Head': 'neck_01',
           'LeftUpperArm': 'upperarm_l', 'LeftLowerArm': 'lowerarm_l', 'LeftHand': 'hand_l',
           'RightUpperArm': 'upperarm_r', 'RightLowerArm': 'lowerarm_r', 'RightHand': 'hand_r',
           'LeftUpperLeg': 'thigh_l', 'LeftLowerLeg': 'calf_l', 'LeftFoot': 'foot_l',
           'RightUpperLeg': 'thigh_r', 'RightLowerLeg': 'calf_r', 'RightFoot': 'foot_r'}
FINGERS = ('thumb', 'index', 'middle', 'ring', 'pinky')


def r15_for(bone):
    """The R15 joint an MPFB game_engine bone belongs to, or None for a bone this mapping does not know."""
    for joint, primary in PRIMARY.items():
        if bone == primary: return joint
    if bone in ('spine_02', 'spine_03', 'clavicle_l', 'clavicle_r'): return 'UpperTorso'
    if bone == 'head': return 'Head'
    if bone in ('ball_l', 'ball_r'): return 'LeftFoot' if bone.endswith('_l') else 'RightFoot'
    for f in FINGERS:
        for k in ('01', '02', '03'):
            if bone == f'{f}_{k}_l': return 'LeftHand'
            if bone == f'{f}_{k}_r': return 'RightHand'
    return None


def mapping(bones):
    """{mpfb bone: r15 joint} for every bone; raises ValueError naming any bone without a joint."""
    out, unknown = {}, []
    for b in bones:
        j = r15_for(b)
        (out.__setitem__(b, j) if j else unknown.append(b))
    if unknown: raise ValueError(f'no R15 joint for bones {sorted(unknown)}')
    return out


# Triangle budgets: Roblox's per-group limits, split across a group's parts so the group total holds.
GROUP_BUDGET = {'Head': 4000, 'Torso': 1750, 'LeftArm': 1248, 'RightArm': 1248, 'LeftLeg': 1248, 'RightLeg': 1248}
TOTAL_BUDGET = 10742
MESH_MAX = 20000
GROUP_OF = {'Head': 'Head', 'UpperTorso': 'Torso', 'LowerTorso': 'Torso'}
for side in ('Left', 'Right'):
    for p in ('UpperArm', 'LowerArm', 'Hand'): GROUP_OF[side + p] = side + 'Arm'
    for p in ('UpperLeg', 'LowerLeg', 'Foot'): GROUP_OF[side + p] = side + 'Leg'
PART_BUDGET = {'Head': 4000, 'UpperTorso': 1000, 'LowerTorso': 750}
for side in ('Left', 'Right'):
    PART_BUDGET.update({side + 'UpperArm': 450, side + 'LowerArm': 450, side + 'Hand': 348,
                        side + 'UpperLeg': 500, side + 'LowerLeg': 450, side + 'Foot': 298})
MAX_INFLUENCES = 4
TEXTURE_MAX = 1024           # CHE's limit: Roblox's PBR budget and its recommendation for humanoid characters
TEXTURE_HARD_MAX = 2048      # Roblox's Marketplace body maximum


def validate(m):
    """Check a measured export (roblox_export.py's manifest) against the rules above. Returns
    {ok, studio_import_ready, marketplace_ready, failures, warnings, triangles_total, groups}. ok and studio_import_ready
    mean every hard rule holds; marketplace_ready also needs cages and attachments, which CHE does not build yet."""
    fails, warns = [], []
    bones = m.get('bones') or {}
    for b, parent in R15_PARENTS.items():
        if b not in bones: fails.append(f'missing joint {b}')
        elif (bones[b] or None) != parent: fails.append(f'joint {b} has parent {bones[b]!r}, expected {parent!r}')
    extra = sorted(set(bones) - set(R15_PARENTS))
    if extra: fails.append(f'joints outside R15: {extra[:8]}')
    meshes = m.get('meshes') or {}
    groups = {g: 0 for g in GROUP_BUDGET}; total = 0
    for part in PARTS:
        info = meshes.get(f'{part}_Geo')
        if not info: fails.append(f'missing mesh {part}_Geo'); continue
        t = int(info.get('triangles', 0)); total += t; groups[GROUP_OF[part]] += t
        if t <= 0: fails.append(f'{part}_Geo has no triangles')
        if t > MESH_MAX: fails.append(f'{part}_Geo has {t} triangles, over the {MESH_MAX} per-mesh limit')
        if int(info.get('max_influences', 0)) > MAX_INFLUENCES: fails.append(f'{part}_Geo has vertices with {info["max_influences"]} influences (max {MAX_INFLUENCES})')
        if int(info.get('unweighted_vertices', 0)) > 0: warns.append(f'{part}_Geo has {info["unweighted_vertices"]} vertices with no skin weight')
        if int(info.get('root_weighted_vertices', 0)) > 0: fails.append(f'{part}_Geo has {info["root_weighted_vertices"]} vertices weighted to the Root')
        if any(abs(float(s) - 1.0) > 1e-4 for s in info.get('scale', (1, 1, 1))): fails.append(f'{part}_Geo is not at scale 1')
    extra_m = sorted(k for k in meshes if k not in {f'{p}_Geo' for p in PARTS})
    if extra_m: fails.append(f'meshes outside R15: {extra_m[:8]}')
    for g, t in groups.items():
        if t > GROUP_BUDGET[g]: fails.append(f'{g} has {t} triangles, over its {GROUP_BUDGET[g]} budget')
    if total > TOTAL_BUDGET: fails.append(f'{total} triangles in all, over the {TOTAL_BUDGET} body budget')
    for name, (w, h) in (m.get('textures') or {}).items():
        if max(w, h) > TEXTURE_HARD_MAX: fails.append(f'texture {name} is {w}x{h}, over {TEXTURE_HARD_MAX}')
        elif max(w, h) > TEXTURE_MAX: warns.append(f'texture {name} is {w}x{h}; Roblox reduces maps over {TEXTURE_MAX}')
    if any(abs(float(s) - 1.0) > 1e-4 for s in m.get('armature_scale', (1, 1, 1))): fails.append('the armature is not at scale 1')
    market = []
    if not m.get('cages'): market.append('no _OuterCage meshes (layered clothing cannot be fitted)')
    if not m.get('attachments'): market.append('no _Att attachments (accessories cannot be attached)')
    if not m.get('watertight'): market.append('the parts are cut from one body and are not capped (Marketplace bodies must be watertight)')
    ok = not fails
    return {'ok': ok, 'studio_import_ready': ok, 'marketplace_ready': ok and not market, 'failures': fails, 'warnings': warns,
            'marketplace_missing': market, 'triangles_total': total, 'groups': groups}

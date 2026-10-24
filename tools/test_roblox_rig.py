"""Roblox R15 rules (tools/avatar_body/roblox_rig.py): the MPFB bone mapping and the validator, without Blender.
  python3 -m pytest tools/test_roblox_rig.py   (or python3 tools/test_roblox_rig.py)"""
import copy
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'avatar_body'))
import roblox_rig as R  # noqa: E402

# MPFB's game_engine skeleton: the 53 bones CHE's characters carry (rig.game_engine.json at MPFB commit b1a2dc98).
MPFB_53 = ['Root', 'pelvis', 'spine_01', 'spine_02', 'spine_03', 'neck_01', 'head', 'clavicle_l', 'clavicle_r',
           'upperarm_l', 'upperarm_r', 'lowerarm_l', 'lowerarm_r', 'hand_l', 'hand_r', 'thigh_l', 'thigh_r',
           'calf_l', 'calf_r', 'foot_l', 'foot_r', 'ball_l', 'ball_r'] + [
    f'{f}_{k}_{s}' for f in ('thumb', 'index', 'middle', 'ring', 'pinky') for k in ('01', '02', '03') for s in ('l', 'r')]


def good():
    """What roblox_export.py measured in its real export of CHE's body on 2026-10-24 (9,934 triangles)."""
    tris = {'Head': 3880, 'UpperTorso': 970, 'LowerTorso': 372, 'LeftUpperArm': 435, 'LeftLowerArm': 436, 'LeftHand': 337,
            'RightUpperArm': 435, 'RightLowerArm': 436, 'RightHand': 337, 'LeftUpperLeg': 484, 'LeftLowerLeg': 429,
            'LeftFoot': 236, 'RightUpperLeg': 484, 'RightLowerLeg': 429, 'RightFoot': 234}
    return {'bones': dict(R.R15_PARENTS), 'armature_scale': [1, 1, 1], 'textures': {},
            'meshes': {f'{p}_Geo': {'triangles': t, 'max_influences': 3, 'unweighted_vertices': 0, 'root_weighted_vertices': 0,
                                    'scale': [1, 1, 1]} for p, t in tris.items()}}


class Mapping(unittest.TestCase):
    def test_every_mpfb_bone_has_a_joint_and_every_joint_a_primary(self):
        self.assertEqual(len(MPFB_53), 53)
        m = R.mapping(MPFB_53)
        self.assertEqual(set(m.values()), set(R.R15_PARENTS) - {'HumanoidRootNode'})
        for joint, primary in R.PRIMARY.items(): self.assertEqual(m[primary], joint)
        self.assertEqual(m['index_03_l'], 'LeftHand'); self.assertEqual(m['ball_r'], 'RightFoot')
        self.assertEqual(m['spine_03'], 'UpperTorso'); self.assertEqual(m['head'], 'Head')

    def test_an_unknown_bone_is_an_error_not_a_guess(self):
        with self.assertRaises(ValueError): R.mapping(MPFB_53 + ['tail_01'])

    def test_budgets_match_roblox(self):
        self.assertEqual(sum(R.GROUP_BUDGET.values()), R.TOTAL_BUDGET)
        for g, budget in R.GROUP_BUDGET.items():
            self.assertLessEqual(sum(R.PART_BUDGET[p] for p in R.PARTS if R.GROUP_OF[p] == g), budget, g)
        self.assertEqual(len(R.PARTS), 15)


class Validate(unittest.TestCase):
    def test_the_real_export_passes_and_is_not_called_marketplace_ready(self):
        v = R.validate(good())
        self.assertTrue(v['ok'], v['failures']); self.assertTrue(v['studio_import_ready'])
        self.assertFalse(v['marketplace_ready']); self.assertEqual(len(v['marketplace_missing']), 3)
        self.assertEqual(v['triangles_total'], 9934)

    def test_each_hard_rule_fails_on_its_own(self):
        cases = {
            'over its 1248 budget': lambda m: m['meshes']['LeftHand_Geo'].update(triangles=900),
            'missing joint HumanoidRootNode': lambda m: m['bones'].pop('HumanoidRootNode'),
            "parent 'Root'": lambda m: m['bones'].update(LowerTorso='Root'),
            'weighted to the Root': lambda m: m['meshes']['Head_Geo'].update(root_weighted_vertices=12),
            'influences': lambda m: m['meshes']['UpperTorso_Geo'].update(max_influences=5),
            'missing mesh RightFoot_Geo': lambda m: m['meshes'].pop('RightFoot_Geo'),
            'over 2048': lambda m: m['textures'].update(skin=[4096, 4096]),
            'not at scale 1': lambda m: m['meshes']['Head_Geo'].update(scale=[0.01, 0.01, 0.01]),
            'joints outside R15': lambda m: m['bones'].update(index_01_l='LeftHand'),
            'per-mesh limit': lambda m: m['meshes']['Head_Geo'].update(triangles=20001),
        }
        for want, change in cases.items():
            m = copy.deepcopy(good()); change(m); v = R.validate(m)
            self.assertFalse(v['ok'], want)
            self.assertTrue(any(want in f for f in v['failures']), (want, v['failures']))

    def test_a_large_texture_under_the_hard_limit_is_a_warning(self):
        m = good(); m['textures'] = {'skin': [2048, 2048]}
        v = R.validate(m)
        self.assertTrue(v['ok']); self.assertTrue(any('2048x2048' in w for w in v['warnings']))


if __name__ == '__main__':
    unittest.main()

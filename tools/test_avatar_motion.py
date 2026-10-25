"""Tests for CHE's movement clip library (tools/avatar_motion): BVH parsing and FK, quaternions, retargeting onto a
rig, foot locking, blending, the clip manifest, and (with bpy, MPFB2 and the cached clips) the real skeleton.

  python3 -m unittest discover -s tools -p 'test_avatar_motion.py'
The Blender test runs only where `import bpy` works and MPFB2 data and the clip cache exist (CHE_MOTION_CACHE);
elsewhere it is skipped and says why.
"""
import json
import os
import sys
import unittest

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, 'avatar_motion'))
import blend as B  # noqa: E402
import bvh  # noqa: E402
import quat as Q  # noqa: E402
import retarget as RT  # noqa: E402

TINY = """HIERARCHY
ROOT Hips
{
 OFFSET 0 0 0
 CHANNELS 6 Xposition Yposition Zposition Zrotation Yrotation Xrotation
 JOINT Spine
 {
  OFFSET 0 2 0
  CHANNELS 3 Zrotation Yrotation Xrotation
  End Site
  {
   OFFSET 0 1 0
  }
 }
}
MOTION
Frames: 2
Frame Time: 0.5
0 10 0 0 0 0 0 0 0
1 10 0 0 0 0 90 0 0
"""


def two_bone_rig():
    """A small Blender-axes rig: root, pelvis up, a leg (thigh, calf, foot, ball) on each side."""
    bones = []

    def add(name, parent, head, tail):
        d = np.array(tail, float) - np.array(head, float); d /= np.linalg.norm(d)
        # rest matrix: Y axis along the bone (Blender convention), any orthonormal completion
        y = d; x = np.cross(y, [0, 0, 1.0]) if abs(y[2]) < 0.9 else np.cross(y, [1.0, 0, 0]); x /= np.linalg.norm(x); z = np.cross(x, y)
        bones.append({'name': name, 'parent': parent, 'head': head, 'tail': tail, 'matrix': np.stack([x, y, z], 1).tolist()})
    add('Root', None, [0, 0, 0], [0, 0.03, 0])
    add('pelvis', 'Root', [0, 0, 0.9], [0, 0, 1.0])
    for s, x in (('l', 0.1), ('r', -0.1)):
        add(f'thigh_{s}', 'pelvis', [x, 0, 0.88], [x, 0, 0.48])
        add(f'calf_{s}', f'thigh_{s}', [x, 0, 0.48], [x, 0, 0.08])
        add(f'foot_{s}', f'calf_{s}', [x, 0, 0.08], [x, -0.12, 0.01])
        add(f'ball_{s}', f'foot_{s}', [x, -0.12, 0.01], [x, -0.18, 0.01])
    return RT.Rig(bones)


class BvhTest(unittest.TestCase):
    def test_parse_and_fk(self):
        J, M, ft = bvh.parse(TINY)
        self.assertEqual([j.name for j in J], ['Hips', 'Spine']); self.assertEqual(M.shape, (2, 9)); self.assertEqual(ft, 0.5)
        W, P = bvh.fk(J, M)
        np.testing.assert_allclose(P[0, 1], [0, 12, 0])           # spine 2 above hips at y=10
        np.testing.assert_allclose(P[1, 1], [1, 12, 0], atol=1e-9)  # root moved 1 in x
        ends = bvh.end_positions(J, W, P)
        np.testing.assert_allclose(ends['Spine'][1], [0, 12, 0], atol=1e-9)   # spine turned 90 deg about Z: +Y -> -X
        R, Pb = bvh.to_blender(W, P)
        np.testing.assert_allclose(Pb[0, 1], [0, 0, 12], atol=1e-9)   # BVH up (Y) is Blender up (Z)

    def test_resample(self):
        idx = bvh.resample_index(121, 1 / 120, 1 / 30)
        self.assertEqual(len(idx), 31); self.assertAlmostEqual(idx[-1], 120)


class QuatTest(unittest.TestCase):
    def test_roundtrip_and_slerp(self):
        rng = np.random.default_rng(0)
        q = rng.normal(size=(50, 4)); q /= np.linalg.norm(q, axis=1, keepdims=True)
        q2 = Q.from_matrix(Q.to_matrix(q))
        self.assertTrue(np.allclose(np.abs(np.sum(q * q2, 1)), 1, atol=1e-9))
        a = Q.from_matrix(np.eye(3)); b = Q.from_matrix(Q.axis_angle((0, 0, 1), np.pi / 2))
        mid = Q.to_matrix(Q.slerp(a, b, 0.5))
        np.testing.assert_allclose(mid, Q.axis_angle((0, 0, 1), np.pi / 4), atol=1e-9)
        np.testing.assert_allclose(Q.arc([1, 0, 0], [0, 1, 0]) @ [1, 0, 0], [0, 1, 0], atol=1e-12)


class RetargetTest(unittest.TestCase):
    def test_fk_consistency_and_ik(self):
        rig = two_bone_rig()
        F = 3
        local = {n: np.tile(np.eye(3), (F, 1, 1)) for n in rig.names}
        G, H, T = RT.pose_world(rig, local, np.zeros((F, 3)))
        for n in rig.names: np.testing.assert_allclose(H[n][0], rig.head[n], atol=1e-12)
        np.testing.assert_allclose(T['calf_l'][0], rig.tail['calf_l'], atol=1e-12)
        back = RT.local_from_world(rig, G)
        for n in rig.names: np.testing.assert_allclose(back[n], local[n], atol=1e-12)
        k = RT.two_bone_ik(np.array([0, 0, 1.0]), np.array([0, -0.1, 0.5]), np.array([0, 0, 0.0]), np.array([0, 0, 0.3]), 0.5, 0.5)
        self.assertAlmostEqual(np.linalg.norm(k - [0, 0, 1.0]), 0.5, places=9)
        self.assertAlmostEqual(np.linalg.norm(k - [0, 0, 0.3]), 0.5, places=9)
        self.assertLess(k[1], 0)   # bends forward, as the original knee did

    def test_foot_lock_removes_slip(self):
        rig = two_bone_rig()
        F = 40
        local = {n: np.tile(np.eye(3), (F, 1, 1)) for n in rig.names}
        root = np.zeros((F, 3)); root[:, 1] = np.linspace(0, 0.04, F); root[:, 2] = -0.02   # whole body drifts 4 cm: feet slide
        root_loc = root @ rig.rest['pelvis']
        new, rep = RT.foot_lock(rig, local, root_loc, fps=30)
        self.assertGreater(rep['l']['slip_before_mm'], 30)
        self.assertLess(rep['l']['slip_after_mm'], 2)
        self.assertLess(rep['r']['slip_after_mm'], 2)


class BlendTest(unittest.TestCase):
    def clip(self, name, F, yaw_deg, dx):
        rig = two_bone_rig()
        q = {n: np.tile([1.0, 0, 0, 0], (F, 1)) for n in rig.names}
        Rz = Q.axis_angle((0, 0, 1), np.radians(yaw_deg)); R = rig.rest['pelvis']
        q['pelvis'] = np.tile(Q.from_matrix(R.T @ Rz @ R), (F, 1))
        root = np.zeros((F, 3)); root[:, 0] = np.linspace(0, dx, F)
        return rig, B.Clip(name, q, root, 30)

    def test_crossfade_aligns_and_blends(self):
        rig, a = self.clip('a', 30, 0, 1.0)
        _, b = self.clip('b', 30, 90, 0.5)
        c = B.crossfade(rig, a, b, 10)
        self.assertEqual(c.frames, 50)
        self.assertAlmostEqual(B.heading(rig, c, 0), 0, places=6)
        self.assertAlmostEqual(B.heading(rig, c, 49), B.heading(rig, a, 29), places=6)   # b turned to a's heading
        steps = np.linalg.norm(np.diff(c.root, axis=0), axis=1)
        self.assertLess(steps.max(), 0.06)   # no jump at the transition

    def test_layer_and_breathing(self):
        rig, a = self.clip('a', 20, 0, 0)
        _, b = self.clip('b', 20, 45, 0)
        L = B.layer(a, b, bones=('pelvis',))
        np.testing.assert_allclose(L.q['pelvis'], b.q['pelvis'])
        rig2 = two_bone_rig()
        br = B.additive(a, 'pelvis', (1, 0, 0), np.full(20, 2.0))
        self.assertGreater(np.abs(br.q['pelvis'] - a.q['pelvis']).max(), 0.01)
        self.assertEqual(B.resample(a, 15).frames, 10)
        del rig2


class ManifestTest(unittest.TestCase):
    def test_manifest(self):
        m = json.load(open(os.path.join(HERE, 'avatar_motion', 'clips.json')))
        self.assertIn('commercial', m['sources']['cmu']['licence'])
        self.assertIn('09a07f54f3bbb58797325f009282d0b2048a2871', m['sources']['cmu']['mirror'])
        for fid, f in m['files'].items():
            self.assertRegex(f['sha256'], r'^[0-9a-f]{64}$')
        for name, c in m['clips'].items():
            self.assertIn(c['file'], m['files'], name)
            self.assertLess(c['frames'][0], c['frames'][1])
            self.assertGreaterEqual(c['frames'][0], 1, 'frame 0 is the T-pose reference, never a clip frame')
        for need in ('walk_in_turn', 'walk_turn_sit', 'sit_down', 'seated_idle', 'seated_gesture', 'talk_gesture', 'turn_in_place'):
            self.assertIn(need, m['clips'])


def _blender_ready():
    try:
        import bpy  # noqa: F401
    except ImportError:
        return 'bpy is not importable here'
    mpfb = os.environ.get('MPFB', '')
    if not os.path.isdir(os.path.join(mpfb, 'rigs')): return 'MPFB data (env MPFB) is not available'
    sys.path.insert(0, os.path.join(HERE, 'avatar_motion'))
    import library
    for fid in ('86_15', '16_17'):
        p = os.path.join(library.cache_dir(), f'{fid}.bvh')
        if not os.path.exists(p): return f'clip cache has no {fid}.bvh (run tools/avatar_motion/library.py --fetch)'
    return ''


@unittest.skipIf(_blender_ready(), _blender_ready() or 'ready')
class SkeletonTest(unittest.TestCase):
    def test_clips_on_real_skeleton(self):
        sys.path.insert(0, os.path.join(HERE, 'cinematic'))
        import character
        import blender_rig
        import library
        import bpy
        c = character.build(character.identity_env('che'))
        arm = c['arm']
        before = [b.name for b in arm.data.bones]
        self.assertEqual(len(before), 53)
        rig = blender_rig.rig_from_armature(arm)
        for name in ('walk_turn_sit', 'walk_in_turn'):
            clip, rep = library.build(name, rig, fps=24)
            act = blender_rig.write_clip(arm, rig, clip)
            self.assertLess(rep['foot_lock']['l']['slip_after_mm'], 30)
            arm.animation_data.action = act
            sc = bpy.context.scene
            sc.frame_set(0); p0 = (arm.matrix_world @ arm.pose.bones['pelvis'].head).copy()
            sc.frame_set(clip.frames - 1); p1 = (arm.matrix_world @ arm.pose.bones['pelvis'].head).copy()
            self.assertGreater((p1 - p0).length, 0.5, f'{name}: the pelvis travels')
            arm.animation_data.action = None
        self.assertEqual([b.name for b in arm.data.bones], before)   # bone names and count unchanged
        tracks = [t.name for t in arm.animation_data.nla_tracks]
        for orig in ('idle', 'walk', 'run', 'wave', 'talk', 'walk_turn_sit', 'walk_in_turn'): self.assertIn(orig, tracks)


if __name__ == '__main__':
    unittest.main()

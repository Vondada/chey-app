"""verify_glb.py's planted-foot slide check, on small hand-made GLBs (numpy only, no Blender).

  python3 -m unittest discover -s tools -p 'test_avatar_body_verify.py'

A walk clip whose planted foot moves back at exactly its declared ground speed passes; the same clip without the
declared speed, with a wrong speed, or with a foot that drifts sideways while planted fails; a foot that is planted for
only a frame or two fails; the frame pair across the loop seam is not counted as slide.
"""
import json
import os
import struct
import sys
import tempfile
import unittest

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'avatar_body'))
import verify_glb  # noqa: E402

FPS = 30


def foot_track(frames, duty, step, phase, lift=0.1, drift=0.0, ankle=(0.1, 0.08, 0.0)):
    """Ankle positions (glTF: Y up, forward +Z) of an in-place cycle: planted for `duty` of it, moving back (-Z) by
    `step`; `drift` metres of sideways (X) creep while planted."""
    out = []
    for f in range(frames + 1):
        u = (f / frames + phase) % 1.0
        if u < duty:
            k = u / duty
            out.append((ankle[0] + drift * k, ankle[1], ankle[2] + step / 2 - step * k))
        else:
            # Swing: forward on a Hermite curve whose end speeds equal the planted speed (as mpfb_body.py's gait), so
            # the frames just after lift-off, still under 1.5 cm, do not flick forward.
            w = (u - duty) / (1 - duty); m = -step * (1 - duty) / duty
            z = (2 * w ** 3 - 3 * w ** 2 + 1) * -step / 2 + (w ** 3 - 2 * w ** 2 + w) * m \
                + (-2 * w ** 3 + 3 * w ** 2) * step / 2 + (w ** 3 - w ** 2) * m
            out.append((ankle[0] + drift * (1 - w), ankle[1] + lift * np.sin(np.pi * w), ankle[2] + z))
    return np.array(out, np.float32)


def write_glb(path, clips):
    """clips: {name: (tracks {node_name: (N, 3) translations}, extras or None)}; nodes pelvis > foot_l, foot_r."""
    names = ['pelvis', 'foot_l', 'foot_r']
    blob = bytearray(); views = []; accs = []

    def add(arr, typ, minmax=False):
        arr = np.ascontiguousarray(arr, np.float32)
        views.append({'buffer': 0, 'byteOffset': len(blob), 'byteLength': arr.nbytes})
        blob.extend(arr.tobytes()); blob.extend(b'\0' * (-len(blob) % 4))
        a = {'bufferView': len(views) - 1, 'componentType': 5126, 'count': len(arr), 'type': typ}
        if minmax: a.update(min=[float(arr.min())], max=[float(arr.max())])
        accs.append(a)
        return len(accs) - 1
    ibm = add(np.tile(np.eye(4, dtype=np.float32).T.reshape(1, 16), (3, 1)), 'MAT4')
    anims = []
    for name, (tracks, extras) in clips.items():
        n = len(next(iter(tracks.values())))
        t = add(np.arange(n, dtype=np.float32).reshape(-1, 1) / FPS, 'SCALAR', minmax=True)
        samplers, channels = [], []
        for node, xyz in tracks.items():
            samplers.append({'input': t, 'output': add(xyz, 'VEC3'), 'interpolation': 'LINEAR'})
            channels.append({'sampler': len(samplers) - 1, 'target': {'node': names.index(node), 'path': 'translation'}})
        anim = {'name': name, 'samplers': samplers, 'channels': channels}
        if extras: anim['extras'] = extras
        anims.append(anim)
    gl = {'asset': {'version': '2.0'}, 'scene': 0, 'scenes': [{'nodes': [0]}],
          'nodes': [{'name': 'pelvis', 'children': [1, 2]}, {'name': 'foot_l'}, {'name': 'foot_r'}],
          'skins': [{'joints': [0, 1, 2], 'inverseBindMatrices': ibm}],
          'accessors': accs, 'bufferViews': views, 'buffers': [{'byteLength': len(blob)}], 'animations': anims}
    js = json.dumps(gl).encode(); js += b' ' * (-len(js) % 4)
    with open(path, 'wb') as f:
        f.write(struct.pack('<4sII', b'glTF', 2, 12 + 8 + len(js) + 8 + len(blob)))
        f.write(struct.pack('<I4s', len(js), b'JSON') + js + struct.pack('<I4s', len(blob), b'BIN\0') + bytes(blob))


def walk(frames=30, duty=0.62, step=0.62, drift=0.0, seam_phase=0.0):
    return {'foot_l': foot_track(frames, duty, step, seam_phase, drift=drift),
            'foot_r': foot_track(frames, duty, step, seam_phase + 0.5, drift=drift)}


SPEED = 0.62 / (0.62 * 1.0)   # step / (duty * cycle seconds)
DECLARED = {'ground_speed_mps': SPEED, 'forward': [0.0, 0.0, 1.0], 'in_place': True}


class SlideCheck(unittest.TestCase):
    def receipt(self, clips):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, 'm.glb'); write_glb(p, clips)
            return verify_glb.verify(p, expect_bones=3, clips=list(clips), morphs=())

    def slide_failures(self, rec):
        return [f for f in rec['failures'] if 'slides' in f or 'planted' in f]

    def test_a_planted_foot_moving_back_at_the_declared_speed_does_not_slide(self):
        rec = self.receipt({'walk': (walk(), DECLARED)})
        w = rec['motion']['walk']
        self.assertEqual(self.slide_failures(rec), [])
        self.assertLess(w['foot_l_stance_slide_m'], 0.005); self.assertLess(w['foot_r_stance_slide_m'], 0.005)
        self.assertGreater(w['foot_l_stance_travel_m'], 0.5, 'the raw in-clip travel is still reported')
        self.assertEqual(rec['clips']['walk']['ground_speed_mps'], round(SPEED, 4))

    def test_the_same_in_place_clip_without_a_declared_speed_fails_as_sliding(self):
        rec = self.receipt({'walk': (walk(), None)})
        self.assertTrue(any('walk: planted foot_l slides' in f for f in rec['failures']), rec['failures'])
        self.assertFalse(rec['ok'])

    def test_a_declared_speed_the_feet_do_not_match_fails(self):
        rec = self.receipt({'walk': (walk(), dict(DECLARED, ground_speed_mps=SPEED * 0.7))})
        self.assertTrue(any('walk: planted foot_r slides' in f for f in rec['failures']), rec['failures'])

    def test_a_planted_foot_creeping_sideways_fails(self):
        rec = self.receipt({'walk': (walk(drift=0.08), DECLARED)})
        self.assertTrue(any('slides' in f for f in rec['failures']), rec['failures'])

    def test_a_foot_on_the_floor_for_only_a_frame_or_two_is_not_a_planted_gait(self):
        rec = self.receipt({'walk': (walk(duty=0.1, step=0.1), dict(DECLARED, ground_speed_mps=1.0))})
        self.assertTrue(any('walk: foot_l is planted' in f for f in rec['failures']), rec['failures'])

    def test_the_loop_seam_is_not_counted_as_slide(self):
        # The left foot is planted across the end and the start of the cycle (frames 27..30 and 0..15).
        rec = self.receipt({'walk': (walk(seam_phase=0.1), DECLARED)})
        self.assertEqual(self.slide_failures(rec), [])
        self.assertLess(rec['motion']['walk']['foot_l_stance_slide_m'], 0.005)

    def test_a_still_foot_in_a_clip_with_no_speed_does_not_slide(self):
        still = np.tile(np.array([[0.1, 0.08, 0.0]], np.float32), (31, 1))
        rec = self.receipt({'idle': ({'foot_l': still, 'foot_r': still * [-1, 1, 1]}, None)})
        self.assertEqual(rec['motion']['idle']['foot_l_stance_slide_m'], 0.0)
        self.assertEqual(self.slide_failures(rec), [])


if __name__ == '__main__':
    unittest.main()

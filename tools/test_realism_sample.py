"""Tests for the realism sample pipeline (tools/cinematic): clip blending at the crossfade seam, the foot-contact
check, viseme timing measured against the line's audio, render sharding and the shard merge before muxing.

  python3 -m unittest tools/test_realism_sample.py

Pure numpy; no Blender. The tests on the real timeline need the cached CMU clips (CHE_MOTION_CACHE, fetched by
`python3 tools/avatar_motion/library.py --fetch`) and are skipped, saying why, where they are absent. The Rhubarb
re-run test needs the Rhubarb binary (CHE_RHUBARB).
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
import wave

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
for p in ('avatar_motion', 'avatar_facial', 'cinematic'):
    sys.path.insert(0, os.path.join(HERE, p))

import blend as B  # noqa: E402
import face_anim as FA  # noqa: E402
import library  # noqa: E402
import mux  # noqa: E402
import quat as Q  # noqa: E402
import retarget as RT  # noqa: E402
import timeline as TL  # noqa: E402

ASSETS = os.path.join(HERE, 'cinematic', 'assets')
RIG = os.path.join(HERE, 'fixtures', 'motion', 'che_rig53.json')


def clips_cached():
    m = library.manifest()
    need = {m['clips'][k]['file'] for k in ('walk_turn_sit', 'seated_gesture')}
    d = os.environ.get('CHE_MOTION_CACHE') or os.path.join(os.path.expanduser('~'), '.cache', 'che-motion')
    missing = [f for f in need if not os.path.exists(os.path.join(d, f + '.bvh'))]
    return f'CMU clips not cached in {d} ({", ".join(missing)}); run tools/avatar_motion/library.py --fetch' if missing else ''


def load_rig():
    with open(RIG) as f: return RT.Rig(json.load(f))


class ContactCheckTest(unittest.TestCase):
    """retarget.contact_slip: the foot-contact check run on finished motion."""

    def walk_feet(self, F=60, fps=30.0):
        heel = np.zeros((F, 3)); heel[:, 2] = 0.08; ball = heel + [0, -0.14, -0.06]
        return heel, ball

    def test_planted_foot_has_no_slip(self):
        heel, ball = self.walk_feet()
        r = RT.contact_slip(heel, ball, 30)
        self.assertEqual(r['segments'], 1); self.assertEqual(r['max_slip_mm'], 0.0)

    def test_gliding_foot_is_measured(self):
        heel, ball = self.walk_feet()
        glide = np.linspace(0, 0.06, 60)[:, None] * [1, 0, 0]   # 6 cm over 2 s: slow enough to count as contact
        r = RT.contact_slip(heel + glide, ball + glide, 30)
        self.assertAlmostEqual(r['max_slip_mm'], 60.0, delta=1.5)

    def test_heel_roll_over_a_planted_ball_is_not_slip(self):
        heel, ball = self.walk_feet()
        lift = np.clip(np.linspace(-0.5, 1.0, 60), 0, 1) * 0.05   # the heel rises 5 cm, the ball stays put
        heel2 = heel.copy(); heel2[:, 2] += lift; heel2[:, 1] += lift * 0.4   # and the heel swings forward a little
        r = RT.contact_slip(heel2, ball, 30)
        self.assertLess(r['max_slip_mm'], 0.4 * 15 + 0.5)   # only the heel's drift inside the 15 mm touch band counts

    def test_steps_in_the_air_are_not_contacts(self):
        heel, ball = self.walk_feet()
        heel[:, 2] += np.r_[np.zeros(20), np.full(20, 0.2), np.zeros(20)]
        ball[:, 2] += np.r_[np.zeros(20), np.full(20, 0.2), np.zeros(20)]
        heel[40:, 0] += 0.4; ball[40:, 0] += 0.4   # the foot lands somewhere else
        r = RT.contact_slip(heel, ball, 30)
        self.assertEqual(r['segments'], 2); self.assertEqual(r['max_slip_mm'], 0.0)


class BlendSeamTest(unittest.TestCase):
    def test_crossfade_has_no_pop(self):
        """Two constant poses 60 degrees apart: the per-frame step inside the fade stays near the smoothstep's slope
        (1.5 x angle / frames) and is zero outside it."""
        rig = load_rig()
        F, fade = 40, 12
        qa = {k: np.tile([1.0, 0, 0, 0], (F, 1)) for k in rig.names}
        qb = {k: v.copy() for k, v in qa.items()}
        qb['upperarm_l'] = np.tile(Q.from_matrix(Q.axis_angle((0, 0, 1), np.radians(60))), (F, 1))
        a = B.Clip('a', qa, np.zeros((F, 3)), 24); b = B.Clip('b', qb, np.zeros((F, 3)), 24)
        seq = B.crossfade(rig, a, b, fade)
        sp = TL.angular_speed(seq, ['upperarm_l'])['upperarm_l']
        s = F - fade
        self.assertLess(sp.max(), 1.5 * 60 / fade + 0.5)
        self.assertLess(sp[:s].max(), 1e-6); self.assertLess(sp[s + fade + 1:].max(), 1e-6)
        r = TL.seam_report(seq, s, s + fade, bones=('upperarm_l',))
        self.assertGreater(r['max_step_deg'], 0)

    def test_shard_ranges_cover_every_frame_once(self):
        for n, N in ((426, 6), (7, 3), (5, 5), (100, 1)):
            got = [f for k in range(N) for f in TL.shard_range(n, k, N)]
            self.assertEqual(got, list(range(n)))
        with self.assertRaises(ValueError): TL.shard_range(10, 3, 3)


@unittest.skipIf(clips_cached(), clips_cached() or 'ready')
class RealTimelineTest(unittest.TestCase):
    """The sample's actual timeline on CHE's real 53-bone rest skeleton."""

    @classmethod
    def setUpClass(cls):
        cls.rig = load_rig()
        cls.tl = TL.build(cls.rig, fps=24)

    def test_length_and_seat(self):
        r = self.tl.report
        self.assertTrue(15.0 <= r['seconds'] <= 20.0, r['seconds'])
        self.assertTrue(0.4 < self.tl.seat_top < 0.6, self.tl.seat_top)   # a chair-height seat under her hips
        np.testing.assert_allclose(self.tl.hips[:2], TL.SEAT_XY, atol=0.05)

    def test_crossfade_seam_is_smooth(self):
        seam = self.tl.report['seam']
        self.assertLess(seam['ratio'], 1.0, seam)   # no bone turns faster at the seam than the mocap does elsewhere
        self.assertLess(seam['root_speed_max_ms'], seam['root_speed_p99_elsewhere_ms'] + 0.05, seam)

    def test_walk_steps_do_not_slide(self):
        c = self.tl.clip
        _, H, _ = RT.pose_world(self.rig, {k: Q.to_matrix(v) for k, v in c.q.items()}, c.root_loc(self.rig))
        walk_end = int(4.8 * c.fps)   # before the turn-and-sit
        for s in 'lr':
            r = RT.contact_slip(H[f'foot_{s}'], H[f'ball_{s}'], c.fps)
            steps = [mm for mm, (a, b) in zip(r['per_segment_mm'], r['segment_frames']) if b <= walk_end]
            self.assertGreaterEqual(len(steps), 2, (s, r))
            self.assertLessEqual(max(steps), 15.0, (s, r))
        fl = self.tl.report['foot_lock']
        for s in 'lr': self.assertLess(fl[s]['slip_after_mm'], fl[s]['check_before_mm'] + 0.1, fl)


class VisemeTimingTest(unittest.TestCase):
    """Mouth timing measured against the line's own audio."""

    def read(self):
        with wave.open(os.path.join(ASSETS, 'che_line.wav')) as w:
            sr = w.getframerate(); x = np.frombuffer(w.readframes(w.getnframes()), np.int16) / 32768.0
        return x, sr

    def test_rhubarb_cues_match_the_audio(self):
        x, sr = self.read()
        cues = FA.load_rhubarb(os.path.join(ASSETS, 'che_line_rhubarb.json'))
        self.assertGreater(len(cues), 10)
        self.assertAlmostEqual(cues[-1][1], len(x) / sr, delta=0.1)
        for fps in (24, 30):
            n = int(len(x) / sr * fps) + 1
            lag, corr = FA.lip_sync_lag(FA.mouth_opening(FA.visemes(cues, fps, n)), x, sr, fps)
            self.assertLessEqual(abs(lag), 1000 / fps + 1, (fps, lag))   # within one frame
            self.assertGreater(corr, 0.25, (fps, corr))

    def test_offset_line_keeps_its_timing(self):
        """Placed 10 s into the timeline (as in the sample), the measured lag stays within a frame."""
        x, sr = self.read()
        cues = FA.load_rhubarb(os.path.join(ASSETS, 'che_line_rhubarb.json'))
        fps, off = 24, 10.07
        n = int((off + len(x) / sr) * fps) + 10
        lag, corr = FA.lip_sync_lag(FA.mouth_opening(FA.visemes(cues, fps, n, offset_s=off)), x, sr, fps, offset_s=off)
        self.assertLessEqual(abs(lag), 1000 / fps + 1); self.assertGreater(corr, 0.25)

    def test_lag_detects_a_late_mouth(self):
        x, sr = self.read()
        cues = FA.load_rhubarb(os.path.join(ASSETS, 'che_line_rhubarb.json'))
        fps = 24; n = int(len(x) / sr * fps) + 1
        late = [(a + 0.125, b + 0.125, v) for a, b, v in cues]   # three frames late
        lag, _ = FA.lip_sync_lag(FA.mouth_opening(FA.visemes(late, fps, n)), x, sr, fps)
        self.assertGreaterEqual(lag, 80)

    @unittest.skipUnless(os.environ.get('CHE_RHUBARB') and os.path.exists(os.environ.get('CHE_RHUBARB', '')),
                         'set CHE_RHUBARB to the Rhubarb Lip Sync 1.13.0 binary to re-run it on the line')
    def test_rhubarb_rerun_matches_fixture(self):
        out = os.path.join(tempfile.mkdtemp(), 'cues.json')
        subprocess.run([os.environ['CHE_RHUBARB'], '-q', '-f', 'json', '-d', os.path.join(ASSETS, 'che_line.txt'),
                        '--extendedShapes', 'GHX', os.path.join(ASSETS, 'che_line.wav'), '-o', out], check=True)
        self.assertEqual(FA.load_rhubarb(out), FA.load_rhubarb(os.path.join(ASSETS, 'che_line_rhubarb.json')))


class MergeTest(unittest.TestCase):
    def make(self, root, k, frames, glb=False):
        d = os.path.join(root, f'che-realism-shard-{k}'); os.makedirs(os.path.join(d, 'frames'))
        for f in frames: open(os.path.join(d, 'frames', f'{f:04d}.png'), 'wb').write(b'png')
        if glb: open(os.path.join(d, 'che_interactive.glb'), 'wb').write(b'glb')
        json.dump({'fps': 24, 'timeline': {'frames': 6}, 'face': {'speech_s': [1, 2]}, 'shots': [],
                   'render': {'frames': [frames[0], frames[-1]]}, 'frame_seconds': {str(f): 1.5 for f in frames},
                   'device': {'cpu': 'test'}, 'total_seconds': 10 + k, 'peak_rss_gb': 1.0}, open(os.path.join(d, 'receipt.json'), 'w'))

    def test_merge_joins_shards(self):
        root = tempfile.mkdtemp(); out = os.path.join(root, 'out')
        self.make(root, 0, [0, 1, 2], glb=True); self.make(root, 1, [3, 4, 5])
        rec = mux.merge(root, out)
        self.assertEqual(sorted(os.listdir(os.path.join(out, 'frames'))), [f'{f:04d}.png' for f in range(6)])
        self.assertEqual(len(rec['frame_seconds']), 6); self.assertEqual(rec['render_seconds_total'], 9.0)
        self.assertEqual(rec['wall_seconds_longest_shard'], 11)
        self.assertTrue(os.path.exists(os.path.join(out, 'che_interactive.glb')))
        shutil.rmtree(root)

    def test_merge_refuses_missing_frames(self):
        root = tempfile.mkdtemp()
        self.make(root, 0, [0, 1, 2], glb=True); self.make(root, 1, [3, 5])
        with self.assertRaises(SystemExit) as e: mux.merge(root, os.path.join(root, 'out'))
        self.assertIn('missing', str(e.exception))
        shutil.rmtree(root)


if __name__ == '__main__':
    unittest.main()

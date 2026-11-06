"""End-to-end tests for the Visual Studio renderer: real source media made with ffmpeg, edit documents built by the
real CHE operations (tools/che_edit_doc.mjs → server/cloudflare/visual_studio.js), real renders, and the outputs
re-opened and measured. Skipped only when ffmpeg is not installed, and then says so."""
import json, os, shutil, subprocess, sys, tempfile, unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
import che_edit_render as R  # noqa: E402

HAVE = shutil.which('ffmpeg') and shutil.which('ffprobe') and shutil.which('node')


def ff(*args):
    subprocess.run(['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error', *args], check=True)


@unittest.skipUnless(HAVE, 'ffmpeg, ffprobe and node are required for the Visual Studio render tests')
class EditRender(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dir = Path(tempfile.mkdtemp(prefix='che-edit-test-'))
        src = cls.dir / 'sources'
        src.mkdir()
        ff('-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=30:duration=4', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', str(src / 'clipA.mp4'))
        ff('-f', 'lavfi', '-i', 'testsrc2=size=640x480:rate=30:duration=3', '-f', 'lavfi', '-i', 'sine=frequency=660:duration=3', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', str(src / 'clipB.mp4'))
        ff('-f', 'lavfi', '-i', 'gradients=size=800x600:duration=1:seed=7', '-frames:v', '1', str(src / 'photo.png'))
        ff('-f', 'lavfi', '-i', 'sine=frequency=220:duration=12', '-ac', '2', str(src / 'song.wav'))
        cls.assets = json.dumps({'clipA': 'clipA', 'clipB': 'clipB', 'photo': 'photo', 'song': 'song'})
        cls.src = src

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.dir, ignore_errors=True)

    def render(self, scenario):
        spec = json.loads(subprocess.run(['node', str(ROOT / 'tools' / 'che_edit_doc.mjs'), scenario, self.assets], check=True, capture_output=True, text=True, env={**os.environ, 'CHE_EDIT_TEST_SCALE': '3'}).stdout)
        out = self.dir / scenario
        if out.exists():
            shutil.rmtree(out)
        out.mkdir()
        (self.dir / f'{scenario}.json').write_text(json.dumps(spec))
        subprocess.run([sys.executable, str(ROOT / 'tools' / 'che_edit_render.py'), '--spec', str(self.dir / f'{scenario}.json'), '--sources', str(self.src), '--out', str(out)], check=True, capture_output=True, text=True)
        return spec, json.loads((out / 'manifest.json').read_text()), out

    def mean_luma(self, path, at):
        raw = subprocess.run(['ffmpeg', '-v', 'error', '-ss', str(at), '-i', str(path), '-frames:v', '1', '-vf', 'scale=64:-1,format=gray', '-f', 'rawvideo', '-'], check=True, capture_output=True).stdout
        return sum(raw) / len(raw)

    def test_video_trim_split_reorder_transition_music_captions_render_mp4(self):
        spec, m, out = self.render('video')
        self.assertEqual(m['status'], 'verified')
        self.assertEqual((m['video_width'], m['video_height']), (360, 640), 'TikTok 9:16 canvas (1080x1920 rendered at 1/3 for CI)')
        self.assertAlmostEqual(m['duration_seconds'], spec['duration'], delta=0.35)
        info = R.probe(out / 'video.mp4')
        kinds = {s['codec_type']: s['codec_name'] for s in info['streams']}
        self.assertEqual(kinds, {'video': 'h264', 'audio': 'aac'})
        self.assertTrue((out / 'thumbnail.png').exists())

    def frame(self, path, at):
        return subprocess.run(['ffmpeg', '-v', 'error', '-ss', str(at), '-i', str(path), '-frames:v', '1', '-vf', 'scale=64:-1,format=gray', '-f', 'rawvideo', '-'], check=True, capture_output=True).stdout

    def test_freeze_holds_the_requested_frame_not_the_last(self):
        spec, m, out = self.render('freeze')
        self.assertEqual(m['status'], 'verified')
        self.assertAlmostEqual(m['duration_seconds'], 5.5, delta=0.2)
        diff = lambda x, y: sum(abs(p - q) for p, q in zip(x, y)) / len(x)
        held_a, held_b = self.frame(out / 'video.mp4', 1.2), self.frame(out / 'video.mp4', 2.3)
        moving = self.frame(out / 'video.mp4', 3.4)
        self.assertLess(diff(held_a, held_b), 0.5, 'the frame at 1 s is held for 1.5 s')
        self.assertGreater(diff(held_a, moving), diff(held_a, held_b) + 0.5, 'playback resumes after the freeze')
        source_at_1 = subprocess.run(['ffmpeg', '-v', 'error', '-ss', '1.0', '-i', str(self.src / 'clipA.mp4'), '-frames:v', '1', '-vf', 'scale=640:360:force_original_aspect_ratio=increase,crop=640:360,scale=64:-1,format=gray', '-f', 'rawvideo', '-'], check=True, capture_output=True).stdout
        source_end = subprocess.run(['ffmpeg', '-v', 'error', '-sseof', '-0.1', '-i', str(self.src / 'clipA.mp4'), '-frames:v', '1', '-vf', 'scale=640:360:force_original_aspect_ratio=increase,crop=640:360,scale=64:-1,format=gray', '-f', 'rawvideo', '-'], check=True, capture_output=True).stdout
        self.assertLess(diff(held_a, source_at_1), diff(held_a, source_end), 'the held frame is the one at 1 s, not the last frame')

    def test_color_adjustment_changes_the_rendered_pixels(self):
        _, _, out = self.render('video')
        _, _, plain = self.render('video_plain')
        self.assertGreater(self.mean_luma(out / 'video.mp4', 0.3), self.mean_luma(plain / 'video.mp4', 0.3) + 3, 'brightness +40 on the first clip is visible in the output')

    def test_image_brightness_contrast_crop_text_undo_redo_export_png(self):
        from PIL import Image, ImageStat
        spec, m, out = self.render('image')
        self.assertEqual(m['status'], 'verified')
        img = Image.open(out / 'edited.png')
        self.assertEqual(img.size, (1080, 1080))
        _, _, plain = self.render('image_plain')
        edited = ImageStat.Stat(img.convert('L')).mean[0]
        base = ImageStat.Stat(Image.open(plain / 'edited.png').convert('L')).mean[0]
        self.assertNotAlmostEqual(edited, base, delta=1.0, msg='the edits change the exported pixels')
        sat = ImageStat.Stat(img.convert('HSV')).mean[1]
        self.assertGreater(sat, 20, 'the undone desaturation is not in the export')
        self.assertTrue(any(l['type'] == 'text' for l in spec['doc']['layers']))

    def test_youtube_variant_renders_16_9(self):
        _, m, _ = self.render('youtube')
        self.assertEqual((m['video_width'], m['video_height']), (640, 360), 'YouTube 16:9 (1920x1080 at 1/3)')

    def test_music_promo_template_with_song_and_waveform(self):
        spec, m, out = self.render('template')
        self.assertEqual(m['status'], 'verified')
        self.assertEqual(spec['doc']['template'], 'music-promo')
        self.assertAlmostEqual(m['duration_seconds'], 5, delta=0.35)

    def region(self, path, at, box=(0.57, 0.12, 0.75, 0.30)):
        x0, y0, x1, y1 = box
        vf = f'crop=iw*{x1 - x0}:ih*{y1 - y0}:iw*{x0}:ih*{y0},scale=32:16,format=rgb24'
        return subprocess.run(['ffmpeg', '-v', 'error', '-ss', str(at), '-i', str(path), '-frames:v', '1', '-vf', vf, '-f', 'rawvideo', '-'], check=True, capture_output=True).stdout

    def test_stage3_two_tracks_keyframes_speed_ramp_and_lut_render_a_checked_mp4(self):
        spec, m, out = self.render('multitrack')
        _, plain_m, plain = self.render('multitrack_plain')
        video = out / 'video.mp4'
        self.assertEqual(m['status'], 'verified')
        info = R.probe(video)
        self.assertEqual({s['codec_type']: s['codec_name'] for s in info['streams']}, {'video': 'h264', 'audio': 'aac'})
        self.assertEqual((m['video_width'], m['video_height']), (640, 360))
        # The speed ramp: clip B (3 s of source) plays 1.5 s at 1x, then 0.5 s each at 1.25x, 1.6x and 2x = 2.4625 s.
        # The editor's own timeline and the rendered file agree on the whole length.
        self.assertAlmostEqual(spec['duration'], 4 + 1.5 + 0.4 + 0.3125 + 0.25, delta=0.01)
        self.assertAlmostEqual(m['duration_seconds'], spec['duration'], delta=0.1)
        self.assertAlmostEqual(plain_m['duration_seconds'], spec['duration'], delta=0.1)
        diff = lambda x, y: sum(abs(p - q) for p, q in zip(x, y)) / len(x)
        # The teal-and-orange LUT (and the contrast curve) change the pixels before any overlay starts.
        self.assertGreater(diff(self.region(video, 0.2, (0, 0, 1, 1)), self.region(plain / 'video.mp4', 0.2, (0, 0, 1, 1))), 4)
        # The overlay track: nothing over the bars at 0.2 s, the photo there at 3 s (it slid in and faded up by 1.5 s).
        p = plain / 'video.mp4'
        self.assertLess(diff(self.region(p, 0.2), self.region(p, 0.4)), 6, 'the bars alone barely change')
        self.assertGreater(diff(self.region(p, 0.2), self.region(p, 3.0)), 25, 'the photo covers the bars at 3 s')
        # The second track's picture-in-picture video is drawn from 2 s.
        pip = (0.06, 0.62, 0.28, 0.85)
        self.assertGreater(diff(self.region(p, 1.0, pip), self.region(p, 3.0, pip)), 20)

    def test_a_ramped_clip_with_a_freeze_fails_the_render_with_its_reason(self):
        with self.assertRaises(subprocess.CalledProcessError):
            self.render('ramp_freeze')
        m = json.loads((self.dir / 'ramp_freeze' / 'manifest.json').read_text())
        self.assertEqual(m['status'], 'failed')
        self.assertIn('Clip B has a speed ramp and a freeze, which do not combine', m['error'])
        self.assertFalse((self.dir / 'ramp_freeze' / 'video.mp4').exists())

    def test_a_missing_source_fails_with_its_reason_and_no_ready_file(self):
        spec = json.loads(subprocess.run(['node', str(ROOT / 'tools' / 'che_edit_doc.mjs'), 'video', json.dumps({'clipA': 'nope', 'clipB': 'clipB', 'photo': 'photo', 'song': 'song'})], check=True, capture_output=True, text=True).stdout)
        out = self.dir / 'broken'
        out.mkdir(exist_ok=True)
        (self.dir / 'broken.json').write_text(json.dumps(spec))
        p = subprocess.run([sys.executable, str(ROOT / 'tools' / 'che_edit_render.py'), '--spec', str(self.dir / 'broken.json'), '--sources', str(self.src), '--out', str(out)], capture_output=True, text=True)
        self.assertNotEqual(p.returncode, 0)
        m = json.loads((out / 'manifest.json').read_text())
        self.assertEqual(m['status'], 'failed')
        self.assertIn('source nope was not downloaded', m['error'])
        self.assertFalse((out / 'video.mp4').exists())


if __name__ == '__main__':
    unittest.main()


class Stage3Math(unittest.TestCase):
    """The renderer's keyframe expressions and ramp cuts, checked without ffmpeg against the editor's numbers."""

    def ffeval(self, expr, t):
        import re
        py = re.sub(r'\bif\(', 'iff(', expr)
        return eval(py, {'iff': lambda c, a, b: a if c else b, 'lt': lambda a, b: a < b, 't': t, 'T': t, 'max': max, 'trunc': int})

    def test_keyframes_linear_and_eased_match_the_editor(self):
        ov = {'start': 2.0, 'x': 0.5, 'keys': {'x': [{'t': 0, 'v': 0.0}, {'t': 1, 'v': 1.0, 'ease': 'linear'}, {'t': 3, 'v': 0.0, 'ease': 'ease_in_out'}]}}
        e = R.key_expr(ov, 'x', 't')
        self.assertAlmostEqual(self.ffeval(e, 1.0), 0.0, places=4, msg='before the overlay: the first keyframe holds')
        self.assertAlmostEqual(self.ffeval(e, 2.5), 0.5, places=4, msg='linear halfway')
        self.assertAlmostEqual(self.ffeval(e, 3.5), 1 - (0.25 * 0.25 * (3 - 2 * 0.25)), places=4, msg='smoothstep a quarter of the way down')
        self.assertAlmostEqual(self.ffeval(e, 4.0), 0.5, places=4, msg='smoothstep halfway')
        self.assertAlmostEqual(self.ffeval(e, 9.0), 0.0, places=4, msg='after the last keyframe it holds')
        self.assertEqual(R.key_expr({'start': 0, 'x': 0.3, 'keys': {}}, 'x', 't'), '0.30000')

    def test_ramp_cuts_a_clip_into_pieces_whose_lengths_add_up(self):
        c = {'id': 'c', 'in': 1.0, 'out': 4.0, 'speed': 1, 'ramp': [{'at': 1.5, 'speed': 1.25}, {'at': 2.0, 'speed': 1.6}, {'at': 2.5, 'speed': 2}], 'transition': {'type': 'fade', 'duration': 0.5}}
        pieces = R.expand_ramps([c])
        self.assertEqual([(p['in'], p['out'], p['speed']) for p in pieces], [(1.0, 2.5, 1), (2.5, 3.0, 1.25), (3.0, 3.5, 1.6), (3.5, 4.0, 2)])
        self.assertEqual([p['transition']['type'] for p in pieces], ['cut', 'cut', 'cut', 'fade'], 'the clip\'s own transition stays on its last piece')
        self.assertAlmostEqual(sum(R.clip_len(p) for p in pieces), 1.5 + 0.4 + 0.3125 + 0.25)

    def test_a_ramp_never_silently_drops_a_freeze_or_a_reverse(self):
        for extra in ({'freeze': {'at': 1, 'duration': 1}}, {'reverse': True}):
            c = {'id': 'c', 'name': 'Clip B', 'in': 0.0, 'out': 3.0, 'speed': 1, 'ramp': [{'at': 1.5, 'speed': 2}], **extra}
            with self.assertRaisesRegex(RuntimeError, 'Clip B has a speed ramp and a (freeze|reverse), which do not combine'):
                R.expand_ramps([c])

    def test_look_luts_are_valid_cube_files_and_mono_has_no_colour(self):
        d = Path(tempfile.mkdtemp())
        for name in R.LOOKS:
            lines = R.write_cube(name, d / f'{name}.cube').read_text().splitlines()
            self.assertEqual(lines[1], 'LUT_3D_SIZE 17')
            rows = [tuple(map(float, l.split())) for l in lines[2:]]
            self.assertEqual(len(rows), 17 ** 3)
            self.assertTrue(all(0 <= v <= 1 for r in rows for v in r))
        mono = [tuple(map(float, l.split())) for l in (d / 'mono.cube').read_text().splitlines()[2:]]
        self.assertTrue(all(r[0] == r[1] == r[2] for r in mono))
        self.assertNotEqual(R.look_rgb('teal_orange', 0.1, 0.1, 0.1), R.look_rgb('teal_orange', 0.9, 0.9, 0.9)[::-1], 'shadows and highlights are tinted differently')
        self.assertGreater(R.look_rgb('teal_orange', 0.1, 0.1, 0.1)[2], R.look_rgb('teal_orange', 0.1, 0.1, 0.1)[0], 'shadows lean teal')
        self.assertGreater(R.look_rgb('teal_orange', 0.9, 0.9, 0.9)[0], R.look_rgb('teal_orange', 0.9, 0.9, 0.9)[2], 'highlights lean orange')


class FilterGraphArgs(unittest.TestCase):
    def test_small_graph_goes_inline_so_any_ffmpeg_version_accepts_it(self):
        # ffmpeg 8 removed -filter_complex_script; ffmpeg 6.1 (Ubuntu 24.04) has no -/filter_complex.
        sys.path.insert(0, str(ROOT / 'tools'))
        import che_edit_render
        self.assertEqual(che_edit_render.filter_graph_args('[0:v]null[vout]', tempfile.mkdtemp()), ['-filter_complex', '[0:v]null[vout]'])

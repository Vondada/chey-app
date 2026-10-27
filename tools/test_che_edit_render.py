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


class FilterGraphArgs(unittest.TestCase):
    def test_small_graph_goes_inline_so_any_ffmpeg_version_accepts_it(self):
        # ffmpeg 8 removed -filter_complex_script; ffmpeg 6.1 (Ubuntu 24.04) has no -/filter_complex.
        sys.path.insert(0, str(ROOT / 'tools'))
        import che_edit_render
        self.assertEqual(che_edit_render.filter_graph_args('[0:v]null[vout]', tempfile.mkdtemp()), ['-filter_complex', '[0:v]null[vout]'])

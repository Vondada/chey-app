"""Film Studio renderer: two segments rendered like two parallel runners, then joined without re-encoding."""
import json, os, shutil, subprocess, sys, tempfile, unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HAVE = all(shutil.which(t) for t in ('ffmpeg', 'ffprobe'))
ENV = {**os.environ, 'CHE_FILM_TEST_SCALE': '4'}  # 320x180: the same filters, a fraction of the CPU


def ff(*args):
    subprocess.run(['ffmpeg', '-nostdin', '-y', '-hide_banner', '-loglevel', 'error', *args], check=True)


def render(*args):
    p = subprocess.run([sys.executable, str(ROOT / 'tools' / 'che_film_render.py'), *args], capture_output=True, text=True, env=ENV)
    if p.returncode != 0:
        raise AssertionError(p.stderr)
    return json.loads(p.stdout)


@unittest.skipUnless(HAVE, 'ffmpeg and ffprobe are required for the Film Studio render tests')
class FilmRender(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dir = Path(tempfile.mkdtemp(prefix='che-film-test-'))
        src = cls.dir / 'sources' / 'film' / 'film_x'
        src.mkdir(parents=True)
        ff('-f', 'lavfi', '-i', 'testsrc2=size=1024x1024', '-frames:v', '1', str(src / 'a.jpg'))
        ff('-f', 'lavfi', '-i', 'gradients=size=1024x1024', '-frames:v', '1', str(src / 'b.jpg'))
        ff('-f', 'lavfi', '-i', 'sine=frequency=300:duration=1.5', '-c:a', 'libmp3lame', '-b:a', '64k', str(src / 'line.mp3'))
        ff('-f', 'lavfi', '-i', 'testsrc=size=768x432:rate=24:duration=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', str(src / 'clip.mp4'))
        cls.sources = cls.dir / 'sources'

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.dir, ignore_errors=True)

    def spec(self, index, shots, audio):
        seconds = sum(s['seconds'] for s in shots)
        path = self.dir / f'seg{index}.json'
        path.write_text(json.dumps({'segment': index, 'width': 1280, 'height': 720, 'fps': 24, 'seconds': seconds, 'shots': shots, 'audio': audio,
                                    'music': {'mood': 'calm', 'gain': 0.18}, 'captions': True}))
        return path, seconds

    def test_two_parallel_segments_join_without_reencoding_and_keep_their_length(self):
        p0, s0 = self.spec(0, [
            {'n': 1, 'seconds': 2.5, 'image': 'film/film_x/a.jpg', 'motion': 'push_in', 'variant': 0, 'caption': 'Where were you last night?'},
            {'n': 2, 'seconds': 2.0, 'image': 'film/film_x/a.jpg', 'motion': 'pan_left', 'variant': 1, 'caption': ''},
        ], [{'key': 'film/film_x/line.mp3', 'at': 0.3, 'gain': 1}])
        p1, s1 = self.spec(1, [
            {'n': 3, 'seconds': 2.0, 'clip': 'film/film_x/clip.mp4', 'image': '', 'motion': 'push_in', 'caption': 'A moving shot.'},
            {'n': 4, 'seconds': 2.0, 'image': 'film/film_x/b.jpg', 'motion': 'pull_out', 'variant': 2, 'caption': ''},
        ], [])
        a = render('segment', '--spec', str(p0), '--sources', str(self.sources), '--out', str(self.dir / 'seg0.mp4'), '--report', str(self.dir / 'r0.json'))
        b = render('segment', '--spec', str(p1), '--sources', str(self.sources), '--out', str(self.dir / 'seg1.mp4'))
        for facts, seconds in ((a, s0), (b, s1)):
            self.assertEqual((facts['video'], facts['audio'], facts['width'], facts['height']), ('h264', 'aac', 320, 180))
            self.assertAlmostEqual(facts['seconds'], seconds, delta=0.15)
        self.assertGreater(json.loads((self.dir / 'r0.json').read_text())['encode_s'], 0, 'timing is reported for CHE to measure')
        film = render('concat', '--out', str(self.dir / 'film.mp4'), '--expected', str(s0 + s1), str(self.dir / 'seg0.mp4'), str(self.dir / 'seg1.mp4'))
        self.assertEqual((film['video'], film['audio']), ('h264', 'aac'))
        self.assertAlmostEqual(film['seconds'], s0 + s1, delta=0.3)
        head = (self.dir / 'film.mp4').read_bytes()[:4096]
        self.assertIn(b'moov', head, 'the index is at the front (+faststart) so CHE can verify the stored file from its first bytes')

    def test_a_film_of_the_wrong_length_is_refused(self):
        p, s = self.spec(9, [{'n': 1, 'seconds': 2.0, 'image': 'film/film_x/b.jpg', 'motion': 'drift', 'variant': 0, 'caption': ''}], [])
        render('segment', '--spec', str(p), '--sources', str(self.sources), '--out', str(self.dir / 'short.mp4'))
        proc = subprocess.run([sys.executable, str(ROOT / 'tools' / 'che_film_render.py'), 'concat', '--out', str(self.dir / 'bad.mp4'), '--expected', '60', str(self.dir / 'short.mp4')],
                              capture_output=True, text=True, env=ENV)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn('expected 60', proc.stderr)


if __name__ == '__main__':
    unittest.main()

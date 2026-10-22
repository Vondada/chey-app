"""CHE internal video engine, local proof: frames rendered by CHE's own renderer (tools/che_internal_frames.mjs) are
encoded with ffmpeg (free, open source; the same encoder the owner's GitHub renderer runs) into an H.264 MP4, which is
re-opened with ffprobe and fully decoded. Skipped only when ffmpeg or node is missing, and then says so."""
import json, shutil, subprocess, tempfile, unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HAVE = shutil.which('ffmpeg') and shutil.which('ffprobe') and shutil.which('node')


@unittest.skipUnless(HAVE, 'ffmpeg, ffprobe and node are required for the internal video test')
class InternalVideo(unittest.TestCase):
    def test_internal_frames_encode_to_a_playable_mp4(self):
        d = Path(tempfile.mkdtemp(prefix='che-internal-video-'))
        try:
            subprocess.run(['node', str(ROOT / 'tools' / 'che_internal_frames.mjs'), str(d), 'sunset', '24', '12'], check=True)
            spec = json.loads((d / 'timeline.json').read_text())
            self.assertEqual(spec['frames'], 24)
            self.assertEqual(len(list(d.glob('frame_*.png'))), 24)
            out = d / 'video.mp4'
            subprocess.run(['ffmpeg', '-y', '-v', 'error', '-framerate', str(spec['fps']), '-i', str(d / 'frame_%04d.png'),
                            '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', str(out)], check=True)
            info = json.loads(subprocess.run(['ffprobe', '-v', 'error', '-show_streams', '-show_format', '-of', 'json', str(out)], check=True, capture_output=True, text=True).stdout)
            v = next(s for s in info['streams'] if s['codec_type'] == 'video')
            self.assertEqual((v['codec_name'], v['width'], v['height']), ('h264', 320, 180))
            self.assertAlmostEqual(float(info['format']['duration']), 2.0, delta=0.15)
            # A full decode: every frame must decode without error.
            dec = subprocess.run(['ffmpeg', '-v', 'error', '-i', str(out), '-f', 'null', '-'], capture_output=True, text=True)
            self.assertEqual(dec.returncode, 0, dec.stderr)
            self.assertEqual(dec.stderr.strip(), '')
            # The waves move: the first and the middle frame differ.
            a = subprocess.run(['ffmpeg', '-v', 'error', '-ss', '0', '-i', str(out), '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], check=True, capture_output=True).stdout
            b = subprocess.run(['ffmpeg', '-v', 'error', '-ss', '1', '-i', str(out), '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], check=True, capture_output=True).stdout
            self.assertGreater(sum(abs(x - y) for x, y in zip(a, b)) / len(a), 0.3, 'the animation moves')
        finally:
            shutil.rmtree(d, ignore_errors=True)


if __name__ == '__main__':
    unittest.main()

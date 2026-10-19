"""Fish narration in the video renderer: model, caching, fallback, pronunciation.

Pillow and the network are replaced, so this runs anywhere without a key.
"""
import io, json, os, shutil, subprocess, sys, tempfile, types, unittest, urllib.error
from pathlib import Path
from unittest import mock

# The renderer imports Pillow at the top; narration does not need it.
pil = types.ModuleType('PIL')
for name in ('Image', 'ImageDraw', 'ImageFont'):
    setattr(pil, name, types.ModuleType(name))
sys.modules.setdefault('PIL', pil)
sys.path.insert(0, str(Path(__file__).resolve().parent))
import che_video_render as render  # noqa: E402

MP3 = b'ID3\x04\x00\x00\x00\x00' + b'\x55' * 64
VOICE = '802e3bc2b27e49c2995d23ef70e6ac89'


def unpack(data):
    """Small MessagePack reader for the request bodies the renderer sends."""
    import struct
    at = 0
    def read():
        nonlocal at
        b = data[at]; at += 1
        def take(n):
            nonlocal at
            chunk = data[at:at + n]; at += n
            return chunk
        if b <= 0x7f: return b
        if b >= 0xe0: return b - 0x100
        if b & 0xe0 == 0xa0: return take(b & 0x1f).decode()
        if b & 0xf0 == 0x90: return [read() for _ in range(b & 0x0f)]
        if b & 0xf0 == 0x80: return {read(): read() for _ in range(b & 0x0f)}
        simple = {0xc0: None, 0xc2: False, 0xc3: True}
        if b in simple: return simple[b]
        if b == 0xcc: return take(1)[0]
        if b == 0xcd: return struct.unpack('>H', take(2))[0]
        if b == 0xcb: return struct.unpack('>d', take(8))[0]
        if b == 0xd9: return take(take(1)[0]).decode()
        if b == 0xde: return {read(): read() for _ in range(struct.unpack('>H', take(2))[0])}
        raise ValueError(hex(b))
    return read()


class FakeResponse(io.BytesIO):
    def __enter__(self): return self
    def __exit__(self, *_): return False


class FishNarrationTest(unittest.TestCase):
    def setUp(self):
        self.cache = tempfile.mkdtemp()
        self.env = mock.patch.dict(os.environ, {
            'FISH_API_KEY': 'fish-test-key', 'CHE_FISH_VOICE_ID': VOICE,
            'CHE_NARRATION_CACHE': self.cache, 'CHE_FISH_EXPRESSIVE_MODEL': '', 'CHE_FISH_NARRATION': '1',
            'CHE_FISH_PREFERRED': '1',
        })
        self.env.start()
        self.calls = []

    def tearDown(self):
        self.env.stop()

    def fake(self, reply):
        def urlopen(request, timeout=None):
            self.calls.append(request)
            return reply(request)
        return mock.patch.object(render.urllib.request, 'urlopen', urlopen)

    def test_drama_3_narrates_once_then_the_cache_answers(self):
        with self.fake(lambda _: FakeResponse(MP3)):
            first = render.fish_narration('Three hundred miles off the coast.')
            second = render.fish_narration('Three hundred miles off the coast.')
        self.assertEqual(len(self.calls), 1)
        request = self.calls[0]
        self.assertEqual(request.full_url, 'https://api.fish.audio/v1/tts')
        self.assertEqual(request.get_header('Model'), 'drama-3')
        self.assertEqual(request.get_header('Authorization'), 'Bearer fish-test-key')
        self.assertEqual(request.get_header('Content-type'), 'application/msgpack')
        body = unpack(request.data)
        self.assertEqual(body['chunk_length'], 200)
        self.assertEqual(body['references'], [])
        self.assertEqual(body['text'], 'Three hundred miles off the coast.')
        self.assertEqual(body['reference_id'], VOICE)
        self.assertEqual(first[1:], ('drama-3', 'miss'))
        self.assertEqual(second[1:], ('drama-3', 'hit'))
        self.assertEqual(Path(second[0]).read_bytes(), MP3)

    def test_without_fish_or_when_switched_off_piper_narrates(self):
        with mock.patch.dict(os.environ, {'FISH_API_KEY': ''}):
            self.assertIsNone(render.fish_narration('Hello.'))
        with mock.patch.dict(os.environ, {'CHE_FISH_NARRATION': '0'}):
            self.assertIsNone(render.fish_narration('Hello.'))
        # Free by default: without the owner's opt-in Fish is never called.
        with mock.patch.dict(os.environ, {'CHE_FISH_NARRATION': ''}):
            self.assertIsNone(render.fish_narration('Hello.'))
        with mock.patch.dict(os.environ, {'CHE_FISH_PREFERRED': '0'}):
            self.assertIsNone(render.fish_narration('Hello.'))
        with mock.patch.dict(os.environ, {'CHE_FISH_VOICE_ID': 'bad id'}):
            self.assertIsNone(render.fish_narration('Hello.'))
        self.assertEqual(self.calls, [])

    def test_a_fish_error_or_non_audio_reply_falls_back(self):
        def refused(request):
            raise urllib.error.HTTPError(request.full_url, 402, 'Payment Required', {}, io.BytesIO(b'{}'))
        with self.fake(refused):
            self.assertIsNone(render.fish_narration('Hello.'))
        with self.fake(lambda _: FakeResponse(b'{"error":"nope"}')):
            self.assertIsNone(render.fish_narration('Hello again.'))
        self.assertEqual(list(Path(self.cache).glob('*.mp3')), [], 'nothing unplayable is cached')

    def test_without_drama_3_credit_the_everyday_fish_voice_narrates(self):
        # The owner's real account: drama-3 answers 402, s2.1-pro-free speaks.
        def reply(request):
            if request.get_header('Model') == 'drama-3':
                raise urllib.error.HTTPError(request.full_url, 402, 'Payment Required', {},
                    io.BytesIO(b'{"message":"Insufficient API credit."}'))
            return FakeResponse(MP3)
        with self.fake(reply):
            first = render.fish_narration('The lighthouse keeper heard a knock.')
            second = render.fish_narration('The lighthouse keeper heard a knock.')
        self.assertEqual([c.get_header('Model') for c in self.calls], ['drama-3', 's2.1-pro-free'])
        self.assertEqual(first[1:], ('s2.1-pro-free', 'miss'))
        self.assertEqual(second[1:], ('s2.1-pro-free', 'hit'), 'the fallback narration is cached too')

    def test_a_refused_key_goes_straight_to_piper(self):
        def refused(request):
            raise urllib.error.HTTPError(request.full_url, 401, 'Unauthorized', {}, io.BytesIO(b'{"message":"bad key"}'))
        with self.fake(refused):
            self.assertIsNone(render.fish_narration('Hello.'))
        self.assertEqual(len(self.calls), 1)

    def test_a_custom_expressive_model_is_used_and_a_bad_one_is_not(self):
        with mock.patch.dict(os.environ, {'CHE_FISH_EXPRESSIVE_MODEL': 'drama-3-preview'}), self.fake(lambda _: FakeResponse(MP3)):
            render.fish_narration('One.')
        with mock.patch.dict(os.environ, {'CHE_FISH_EXPRESSIVE_MODEL': 'x\r\nInjected: 1'}), self.fake(lambda _: FakeResponse(MP3)):
            render.fish_narration('Two.')
        self.assertEqual([c.get_header('Model') for c in self.calls], ['drama-3-preview', 'drama-3'])

    def test_msgpack_matches_the_reference_encoding(self):
        # Bytes from Python's msgpack.packb for the same map.
        body = {'text': 'Hi', 'mp3_bitrate': 128, 'normalize': True, 'references': [], 'top_p': 0.7,
                'prosody': {'speed': 1.1, 'volume': 0}}
        self.assertEqual(render.pack(body).hex(),
            '86a474657874a24869ab6d70335f62697472617465cc80a96e6f726d616c697a65c3aa7265666572656e63657390a5746f705f70cb3fe6666666666666a770726f736f647982a57370656564cb3ff199999999999aa6766f6c756d6500')

    def test_a_refusal_reason_hides_the_key_and_voice(self):
        reason = render.fish_reason(b'{"message":"bad voice ' + VOICE.encode() + b' for fish-test-key"}', ('fish-test-key', VOICE))
        self.assertEqual(reason, 'bad voice [hidden] for [hidden]')

    def test_che_is_spoken_as_chay(self):
        self.assertEqual(render.spoken("CHE's channel. Che explains."), "Chay's channel. Chay explains.")
        self.assertEqual(render.spoken('Check the cheese.'), 'Check the cheese.')


PILOT_SPEC = Path(__file__).resolve().parent / 'fixtures' / 'pilot_render_spec.json'


class StoryboardTest(unittest.TestCase):
    """The Creator Studio pilot storyboard (written by creator_studio.js) as the renderer checks it."""

    def spec(self, **change):
        data = json.loads(PILOT_SPEC.read_text())
        data.update(change)
        return data

    def refused(self, data, words):
        with self.assertRaises(ValueError) as caught:
            render.validate_spec(json.dumps(data))
        self.assertIn(words, str(caught.exception))

    def test_the_pilot_storyboard_is_accepted_as_a_vertical_40_second_episode(self):
        spec = render.validate_spec(PILOT_SPEC.read_text())
        self.assertEqual((spec['width'], spec['height'], spec['seconds'], spec['episode']), (1080, 1920, 40, 'S1E1'))
        self.assertEqual(sum(s['seconds'] for s in spec['scenes']), 40)
        self.assertTrue(all(s['speaker'] in s['cast'] for s in spec['scenes']))
        self.assertTrue(all(s['sources'] for s in spec['scenes'] if s['kind'] == 'fact'))

    def test_a_storyboard_that_breaks_the_format_is_refused_before_anything_is_drawn(self):
        self.refused(self.spec(width=1920, height=1080), '9:16')
        self.refused(self.spec(seconds=60), '30 to 45 seconds')
        data = self.spec(); data['scenes'][0]['seconds'] += 1
        self.refused(data, 'do not add up')
        data = self.spec(); data['scenes'][0]['speaker'] = 'odette'
        self.refused(data, 'speaker is not in the shot')
        data = self.spec(); data['scenes'][2]['sources'] = []
        self.refused(data, 'fact without a source')
        data = self.spec(); data['scenes'][1]['cast'] = ['tay', 'stranger']
        self.refused(data, 'not in the series cast')
        data = self.spec(); data['layout']['caption'] = [72, 1030, 1200, 1240]
        self.refused(data, 'outside the frame')
        data = self.spec(); data['cast'][0]['color'] = 'red; rm -rf /'
        self.refused(data, 'colors are invalid')
        self.refused(self.spec(v=2), 'version')
        with self.assertRaises(ValueError):
            render.validate_spec('{' + ' ' * 16001 + '}')

    def test_control_characters_are_flattened_and_long_text_is_refused_not_cut(self):
        data = self.spec(); data['scenes'][0]['caption'] = 'Line\none\x00two'
        self.assertEqual(render.validate_spec(json.dumps(data))['scenes'][0]['caption'], 'Line one two')
        data = self.spec(); data['scenes'][0]['narration'] = 'word ' * 120
        self.refused(data, 'longer than 400')

    def test_captions_file_timing(self):
        self.assertEqual(render.srt([(0, 1.5, 'One'), (61.25, 3600.004, 'Two')]),
                         '1\n00:00:00,000 --> 00:00:01,500\nOne\n\n2\n00:01:01,250 --> 01:00:00,004\nTwo\n\n')


def _real_renderer_available():
    probe = subprocess.run([sys.executable, '-c', 'import PIL.Image'], capture_output=True)
    return probe.returncode == 0 and shutil.which('ffmpeg') and shutil.which('ffprobe')


@unittest.skipUnless(_real_renderer_available(), 'needs real Pillow and ffmpeg (CI checks the storyboard only)')
class StoryboardRenderTest(unittest.TestCase):
    """A real render of the pilot with Pillow and ffmpeg; Piper is replaced by a tone of the same length."""

    def test_the_pilot_renders_to_a_verified_vertical_mp4_with_captions(self):
        out = Path(tempfile.mkdtemp()) / 'rendered'
        script = (
            'import os, subprocess, sys\n'
            'from pathlib import Path\n'
            f'sys.path.insert(0, {str(Path(__file__).resolve().parent)!r})\n'
            'import che_video_render as r\n'
            'def tone(text, out, name="narration.wav"):\n'
            '    wav = out / name\n'
            '    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-f", "lavfi", "-i", f"sine=frequency=330:duration={max(0.8, len(text.split()) / 2.6):.2f}", str(wav)], check=True)\n'
            '    return wav\n'
            'r.piper_narration = tone\n'
            f'r.render_episode(r.validate_spec(Path({str(PILOT_SPEC)!r}).read_text()), Path({str(out)!r}))\n'
        )
        env = {k: v for k, v in os.environ.items() if not k.startswith(('FISH_', 'CHE_FISH'))}
        subprocess.run([sys.executable, '-c', script], check=True, env=env, capture_output=True)
        manifest = json.loads((out / 'manifest.json').read_text())
        self.assertEqual((manifest['video_width'], manifest['video_height'], manifest['format']), (1080, 1920, '9:16'))
        self.assertAlmostEqual(manifest['duration_seconds'], 40, delta=0.3)
        self.assertEqual((manifest['voices'], manifest['lip_sync'], manifest['youtube_uploaded']), (1, False, False))
        self.assertGreater((out / 'video.mp4').stat().st_size, 20000)
        cues = (out / 'captions.srt').read_text()
        self.assertIn('Tay swears the shop', cues)
        self.assertIn('Then check them.', cues.replace('\n', ' '))


if __name__ == '__main__':
    unittest.main()

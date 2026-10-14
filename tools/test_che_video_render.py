"""Fish narration in the video renderer: model, caching, fallback, pronunciation.

Pillow and the network are replaced, so this runs anywhere without a key.
"""
import io, json, os, sys, tempfile, types, unittest, urllib.error
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


class FakeResponse(io.BytesIO):
    def __enter__(self): return self
    def __exit__(self, *_): return False


class FishNarrationTest(unittest.TestCase):
    def setUp(self):
        self.cache = tempfile.mkdtemp()
        self.env = mock.patch.dict(os.environ, {
            'FISH_API_KEY': 'fish-test-key', 'CHE_FISH_VOICE_ID': VOICE,
            'CHE_NARRATION_CACHE': self.cache, 'CHE_FISH_EXPRESSIVE_MODEL': '', 'CHE_FISH_NARRATION': '',
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
        body = json.loads(request.data)
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

    def test_a_custom_expressive_model_is_used_and_a_bad_one_is_not(self):
        with mock.patch.dict(os.environ, {'CHE_FISH_EXPRESSIVE_MODEL': 'drama-3-preview'}), self.fake(lambda _: FakeResponse(MP3)):
            render.fish_narration('One.')
        with mock.patch.dict(os.environ, {'CHE_FISH_EXPRESSIVE_MODEL': 'x\r\nInjected: 1'}), self.fake(lambda _: FakeResponse(MP3)):
            render.fish_narration('Two.')
        self.assertEqual([c.get_header('Model') for c in self.calls], ['drama-3-preview', 'drama-3'])

    def test_che_is_spoken_as_chay(self):
        self.assertEqual(render.spoken("CHE's channel. Che explains."), "Chay's channel. Chay explains.")
        self.assertEqual(render.spoken('Check the cheese.'), 'Check the cheese.')


if __name__ == '__main__':
    unittest.main()

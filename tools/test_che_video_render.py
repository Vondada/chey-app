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
            'CHE_NARRATION_CACHE': self.cache, 'CHE_FISH_EXPRESSIVE_MODEL': '', 'CHE_FISH_NARRATION': '',
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


if __name__ == '__main__':
    unittest.main()

"""One spoken line for a character, offline and free: Kokoro int8 en v0.19 (Apache-2.0 model) through the sherpa-onnx
pip package (Apache-2.0), the same model CHE's iPhone app downloads (lib/che_kokoro_voice.dart).

  python3 tts_line.py --model-dir kokoro-int8-en-v0_19 --text "..." --out line.wav [--sid 0] [--speed 0.94]

Model archive: https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-int8-en-v0_19.tar.bz2
(sha256 c9f0dd393615805b0bab050c340834d5e684e732aec91c0e860cd30e982c08bd, 103 MB). Writes 16-bit mono WAV and prints
LINE <path> <seconds> s <sample_rate> Hz. sid 0 at speed 0.94 is CHE's voice in the Create Room demo (lane E).
"""
import argparse
import os
import wave

KOKORO_SHA256 = 'c9f0dd393615805b0bab050c340834d5e684e732aec91c0e860cd30e982c08bd'


def synth(model_dir, text, sid=0, speed=0.94, threads=2):
    import numpy as np
    import sherpa_onnx
    d = model_dir
    cfg = sherpa_onnx.OfflineTtsConfig(model=sherpa_onnx.OfflineTtsModelConfig(
        kokoro=sherpa_onnx.OfflineTtsKokoroModelConfig(model=f'{d}/model.int8.onnx', voices=f'{d}/voices.bin',
                                                       tokens=f'{d}/tokens.txt', data_dir=f'{d}/espeak-ng-data'),
        num_threads=threads), max_num_sentences=1)
    audio = sherpa_onnx.OfflineTts(cfg).generate(text, sid=sid, speed=speed)
    return np.asarray(audio.samples, dtype=np.float32), audio.sample_rate


def write_wav(path, x, sr, lead_s=0.15, tail_s=0.25):
    import numpy as np
    x = np.concatenate([np.zeros(int(lead_s * sr), np.float32), x, np.zeros(int(tail_s * sr), np.float32)])
    pcm = (np.clip(x, -1, 1) * 32767).astype(np.int16)
    with wave.open(path, 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr); w.writeframes(pcm.tobytes())
    return len(x) / sr


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--model-dir', required=True); ap.add_argument('--text', required=True); ap.add_argument('--out', required=True)
    ap.add_argument('--sid', type=int, default=0); ap.add_argument('--speed', type=float, default=0.94)
    a = ap.parse_args()
    x, sr = synth(a.model_dir, a.text, a.sid, a.speed)
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    dur = write_wav(a.out, x, sr)
    print('LINE', os.path.abspath(a.out), f'{dur:.3f}', 's', sr, 'Hz', flush=True)


if __name__ == '__main__':
    main()

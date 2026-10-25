"""Speech for the Create Room demo: free, local, no API key. Same model CHE's iPhone app downloads (Kokoro int8 en v0.19
through sherpa-onnx, lib/che_kokoro_voice.dart), run here with the `sherpa-onnx` pip package.

  python3 tools/demo/tts.py --model-dir kokoro-int8-en-v0_19 --out OUT_DIR

Reads tools/demo/storyboard.json, synthesizes every line, places it in its segment ("at" seconds, or "gap" after the
previous line), and writes OUT_DIR/audio/<segment>.wav (mono 24 kHz) plus OUT_DIR/timeline.json:
  {segments: [{id, duration, lines: [{who, sid, text, start, end, envelope?}]}], fps}
A line with "lipsync" also gets an amplitude envelope {rate_hz: 30, values: [0..1]}: the RMS of each 1/30 s window,
scaled to the line's own 95th percentile. Live Studio's lipsync command takes exactly that shape (studio.html
startSpeech); it moves the mouth_open shape key with loudness, it is not phoneme-accurate.
"""
import argparse
import json
import os
import wave

import numpy as np
import sherpa_onnx

HERE = os.path.dirname(os.path.abspath(__file__))


def envelope(x, sr, rate=30):
    hop = sr // rate
    n = int(np.ceil(len(x) / hop))
    rms = np.array([np.sqrt(np.mean(x[i * hop:(i + 1) * hop] ** 2) + 1e-12) for i in range(n)])
    ref = np.percentile(rms, 95) or 1.0
    v = np.clip(rms / ref, 0, 1)
    v[v < 0.08] = 0.0   # silence closes the mouth
    return [round(float(a), 3) for a in v]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--model-dir', required=True); ap.add_argument('--out', required=True); ap.add_argument('--threads', type=int, default=2)
    a = ap.parse_args()
    sb = json.load(open(os.path.join(HERE, 'storyboard.json')))
    d = a.model_dir
    cfg = sherpa_onnx.OfflineTtsConfig(model=sherpa_onnx.OfflineTtsModelConfig(
        kokoro=sherpa_onnx.OfflineTtsKokoroModelConfig(model=f'{d}/model.int8.onnx', voices=f'{d}/voices.bin',
                                                       tokens=f'{d}/tokens.txt', data_dir=f'{d}/espeak-ng-data'),
        num_threads=a.threads), max_num_sentences=1)
    tts = sherpa_onnx.OfflineTts(cfg)
    os.makedirs(os.path.join(a.out, 'audio'), exist_ok=True)
    timeline = {'fps': 24, 'engine': 'sherpa-onnx ' + getattr(sherpa_onnx, '__version__', '?') + ', Kokoro int8 en v0.19', 'segments': []}
    for seg in sb['segments']:
        sr, clips, lines, t_end = None, [], [], 0.0
        for ln in seg['lines']:
            v = sb['voices'][ln['who']]
            audio = tts.generate(ln['text'], sid=v['sid'], speed=v['speed'])
            sr = audio.sample_rate
            x = np.asarray(audio.samples, dtype=np.float32)
            start = ln['at'] if 'at' in ln else t_end + ln.get('gap', 0.3)
            if start < t_end:
                print(f"WARN {seg['id']}: line '{ln['text'][:30]}' moved from {start} to {t_end + 0.2:.2f} (overlap)")
                start = t_end + 0.2
            end = start + len(x) / sr
            rec = {'who': ln['who'], 'sid': v['sid'], 'text': ln['text'], 'start': round(start, 3), 'end': round(end, 3)}
            if ln.get('lipsync'): rec['envelope'] = {'rate_hz': 30, 'values': envelope(x, sr)}
            lines.append(rec); clips.append((start, x)); t_end = end
        dur = max(seg['min'], t_end + seg['tail'])
        buf = np.zeros(int(np.ceil(dur * sr)), dtype=np.float32)
        for start, x in clips:
            i = int(start * sr); buf[i:i + len(x)] += x[:len(buf) - i]
        pcm = (np.clip(buf, -1, 1) * 32767).astype(np.int16)
        with wave.open(os.path.join(a.out, 'audio', seg['id'] + '.wav'), 'wb') as w:
            w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr); w.writeframes(pcm.tobytes())
        timeline['segments'].append({'id': seg['id'], 'duration': round(dur, 3), 'lines': lines})
        print(seg['id'], f'{dur:.1f}s', len(lines), 'lines', flush=True)
    timeline['total_seconds'] = round(sum(s['duration'] for s in timeline['segments']), 2)
    json.dump(timeline, open(os.path.join(a.out, 'timeline.json'), 'w'), indent=1)
    print('TOTAL', timeline['total_seconds'])


if __name__ == '__main__':
    main()

#!/usr/bin/env python3
"""CHE Film Studio renderer (runs on a GitHub Actions runner; see .github/workflows/che-film-render.yml).

segment: renders one segment of a film from CHE's segment spec. Every shot is encoded on its own (all CPU cores in
         parallel): a still with a camera move (zoompan) or a farm clip fitted to the frame, with its caption. The
         shots are joined without re-encoding, then the voices are placed at their times over a quiet synthesized
         score and muxed in. Every segment uses identical encode settings so segments join without re-encoding too.
concat:  joins segments without re-encoding, moves the index to the front (+faststart) and measures the result.

Prints one JSON line of facts read back from the output file (ffprobe), plus timings for CHE's throughput record.
"""
import argparse, concurrent.futures, json, os, shutil, subprocess, sys, tempfile, time
from pathlib import Path

FONTS = ['/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
         '/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf', '/Library/Fonts/Arial.ttf']
SCALE = int(os.environ.get('CHE_FILM_TEST_SCALE', '1') or 1)  # tests render at 1/SCALE size


def run(cmd):
    p = subprocess.run(cmd, capture_output=True, text=True, stdin=subprocess.DEVNULL)
    if p.returncode != 0:
        raise RuntimeError(f'{Path(cmd[0]).name} failed: {p.stderr.strip()[-1500:]}')
    return p.stdout


def ff(*args):
    return run(['ffmpeg', '-nostdin', '-y', '-hide_banner', '-loglevel', 'error', *args])


def probe(path):
    data = json.loads(run(['ffprobe', '-v', 'error', '-show_streams', '-show_format', '-of', 'json', str(path)]))
    v = next((s for s in data['streams'] if s['codec_type'] == 'video'), {})
    a = next((s for s in data['streams'] if s['codec_type'] == 'audio'), {})
    return {'seconds': round(float(data['format'].get('duration', 0)), 3), 'video': v.get('codec_name', ''), 'audio': a.get('codec_name', ''),
            'width': int(v.get('width', 0)), 'height': int(v.get('height', 0)), 'bytes': int(data['format'].get('size', 0))}


def encode_args(fps):
    # One set of settings for every shot and segment: concat without re-encoding needs identical streams.
    return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p', '-r', str(fps), '-g', str(fps * 2),
            '-profile:v', 'high', '-video_track_timescale', str(fps * 1000)]


def motion_expr(motion, variant, frames, w, h):
    """zoompan expressions for a camera move over `frames` frames. `variant` reframes a reused picture."""
    d = max(1, frames - 1)
    start = 1.0 + 0.08 * (variant % 4)
    cx = ['iw/2-(iw/zoom/2)', 'iw/3-(iw/zoom/2)', '2*iw/3-(iw/zoom/2)', 'iw/2-(iw/zoom/2)'][variant % 4]
    cy = ['ih/2-(ih/zoom/2)', 'ih/2-(ih/zoom/2)', 'ih/2-(ih/zoom/2)', 'ih/3-(ih/zoom/2)'][variant % 4]
    if motion == 'pull_out':
        return f"{start + 0.25}-0.25*on/{d}", cx, cy
    if motion == 'pan_left':
        return f"{start + 0.15}", f"(iw-iw/zoom)*(1-on/{d})", cy
    if motion == 'pan_right':
        return f"{start + 0.15}", f"(iw-iw/zoom)*on/{d}", cy
    if motion == 'tilt_up':
        return f"{start + 0.15}", cx, f"(ih-ih/zoom)*(1-on/{d})"
    if motion == 'drift':
        return f"{start}+0.04*on/{d}", cx, cy
    return f"{start}+0.25*on/{d}", cx, cy  # push_in


def font():
    return next((f for f in FONTS if os.path.exists(f)), '')


def caption_filter(text, w, h, work, n):
    f = font()
    if not text or not f:
        return ''
    path = Path(work) / f'caption-{n}.txt'
    words, lines, cur = text.split(), [], ''
    for word in words:  # wrap at about 48 characters, at most three lines
        if len(cur) + len(word) + 1 > 48 and cur:
            lines.append(cur); cur = word
        else:
            cur = f'{cur} {word}'.strip()
    lines.append(cur)
    path.write_text('\n'.join(lines[:3]))
    size = max(10, h // 24)
    return (f",drawtext=fontfile={f}:textfile={path}:fontsize={size}:fontcolor=white:line_spacing={size // 4}"
            f":box=1:boxcolor=black@0.45:boxborderw={size // 3}:x=(w-text_w)/2:y=h-text_h-{h // 12}")


def render_shot(shot, sources, w, h, fps, work, captions):
    out = Path(work) / f"shot-{shot['n']:05d}.mp4"
    frames = max(1, round(float(shot['seconds']) * fps))
    cap = caption_filter(shot.get('caption', ''), w, h, work, shot['n']) if captions else ''
    if shot.get('clip'):
        src = Path(sources) / shot['clip']
        vf = (f"scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h},fps={fps},"
              f"tpad=stop_mode=clone:stop_duration={float(shot['seconds']) + 1},trim=end_frame={frames},setpts=PTS-STARTPTS,format=yuv420p{cap}")
        ff('-i', str(src), '-an', '-vf', vf, '-frames:v', str(frames), *encode_args(fps), str(out))
    else:
        src = Path(sources) / shot['image']
        z, x, y = motion_expr(shot.get('motion', 'push_in'), int(shot.get('variant', 0)), frames, w, h)
        # Scale the picture up first so the move stays sharp, then crop/zoom to the frame.
        big_w, big_h = w * 2, h * 2
        vf = (f"scale={big_w}:{big_h}:force_original_aspect_ratio=increase,crop={big_w}:{big_h},"
              f"zoompan=z='{z}':x='{x}':y='{y}':d={frames}:s={w}x{h}:fps={fps},format=yuv420p{cap}")
        ff('-loop', '1', '-i', str(src), '-vf', vf, '-frames:v', str(frames), *encode_args(fps), str(out))
    return out


def score(seconds, mood, gain, path):
    """A quiet synthesized pad (three slow sine voices with a gentle swell). Labelled a simple score, nothing more."""
    chord = {'cinematic': (110, 164.81, 220), 'calm': (130.81, 196, 261.63)}.get(mood, (110, 164.81, 220))
    expr = '+'.join(f"0.3*sin(2*PI*{f}*t)*(0.6+0.4*sin(2*PI*0.05*t+{i}))" for i, f in enumerate(chord))
    ff('-f', 'lavfi', '-i', f"aevalsrc='{expr}':s=48000:d={seconds}", '-af', f"volume={gain},afade=t=in:d=2,afade=t=out:st={max(0, seconds - 2)}:d=2",
       '-ac', '2', '-c:a', 'pcm_s16le', str(path))


def segment(spec, sources, out, report=None):
    t0 = time.time()
    w, h, fps = int(spec['width']) // SCALE, int(spec['height']) // SCALE, int(spec.get('fps', 24))
    seconds = float(spec['seconds'])
    work = tempfile.mkdtemp(prefix='che-film-')
    try:
        with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, os.cpu_count() or 2)) as pool:
            parts = list(pool.map(lambda s: render_shot(s, sources, w, h, fps, work, spec.get('captions', True)), spec['shots']))
        listing = Path(work) / 'shots.txt'
        listing.write_text(''.join(f"file '{p}'\n" for p in parts))
        silent = Path(work) / 'video.mp4'
        ff('-f', 'concat', '-safe', '0', '-i', str(listing), '-c', 'copy', str(silent))
        music = Path(work) / 'score.wav'
        m = spec.get('music') or {}
        score(seconds, m.get('mood', 'calm'), float(m.get('gain', 0.18)), music)
        inputs, filters = ['-i', str(silent), '-i', str(music)], []
        labels = ['[1:a]']
        for i, line in enumerate(spec.get('audio', [])):
            inputs += ['-i', str(Path(sources) / line['key'])]
            ms = int(float(line['at']) * 1000)
            filters.append(f"[{i + 2}:a]aresample=48000,aformat=channel_layouts=stereo,volume={float(line.get('gain', 1))},adelay={ms}|{ms}[v{i}]")
            labels.append(f'[v{i}]')
        filters.append(f"{''.join(labels)}amix=inputs={len(labels)}:normalize=0:duration=longest,apad,atrim=end={seconds},asetpts=PTS-STARTPTS[aout]")
        ff(*inputs, '-filter_complex', ';'.join(filters), '-map', '0:v', '-map', '[aout]', '-c:v', 'copy',
           '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2', '-t', f'{seconds:.3f}', str(out))
        facts = probe(out)
        timing = {'segment': spec.get('segment'), 'encode_s': round(time.time() - t0, 2), 'video_s': facts['seconds']}
        if report:
            Path(report).write_text(json.dumps(timing))
        return {**facts, **timing}
    finally:
        shutil.rmtree(work, ignore_errors=True)


def concat(paths, out, expected=None):
    t0 = time.time()
    work = tempfile.mkdtemp(prefix='che-film-join-')
    try:
        listing = Path(work) / 'segments.txt'
        listing.write_text(''.join(f"file '{Path(p).resolve()}'\n" for p in paths))
        ff('-f', 'concat', '-safe', '0', '-i', str(listing), '-c', 'copy', '-movflags', '+faststart', str(out))
        facts = probe(out)
        if facts['video'] != 'h264' or facts['audio'] != 'aac':
            raise RuntimeError(f"joined film is {facts['video']}/{facts['audio']}, not h264/aac")
        if expected and abs(facts['seconds'] - float(expected)) > max(2.0, float(expected) * 0.02):
            raise RuntimeError(f"joined film is {facts['seconds']} s, expected {expected}")
        return {**facts, 'finish_s': round(time.time() - t0, 2)}
    finally:
        shutil.rmtree(work, ignore_errors=True)


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest='cmd', required=True)
    s = sub.add_parser('segment'); s.add_argument('--spec', required=True); s.add_argument('--sources', required=True); s.add_argument('--out', required=True); s.add_argument('--report')
    c = sub.add_parser('concat'); c.add_argument('--out', required=True); c.add_argument('--expected'); c.add_argument('paths', nargs='+')
    a = ap.parse_args()
    try:
        if a.cmd == 'segment':
            result = segment(json.loads(Path(a.spec).read_text()), a.sources, a.out, a.report)
        else:
            result = concat(a.paths, a.out, a.expected)
    except Exception as error:
        print(f'render failed: {error}', file=sys.stderr)
        sys.exit(1)
    print(json.dumps(result))


if __name__ == '__main__':
    main()

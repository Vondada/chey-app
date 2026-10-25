"""Turns a rendered sample (tools/cinematic/sample.py output) into an MP4: H.264 video + AAC audio, the speech line
placed where the face animation expects it, and honest captions burned in (what is a Blender render of the rig, what
each segment shows).

  python3 mux.py --dir OUT --line-wav che_line.wav [--out OUT/che_realism_sample.mp4]
  python3 mux.py --merge SHARDS --dir OUT --line-wav che_line.wav     (CI: join the shard folders first)

--merge copies every shard's frames into OUT/frames, refuses to continue if any frame of the timeline is missing,
and writes OUT/receipt.json: shard 0's scene receipt plus every frame's render time and each shard's device, wall
time and peak memory. The rigged GLB comes from shard 0.
"""
import argparse
import glob
import json
import os
import shutil
import subprocess
import wave

FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'
CAPTIONS = {
    'wide': 'Motion: CMU mocap (86_15) retargeted to CHE\'s 53-bone rig, blended, foot-locked',
    'medium': 'Seated gestures: mocap upper body + procedural finger curl + breathing',
    'closeup': 'Face: Rhubarb visemes from the Kokoro TTS line, blinks, saccades, expression blends',
    'skeleton': 'Skeleton overlay: the same armature driving the mesh (bones drawn from the rig)',
}
FOOTER = 'Blender 5.0.1 Cycles (CPU) render of CHE\'s rigged 3D model - not AI-generated video'


def load(path):
    with open(path) as f: return json.load(f)


def save(obj, path):
    with open(path, 'w') as f: json.dump(obj, f, indent=1)


def esc(t):
    return t.replace('\\', '\\\\').replace(':', '\\:').replace("'", "’")


def merge(shards_dir, out):
    """Joins shard folders (each a sample.py --shard output) into `out`. Returns the merged receipt."""
    dirs = sorted(d for d in glob.glob(os.path.join(shards_dir, '*')) if os.path.isfile(os.path.join(d, 'receipt.json')))
    if not dirs: raise SystemExit(f'no shard receipts under {shards_dir}')
    recs = [load(os.path.join(d, 'receipt.json')) for d in dirs]
    base = next((r for r, d in zip(recs, dirs) if os.path.exists(os.path.join(d, 'che_interactive.glb'))), recs[0])
    os.makedirs(os.path.join(out, 'frames'), exist_ok=True)
    frames, shard_info = {}, []
    for r, d in zip(recs, dirs):
        for p in glob.glob(os.path.join(d, 'frames', '*.png')):
            shutil.copy2(p, os.path.join(out, 'frames', os.path.basename(p)))
        frames.update({int(k): v for k, v in (r.get('frame_seconds') or {}).items()})
        shard_info.append({'dir': os.path.basename(d), 'frames': r.get('render', {}).get('frames'), 'device': r.get('device'),
                           'total_seconds': r.get('total_seconds'), 'peak_rss_gb': r.get('peak_rss_gb'),
                           'stage_seconds': r.get('stage_seconds'), 'load_avg_1m': r.get('load_avg_1m')})
        for name in ('che_interactive.glb', 'interactive.json', 'che_line_rhubarb.json'):
            src = os.path.join(d, name)
            if os.path.exists(src) and not os.path.exists(os.path.join(out, name)): shutil.copy2(src, os.path.join(out, name))
    n = base['timeline']['frames']
    have = {int(os.path.splitext(f)[0]) for f in os.listdir(os.path.join(out, 'frames')) if f.endswith('.png')}
    missing = sorted(set(range(n)) - have)
    if missing: raise SystemExit(f'{len(missing)} of {n} frames missing (first {missing[:10]}); not muxing a partial sample')
    rec = dict(base)
    rec['frame_seconds'] = {str(k): frames[k] for k in sorted(frames)}
    rec['shards'] = shard_info
    rec['render_seconds_total'] = round(sum(frames.values()), 1)
    rec['wall_seconds_longest_shard'] = max((s['total_seconds'] or 0) for s in shard_info)
    save(rec, os.path.join(out, 'receipt.json'))
    return rec


def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--dir', required=True); ap.add_argument('--line-wav', required=True); ap.add_argument('--out')
    ap.add_argument('--merge', help='folder of shard outputs to join into --dir first')
    a = ap.parse_args()
    if a.merge: merge(a.merge, a.dir)
    rec = load(os.path.join(a.dir, 'receipt.json'))
    fps = rec['fps']; n = rec['timeline']['frames']; dur = n / fps
    out = a.out or os.path.join(a.dir, 'che_realism_sample.mp4')
    t_speech = rec['face']['speech_s'][0]
    with wave.open(a.line_wav) as w: sr = w.getframerate()
    track = os.path.join(a.dir, 'audio_track.wav')
    subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-i', a.line_wav, '-af', f'adelay={int(t_speech * 1000)}:all=1,apad',
                    '-t', f'{dur:.3f}', '-ar', str(sr), '-ac', '1', track], check=True)
    draw = []
    for s in rec['shots']:
        cap = CAPTIONS.get(s['name'])
        if not cap: continue
        draw.append(f"drawtext=fontfile={FONT}:text='{esc(cap)}':x=24:y=22:fontsize=h/34:fontcolor=white:box=1:boxcolor=black@0.45:boxborderw=8:"
                    f"enable='between(t,{s['start_s']},{s['end_s']})'")
    draw.append(f"drawtext=fontfile={FONT}:text='{esc(FOOTER)}':x=24:y=h-th-20:fontsize=h/42:fontcolor=white@0.9:box=1:boxcolor=black@0.4:boxborderw=6")
    cmd = ['ffmpeg', '-loglevel', 'error', '-y', '-framerate', str(fps), '-i', os.path.join(a.dir, 'frames', '%04d.png'), '-i', track,
           '-vf', ','.join(draw), '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k',
           '-movflags', '+faststart', '-shortest', out]
    subprocess.run(cmd, check=True)
    probe = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'stream=codec_name,width,height,r_frame_rate,duration,nb_frames', '-of', 'json', out],
                           capture_output=True, text=True).stdout
    streams = json.loads(probe).get('streams', [])
    rec['mp4'] = {'file': os.path.basename(out), 'bytes': os.path.getsize(out), 'streams': streams}
    save(rec, os.path.join(a.dir, 'receipt.json'))
    print('MP4', out, os.path.getsize(out), 'bytes', json.dumps(streams), flush=True)


if __name__ == '__main__':
    main()

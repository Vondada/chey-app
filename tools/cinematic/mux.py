"""Turns a rendered sample (tools/cinematic/sample.py output) into an MP4: H.264 video + AAC audio, the speech line
placed where the face animation expects it, and honest captions burned in (what is a Blender render of the rig, what
each segment shows).

  python3 mux.py --dir OUT --line-wav che_line.wav [--out OUT/che_realism_sample.mp4]
"""
import argparse
import json
import os
import subprocess
import wave

FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'
CAPTIONS = {
    'wide': 'Motion: CMU mocap (86_15) retargeted to CHE\'s 53-bone rig, blended, foot-locked',
    'medium': 'Seated gestures: mocap upper body + procedural finger curl + breathing',
    'closeup': 'Face: Rhubarb visemes from Kokoro TTS, blinks, saccades, expression blends',
    'skeleton': 'Skeleton overlay: the same armature driving the mesh (bones drawn from the rig)',
}
FOOTER = 'Blender 5.0.1 Cycles (CPU) render of CHE\'s rigged 3D model - not AI-generated video'


def esc(t):
    return t.replace('\\', '\\\\').replace(':', '\\:').replace("'", "’")


def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--dir', required=True); ap.add_argument('--line-wav', required=True); ap.add_argument('--out')
    a = ap.parse_args()
    rec = json.load(open(os.path.join(a.dir, 'receipt.json')))
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
    probe = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'stream=codec_name,width,height,r_frame_rate,duration', '-of', 'json', out],
                           capture_output=True, text=True).stdout
    print('MP4', out, os.path.getsize(out), 'bytes', json.dumps(json.loads(probe).get('streams', [])), flush=True)


if __name__ == '__main__':
    main()

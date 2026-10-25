"""Join the captured frames and the speech into the demo video (H.264 + AAC, 1280x720, 24 fps), plus key frames and a
contact sheet.

  python3 tools/demo/assemble.py BUILD_DIR OUT_DIR

Needs ffmpeg. Writes OUT_DIR/che_create_room_demo.mp4, OUT_DIR/key_<segment>.png (the middle frame of each segment)
and OUT_DIR/contact_sheet.png (one frame per segment, 4 x 3).
"""
import json
import os
import shutil
import subprocess
import sys


def ff(*args):
    subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', *args], check=True)


def main():
    build, out = sys.argv[1], sys.argv[2]
    os.makedirs(out, exist_ok=True)
    tl = json.load(open(os.path.join(build, 'timeline.json')))
    parts = os.path.join(build, 'parts'); os.makedirs(parts, exist_ok=True)
    lst = []
    for seg in tl['segments']:
        sid, dur = seg['id'], seg['duration']
        n = len([f for f in os.listdir(os.path.join(build, 'frames', sid)) if f.endswith('.jpg')])
        dur = n / 24.0
        p = os.path.join(parts, sid + '.mp4')
        ff('-framerate', '24', '-i', os.path.join(build, 'frames', sid, '%05d.jpg'), '-i', os.path.join(build, 'audio', sid + '.wav'),
           '-vf', f'fade=t=in:st=0:d=0.25,fade=t=out:st={dur - 0.25:.3f}:d=0.25,format=yuv420p', '-af', 'apad', '-t', f'{dur:.3f}',
           '-c:v', 'libx264', '-preset', 'medium', '-crf', '21', '-profile:v', 'high', '-r', '24',
           '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2', p)
        lst.append(p)
        ff('-ss', f'{dur / 2:.2f}', '-i', p, '-frames:v', '1', os.path.join(out, f'key_{sid}.png'))
    with open(os.path.join(parts, 'list.txt'), 'w') as f:
        f.write(''.join(f"file '{p}'\n" for p in lst))
    video = os.path.join(out, 'che_create_room_demo.mp4')
    ff('-f', 'concat', '-safe', '0', '-i', os.path.join(parts, 'list.txt'), '-c', 'copy', '-movflags', '+faststart', video)
    keys = [os.path.join(out, f"key_{s['id']}.png") for s in tl['segments']]
    inputs = sum((['-i', k] for k in keys), [])
    k = len(keys); cols = 4; rows = (k + cols - 1) // cols
    layout = '|'.join(f'{(i % cols) * 320}_{(i // cols) * 180}' for i in range(k))
    scaled = ''.join(f'[{i}]scale=320:180[s{i}];' for i in range(k))
    ff(*inputs, '-filter_complex', scaled + ''.join(f'[s{i}]' for i in range(k)) + f'xstack=inputs={k}:layout={layout}:fill=black',
       os.path.join(out, 'contact_sheet.png'))
    print(video, os.path.getsize(video))


if __name__ == '__main__':
    main()

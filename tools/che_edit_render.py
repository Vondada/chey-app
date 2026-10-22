#!/usr/bin/env python3
"""CHE Visual Studio renderer: turns an edit document into a real file, then checks the file.

Video: ffmpeg trims, speeds, crops, colour-adjusts, joins clips with transitions, draws text and captions, mixes
clip audio, voice and music (volume, fades, normalising, voice clean-up, ducking) and writes an H.264/AAC MP4.
Image: Pillow applies the same adjustments, crop, rotation and flips, then draws the layers and writes a PNG.

Nothing is "ready" until the output is re-opened and measured: the MP4 with ffprobe (codecs, frame size,
duration), the PNG with Pillow (size). The manifest records what was measured. No paid service is used.
"""
import argparse, json, math, os, shutil, subprocess, sys, tempfile
from pathlib import Path

FONT_BOLD = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'
FONT_REG = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'
XFADE = {'fade': 'fade', 'dissolve': 'dissolve', 'slide': 'slideleft', 'zoom': 'zoomin'}
TEXT_STYLES = {  # mirrors visual_studio.js TEXT_STYLES for captions
    'caption_clean': {'size': 0.045, 'weight': 600, 'color': '#FFFFFF', 'shadow': True},
    'caption_bold': {'size': 0.055, 'weight': 900, 'color': '#FFFFFF', 'outline': 0.005},
    'caption_minimal': {'size': 0.038, 'weight': 500, 'color': '#FFFFFF', 'box': '#00000088'},
    'caption_karaoke': {'size': 0.055, 'weight': 900, 'color': '#FFFFFF', 'outline': 0.005},
}


def run(cmd):
    p = subprocess.run(cmd, capture_output=True, text=True)
    if p.returncode != 0:
        raise RuntimeError(f'{Path(cmd[0]).name} failed: {p.stderr.strip()[-1500:]}')
    return p.stdout


def probe(path):
    out = run(['ffprobe', '-v', 'error', '-show_streams', '-show_format', '-of', 'json', str(path)])
    return json.loads(out)


def has_audio(path):
    try:
        return any(s.get('codec_type') == 'audio' for s in probe(path)['streams'])
    except Exception:
        return False


def media_seconds(path):
    try:
        return float(probe(path)['format'].get('duration') or 0)
    except Exception:
        return 0.0


def source(sources, asset):
    if not asset:
        raise RuntimeError('a clip or layer has no media')
    hits = sorted(Path(sources).glob(f'{asset}*'))
    if not hits:
        raise RuntimeError(f'source {asset} was not downloaded')
    return hits[0]


def color(value, default='#FFFFFF'):
    v = str(value or default).lstrip('#')
    if len(v) == 6:
        v += 'FF'
    return '0x' + v[:6], int(v[6:8], 16) / 255


# ─── Colour adjustments ─────────────────────────────────────────────────────

def merged_adjust(doc, clip=None):
    out = dict(doc.get('adjust') or {})
    for k, v in ((clip or {}).get('adjust') or {}).items():
        out[k] = out.get(k, 0) + v
    return out


def ffmpeg_adjust(a):
    """The same parameters CHE shows, as ffmpeg filters."""
    f = []
    b, c, s = a.get('brightness', 0), a.get('contrast', 0), a.get('saturation', 0) + 0.5 * a.get('vibrance', 0)
    e = a.get('exposure', 0)
    if b or c or s or e:
        f.append(f"eq=brightness={b / 100 * 0.25:.4f}:contrast={1 + c / 100 * 0.6:.4f}:saturation={max(0, 1 + s / 100):.4f}:gamma={max(0.1, 1 + e / 100 * 0.5):.4f}")
    sh, hl, fade = a.get('shadows', 0), a.get('highlights', 0), a.get('fade', 0)
    if sh or hl or fade:
        lo = min(0.4, fade / 100 * 0.2)
        p25 = min(1, max(0, 0.25 + sh * 0.0015))
        p75 = min(1, max(0, 0.75 + hl * 0.0015))
        f.append(f"curves=all='0/{lo:.3f} 0.25/{p25:.3f} 0.75/{p75:.3f} 1/1'")
    t = a.get('temperature', 0)
    if t:
        f.append(f'colortemperature=temperature={int(6500 - t * 25)}')
    tint = a.get('tint', 0)
    if tint:
        f.append(f'colorbalance=gm={-tint * 0.003:.4f}')
    if a.get('sharpness', 0):
        f.append(f"unsharp=5:5:{a['sharpness'] / 100 * 1.5:.3f}")
    if a.get('clarity', 0):
        f.append(f"unsharp=13:13:{a['clarity'] / 100:.3f}")
    if a.get('blur', 0):
        f.append(f"gblur=sigma={a['blur'] / 100 * 20:.2f}")
    if a.get('vignette', 0):
        f.append(f"vignette=angle={a['vignette'] / 100 * math.pi / 3:.4f}")
    return f


# ─── Video ──────────────────────────────────────────────────────────────────

def clip_len(c):
    return max(0.0, (c['out'] - c['in']) / (c.get('speed') or 1)) + ((c.get('freeze') or {}).get('duration') or 0)


def atempo(speed):
    parts, s = [], speed
    while s > 2.0:
        parts.append('atempo=2.0'); s /= 2.0
    while s < 0.5:
        parts.append('atempo=0.5'); s /= 0.5
    parts.append(f'atempo={s:.4f}')
    return parts


def drawtext(layer, W, H, start, end, workdir, n, value=None):
    t = layer.get('text') or {}
    text = value if value is not None else t.get('value', '')
    path = Path(workdir) / f'text{n}.txt'
    path.write_text(text, encoding='utf-8')
    size = max(8, int((t.get('size') or 0.05) * H))
    col, alpha = color(t.get('color'))
    font = FONT_BOLD if (t.get('weight') or 400) >= 700 else FONT_REG
    x0, w = layer.get('x', 0.1) * W, layer.get('w', 0.8) * W
    x = {'center': f'{x0 + w / 2:.1f}-text_w/2', 'right': f'{x0 + w:.1f}-text_w'}.get(t.get('align'), f'{x0:.1f}')
    y = f"{layer.get('y', 0.1) * H:.1f}"
    opts = [f"fontfile={font}", f"textfile={path}", f"fontsize={size}", f"fontcolor={col}", f"x={x}", f"y={y}",
            f"enable='between(t,{start:.3f},{end:.3f})'"]
    anim = layer.get('animation', 'none')
    op = layer.get('opacity', 1) * alpha
    if anim == 'fade_in' or anim == 'pop':
        opts.append(f"alpha='{op:.3f}*min(1,max(0,(t-{start:.3f})/0.4))'")
    elif anim == 'fade_out':
        opts.append(f"alpha='{op:.3f}*min(1,max(0,({end:.3f}-t)/0.4))'")
    elif op < 1:
        opts.append(f'alpha={op:.3f}')
    if t.get('outline'):
        oc, _ = color(t['outline'].get('color', '#000000'))
        opts += [f"borderw={max(1, int(t['outline'].get('width', 0.004) * H))}", f'bordercolor={oc}']
    if t.get('shadow'):
        sc, _ = color(t['shadow'].get('color', '#000000'))
        opts += [f'shadowcolor={sc}', 'shadowx=3', 'shadowy=3']
    if t.get('background'):
        bc, ba = color(t['background'].get('color', '#000000AA'))
        opts += ['box=1', f'boxcolor={bc}@{ba:.2f}', f'boxborderw={max(4, size // 4)}']
    return 'drawtext=' + ':'.join(opts)


def render_video(spec, sources, out, workdir):
    doc = spec['doc']
    W, H, fps = doc['canvas']['w'], doc['canvas']['h'], doc['canvas'].get('fps', 30)
    clips = doc['clips']
    if not clips:
        raise RuntimeError('the timeline has no clips')
    args, graph, idx = [], [], 0
    lengths = []
    for i, c in enumerate(clips):
        path = source(sources, c['asset'])
        src_len = c['out'] - c['in']
        if c.get('kind') == 'image':
            args += ['-loop', '1', '-framerate', str(fps), '-t', f'{src_len:.3f}', '-i', str(path)]
        else:
            args += ['-ss', f"{c['in']:.3f}", '-t', f'{src_len:.3f}', '-i', str(path)]
        speed = c.get('speed') or 1
        L = clip_len(c)
        lengths.append(L)
        vf = []
        if c.get('reverse'):
            vf.append('reverse')
        vf.append(f'setpts=(PTS-STARTPTS)/{speed:.4f}')
        if c.get('crop'):
            k = c['crop']
            vf.append(f"crop=iw*{k['w']:.4f}:ih*{k['h']:.4f}:iw*{k['x']:.4f}:ih*{k['y']:.4f}")
        rot = c.get('rotate', 0) % 360
        vf += {90: ['transpose=1'], 180: ['transpose=1', 'transpose=1'], 270: ['transpose=2']}.get(rot, [])
        vf.append(f'scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H}')
        vf += ffmpeg_adjust(merged_adjust(doc, c))
        if (c.get('opacity', 1)) < 1:
            o = c['opacity']
            vf.append(f'colorchannelmixer=rr={o}:gg={o}:bb={o}')
        vf.append(f'fps={fps}')
        if c.get('freeze'):
            # Hold the frame at freeze.at (seconds into the clip's source) for freeze.duration, then play on.
            fz = c['freeze']
            at = max(0.0, min(float(fz.get('at') or 0), src_len))
            at = (src_len - at) if c.get('reverse') else at
            start = int(round(at / speed * fps))
            vf += [f"loop=loop={max(1, int(round(float(fz['duration']) * fps)))}:size=1:start={start}", f'setpts=N/({fps}*TB)']
        vf += ['format=yuv420p', 'setsar=1', f'trim=duration={L:.3f}', 'setpts=PTS-STARTPTS']
        graph.append(f'[{idx}:v]' + ','.join(vf) + f'[v{i}]')
        if c.get('kind') != 'image' and not c.get('muted') and has_audio(path):
            af = (['areverse'] if c.get('reverse') else []) + atempo(speed) + [f"volume={c.get('volume', 1):.3f}", 'aresample=48000', 'aformat=channel_layouts=stereo', 'apad', f'atrim=duration={L:.3f}', 'asetpts=PTS-STARTPTS']
            graph.append(f'[{idx}:a]' + ','.join(af) + f'[a{i}]')
        else:
            graph.append(f'anullsrc=r=48000:cl=stereo,atrim=duration={L:.3f}[a{i}]')
        idx += 1
    # Join clips: cuts concatenate, transitions overlap with xfade/acrossfade.
    cur_v, cur_a, total = '[v0]', '[a0]', lengths[0]
    for i in range(1, len(clips)):
        tr = clips[i - 1].get('transition') or {'type': 'cut', 'duration': 0}
        nv, na = f'[vj{i}]', f'[aj{i}]'
        if tr['type'] == 'cut' or not tr.get('duration'):
            graph.append(f'{cur_v}[v{i}]concat=n=2:v=1:a=0{nv}')
            graph.append(f'{cur_a}[a{i}]concat=n=2:v=0:a=1{na}')
            total += lengths[i]
        else:
            d = float(tr['duration'])
            graph.append(f"{cur_v}[v{i}]xfade=transition={XFADE[tr['type']]}:duration={d:.3f}:offset={total - d:.3f}{nv}")
            graph.append(f'{cur_a}[a{i}]acrossfade=d={d:.3f}{na}')
            total += lengths[i] - d
        cur_v, cur_a = nv, na
    # Text, captions and a waveform visualizer on top.
    overlays, n = [], 0
    for item in doc.get('text', []):
        if item['layer'].get('hidden') or not (item['layer'].get('text') or {}).get('value'):
            continue
        overlays.append(drawtext(item['layer'], W, H, item.get('start', 0), min(total, item.get('end', total)), workdir, n)); n += 1
    cap = doc.get('captions') or {}
    st = TEXT_STYLES.get(cap.get('style'), TEXT_STYLES['caption_clean'])
    for cue in cap.get('cues', []):
        layer = {'x': 0.06, 'w': 0.88, 'y': cap.get('position', 0.78), 'text': {'value': cue['text'], 'size': st['size'] * cap.get('scale', 1), 'weight': st['weight'], 'color': st['color'], 'align': 'center',
                 'outline': {'width': st['outline']} if st.get('outline') else None, 'shadow': {} if st.get('shadow') else None, 'background': {'color': st['box']} if st.get('box') else None}}
        overlays.append(drawtext(layer, W, H, cue['start'], cue['end'], workdir, n)); n += 1
    if overlays:
        graph.append(f'{cur_v}' + ','.join(overlays) + '[vt]'); cur_v = '[vt]'
    # Separate audio tracks.
    tracks = []
    for j, a in enumerate(doc.get('audio', [])):
        path = source(sources, a['asset'])
        args += ['-i', str(path)]
        start_in, end_in = a.get('in', 0), a.get('out')
        length = (end_in if end_in is not None else media_seconds(path)) - start_in
        length = max(0.1, min(length, total - a.get('start', 0)))
        af = [f'atrim=start={start_in:.3f}:duration={length:.3f}', 'asetpts=PTS-STARTPTS', 'aresample=48000', 'aformat=channel_layouts=stereo']
        if a.get('clean'):
            af += ['highpass=f=80', 'afftdn=nf=-25']
        if a.get('eq'):
            for freq, key in ((120, 'low'), (1000, 'mid'), (8000, 'high')):
                if a['eq'].get(key):
                    af.append(f"equalizer=f={freq}:t=q:w=1:g={a['eq'][key]}")
        if a.get('normalize'):
            af.append('loudnorm=I=-14:TP=-1.5:LRA=11')
        af.append(f"volume={0 if a.get('muted') else a.get('volume', 1):.3f}")
        if a.get('fade_in'):
            af.append(f"afade=t=in:st=0:d={a['fade_in']:.3f}")
        if a.get('fade_out'):
            af.append(f"afade=t=out:st={max(0, length - a['fade_out']):.3f}:d={a['fade_out']:.3f}")
        if a.get('start'):
            ms = int(a['start'] * 1000)
            af.append(f'adelay={ms}|{ms}')
        graph.append(f'[{idx}:a]' + ','.join(af) + f'[t{j}]')
        tracks.append((a, f'[t{j}]'))
        idx += 1
    # Visualizer from the music.
    vis = doc.get('visualizer')
    music = [t for a, t in tracks if a.get('role') == 'music']
    if vis and vis.get('kind') in ('waveform', 'spectrum') and music:
        src = music[0]
        graph.append(f'{src}asplit=2[mvis]{src.replace("[", "[keep")}')
        tracks = [(a, (t if t != src else src.replace('[', '[keep'))) for a, t in tracks]
        vh = max(16, int(vis.get('h', 0.1) * H) // 2 * 2)
        col = '0x' + vis.get('color', '#7FF5E6').lstrip('#')[:6]
        if vis['kind'] == 'waveform':
            graph.append(f'[mvis]showwaves=s={W}x{vh}:mode=cline:rate={fps}:colors={col},format=rgba,colorkey=0x000000:0.1:0.0[wave]')
        else:
            graph.append(f'[mvis]showfreqs=s={W}x{vh}:mode=bar:fscale=log:colors={col},format=rgba,colorkey=0x000000:0.1:0.0[wave]')
        graph.append(f"{cur_v}[wave]overlay=0:{int(vis.get('y', 0.6) * H)}:shortest=1[vw]")
        cur_v = '[vw]'
    # Duck music under speech (clip audio and voice tracks).
    voices = [t for a, t in tracks if a.get('role') == 'voice']
    musics = [(a, t) for a, t in tracks if a.get('role') != 'voice']
    speech = cur_a
    if voices:
        graph.append(f"{cur_a}{''.join(voices)}amix=inputs={1 + len(voices)}:normalize=0:duration=first[speech]")
        speech = '[speech]'
    mixed = [speech]
    duck = [t for a, t in musics if a.get('duck')]
    plain = [t for a, t in musics if not a.get('duck')]
    if duck:
        graph.append(f'{speech}asplit=2[sp1][sp2]')
        mixed = ['[sp1]']
        for k, t in enumerate(duck):
            side = '[sp2]' if k == 0 else f'[sp2c{k}]'
            if k < len(duck) - 1:
                graph.append(f'{side}asplit=2[sp2u{k}][sp2c{k + 1}]'); side = f'[sp2u{k}]'
            graph.append(f'{t}{side}sidechaincompress=threshold=0.05:ratio=8:attack=20:release=300[d{k}]')
            mixed.append(f'[d{k}]')
    mixed += plain
    if len(mixed) > 1:
        graph.append(f"{''.join(mixed)}amix=inputs={len(mixed)}:normalize=0:duration=first,atrim=duration={total:.3f}[aout]")
    else:
        graph.append(f'{mixed[0]}atrim=duration={total:.3f}[aout]')
    graph.append(f'{cur_v}trim=duration={total:.3f},setpts=PTS-STARTPTS[vout]')
    video = Path(out) / 'video.mp4'
    script = Path(workdir) / 'graph.txt'
    script.write_text(';\n'.join(graph))
    run(['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error', *args, '-filter_complex_script', str(script), '-map', '[vout]', '-map', '[aout]',
         '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', str(fps), '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', '-t', f'{total:.3f}', str(video)])
    facts = verify_video(video, W, H, total)
    thumb = Path(out) / 'thumbnail.png'
    run(['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error', '-ss', f'{min(1.0, total / 2):.2f}', '-i', str(video), '-frames:v', '1', str(thumb)])
    return {'kind': 'video', 'file': 'video.mp4', **facts, 'expected_seconds': round(total, 3)}


def verify_video(path, W, H, expected):
    """The rendered file, measured: it must open, be H.264 + AAC at the canvas size, and last as long as the timeline."""
    info = probe(path)
    v = next((s for s in info['streams'] if s['codec_type'] == 'video'), None)
    a = next((s for s in info['streams'] if s['codec_type'] == 'audio'), None)
    seconds = float(info['format'].get('duration') or 0)
    problems = []
    if not v or v.get('codec_name') != 'h264':
        problems.append('no H.264 video stream')
    if not a or a.get('codec_name') != 'aac':
        problems.append('no AAC audio stream')
    if v and (v.get('width') != W or v.get('height') != H):
        problems.append(f"frame is {v.get('width')}x{v.get('height')}, not {W}x{H}")
    if abs(seconds - expected) > 0.35:
        problems.append(f'lasts {seconds:.2f} s, not {expected:.2f} s')
    # Decode every frame once: a file that only has a valid header fails here.
    run(['ffmpeg', '-v', 'error', '-i', str(path), '-f', 'null', '-'])
    if problems:
        raise RuntimeError('render check failed: ' + '; '.join(problems))
    return {'status': 'verified', 'video_width': W, 'video_height': H, 'duration_seconds': round(seconds, 3), 'video_codec': 'h264', 'audio_codec': 'aac', 'bytes': Path(path).stat().st_size}


# ─── Image ──────────────────────────────────────────────────────────────────

def pil_adjust(img, a):
    from PIL import Image, ImageEnhance, ImageFilter, ImageChops
    img = img.convert('RGB')
    if a.get('exposure'):
        g = max(0.1, 1 + a['exposure'] / 100 * 0.5)
        img = img.point(lambda v: int(255 * ((v / 255) ** (1 / g))))
    if a.get('brightness'):
        img = ImageEnhance.Brightness(img).enhance(1 + a['brightness'] / 100 * 0.5)
    if a.get('contrast'):
        img = ImageEnhance.Contrast(img).enhance(1 + a['contrast'] / 100 * 0.6)
    s = a.get('saturation', 0) + 0.5 * a.get('vibrance', 0)
    if s:
        img = ImageEnhance.Color(img).enhance(max(0, 1 + s / 100))
    sh, hl, fade = a.get('shadows', 0), a.get('highlights', 0), a.get('fade', 0)
    if sh or hl or fade:
        lo = fade / 100 * 0.2 * 255
        def curve(v):
            x = v / 255
            if x < 0.5:
                x += sh * 0.0015 * max(0.0, 1 - abs(x - 0.25) / 0.25)
            else:
                x += hl * 0.0015 * max(0.0, 1 - abs(x - 0.75) / 0.25)
            return int(max(lo, min(255, x * 255)))
        img = img.point(curve)
    t, tint = a.get('temperature', 0), a.get('tint', 0)
    if t or tint:
        r, g, b = img.split()
        r = r.point(lambda v: min(255, int(v * (1 + t / 400))))
        b = b.point(lambda v: min(255, int(v * (1 - t / 400))))
        g = g.point(lambda v: min(255, int(v * (1 - tint / 500))))
        img = Image.merge('RGB', (r, g, b))
    if a.get('sharpness'):
        img = ImageEnhance.Sharpness(img).enhance(1 + a['sharpness'] / 100 * 1.5)
    if a.get('clarity'):
        img = img.filter(ImageFilter.UnsharpMask(radius=6, percent=int(a['clarity'] * 1.2), threshold=2))
    if a.get('blur'):
        img = img.filter(ImageFilter.GaussianBlur(a['blur'] / 100 * 12))
    if a.get('vignette'):
        w, h = img.size
        mask = Image.radial_gradient('L').resize((w, h))
        dark = Image.new('RGB', (w, h), (0, 0, 0))
        mask = mask.point(lambda v: int(v * a['vignette'] / 100))
        img = Image.composite(dark, img, mask)
    return img


def cover(img, w, h, focus=None):
    from PIL import Image
    fx, fy = (focus or {}).get('x', 0.5), (focus or {}).get('y', 0.5)
    scale = max(w / img.width, h / img.height)
    img = img.resize((max(1, round(img.width * scale)), max(1, round(img.height * scale))), Image.LANCZOS)
    left = int(min(max(0, fx * img.width - w / 2), img.width - w))
    top = int(min(max(0, fy * img.height - h / 2), img.height - h))
    return img.crop((left, top, left + w, top + h))


def render_image(spec, sources, out):
    from PIL import Image, ImageDraw, ImageFont, ImageFilter, ImageOps
    doc = spec['doc']
    W, H = doc['canvas']['w'], doc['canvas']['h']
    bg = doc['canvas'].get('background', '#000000').lstrip('#')
    canvas = Image.new('RGBA', (W, H), tuple(int(bg[i:i + 2], 16) for i in (0, 2, 4)) + (255,))
    tf = doc.get('transform') or {}
    for layer in doc.get('layers', []):
        if layer.get('hidden'):
            continue
        x, y, w, h = int(layer['x'] * W), int(layer['y'] * H), max(1, int(layer['w'] * W)), max(1, int(layer['h'] * H))
        if layer['type'] in ('photo', 'background', 'image', 'logo', 'sticker'):
            img = Image.open(source(sources, layer['asset']))
            img = ImageOps.exif_transpose(img)
            if layer['type'] in ('photo', 'background'):
                k = tf.get('crop') or {'x': 0, 'y': 0, 'w': 1, 'h': 1}
                img = img.crop((int(k['x'] * img.width), int(k['y'] * img.height), int((k['x'] + k['w']) * img.width), int((k['y'] + k['h']) * img.height)))
                if tf.get('flip_h'):
                    img = ImageOps.mirror(img)
                if tf.get('flip_v'):
                    img = ImageOps.flip(img)
                angle = -(tf.get('rotate', 0) + tf.get('straighten', 0))
                if angle:
                    img = img.rotate(angle, expand=bool(tf.get('rotate', 0) % 180), resample=Image.BICUBIC)
                img = pil_adjust(img, doc.get('adjust') or {}).convert('RGBA')
                img = cover(img, w, h, (layer.get('fit') or {}).get('focus'))
            else:
                img = img.convert('RGBA')
                img.thumbnail((w, h), Image.LANCZOS)
            if layer.get('opacity', 1) < 1:
                alpha = img.getchannel('A').point(lambda v: int(v * layer['opacity']))
                img.putalpha(alpha)
            if layer.get('rotation'):
                img = img.rotate(-layer['rotation'], expand=True, resample=Image.BICUBIC)
            canvas.alpha_composite(img, (x, y))
        elif layer['type'] == 'text':
            t = layer['text']
            size = max(8, int(t.get('size', 0.05) * H))
            font = ImageFont.truetype(FONT_BOLD if t.get('weight', 400) >= 700 else FONT_REG, size)
            draw = ImageDraw.Draw(canvas)
            bbox = draw.textbbox((0, 0), t['value'], font=font)
            tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
            tx = x + (w - tw) // 2 if t.get('align') == 'center' else x + w - tw if t.get('align') == 'right' else x
            if t.get('background'):
                c = t['background']['color'].lstrip('#')
                pad = size // 4
                draw.rounded_rectangle((tx - pad, y - pad, tx + tw + pad, y + th + pad * 2), radius=pad, fill=tuple(int(c[i:i + 2], 16) for i in (0, 2, 4)) + ((int(c[6:8], 16) if len(c) >= 8 else 255),))
            if t.get('shadow'):
                shadow = Image.new('RGBA', canvas.size, (0, 0, 0, 0))
                ImageDraw.Draw(shadow).text((tx + 3, y + 3), t['value'], font=font, fill=(0, 0, 0, 200))
                canvas.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(4)))
            col = t.get('color', '#FFFFFF').lstrip('#')
            fill = tuple(int(col[i:i + 2], 16) for i in (0, 2, 4)) + (int(255 * layer.get('opacity', 1)),)
            stroke = int((t.get('outline') or {}).get('width', 0) * H)
            draw.text((tx, y), t['value'], font=font, fill=fill, stroke_width=stroke, stroke_fill=(0, 0, 0, 255) if stroke else None)
        elif layer['type'] in ('shape', 'line', 'arrow'):
            draw = ImageDraw.Draw(canvas)
            col = (layer.get('shape') or {}).get('color', '#FFFFFF').lstrip('#')
            fill = tuple(int(col[i:i + 2], 16) for i in (0, 2, 4)) + (int(255 * layer.get('opacity', 1)),)
            if layer['type'] == 'shape':
                draw.rectangle((x, y, x + w, y + h), outline=fill, width=max(2, int((layer.get('shape') or {}).get('stroke', 0.006) * H)))
            else:
                draw.line((x, y + h // 2, x + w, y + h // 2), fill=fill, width=max(2, int(0.006 * H)))
                if layer['type'] == 'arrow':
                    draw.polygon(((x + w, y + h // 2), (x + w - h // 2, y), (x + w - h // 2, y + h)), fill=fill)
    path = Path(out) / 'edited.png'
    canvas.convert('RGB').save(path, 'PNG')
    check = Image.open(path)
    check.load()
    if check.size != (W, H):
        raise RuntimeError(f'render check failed: image is {check.size}, not {(W, H)}')
    return {'kind': 'image', 'file': 'edited.png', 'status': 'verified', 'width': W, 'height': H, 'bytes': path.stat().st_size}


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--spec', required=True, type=Path)
    p.add_argument('--sources', required=True, type=Path)
    p.add_argument('--out', type=Path, default=Path('rendered'))
    a = p.parse_args()
    spec = json.loads(a.spec.read_text())
    if spec.get('v') != 1 or not isinstance(spec.get('doc'), dict):
        sys.exit('spec: not a version 1 CHE edit document')
    a.out.mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix='che-edit-'))
    try:
        facts = render_video(spec, a.sources, a.out, work) if spec['doc']['kind'] == 'video' else render_image(spec, a.sources, a.out)
        manifest = {'title': spec.get('title', 'CHE edit'), **facts, 'fonts': 'DejaVu Sans (substitute for the chosen font)', 'paid_media': False, 'uploaded': False}
        (a.out / 'manifest.json').write_text(json.dumps(manifest, indent=2))
        print(json.dumps(manifest))
    except Exception as err:  # the reason is shown to the owner; nothing is called ready
        (a.out / 'manifest.json').write_text(json.dumps({'status': 'failed', 'error': str(err)[:1500]}))
        print(f'render failed: {err}', file=sys.stderr)
        sys.exit(1)
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == '__main__':
    main()

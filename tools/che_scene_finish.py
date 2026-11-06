#!/usr/bin/env python3
"""CHE Scene Director finish: rendered 3D frames + the scene spec -> a checked, playable MP4.

Everything here is an edit that never re-renders 3D, so "slow down the last five seconds" or "add music" only re-runs
this step on the frames already rendered (tools/che_scene_render.py drew them):
  - time remap: spans of the scene played at another speed (0.25x to 4x);
  - voices: each spoken line, made with the free offline Piper voice, placed where its talk step starts (after the
    remap, so a slowed scene never slows a voice);
  - music: a synthesized pad under the whole video, ducked under the voices;
  - H.264 video, AAC sound, faststart; then ffprobe checks the file itself before a manifest says "verified".

Usage: python3 tools/che_scene_finish.py --spec scene.json --frames frames --out rendered [--voice piper|tone]
"""
import argparse
import json
import subprocess
import sys
from pathlib import Path

VOICE_MODEL = "en_US-kristin-medium"


def args():
    p = argparse.ArgumentParser()
    p.add_argument("--spec", required=True)
    p.add_argument("--frames", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--voice", default="piper", choices=["piper", "tone"], help="tone: a placeholder for tests without the Piper voice")
    return p.parse_args()


def run(cmd):
    subprocess.run(cmd, check=True)


def probe(path):
    out = subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name,width,height",
                                   "-of", "json", str(path)], text=True)
    return json.loads(out)


def duration(path):
    return float(probe(path)["format"]["duration"])


def spans(seconds, remap):
    """The scene cut into consecutive spans [a, b) with a speed each; spans not named in the remap play at 1x."""
    cuts = sorted({0.0, float(seconds), *[min(max(0.0, float(r[k])), seconds) for r in remap for k in ("from", "to")]})
    out = []
    for a, b in zip(cuts, cuts[1:]):
        if b - a < 1e-6:
            continue
        speed = 1.0
        for r in remap:
            if float(r["from"]) <= a + 1e-6 and b <= float(r["to"]) + 1e-6:
                speed = max(0.25, min(4.0, float(r["speed"])))
        out.append((a, b, speed))
    return out


def remap_time(t, parts):
    """Where scene time t lands in the finished video."""
    acc = 0.0
    for a, b, speed in parts:
        if t <= b:
            return acc + max(0.0, t - a) / speed
        acc += (b - a) / speed
    return acc


def voice_lines(spec, out, mode):
    lines = []
    for i, step in enumerate(spec.get("timeline", [])):
        text = str(step.get("line") or "").strip()
        if step.get("action") not in ("talk", "speak") or not text:
            continue
        wav = out / f"line{i}.wav"
        if mode == "piper":
            run([sys.executable, "-m", "piper", "-m", VOICE_MODEL, "-f", str(wav), "--", text])
        else:
            seconds = max(1.0, len(text.split()) / 2.5)
            run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", f"sine=frequency=220:duration={seconds}", "-ar", "24000", str(wav)])
        lines.append({"at": float(step["t0"]) + 0.3, "path": wav, "seconds": duration(wav), "text": text})
    return lines


def main():
    a = args()
    spec = json.loads(Path(a.spec).read_text())
    frames = Path(a.frames)
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    fps = int(spec.get("fps", 24))
    seconds = float(spec["seconds"])
    count = len(list(frames.glob("frame_*.png")))
    expected = int(round(seconds * fps))
    if count != expected:
        raise SystemExit(f"CHE_SCENE_FINISH_FAILED expected {expected} frames, found {count}")
    parts = spans(seconds, spec.get("time_remap", []))
    total = remap_time(seconds, parts)

    # Video: each span trimmed from the frame sequence and retimed, then joined.
    chains, labels = [], []
    for i, (s0, s1, speed) in enumerate(parts):
        chains.append(f"[0:v]trim=start={s0}:end={s1},setpts=(PTS-STARTPTS)/{speed}[v{i}]")
        labels.append(f"[v{i}]")
    video_graph = ";".join(chains) + f";{''.join(labels)}concat=n={len(parts)}:v=1:a=0,fps={fps},format=yuv420p[v]"

    # Sound: voices at their remapped times, over an optional pad that ducks under them.
    lines = voice_lines(spec, out, a.voice)
    inputs = ["-framerate", str(fps), "-i", str(frames / "frame_%05d.png")]
    audio = []
    for i, line in enumerate(lines):
        inputs += ["-i", str(line["path"])]
        at = remap_time(line["at"], parts)
        line["at_out"] = round(at, 3)
        audio.append(f"[{i + 1}:a]aresample=48000,adelay={int(at * 1000)}:all=1[a{i}]")
    music = (spec.get("audio") or {}).get("music")
    mix = [f"[a{i}]" for i in range(len(lines))]
    if music:
        root = {"warm": 220.0, "calm": 196.0, "bright": 261.63}.get(music.get("mood", "warm"), 220.0)
        tone = "+".join(f"0.18*sin(2*PI*{root * r}*t)*(0.7+0.3*sin(2*PI*0.25*t))" for r in (1, 1.25, 1.5, 2))
        audio.append(f"aevalsrc='{tone}':s=48000:d={total},afade=t=in:d=1.5,afade=t=out:st={max(0.0, total - 2)}:d=2,volume=0.35[pad]")
        if lines:
            voices = "".join(mix)
            audio.append(f"{voices}amix=inputs={len(lines)}:normalize=0,asplit=2[vox][key]")
            audio.append("[pad][key]sidechaincompress=threshold=0.05:ratio=6:attack=20:release=400[ducked]")
            audio.append("[ducked][vox]amix=inputs=2:normalize=0,apad[aout]")
        else:
            audio.append("[pad]apad[aout]")
    elif lines:
        audio.append(f"{''.join(mix)}amix=inputs={len(lines)}:normalize=0,apad[aout]")
    else:
        audio.append(f"anullsrc=r=48000:cl=stereo:d={total}[aout]")
    graph = video_graph + ";" + ";".join(audio)
    video = out / "video.mp4"
    run(["ffmpeg", "-v", "error", "-y", *inputs, "-filter_complex", graph, "-map", "[v]", "-map", "[aout]",
         "-t", f"{total:.3f}", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
         "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-movflags", "+faststart", str(video)])
    run(["ffmpeg", "-v", "error", "-y", "-ss", f"{min(total - 0.1, total * 0.6):.2f}", "-i", str(video), "-frames:v", "1", str(out / "thumbnail.png")])

    # The file itself decides: codecs, size and length.
    facts = probe(video)
    streams = {s["codec_type"]: s for s in facts["streams"]}
    got = float(facts["format"]["duration"])
    problems = [p for p in (
        streams.get("video", {}).get("codec_name") != "h264" and "the video is not H.264",
        streams.get("audio", {}).get("codec_name") != "aac" and "the sound is not AAC",
        abs(got - total) > 0.25 and f"it lasts {got:.2f} s, not {total:.2f} s",
        int(streams.get("video", {}).get("width", 0)) != int(spec.get("width", 720)) and "the frame size is wrong",
    ) if p]
    manifest = {
        "status": "failed" if problems else "verified", "problems": problems, "job": spec.get("job", ""),
        "project": spec.get("project", ""), "version": spec.get("version", 0), "title": spec.get("title", "CHE scene"),
        "duration_seconds": round(got, 3), "scene_seconds": seconds, "fps": fps,
        "video_width": int(streams.get("video", {}).get("width", 0)), "video_height": int(streams.get("video", {}).get("height", 0)),
        "spans": [{"from": s0, "to": s1, "speed": sp} for s0, s1, sp in parts],
        "voices": [{"text": l["text"], "at": l["at_out"], "seconds": round(l["seconds"], 2)} for l in lines],
        "voice_provider": "piper-neural" if a.voice == "piper" and lines else ("test-tone" if lines else "none"),
        "music": bool(music), "renderer": "blender-cycles", "paid_media": False, "youtube_uploaded": False,
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print("CHE_SCENE_FINISHED " + json.dumps(manifest), flush=True)
    if problems:
        raise SystemExit("CHE_SCENE_FINISH_FAILED " + "; ".join(problems))


if __name__ == "__main__":
    main()

# CHE render farm worker for a Kaggle GPU session (Film Studio, 2026-10-22).
# CHE pushes this script as a private Kaggle kernel with a T4 GPU and internet on, and fills in the three values
# below. It asks CHE for one moving-clip job at a time, makes it with LTX-Video image-to-video from the shot's
# picture, uploads the MP4 to CHE, and exits when CHE has no more work or before the session time runs out. Talking
# shots are then lip-synced to their voice lines (LatentSync 1.5) and uploaded the same way.
# The token is a film-scoped farm token: it opens only this film's farm jobs, expires, and CHE can revoke it.
# It is never the owner's device token. Model weights download from Hugging Face inside the session.
import json, os, subprocess, sys, time, urllib.request

CHE_BASE = "__CHE_BASE__"
FILM_ID = "__FILM_ID__"
FARM_TOKEN = "__FARM_TOKEN__"
DEADLINE_S = int("__DEADLINE_S__")
STARTED = time.time()
MODEL = "Lightricks/LTX-Video"  # LTXV open-weights license; see server/renderfarm/LICENSES.md


def che(method, path, body=None, raw=None, timeout=120):
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(f"{CHE_BASE}/api/film/farm/{FILM_ID}{path}", data=data, method=method)
    req.add_header("X-CHE-Farm-Token", FARM_TOKEN)
    req.add_header("Content-Type", "video/mp4" if raw is not None else "application/json")
    with urllib.request.urlopen(req, timeout=timeout) as res:
        text = res.read()
        return json.loads(text) if text[:1] in (b"{", b"[") else {}


def fetch(url, dest):
    req = urllib.request.Request(url)
    req.add_header("X-CHE-Farm-Token", FARM_TOKEN)
    with urllib.request.urlopen(req, timeout=300) as res, open(dest, "wb") as out:
        out.write(res.read())


def time_left():
    return DEADLINE_S - (time.time() - STARTED)


def ltx():
    subprocess.run([sys.executable, "-m", "pip", "install", "-q", "diffusers>=0.32", "transformers", "accelerate", "sentencepiece", "imageio[ffmpeg]"], check=True)
    import torch
    from diffusers import LTXImageToVideoPipeline
    pipe = LTXImageToVideoPipeline.from_pretrained(MODEL, torch_dtype=torch.float16)
    pipe.enable_model_cpu_offload()
    return pipe


def make_clip(pipe, job):
    from diffusers.utils import export_to_video, load_image
    fetch(job["image_url"], "frame.jpg")
    image = load_image("frame.jpg").resize((768, 432))
    frames = pipe(image=image, prompt=job["prompt"], negative_prompt="worst quality, blurry, distorted, text, watermark",
                  width=768, height=432, num_frames=int(job.get("frames", 121)), num_inference_steps=int(job.get("steps", 30))).frames[0]
    export_to_video(frames, "clip.mp4", fps=int(job.get("fps", 24)))
    return "clip.mp4"


# Lip sync: LatentSync 1.5 (Apache-2.0, ByteDance), pinned, in its own environment so its pinned packages never touch
# the clip model's. 1.5 needs about 8 GB of GPU memory, inside a T4; 1.6 needs 18 GB and does not fit.
LATENTSYNC_REPO = "https://github.com/bytedance/LatentSync.git"
LATENTSYNC_COMMIT = "a229c3948406bc2cf6eaf4873e662e70c6a04746"
LATENTSYNC_WEIGHTS = "ByteDance/LatentSync-1.5"


def ffmpeg():
    import shutil
    found = shutil.which("ffmpeg")
    if found:
        return found
    subprocess.run([sys.executable, "-m", "pip", "install", "-q", "imageio-ffmpeg"], check=True)
    import imageio_ffmpeg
    return imageio_ffmpeg.get_ffmpeg_exe()


def lipsync_setup():
    root, env = os.path.abspath("LatentSync"), os.path.abspath("lsenv")
    if not os.path.isdir(root):
        subprocess.run(["git", "clone", "-q", LATENTSYNC_REPO, root], check=True)
    subprocess.run(["git", "-C", root, "checkout", "-q", LATENTSYNC_COMMIT], check=True)
    subprocess.run([sys.executable, "-m", "venv", env], check=True)
    py = os.path.join(env, "bin", "python")
    subprocess.run([py, "-m", "pip", "install", "-q", "-r", os.path.join(root, "requirements.txt")], check=True)
    get = "from huggingface_hub import hf_hub_download as d; [d('%s', f, local_dir='checkpoints') for f in ('latentsync_unet.pt', 'whisper/tiny.pt')]" % LATENTSYNC_WEIGHTS
    subprocess.run([py, "-c", get], check=True, cwd=root)
    return root, py


def lipsync(job, setup):
    root, py = setup
    ff = ffmpeg()
    seconds = float(job["seconds"])
    # The voice track at the same times the film's edit puts each line (film_studio.voiceTimes), silence elsewhere.
    inputs, chains = [], []
    for i, line in enumerate(job["audio"]):
        fetch(line["url"], f"line{i}.mp3")
        inputs += ["-i", f"line{i}.mp3"]
        chains.append(f"[{i}:a]adelay={int(float(line['at']) * 1000)}:all=1[a{i}]")
    mix = "".join(f"[a{i}]" for i in range(len(job["audio"]))) + f"amix=inputs={len(job['audio'])}:normalize=0,apad,atrim=0:{seconds}[voice]"
    subprocess.run([ff, "-y", "-loglevel", "error", *inputs, "-filter_complex", ";".join(chains + [mix]), "-map", "[voice]", "-ar", "16000", "-ac", "1", "voice.wav"], check=True)
    # The picture: the shot's moving clip looped to the shot's length, or its still held for it.
    if job.get("video_url"):
        fetch(job["video_url"], "base.mp4")
        source = ["-stream_loop", "-1", "-i", "base.mp4"]
    else:
        fetch(job["image_url"], "base.jpg")
        source = ["-loop", "1", "-i", "base.jpg"]
    subprocess.run([ff, "-y", "-loglevel", "error", *source, "-t", str(seconds), "-r", str(int(job.get("fps", 25))),
                    "-vf", "scale=768:432:force_original_aspect_ratio=increase,crop=768:432", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-an", "face.mp4"], check=True)
    subprocess.run([py, "-m", "scripts.inference", "--unet_config_path", "configs/unet/stage2.yaml", "--inference_ckpt_path", "checkpoints/latentsync_unet.pt",
                    "--inference_steps", "20", "--guidance_scale", "1.5", "--video_path", os.path.abspath("face.mp4"),
                    "--audio_path", os.path.abspath("voice.wav"), "--video_out_path", os.path.abspath("synced.mp4")], check=True, cwd=root)
    # Voices are mixed by the edit, so the clip goes back silent, H.264, exactly the shot's length.
    subprocess.run([ff, "-y", "-loglevel", "error", "-i", "synced.mp4", "-t", str(seconds), "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "lipsync.mp4"], check=True)
    return "lipsync.mp4"


def main():
    pipe, setup = None, None
    made, synced = 0, 0
    while time_left() > 600:
        job = che("GET", "/next")
        if not job or job.get("done"):
            break
        if job.get("wait"):  # pictures or voices are still being made
            time.sleep(min(60, int(job["wait"])))
            continue
        started = time.time()
        if job.get("kind") == "lipsync":
            if pipe is not None:  # free the GPU for LatentSync
                import torch
                pipe = None
                torch.cuda.empty_cache()
            try:
                if setup is None:
                    setup = lipsync_setup()
                if isinstance(setup, Exception):
                    raise setup
                with open(lipsync(job, setup), "rb") as f:
                    che("PUT", f"/result?shot={int(job['shot'])}&kind=lipsync&seconds={time.time() - started:.1f}", raw=f.read(), timeout=300)
                synced += 1
            except Exception as error:  # that shot keeps its picture; the rest of the film goes on
                if setup is None:
                    setup = error
                che("POST", "/lipfail", body={"shot": int(job["shot"]), "error": str(error)[:300]})
            continue
        if pipe is None:
            pipe = ltx()
        with open(make_clip(pipe, job), "rb") as f:
            che("PUT", f"/result?shot={int(job['shot'])}&seconds={time.time() - started:.1f}", raw=f.read(), timeout=300)
        made += 1
    che("POST", "/done", body={"made": made, "lip_synced": synced, "seconds": round(time.time() - STARTED)})


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # Report the failure to CHE so the owner hears what happened.
        try:
            che("POST", "/done", body={"error": str(error)[:400], "seconds": round(time.time() - STARTED)})
        finally:
            raise

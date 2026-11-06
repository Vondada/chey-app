# CHE render farm worker for a Kaggle GPU session (Film Studio, 2026-10-22).
# CHE pushes this script as a private Kaggle kernel with a T4 GPU and internet on, and fills in the three values
# below. It asks CHE for one moving-clip job at a time, makes it with LTX-Video image-to-video from the shot's
# picture, uploads the MP4 to CHE, and exits when CHE has no more work or before the session time runs out. Talking
# shots are then lip-synced to their voice lines (LatentSync 1.5) and uploaded the same way.
# The token is a film-scoped farm token: it opens only this film's farm jobs, expires, and CHE can revoke it.
# It is never the owner's device token. Model weights download from Hugging Face inside the session.
import json, os, subprocess, sys, threading, time, urllib.request

CHE_BASE = "__CHE_BASE__"
FILM_ID = "__FILM_ID__"
FARM_TOKEN = "__FARM_TOKEN__"
DEADLINE_S = int("__DEADLINE_S__")
LIPSYNC = "__LIPSYNC__" == "1"  # this film has talking shots to lip-sync
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
    # uv installs the pinned packages in parallel, several times faster than pip; pip stays the fallback.
    py = os.path.join(env, "bin", "python")
    try:
        subprocess.run([sys.executable, "-m", "pip", "install", "-q", "uv"], check=True)
        subprocess.run([sys.executable, "-m", "uv", "venv", "-q", "--python", sys.executable, env], check=True)
        subprocess.run([sys.executable, "-m", "uv", "pip", "install", "-q", "--python", py, "-r", os.path.join(root, "requirements.txt")], check=True)
    except Exception:
        subprocess.run([sys.executable, "-m", "venv", "--clear", env], check=True)
        subprocess.run([py, "-m", "pip", "install", "-q", "-r", os.path.join(root, "requirements.txt")], check=True)
    get = "from huggingface_hub import hf_hub_download as d; [d('%s', f, local_dir='checkpoints') for f in ('latentsync_unet.pt', 'whisper/tiny.pt')]" % LATENTSYNC_WEIGHTS
    subprocess.run([py, "-c", get], check=True, cwd=root)
    return root, py


def lipsync(job, setup, gpu=None):
    root, py = setup
    ff = ffmpeg()
    seconds = float(job["seconds"])
    work = os.path.abspath(f"lip{int(job['shot'])}")  # each shot in its own folder: two GPUs may work at once
    os.makedirs(work, exist_ok=True)
    at = lambda name: os.path.join(work, name)
    # The voice track at the same times the film's edit puts each line (film_studio.voiceTimes), silence elsewhere.
    inputs, chains = [], []
    for i, line in enumerate(job["audio"]):
        fetch(line["url"], at(f"line{i}.mp3"))
        inputs += ["-i", at(f"line{i}.mp3")]
        chains.append(f"[{i}:a]adelay={int(float(line['at']) * 1000)}:all=1[a{i}]")
    mix = "".join(f"[a{i}]" for i in range(len(job["audio"]))) + f"amix=inputs={len(job['audio'])}:normalize=0,apad,atrim=0:{seconds}[voice]"
    subprocess.run([ff, "-y", "-loglevel", "error", *inputs, "-filter_complex", ";".join(chains + [mix]), "-map", "[voice]", "-ar", "16000", "-ac", "1", at("voice.wav")], check=True)
    # The picture: the shot's moving clip looped to the shot's length, or its still held for it.
    if job.get("video_url"):
        fetch(job["video_url"], at("base.mp4"))
        source = ["-stream_loop", "-1", "-i", at("base.mp4")]
    else:
        fetch(job["image_url"], at("base.jpg"))
        source = ["-loop", "1", "-i", at("base.jpg")]
    subprocess.run([ff, "-y", "-loglevel", "error", *source, "-t", str(seconds), "-r", str(int(job.get("fps", 25))),
                    "-vf", "scale=768:432:force_original_aspect_ratio=increase,crop=768:432", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-an", at("face.mp4")], check=True)
    # DeepCache reuses work between denoising steps (about twice as fast), as LatentSync's own inference.sh does.
    run_env = dict(os.environ, **({"CUDA_VISIBLE_DEVICES": str(gpu)} if gpu is not None else {}))
    subprocess.run([py, "-m", "scripts.inference", "--unet_config_path", "configs/unet/stage2.yaml", "--inference_ckpt_path", "checkpoints/latentsync_unet.pt",
                    "--inference_steps", "20", "--guidance_scale", "1.5", "--enable_deepcache", "--video_path", at("face.mp4"),
                    "--audio_path", at("voice.wav"), "--video_out_path", at("synced.mp4"), "--temp_dir", at("temp")], check=True, cwd=root, env=run_env)
    # Voices are mixed by the edit, so the clip goes back silent, H.264, exactly the shot's length.
    subprocess.run([ff, "-y", "-loglevel", "error", "-i", at("synced.mp4"), "-t", str(seconds), "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", at("lipsync.mp4")], check=True)
    return at("lipsync.mp4")


def gpu_count():
    try:
        import torch
        return torch.cuda.device_count()
    except Exception:
        return 1


# Lip sync's own install starts with the session, in the background, while the clip model loads: it is never waited
# for on the way to the first clip.
SETUP = {}


def prepare():
    began = time.time()
    try:
        SETUP["ready"] = lipsync_setup()
    except Exception as error:
        SETUP["error"] = error
    SETUP["seconds"] = time.time() - began


PREPARING = threading.Thread(target=prepare, daemon=True)
TOTALS = {"made": 0, "lip_synced": 0}
LOCK = threading.Lock()


def work(kind, gpu):
    """Asks CHE for jobs of one kind ("clip", "lipsync" or "any") and does them on one GPU until there are none."""
    pipe = None
    reported = False
    while time_left() > 600:
        job = che("GET", f"/next?kind={kind}&gpus={gpu_count()}")
        if not job or job.get("done"):
            break
        if job.get("wait"):  # pictures or voices are still being made, or the other GPU holds the last job
            time.sleep(min(60, int(job["wait"])))
            continue
        started = time.time()
        if job.get("kind") == "lipsync":
            if pipe is not None:  # one GPU only: free it for LatentSync
                import torch
                pipe = None
                torch.cuda.empty_cache()
            try:
                if not PREPARING.is_alive() and "seconds" not in SETUP:
                    PREPARING.start()
                PREPARING.join()
                if "error" in SETUP:
                    raise SETUP["error"]
                setup_s = "" if reported else f"&setup={SETUP['seconds']:.1f}"
                with open(lipsync(job, SETUP["ready"], gpu), "rb") as f:
                    che("PUT", f"/result?shot={int(job['shot'])}&kind=lipsync&seconds={time.time() - started:.1f}{setup_s}", raw=f.read(), timeout=300)
                reported = True
                with LOCK:
                    TOTALS["lip_synced"] += 1
            except Exception as error:  # that shot keeps its picture; the rest of the film goes on
                che("POST", "/lipfail", body={"shot": int(job["shot"]), "error": str(error)[:300]})
            continue
        if pipe is None:  # the clip model runs on the first GPU (LatentSync gets the second when there are two)
            pipe = ltx()
        with open(make_clip(pipe, job), "rb") as f:
            che("PUT", f"/result?shot={int(job['shot'])}&seconds={time.time() - started:.1f}", raw=f.read(), timeout=300)
        with LOCK:
            TOTALS["made"] += 1


def main():
    che("GET", f"/next?kind=hello&gpus={gpu_count()}&boot={time.time() - STARTED:.1f}")
    if LIPSYNC:
        PREPARING.start()
    if LIPSYNC and gpu_count() >= 2:
        # Two GPUs (Kaggle's T4 x2): moving clips on the first, lip sync on the second, at the same time.
        loops = [threading.Thread(target=work, args=("clip", 0)), threading.Thread(target=work, args=("lipsync", 1))]
        for t in loops:
            t.start()
        for t in loops:
            t.join()
    else:
        work("any", None)
    che("POST", "/done", body={**TOTALS, "gpus": gpu_count(), "seconds": round(time.time() - STARTED)})


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # Report the failure to CHE so the owner hears what happened.
        try:
            che("POST", "/done", body={"error": str(error)[:400], "seconds": round(time.time() - STARTED)})
        finally:
            raise

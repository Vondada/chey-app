# CHE render farm worker for a Kaggle GPU session (Film Studio, 2026-10-22).
# CHE pushes this script as a private Kaggle kernel with a T4 GPU and internet on, and fills in the three values
# below. It asks CHE for one moving-clip job at a time, makes it with LTX-Video image-to-video from the shot's
# picture, uploads the MP4 to CHE, and exits when CHE has no more work or before the session time runs out.
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


def main():
    subprocess.run([sys.executable, "-m", "pip", "install", "-q", "diffusers>=0.32", "transformers", "accelerate", "sentencepiece", "imageio[ffmpeg]"], check=True)
    import torch
    from diffusers import LTXImageToVideoPipeline
    from diffusers.utils import export_to_video, load_image

    pipe = LTXImageToVideoPipeline.from_pretrained(MODEL, torch_dtype=torch.float16)
    pipe.enable_model_cpu_offload()
    made = 0
    while time_left() > 900:
        job = che("GET", "/next")
        if not job or job.get("done"):
            break
        started = time.time()
        fetch(job["image_url"], "frame.jpg")
        image = load_image("frame.jpg").resize((768, 432))
        frames = pipe(image=image, prompt=job["prompt"], negative_prompt="worst quality, blurry, distorted, text, watermark",
                      width=768, height=432, num_frames=int(job.get("frames", 121)), num_inference_steps=int(job.get("steps", 30))).frames[0]
        export_to_video(frames, "clip.mp4", fps=int(job.get("fps", 24)))
        with open("clip.mp4", "rb") as f:
            che("PUT", f"/result?shot={int(job['shot'])}&seconds={time.time() - started:.1f}", raw=f.read(), timeout=300)
        made += 1
    che("POST", "/done", body={"made": made, "seconds": round(time.time() - STARTED)})


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # Report the failure to CHE so the owner hears what happened.
        try:
            che("POST", "/done", body={"error": str(error)[:400], "seconds": round(time.time() - STARTED)})
        finally:
            raise

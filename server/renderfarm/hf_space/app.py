# CHE film farm Space (ZeroGPU). CHE creates this private Space in the owner's Hugging Face account and calls its
# "clip" endpoint with one shot at a time: the shot's picture (fetched from CHE with a film-scoped farm token), a
# prompt and a length. Each call uses the account's free daily ZeroGPU minutes; when they are used up the call fails
# and CHE plans the shot as a still with camera motion instead. Nothing here is paid.
import json, tempfile, urllib.request

import gradio as gr
import spaces
import torch
from diffusers import LTXImageToVideoPipeline
from diffusers.utils import export_to_video, load_image

pipe = LTXImageToVideoPipeline.from_pretrained("Lightricks/LTX-Video", torch_dtype=torch.bfloat16)
pipe.to("cuda")


def fetch(url, token):
    req = urllib.request.Request(url)
    req.add_header("X-CHE-Farm-Token", token)
    path = tempfile.mktemp(suffix=".jpg")
    with urllib.request.urlopen(req, timeout=120) as res, open(path, "wb") as out:
        out.write(res.read())
    return path


@spaces.GPU(duration=60)
def clip(request_json):
    job = json.loads(request_json)
    image = load_image(fetch(job["image_url"], job["farm_token"])).resize((768, 432))
    frames = pipe(image=image, prompt=job["prompt"], negative_prompt="worst quality, blurry, distorted, text, watermark",
                  width=768, height=432, num_frames=int(job.get("frames", 121)), num_inference_steps=int(job.get("steps", 30))).frames[0]
    out = tempfile.mktemp(suffix=".mp4")
    export_to_video(frames, out, fps=int(job.get("fps", 24)))
    with open(out, "rb") as f:
        data = f.read()
    req = urllib.request.Request(job["upload_url"], data=data, method="PUT")
    req.add_header("X-CHE-Farm-Token", job["farm_token"])
    req.add_header("Content-Type", "video/mp4")
    with urllib.request.urlopen(req, timeout=300) as res:
        return json.dumps({"uploaded": res.status == 200, "bytes": len(data)})


gr.Interface(fn=clip, inputs=gr.Textbox(), outputs=gr.Textbox(), api_name="clip").queue().launch()

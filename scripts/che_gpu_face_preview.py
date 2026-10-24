import bpy, sys, os, json, time
from pathlib import Path
args=sys.argv[sys.argv.index('--')+1:]
out=Path(args[args.index('--output')+1])
scene=bpy.context.scene
scene.render.engine='CYCLES'
prefs=bpy.context.preferences.addons['cycles'].preferences
selected=None
for backend in ('OPTIX','CUDA'):
    try:
        prefs.compute_device_type=backend
        prefs.get_devices()
        gpus=[d for d in prefs.devices if d.type in ('OPTIX','CUDA')]
        if gpus:
            for d in prefs.devices: d.use=(d in gpus)
            selected={'backend':backend,'gpus':[d.name for d in gpus]}
            break
    except Exception: pass
if not selected: raise RuntimeError('GPU unavailable; refusing CPU fallback')
scene.cycles.device='GPU'
scene.render.resolution_x=480
scene.render.resolution_y=480
scene.render.resolution_percentage=100
scene.cycles.samples=24
scene.cycles.use_denoising=True
scene.render.image_settings.file_format='PNG'
out.parent.mkdir(parents=True,exist_ok=True)
scene.render.filepath=str(out)
start=time.monotonic()
bpy.ops.render.render(write_still=True)
if not out.is_file() or out.stat().st_size==0: raise RuntimeError('Missing preview')
receipt={'status':'render_completed','configured_gpu':selected,'elapsed_seconds':round(time.monotonic()-start,2),'output':str(out)}
Path(str(out)+'.json').write_text(json.dumps(receipt,indent=2))
print('CHE_GPU_RECEIPT',json.dumps(receipt))

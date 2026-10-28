"""Render profiles for CHE's Creation Engine (render_glb.py), chosen by RENDER_PROFILE. Same scene and camera in every
profile; only the renderer settings and, for final, the materials change. tools/creation_benchmark.py measures them
against each other on the same hardware; docs/CHE_CREATION_TOOLS.md has the measured results.

  legacy   the pipeline before this upgrade, unchanged: Cycles at SAMPLES with Blender 5.0's defaults (adaptive
           sampling at threshold 0.01, OpenImageDenoise, 12 bounces, caustics on, no persistent data).
  final    Cycles for the delivered pictures: SAMPLES is the ceiling and adaptive sampling stops each pixel once its
           noise is under ADAPTIVE_THRESHOLD (0.02) after at least ADAPTIVE_MIN (16) samples; OpenImageDenoise with
           albedo and normal passes (on the GPU as well when a GPU renders); light paths capped for people and props
           (6 total, 3 diffuse, 3 glossy, no caustics, indirect clamp 6); persistent data, so the second and later views
           of one session reuse the scene's BVH and images instead of building them again. The materials get skin
           subsurface scattering, a procedural pore and fabric micro-normal and a cloth sheen (procedural nodes only:
           no downloaded textures, so no licence beyond Blender's own).
  preview  the progressive quick look shown while final renders: EEVEE when PREVIEW_ENGINE=eevee (needs an OpenGL/EGL
           context; on a machine without one Blender aborts, so the runner starts it in its own process and falls back),
           otherwise Cycles at PREVIEW_SAMPLES (4) with OpenImageDenoise at PREVIEW_SCALE (50 %) of the size.
Each profile prints PROFILE <name> <engine> <settings json> so the receipt and benchmark record what really ran.
"""
import json
import os

PROFILES = ('legacy', 'final', 'preview')
FINAL = {'adaptive_threshold': 0.02, 'adaptive_min_samples': 16, 'max_bounces': 6, 'diffuse_bounces': 3, 'glossy_bounces': 3,
         'transmission_bounces': 4, 'transparent_max_bounces': 8, 'sample_clamp_indirect': 6.0}


def profile_name():
    name = os.environ.get('RENDER_PROFILE', 'legacy').strip().lower() or 'legacy'
    if name not in PROFILES: raise SystemExit(f'RENDER_PROFILE {name!r} is not one of {", ".join(PROFILES)}')
    return name


def preview_engine():
    return 'eevee' if os.environ.get('PREVIEW_ENGINE', 'cycles').strip().lower() == 'eevee' else 'cycles'


def apply(sc, name, samples, gpu=False):
    """Set the renderer for profile `name` on scene `sc` (the device is already set by render_device.setup). Returns
    the settings as recorded in the PROFILE line."""
    c = sc.cycles
    if name == 'legacy':
        c.samples = samples; c.use_denoising = True
        rec = {'engine': 'CYCLES', 'samples': samples, 'adaptive_threshold': round(c.adaptive_threshold, 4), 'denoiser': c.denoiser}
    elif name == 'final':
        c.samples = samples; c.use_adaptive_sampling = True
        for k, v in FINAL.items(): setattr(c, k, v)
        c.adaptive_threshold = float(os.environ.get('ADAPTIVE_THRESHOLD', FINAL['adaptive_threshold']))
        c.caustics_reflective = False; c.caustics_refractive = False; c.blur_glossy = 1.0
        c.use_denoising = True; c.denoiser = 'OPENIMAGEDENOISE'
        c.denoising_input_passes = 'RGB_ALBEDO_NORMAL'; c.denoising_prefilter = 'ACCURATE'
        if gpu and hasattr(c, 'denoising_use_gpu'): c.denoising_use_gpu = True
        sc.render.use_persistent_data = True
        rec = {'engine': 'CYCLES', 'samples': samples, **{k: getattr(c, k) for k in FINAL}, 'denoiser': c.denoiser,
               'persistent_data': True, 'caustics': False, 'denoise_on_gpu': bool(gpu)}
        rec['adaptive_threshold'] = round(c.adaptive_threshold, 4)
    else:
        scale = float(os.environ.get('PREVIEW_SCALE', '0.5'))
        sc.render.resolution_percentage = max(10, min(100, round(scale * 100)))
        if preview_engine() == 'eevee':
            sc.render.engine = 'BLENDER_EEVEE'
            sc.eevee.taa_render_samples = int(os.environ.get('PREVIEW_SAMPLES', '16'))
            rec = {'engine': 'BLENDER_EEVEE', 'samples': sc.eevee.taa_render_samples, 'scale': scale}
        else:
            ps = int(os.environ.get('PREVIEW_SAMPLES', '4'))
            c.samples = ps; c.use_adaptive_sampling = False; c.use_denoising = True; c.denoiser = 'OPENIMAGEDENOISE'
            c.denoising_input_passes = 'RGB_ALBEDO_NORMAL'; c.max_bounces = 4; c.caustics_reflective = False; c.caustics_refractive = False
            rec = {'engine': 'CYCLES', 'samples': ps, 'scale': scale, 'denoiser': c.denoiser}
    print('PROFILE', name, rec['engine'], json.dumps(rec, sort_keys=True), flush=True)
    return rec


def _principled(m):
    if not m or not m.node_tree: return None
    return next((n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'), None)


def _tint(p):
    """Sheen in the material's own colour (glTF base colour, or the vertex-colour node feeding it), not white."""
    base = p.inputs['Base Color']
    if base.is_linked: p.id_data.links.new(base.links[0].from_socket, p.inputs['Sheen Tint'])
    else: p.inputs['Sheen Tint'].default_value = base.default_value


def _micro_normal(m, p, scale, strength, stretch=None):
    """A procedural micro-normal (Noise texture -> Bump) on the Principled BSDF's Normal input, in object space so it
    stays on the body when it moves. stretch=(x, y, z) elongates the noise (fabric weave)."""
    nt = m.node_tree
    if p.inputs['Normal'].is_linked: return False
    tc = nt.nodes.new('ShaderNodeTexCoord'); noise = nt.nodes.new('ShaderNodeTexNoise'); bump = nt.nodes.new('ShaderNodeBump')
    noise.inputs['Scale'].default_value = scale; noise.inputs['Detail'].default_value = 6.0
    src = tc.outputs['Object']
    if stretch:
        mp = nt.nodes.new('ShaderNodeMapping'); mp.inputs['Scale'].default_value = stretch
        nt.links.new(src, mp.inputs['Vector']); src = mp.outputs['Vector']
    nt.links.new(src, noise.inputs['Vector'])
    bump.inputs['Strength'].default_value = strength; bump.inputs['Distance'].default_value = 0.001
    nt.links.new(noise.outputs['Fac'], bump.inputs['Height']); nt.links.new(bump.outputs['Normal'], p.inputs['Normal'])
    return True


def upgrade_materials(objects):
    """Final-profile materials on the imported GLB (glTF keeps only base colour, roughness and specular, so the
    detail is added at render time, the same way for every view). Returns the list of changes for the receipt."""
    done = []
    seen = set()
    for o in objects:
        if o.type != 'MESH': continue
        for slot in o.material_slots:
            m = slot.material
            if not m or m.name in seen: continue
            seen.add(m.name); p = _principled(m); low = m.name.lower()
            if not p: continue
            if low.startswith('skin'):
                # Human skin: red light scatters furthest (radius in metres, Blender's skin default ratio), scale for a
                # 1.7 m figure; a fine pore normal so the face is not plastic.
                p.inputs['Subsurface Weight'].default_value = 0.35
                p.inputs['Subsurface Radius'].default_value = (1.0, 0.2, 0.1)
                p.inputs['Subsurface Scale'].default_value = 0.008
                p.inputs['Coat Weight'].default_value = 0.04; p.inputs['Coat Roughness'].default_value = 0.35
                _micro_normal(m, p, 900.0, 0.08)
                done.append(f'{m.name}: subsurface scattering, pore micro-normal, thin oil coat')
            elif low.startswith(('top', 'trousers')):
                # Sheen tinted by the cloth's own colour: a white sheen made dark trousers read as shiny leggings in
                # the first benchmark (2026-10-24).
                p.inputs['Sheen Weight'].default_value = 0.25; p.inputs['Sheen Roughness'].default_value = 0.5
                _tint(p)
                _micro_normal(m, p, 420.0, 0.12, stretch=(1.0, 1.0, 6.0))
                done.append(f'{m.name}: cloth sheen, woven micro-normal')
            elif low.startswith('shoe'):
                p.inputs['Coat Weight'].default_value = 0.3; p.inputs['Coat Roughness'].default_value = 0.25
                done.append(f'{m.name}: clear coat')
            elif 'eye' in low and 'brow' not in low and 'lash' not in low:
                p.inputs['Coat Weight'].default_value = 1.0; p.inputs['Coat Roughness'].default_value = 0.03
                done.append(f'{m.name}: wet cornea coat')
            elif 'hair' in low:
                p.inputs['Sheen Weight'].default_value = 0.15; _tint(p)   # untinted sheen turned dark hair grey
                _micro_normal(m, p, 300.0, 0.25, stretch=(1.0, 1.0, 12.0))
                done.append(f'{m.name}: strand-direction micro-normal, sheen')
    print('MATERIALS', json.dumps(done), flush=True)
    return done

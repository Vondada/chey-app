"""CHE face lab (Face First mode, 2026-10-24): one small face-crop test still per change, matched to the owner's
realism reference (warm window light, 85 mm, shallow focus, film grain). It builds CHE in a .blend that can be
saved for the final render, and renders at most one low-sample still.

Steps (env FACE_STEPS, comma list, applied in this order):
  subd   denser head for close-ups (Catmull-Clark subdivision on the Body, shape keys kept)
  skin   skin v4: albedo tuned to the reference's deep warm brown, subtle random-walk subsurface,
         oil-sheen coat on forehead/nose/cheekbones, pores and micro-wrinkles in UV space
  light  reference-matched lighting only (always on; listed for clarity)
Env: BLEND (source .blend), OUT (png path), SAVE (optional .blend path to keep the built scene), SAMPLES (32),
RES (480x600), VIEW_DEG (yaw of the camera around the head, default 28), TARGET_SRGB ("100,57,39").
Everything is procedural or comes from CHE's own textures: no downloaded or paid assets.
"""
import math
import os
import sys

import bpy
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', 'avatar_portraits'))
sys.path.insert(0, HERE)
from strand_hair import build_strand_hair  # noqa: E402

STEPS = [s for s in os.environ.get('FACE_STEPS', '').split(',') if s]
bpy.ops.wm.open_mainfile(filepath=os.environ['BLEND'])
sc = bpy.context.scene
rig = bpy.data.objects['Rig']
act = bpy.data.actions['idle_relaxed']
rig.animation_data_create(); rig.animation_data.action = act
if getattr(act, 'slots', None):
    rig.animation_data.action_slot = act.slots[0]
sc.frame_set(12); bpy.context.view_layer.update()


def srgb_to_linear(c):
    c = c / 255.0
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


# ── Step: subd ──────────────────────────────────────────────────────────────────────────────────────────────────────
if 'subd' in STEPS:
    body = bpy.data.objects['Body']
    if not any(m.type == 'SUBSURF' for m in body.modifiers):
        m = body.modifiers.new('FaceSubd', 'SUBSURF')
        m.levels = 1; m.render_levels = 2; m.quality = 3
        m.uv_smooth = 'PRESERVE_BOUNDARIES'; m.boundary_smooth = 'PRESERVE_CORNERS'
    print('SUBD body verts', len(body.data.vertices), 'render level 2', flush=True)

# ── Step: skin ──────────────────────────────────────────────────────────────────────────────────────────────────────
if 'skin' in STEPS:
    m = bpy.data.materials['Skin']; nt = m.node_tree
    b = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
    # Albedo: scale CHE's own painted map so its median lands on the reference's warm brown.
    tex = next(n for n in nt.nodes if n.type == 'TEX_IMAGE' and n.image and 'color' in n.image.name)
    img = tex.image
    px = list(img.pixels[:])  # linear floats for a float/linear image, sRGB-encoded for an 8-bit one
    is_srgb = img.colorspace_settings.name.lower().startswith('srgb')
    step = 4 * 97  # a sparse sample is enough for a median
    samples = []
    for i in range(0, len(px) - 3, step):
        r, g, bb, a = px[i:i + 4]
        if a > 0.5 and (r + g + bb) > 0.05:
            samples.append((r, g, bb))
    def lin(v):
        return srgb_to_linear(v * 255.0) if is_srgb else v
    med = [sorted(lin(s[k]) for s in samples)[len(samples) // 2] for k in range(3)]
    target = [srgb_to_linear(float(x)) for x in os.environ.get('TARGET_SRGB', '100,57,39').split(',')]
    gain = [max(0.05, min(2.0, t / max(1e-4, mm))) for t, mm in zip(target, med)]
    print('SKIN median', [round(x, 4) for x in med], 'target', [round(x, 4) for x in target], 'gain', [round(x, 3) for x in gain], flush=True)
    src = b.inputs['Base Color'].links[0].from_socket
    mul = nt.nodes.new('ShaderNodeMix'); mul.data_type = 'RGBA'; mul.blend_type = 'MULTIPLY'
    mul.inputs['Factor'].default_value = 1.0
    nt.links.new(src, mul.inputs[6])
    mul.inputs[7].default_value = (gain[0], gain[1], gain[2], 1.0)
    nt.links.new(mul.outputs[2], b.inputs['Base Color'])
    # Subsurface: on, but short, so the dark colour is kept (v3 washed out at 0.004 m).
    b.subsurface_method = 'RANDOM_WALK_SKIN'
    b.inputs['Subsurface Weight'].default_value = 1.0
    b.inputs['Subsurface Radius'].default_value = (1.0, 0.32, 0.16)
    b.inputs['Subsurface Scale'].default_value = float(os.environ.get('SKIN_SSS', '0.0015'))
    # Pores and micro-wrinkles in UV space, so they follow the skin when it deforms.
    uv = nt.nodes.new('ShaderNodeUVMap'); uv.uv_map = 'UVMap'
    vor = nt.nodes.new('ShaderNodeTexVoronoi'); vor.inputs['Scale'].default_value = float(os.environ.get('PORE_SCALE', '1800'))
    nt.links.new(uv.outputs['UV'], vor.inputs['Vector'])
    pit = nt.nodes.new('ShaderNodeMapRange'); pit.inputs['From Max'].default_value = 0.3
    nt.links.new(vor.outputs['Distance'], pit.inputs['Value'])
    fine = nt.nodes.new('ShaderNodeTexNoise'); fine.inputs['Scale'].default_value = 900.0; fine.inputs['Detail'].default_value = 6.0
    nt.links.new(uv.outputs['UV'], fine.inputs['Vector'])
    add = nt.nodes.new('ShaderNodeMath'); add.operation = 'MULTIPLY_ADD'; add.inputs[1].default_value = 0.4
    nt.links.new(fine.outputs['Fac'], add.inputs[0]); nt.links.new(pit.outputs['Result'], add.inputs[2])
    bump = nt.nodes.new('ShaderNodeBump'); bump.inputs['Strength'].default_value = float(os.environ.get('PORE_DEPTH', '0.35'))
    bump.inputs['Distance'].default_value = 0.0006
    nt.links.new(add.outputs['Value'], bump.inputs['Height']); nt.links.new(bump.outputs['Normal'], b.inputs['Normal'])
    # Shine: a little lower roughness overall plus a thin oily coat, which gives the reference's highlights on the
    # forehead, nose bridge and cheekbones without lifting the skin colour.
    if b.inputs['Roughness'].is_linked:
        rsrc = b.inputs['Roughness'].links[0].from_socket
        rm = nt.nodes.new('ShaderNodeMath'); rm.operation = 'MULTIPLY_ADD'
        rm.inputs[1].default_value = 0.95; rm.inputs[2].default_value = 0.03
        nt.links.new(rsrc, rm.inputs[0])
        cl = nt.nodes.new('ShaderNodeClamp'); cl.inputs['Min'].default_value = 0.3; cl.inputs['Max'].default_value = 0.65
        nt.links.new(rm.outputs['Value'], cl.inputs['Value']); nt.links.new(cl.outputs['Result'], b.inputs['Roughness'])
    b.inputs['Coat Weight'].default_value = float(os.environ.get('SKIN_COAT', '0.1'))
    b.inputs['Coat Roughness'].default_value = 0.22
    b.inputs['Sheen Weight'].default_value = 0.04
    b.inputs['Specular IOR Level'].default_value = 0.5

# ── Hair (strands, as in the portraits) ─────────────────────────────────────────────────────────────────────────────
if os.environ.get('NOHAIR'):  # framing probes only: hide the cards, skip the slow strand build
    bpy.data.objects['Hair'].hide_render = True
else:
    build_strand_hair(sc, strands_per_card=int(os.environ.get('STRANDS', '90')), parent_bone=None)

# ── Light: reference match (warm window key, soft bounce, defocused interior) ───────────────────────────────────────
for o in [o for o in sc.objects if o.type == 'LIGHT']:
    o.hide_render = True
eye = (rig.matrix_world @ rig.pose.bones['eye_l'].head + rig.matrix_world @ rig.pose.bones['eye_r'].head) / 2
head_bone = rig.pose.bones['head']
# Forward is from the head joint toward the eyes (the bone's own Y axis runs up the neck, not out of the face).
fwd = eye - rig.matrix_world @ head_bone.head
fwd.z = 0; fwd.normalize()
right = Vector((fwd.y, -fwd.x, 0)).normalized()
up = Vector((0, 0, 1))
tgt = bpy.data.objects.new('FaceTarget', None); sc.collection.objects.link(tgt); tgt.location = eye - up * 0.05

# ── Step: eyes (corneas, strand lashes, strand brows) ───────────────────────────────────────────────────────────────
if 'eyes' in STEPS:
    from eyes_brows import add_corneas, brow_strands, lash_strands
    add_corneas(fwd)
    lashes_card = bpy.data.objects.get('Lashes')
    if lashes_card: lashes_card.hide_render = True
    lash_strands(fwd, up)
    brow_strands(fwd, up)
    print('EYES corneas + strand lashes + strand brows', flush=True)

# ── Step: lips (gloss and lip lines), baby hairs, no strands across the face ───────────────────────────────────────
if 'lips' in STEPS:
    from lips_hairline import baby_hairs, clear_face_strands, lip_gloss
    print('LIPS gloss', lip_gloss(), 'cleared strands', clear_face_strands(fwd, up, eye),
          'baby hairs', baby_hairs(fwd, up, eye), flush=True)


def area(name, pos, size, energy, color):
    l = bpy.data.objects.new(name, bpy.data.lights.new(name, 'AREA')); sc.collection.objects.link(l)
    l.data.shape = 'RECTANGLE'; l.data.size = size; l.data.size_y = size * 1.4
    l.data.energy = energy; l.data.color = color; l.location = pos
    c = l.constraints.new('TRACK_TO'); c.target = tgt; c.track_axis = 'TRACK_NEGATIVE_Z'; c.up_axis = 'UP_Y'
    return l


# Window: big, warm, to the side and a little in front, like late-afternoon light through a hospital window.
area('Window', eye + right * 1.6 + fwd * 0.9 + up * 0.35, 1.6, float(os.environ.get('KEY_W', '260')), (1.0, 0.8, 0.6))
area('Bounce', eye - right * 1.4 + fwd * 1.0 - up * 0.2, 2.0, 30, (0.95, 0.9, 0.85))
area('Back', eye - fwd * 1.2 + right * 0.4 + up * 0.8, 0.8, 40, (1.0, 0.88, 0.75))
# A bright, out-of-focus interior behind her.
bpy.ops.mesh.primitive_plane_add(size=6, location=eye - fwd * 2.5)
wall = bpy.context.active_object; wall.rotation_euler = (math.radians(90), 0, math.atan2(fwd.y, fwd.x) - math.radians(90))
wm = bpy.data.materials.new('Wall'); wm.use_nodes = True
wb = wm.node_tree.nodes['Principled BSDF']; wb.inputs['Base Color'].default_value = (0.55, 0.52, 0.48, 1)
wb.inputs['Emission Color'].default_value = (0.9, 0.85, 0.78, 1); wb.inputs['Emission Strength'].default_value = 0.6
wall.data.materials.append(wm)
w = sc.world or bpy.data.worlds.new('W'); sc.world = w
w.node_tree.nodes['Background'].inputs['Color'].default_value = (0.35, 0.33, 0.3, 1)
w.node_tree.nodes['Background'].inputs['Strength'].default_value = 0.4

# Camera: 85 mm, shallow focus on the near eye.
cam = bpy.data.objects.new('FaceCam', bpy.data.cameras.new('FaceCam')); sc.collection.objects.link(cam); sc.camera = cam
cam.data.lens = 85
a = math.radians(float(os.environ.get('VIEW_DEG', '28')))
dist = float(os.environ.get('DIST', '0.95'))
cam.location = tgt.location + (fwd * math.cos(a) + right * math.sin(a)) * dist + up * 0.03
tr = cam.constraints.new('TRACK_TO'); tr.target = tgt; tr.track_axis = 'TRACK_NEGATIVE_Z'; tr.up_axis = 'UP_Y'
cam.data.dof.use_dof = True; cam.data.dof.focus_object = tgt; cam.data.dof.aperture_fstop = float(os.environ.get('FSTOP', '2.0'))

sc.render.engine = 'CYCLES'; sc.cycles.device = 'CPU'
sc.cycles.samples = int(os.environ.get('SAMPLES', '32')); sc.cycles.use_denoising = True
rx, ry = (int(x) for x in os.environ.get('RES', '480x600').split('x'))
sc.render.resolution_x, sc.render.resolution_y = rx, ry
sc.view_settings.view_transform = 'AgX'; sc.view_settings.look = 'AgX - Medium High Contrast'
sc.view_settings.exposure = float(os.environ.get('EXPOSURE', '0.0'))
if os.environ.get('SAVE'):
    bpy.ops.wm.save_as_mainfile(filepath=os.environ['SAVE'], copy=True)
sc.render.filepath = os.environ['OUT']
bpy.ops.render.render(write_still=True)
print('WROTE', os.environ['OUT'], flush=True)

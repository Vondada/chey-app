# CHE cinematic sample: Route-B CHE model, procedural office, camera moves, Rhubarb lip sync.
# Environment: DEMO_FRAMES, DEMO_RES_X, DEMO_RES_Y, DEMO_SAMPLES, DEMO_OUT, DEMO_TEST (comma-separated frames to render only).
import bpy, json, math, os, random, time
from mathutils import Vector

D = os.environ.get('DEMO_DIR', os.path.dirname(os.path.abspath(__file__)))
FR = int(os.environ.get('DEMO_FRAMES', '288'))
FPS = 24
OUT = os.environ.get('DEMO_OUT', os.path.join(D, 'frames'))
os.makedirs(OUT, exist_ok=True)
random.seed(7)

bpy.ops.wm.open_mainfile(filepath=os.path.join(os.environ['DEMO_BLEND']))
sc = bpy.context.scene
sc.render.engine = 'CYCLES'
sc.cycles.device = 'CPU'
sc.cycles.samples = int(os.environ.get('DEMO_SAMPLES', '24'))
sc.cycles.use_denoising = True
sc.render.resolution_x = int(os.environ.get('DEMO_RES_X', '360'))
sc.render.resolution_y = int(os.environ.get('DEMO_RES_Y', '640'))
sc.render.resolution_percentage = 100
sc.render.fps = FPS
sc.frame_start = 1
sc.frame_end = FR
sc.render.image_settings.file_format = 'PNG'

rig = bpy.data.objects['Rig']
body = bpy.data.objects['Body']
sc.frame_set(1)
bpy.context.view_layer.update()

def rb(name):
    return rig.matrix_world @ rig.pose.bones[name].head

eye_mid = (rb('eye_l') + rb('eye_r')) / 2
neck = rb('neck_01')
F = Vector((eye_mid.x - neck.x, eye_mid.y - neck.y, 0)).normalized()
Z = Vector((0, 0, 1))
R = F.cross(Z).normalized()
corners = [body.matrix_world @ Vector(c) for c in body.bound_box]
z0 = min(c.z for c in corners)
top = max(c.z for c in corners)
H = top - z0
s = H / 1.7
head = Vector((eye_mid.x, eye_mid.y, z0 + 0.93 * H))
C = Vector((head.x, head.y, z0))
print('CHE forward', tuple(round(v, 3) for v in F), 'height', round(H, 3), 'scale', round(s, 3))

def mat(name, color, rough=0.5, metal=0.0, emit=0.0, emit_strength=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = (*color, 1)
    b.inputs['Roughness'].default_value = rough
    b.inputs['Metallic'].default_value = metal
    if emit_strength:
        b.inputs['Emission Color'].default_value = (*emit, 1)
        b.inputs['Emission Strength'].default_value = emit_strength
    return m

def box(name, loc, size, m, rot=0.0):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc)
    o = bpy.context.active_object
    o.name = name
    o.scale = (size[0], size[1], size[2])
    o.rotation_euler = (0, 0, rot)
    o.data.materials.append(m)
    return o

def plane(name, loc, size, m, rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_plane_add(size=1, location=loc, rotation=rot)
    o = bpy.context.active_object
    o.name = name
    o.scale = (size[0], size[1], 1)
    o.data.materials.append(m)
    return o

# Room: back wall behind CHE, front wall beyond the camera start, side walls at +-4.2 s.
room_w, room_len, room_h = 8.4 * s, 12.0 * s, 3.4 * s
back_d = -2.6 * s
mid_f = back_d + room_len / 2
floor_c = C + F * mid_f + Vector((0, 0, 0))
floor_c.z = z0
wall_m = mat('Wall', (0.46, 0.46, 0.48), rough=0.8)
floor_m = mat('Floor', (0.16, 0.17, 0.19), rough=0.10, metal=0.0)
ceil_m = mat('Ceiling', (0.30, 0.31, 0.33), rough=0.9)
screen_m = mat('Screen', (0.02, 0.05, 0.08), rough=0.2, emit=(0.35, 0.85, 0.95), emit_strength=6.0)
window_m = mat('Window', (0.9, 0.95, 1.0), rough=0.1, emit=(0.85, 0.92, 1.0), emit_strength=3.0)
wood_m = mat('Wood', (0.42, 0.27, 0.16), rough=0.45)
metal_m = mat('Metal', (0.55, 0.57, 0.6), rough=0.25, metal=1.0)
plant_m = mat('Plant', (0.10, 0.35, 0.15), rough=0.7)
pot_m = mat('Pot', (0.55, 0.30, 0.20), rough=0.6)

floor = plane('Floor', floor_c, (room_w, room_len), floor_m)
ceil = plane('Ceiling', floor_c + Z * room_h, (room_w, room_len), ceil_m, rot=(math.pi, 0, 0))
for side, sx in (('L', -1), ('R', 1)):
    p = C + R * (sx * room_w / 2) + F * mid_f + Z * room_h / 2
    w = plane('Wall' + side, p, (room_len, room_h), wall_m, rot=(math.pi / 2, 0, math.pi / 2 if sx < 0 else -math.pi / 2))
back = plane('BackWall', C + F * back_d + Z * room_h / 2, (room_w, room_h), wall_m, rot=(math.pi / 2, 0, 0))
front = plane('FrontWall', C + F * (back_d + room_len) + Z * room_h / 2, (room_w, room_h), wall_m, rot=(math.pi / 2, 0, math.pi))
# Tall window with bright daylight behind CHE, and screens on the side walls.
win = plane('Window', C + F * (back_d + 0.02) + Z * (room_h * 0.55) + R * 0.0, (3.6 * s, 2.2 * s), window_m, rot=(math.pi / 2, 0, 0))
for i, sx in enumerate((-1, 1)):
    for j, fy in enumerate((-1.2, 2.0)):
        base = C + R * (sx * 2.7 * s) + F * fy
        desk = box(f'Desk{i}{j}', base + Z * 0.38 * s - R * sx * 0.55 * s * 0, (1.6 * s, 0.75 * s, 0.76 * s), wood_m, rot=math.atan2(R.y, R.x) + (0 if sx > 0 else math.pi))
        scr = box(f'Screen{i}{j}', base + Z * 1.2 * s - R * sx * 0.6 * s, (0.05 * s, 0.8 * s, 0.5 * s), screen_m, rot=math.atan2(R.y, R.x) + (0 if sx > 0 else math.pi))
# Plants and a column light
for k, (fx, sx) in enumerate(((-1.0, -1), (7.0, 1), (5.5, -1))):
    pos = C + R * (sx * (room_w / 2 - 0.5 * s)) + F * fx
    pot = box(f'Pot{k}', pos + Z * 0.25 * s, (0.5 * s, 0.5 * s, 0.5 * s), pot_m)
    bpy.ops.mesh.primitive_ico_sphere_add(radius=0.55 * s, location=pos + Z * 1.0 * s)
    bpy.context.active_object.name = f'Plant{k}'
    bpy.context.active_object.data.materials.append(plant_m)
# Ceiling light panels
for k, fy in enumerate((0.5, 4.5, 8.5)):
    panel = plane(f'Panel{k}', C + F * fy + Z * (room_h - 0.02), (1.2 * s, 2.4 * s), window_m, rot=(0, 0, 0))

led_m = mat('LED', (0.2, 0.9, 0.9), rough=0.3, emit=(0.2, 1.0, 1.0), emit_strength=8.0)
for sx in (-1, 1):
    for fy in (-1.0, 3.0, 7.0):
        box(f'LED{sx}{fy}', C + R * (sx * (room_w / 2 - 0.03)) + F * fy + Z * 0.5 * s, (0.03, room_len / 3, 0.05 * s), led_m)
# Lights: window area light (warm key from behind-left), fill from front, ceiling fill.
def area(name, loc, size, energy, color, target=None):
    ld = bpy.data.lights.new(name, 'AREA')
    ld.energy = energy
    ld.color = color
    ld.size = size
    ob = bpy.data.objects.new(name, ld)
    bpy.context.collection.objects.link(ob)
    ob.location = loc
    if target is not None:
        con = ob.constraints.new('TRACK_TO')
        con.target = target
        con.track_axis = 'TRACK_NEGATIVE_Z'
        con.up_axis = 'UP_Y'
    return ob
tgt = bpy.data.objects.new('LightTarget', None)
bpy.context.collection.objects.link(tgt)
tgt.location = C + Z * 1.2 * s
area('KeyWindow', C + F * (back_d + 1.0) + Z * (room_h * 0.6) + R * 1.5, 3.0 * s, 260 * s * s, (1.0, 0.95, 0.9), tgt)
area('FillFront', C + F * 5.0 + R * 2.0 + Z * 2.4 * s, 3.5 * s, 110 * s * s, (0.85, 0.92, 1.0), tgt)
area('Rim', C + F * (back_d + 2.0) - R * 2.0 + Z * 2.0 * s, 1.5 * s, 260 * s * s, (0.4, 0.9, 0.95), tgt)
world = sc.world or bpy.data.worlds.new('World')
sc.world = world
world.use_nodes = True
wbg = world.node_tree.nodes['Background']
wbg.inputs['Color'].default_value = (0.11, 0.13, 0.16, 1)
wbg.inputs['Strength'].default_value = 0.3
sc.view_settings.view_transform = 'AgX'
sc.view_settings.exposure = -0.4

# Camera with keyframed position and a keyframed target it tracks.
cam_d = bpy.data.cameras.new('Cam')
cam_d.lens = 40
cam_d.dof.use_dof = False
cam_d.dof.focus_object = None
cam = bpy.data.objects.new('Cam', cam_d)
bpy.context.collection.objects.link(cam)
sc.camera = cam
look = bpy.data.objects.new('CamTarget', None)
bpy.context.collection.objects.link(look)
trk = cam.constraints.new('TRACK_TO')
trk.target = look
trk.track_axis = 'TRACK_NEGATIVE_Z'
trk.up_axis = 'UP_Y'

# Keyframes for the shot list. Times in seconds at 24 fps.
def at(sec):
    return max(1, min(FR, round(sec * FPS) + 1))
shots = [
    (0.0, C + F * 6.0 + R * 2.5 + Z * 0.7 * s, C + Z * 1.0 * s - R * 1.0 * s),
    (4.0, C + F * 3.6 - R * 1.0 * s + Z * 0.5 * s, C + Z * 1.2 * s),
    (6.0, C + F * 2.9 + R * 0.25 * s + Z * 1.2 * s, head + Vector((0, 0, 0))),
    (12.0, C + F * 2.4 + Z * 1.2 * s, head + Vector((0, 0, 0))),
]
for sec, p, t in shots:
    f = at(sec)
    cam.location = p
    cam.keyframe_insert('location', frame=f)
    look.location = t
    look.keyframe_insert('location', frame=f)

# Lip sync from Rhubarb cues: shape keys on the skin and the lashes.
cues = json.load(open(os.path.join(D, 'cues.json')))['mouthCues']
SPEECH_START = float(os.environ.get('DEMO_SPEECH_START', '6.0'))
VIS = {'X': {}, 'A': {}, 'B': {'mouth_open': 0.15}, 'C': {'mouth_open': 0.45, 'mouth_wide': 0.2},
       'D': {'mouth_open': 0.8, 'mouth_wide': 0.35}, 'E': {'mouth_open': 0.35, 'mouth_round': 0.6},
       'F': {'mouth_round': 0.7, 'mouth_open': 0.2}, 'G': {'viseme_fv': 0.8}, 'H': {'mouth_open': 0.3, 'mouth_wide': 0.15}}
keys = ['mouth_open', 'mouth_wide', 'mouth_round', 'viseme_fv', 'blink']
for ob in (body, bpy.data.objects['Lashes']):
    kb = ob.data.shape_keys.key_blocks
    for k in keys:
        kb[k].value = 0
        kb[k].keyframe_insert('value', frame=1)
    for c in cues:
        f = at(SPEECH_START + c['start'])
        f2 = at(SPEECH_START + c['end'])
        vals = VIS.get(c['value'], {})
        for k in keys[:4]:
            kb[k].value = vals.get(k, 0)
            kb[k].keyframe_insert('value', frame=f)
        for k in keys[:4]:
            kb[k].value = vals.get(k, 0)
            kb[k].keyframe_insert('value', frame=f2)
    for sec in (2.6, 8.9):
        for f, v in ((at(sec), 0.0), (at(sec) + 2, 1.0), (at(sec) + 4, 0.0)):
            kb['blink'].value = v
            kb['blink'].keyframe_insert('value', frame=f)
    # Speech ends with the mouth closed.
    for k in keys[:4]:
        kb[k].value = 0
        kb[k].keyframe_insert('value', frame=at(SPEECH_START + cues[-1]['end']) + 2)

print('frames', FR, 'camera keys', len(shots), 'cues', len(cues))
tests = os.environ.get('DEMO_TEST', '')
frames = [int(x) for x in tests.split(',')] if tests else list(range(1, FR + 1))
t0 = time.time()
for f in frames:
    sc.frame_set(f)
    sc.render.filepath = os.path.join(OUT, f'f_{f:04d}.png')
    bpy.ops.render.render(write_still=True)
    print('rendered', f, round(time.time() - t0, 1), flush=True)
print('DONE', round(time.time() - t0, 1))

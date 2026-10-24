# Crew portraits: imports each crew GLB from assets/characters/crew, poses it on its idle clip, and renders
# a head-and-shoulders portrait with the same three-point light as CHE's portraits.
# Env: CREW_DIR (glb folder), OUTDIR, NAMES (comma list, default all), VIEWS, SAMPLES, RES (WxH), FRAME
import bpy, glob, math, os, time
from mathutils import Vector

CREW = os.environ.get('CREW_DIR', os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'assets', 'characters', 'crew'))
OUT = os.environ['OUTDIR']; os.makedirs(OUT, exist_ok=True)
names = os.environ.get('NAMES', '').split(',') if os.environ.get('NAMES') else sorted(os.path.basename(p)[:-4] for p in glob.glob(os.path.join(CREW, '*.glb')))
VIEWS = {'front': 0, 'threequarter': 35, 'side': 85}
views = os.environ.get('VIEWS', 'front,threequarter').split(',')
t0 = time.time()
for name in names:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=os.path.join(CREW, name + '.glb'))
    sc = bpy.context.scene
    rig = next(o for o in bpy.data.objects if o.type == 'ARMATURE')
    act = bpy.data.actions.get('idle') or (bpy.data.actions[0] if bpy.data.actions else None)
    if act:
        rig.animation_data_create(); rig.animation_data.action = act
        if getattr(act, 'slots', None) and len(act.slots): rig.animation_data.action_slot = act.slots[0]
    sc.frame_set(int(os.environ.get('FRAME', '12'))); bpy.context.view_layer.update()
    # The glTF export carries a sky sphere; it must not shade the portrait.
    for o in bpy.data.objects:
        if o.type == 'MESH' and max(o.dimensions) > 1.5: o.hide_render = True
    hb = rig.pose.bones.get('head')
    head = rig.matrix_world @ hb.head if hb else Vector((0, 0, max(o.dimensions.z for o in bpy.data.objects if o.type == 'MESH') * 0.9))
    htop = (rig.matrix_world @ hb.tail) if hb else head + Vector((0, 0, 0.12))
    hlen = max((htop - head).length, 0.08)
    eye = head + (htop - head) * 0.45
    tgt = bpy.data.objects.new('T', None); sc.collection.objects.link(tgt); tgt.location = eye - Vector((0, 0, hlen * 0.3))
    cam = bpy.data.objects.new('Cam', bpy.data.cameras.new('Cam')); sc.collection.objects.link(cam); sc.camera = cam
    cam.data.lens = 85
    tr = cam.constraints.new('TRACK_TO'); tr.target = tgt; tr.track_axis = 'TRACK_NEGATIVE_Z'; tr.up_axis = 'UP_Y'
    def light(lname, off, size, energy, color):
        l = bpy.data.objects.new(lname, bpy.data.lights.new(lname, 'AREA')); sc.collection.objects.link(l)
        l.data.size = size; l.data.energy = energy; l.data.color = color; l.location = eye + off
        c = l.constraints.new('TRACK_TO'); c.target = tgt; c.track_axis = 'TRACK_NEGATIVE_Z'; c.up_axis = 'UP_Y'
    k = hlen / 0.12  # scale the light rig to the character's head size
    light('Key', Vector((-0.9, -1.2, 0.5)) * k, 1.2 * k, 150 * k * k, (1.0, 0.95, 0.9))
    light('Fill', Vector((1.1, -1.0, 0.0)) * k, 1.5 * k, 45 * k * k, (0.9, 0.95, 1.0))
    light('Rim', Vector((0.6, 1.0, 0.6)) * k, 0.8 * k, 60 * k * k, (0.85, 0.95, 1.0))
    w = bpy.data.worlds.new('W'); sc.world = w; w.use_nodes = True
    w.node_tree.nodes['Background'].inputs['Color'].default_value = (0.05, 0.055, 0.065, 1)
    sc.render.engine = 'CYCLES'; sc.cycles.device = 'CPU'
    sc.cycles.samples = int(os.environ.get('SAMPLES', '48')); sc.cycles.use_denoising = True
    rx, ry = (int(x) for x in os.environ.get('RES', '540x675').split('x'))
    sc.render.resolution_x, sc.render.resolution_y = rx, ry
    sc.view_settings.view_transform = 'AgX'
    dist = hlen * 8.5
    for view in views:
        a = math.radians(VIEWS[view])
        cam.location = tgt.location + Vector((-math.sin(a) * dist, -math.cos(a) * dist, hlen * 0.25))
        sc.render.filepath = os.path.join(OUT, f'{name}_{view}.png')
        bpy.ops.render.render(write_still=True)
        print('RENDERED', name, view, round(time.time() - t0, 1), flush=True)

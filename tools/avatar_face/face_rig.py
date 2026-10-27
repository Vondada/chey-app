"""Face step 5: the 52 ARKit blendshapes on CHE's Route-B head, with the eyes driven by the eye-look shapes.

  python3 face_rig.py IN.blend OUT.blend

CHE's model already carries 21 authored expression keys (blink, smile, mouth_open, brows_frown, ...). Those stay as they
are (the lip sync and clips use them). The ARKit set is built on top:
  - split: a symmetric authored key cut into Left/Right with a soft 1 cm blend across the face's midline
  - copy:  an authored key that already is the ARKit shape (blink_l -> eyeBlinkLeft, mouth_open -> jawOpen)
  - sculpt: shapes CHE has no key for (jawLeft, mouthPucker, cheekPuff, ...), moved from face regions measured on her
    own mesh (lips from the mouth_open movers, the jaw from where mouth_open moves down, cheeks between mouth and eyes)
  - eyeLook*: the eye bones turn from the shape values by drivers (±25° side, +20°/-25° up/down), and the lids follow a
    little (a fraction of eyeWide / eyeBlink), so a face-capture stream moves the real eyes.
tongueOut is created empty: the model has no tongue mesh, so it is listed as not built.
"""
import math
import sys

import bpy
from mathutils import Vector

src, dst = sys.argv[-2], sys.argv[-1]
bpy.ops.wm.open_mainfile(filepath=src)
body = bpy.data.objects['Body']
keys = body.data.shape_keys
kb = keys.key_blocks
basis = [v.co.copy() for v in kb[0].data]
N = len(basis)
rig = next(o for o in bpy.data.objects if o.type == 'ARMATURE')

# ── Face frame in the body's own (rest) coordinates ─────────────────────────────────────────────────────────────────
inv = body.matrix_world.inverted()
for o in bpy.data.objects:
    if o.type == 'ARMATURE' and o.animation_data: o.animation_data.action = None
for pb in rig.pose.bones: pb.matrix_basis.identity()
bpy.context.view_layer.update()


def centre(name):
    ob = bpy.data.objects[name]
    dg = bpy.context.evaluated_depsgraph_get(); ev = ob.evaluated_get(dg); me = ev.to_mesh()
    pts = [ob.matrix_world @ v.co for v in me.vertices]; ev.to_mesh_clear()
    return sum(pts, Vector()) / len(pts)


el, er = inv @ centre('Eye_l'), inv @ centre('Eye_r')
eye_mid = (el + er) / 2
side_l = (el - er).normalized()            # toward CHE's left eye
up = Vector((0, 0, 1)); up = (up - side_l * up.dot(side_l)).normalized()
fwd = side_l.cross(up)
# The face is in front of the eyes' midpoint: flip if most mouth movers sit behind it.
d_open = [(kb['mouth_open'].data[i].co - basis[i]) for i in range(N)]
movers = sorted(range(N), key=lambda i: -d_open[i].length)[:200]
if sum((basis[i] - eye_mid).dot(fwd) for i in movers) < 0: fwd = -fwd


def local(i):
    p = basis[i] - eye_mid
    return p.dot(side_l), p.dot(up), p.dot(fwd)


def smooth(a, b, x):
    t = max(0.0, min(1.0, (x - a) / (b - a))); return t * t * (3 - 2 * t)


# Lips: the strongest mouth_open movers (as lip_gloss does); mouth centre and the corners from mouth_wide.
top = sorted(v.length for v in d_open)[int(N * 0.995)] or 1e-6
lip = [max(0.0, min(1.0, (d_open[i].length / top - 0.35) / 0.4)) for i in range(N)]
lip_ids = [i for i in range(N) if lip[i] > 0.5]
mouth = sum((basis[i] for i in lip_ids), Vector()) / max(1, len(lip_ids))
m_up = (mouth - eye_mid).dot(up)
lip_half = max(abs(local(i)[0]) for i in lip_ids) if lip_ids else 0.025
# Jaw: everything mouth_open moves downward below the mouth line.
jaw = [max(0.0, min(1.0, -d_open[i].dot(up) / (top * 0.8))) * smooth(m_up + 0.004, m_up - 0.006, local(i)[1]) for i in range(N)]
# Cheeks: in front, between the mouth line and the lower lids, outside the nose.
cheek = []
for i in range(N):
    s, u, f = local(i)
    cheek.append(smooth(0.018, 0.03, abs(s)) * smooth(0.075, 0.055, abs(s)) * smooth(m_up - 0.005, m_up + 0.01, u)
                 * smooth(-0.005, -0.02, u) * smooth(-0.04, -0.01, f))


def side_w(i, left):
    s = local(i)[0] * (1 if left else -1)
    return smooth(-0.008, 0.008, s)


def new_key(name, deltas):
    k = kb.get(name) or body.shape_key_add(name=name, from_mix=False)
    for i in range(N):
        k.data[i].co = basis[i] + deltas[i]
    k.slider_min, k.slider_max = 0.0, 1.0
    return k


def delta_of(name):
    return [(kb[name].data[i].co - basis[i]) for i in range(N)]


ZERO = Vector()
made = {}


def split(src_name, base):
    d = delta_of(src_name)
    for left, suf in ((True, 'Left'), (False, 'Right')):
        made[base + suf] = new_key(base + suf, [d[i] * side_w(i, left) for i in range(N)])


def copy(src_name, name, scale=1.0, mask=None):
    d = delta_of(src_name)
    made[name] = new_key(name, [d[i] * scale * (mask[i] if mask else 1.0) for i in range(N)])


def sculpt(name, fn):
    made[name] = new_key(name, [fn(i) for i in range(N)])


# Eyes and lids
copy('blink_l', 'eyeBlinkLeft'); copy('blink_r', 'eyeBlinkRight')
split('squint', 'eyeSquint'); split('eyes_wide', 'eyeWide')
for left, suf in ((True, 'Left'), (False, 'Right')):
    blink = delta_of('blink_l' if left else 'blink_r'); wide = delta_of('eyes_wide')
    made['eyeLookDown' + suf] = new_key('eyeLookDown' + suf, [blink[i] * 0.22 for i in range(N)])
    made['eyeLookUp' + suf] = new_key('eyeLookUp' + suf, [wide[i] * side_w(i, left) * 0.4 for i in range(N)])
    made['eyeLookIn' + suf] = new_key('eyeLookIn' + suf, [ZERO] * N)
    made['eyeLookOut' + suf] = new_key('eyeLookOut' + suf, [ZERO] * N)
# Brows
split('brows_frown', 'browDown'); copy('brows_worry', 'browInnerUp'); split('brow_outer_up', 'browOuterUp')
# Nose and cheeks
split('nose_sneer', 'noseSneer')
sculpt('cheekPuff', lambda i: (basis[i] - mouth).normalized() * 0.0045 * cheek[i] if cheek[i] else ZERO)
for left, suf in ((True, 'Left'), (False, 'Right')):
    made['cheekSquint' + suf] = new_key('cheekSquint' + suf, [(up * 0.0028 + fwd * 0.0008) * cheek[i] * side_w(i, left) for i in range(N)])
# Jaw
copy('mouth_open', 'jawOpen')
sculpt('jawForward', lambda i: fwd * 0.006 * jaw[i])
sculpt('jawLeft', lambda i: side_l * 0.008 * jaw[i])
sculpt('jawRight', lambda i: -side_l * 0.008 * jaw[i])
# Mouth
copy('mouth_open', 'mouthClose', scale=-1.0, mask=[lip[i] * smooth(m_up + 0.002, m_up - 0.004, local(i)[1]) for i in range(N)])
copy('mouth_round', 'mouthFunnel')
sculpt('mouthPucker', lambda i: ((mouth - basis[i]).dot(side_l) * side_l * 0.3 + fwd * 0.005) * lip[i])
sculpt('mouthLeft', lambda i: side_l * 0.006 * lip[i])
sculpt('mouthRight', lambda i: -side_l * 0.006 * lip[i])
split('smile', 'mouthSmile'); split('mouth_frown', 'mouthFrown'); split('mouth_wide', 'mouthStretch')
split('mouth_press', 'mouthPress'); split('mouth_upper_up', 'mouthUpperUp')
upper = lambda i: smooth(m_up - 0.002, m_up + 0.003, local(i)[1])
lower = lambda i: 1.0 - upper(i)
sculpt('mouthRollUpper', lambda i: (-fwd * 0.003 - up * 0.0015) * lip[i] * upper(i))
sculpt('mouthRollLower', lambda i: (-fwd * 0.003 + up * 0.0015) * lip[i] * lower(i))
sculpt('mouthShrugUpper', lambda i: up * 0.002 * lip[i] * upper(i))
sculpt('mouthShrugLower', lambda i: (up * 0.003 + fwd * 0.001) * (lip[i] * lower(i) + jaw[i] * 0.4))
for left, suf in ((True, 'Left'), (False, 'Right')):
    corner = lambda i, left=left: lip[i] * smooth(lip_half * 0.45, lip_half * 0.9, local(i)[0] * (1 if left else -1))
    made['mouthDimple' + suf] = new_key('mouthDimple' + suf, [(-fwd * 0.003 + side_l * (0.0015 if left else -0.0015)) * corner(i) for i in range(N)])
    made['mouthLowerDown' + suf] = new_key('mouthLowerDown' + suf, [-up * 0.004 * lip[i] * lower(i) * side_w(i, left) for i in range(N)])
made['tongueOut'] = new_key('tongueOut', [ZERO] * N)

# ── Eye bones follow the look shapes (drivers) ─────────────────────────────────────────────────────────────────────
for bone, suf in (('eye_l', 'Left'), ('eye_r', 'Right')):
    pb = rig.pose.bones[bone]; pb.rotation_mode = 'XYZ'
    sign_in = -1 if suf == 'Left' else 1  # "in" turns toward the nose
    for axis, expr in ((0, '(up*0.35 - down*0.44)'), (2, f'({sign_in}*(lin - lout))*0.44')):
        fc = pb.driver_add('rotation_euler', axis); drv = fc.driver; drv.type = 'SCRIPTED'
        for var, key in (('up', 'eyeLookUp'), ('down', 'eyeLookDown'), ('lin', 'eyeLookIn'), ('lout', 'eyeLookOut')):
            v = drv.variables.new(); v.name = var; v.type = 'SINGLE_PROP'
            v.targets[0].id_type = 'KEY'; v.targets[0].id = keys
            v.targets[0].data_path = f'key_blocks["{key}{suf}"].value'
        drv.expression = expr

ARKIT = ['eyeBlinkLeft', 'eyeLookDownLeft', 'eyeLookInLeft', 'eyeLookOutLeft', 'eyeLookUpLeft', 'eyeSquintLeft', 'eyeWideLeft',
         'eyeBlinkRight', 'eyeLookDownRight', 'eyeLookInRight', 'eyeLookOutRight', 'eyeLookUpRight', 'eyeSquintRight', 'eyeWideRight',
         'jawForward', 'jawLeft', 'jawRight', 'jawOpen', 'mouthClose', 'mouthFunnel', 'mouthPucker', 'mouthLeft', 'mouthRight',
         'mouthSmileLeft', 'mouthSmileRight', 'mouthFrownLeft', 'mouthFrownRight', 'mouthDimpleLeft', 'mouthDimpleRight',
         'mouthStretchLeft', 'mouthStretchRight', 'mouthRollLower', 'mouthRollUpper', 'mouthShrugLower', 'mouthShrugUpper',
         'mouthPressLeft', 'mouthPressRight', 'mouthLowerDownLeft', 'mouthLowerDownRight', 'mouthUpperUpLeft', 'mouthUpperUpRight',
         'browDownLeft', 'browDownRight', 'browInnerUp', 'browOuterUpLeft', 'browOuterUpRight', 'cheekPuff', 'cheekSquintLeft',
         'cheekSquintRight', 'noseSneerLeft', 'noseSneerRight', 'tongueOut']
missing = [n for n in ARKIT if n not in kb]
moving = {n: round(max((kb[n].data[i].co - basis[i]).length for i in range(N)) * 1000, 2) for n in ARKIT if n in kb}
print('ARKIT', len(ARKIT) - len(missing), 'of', len(ARKIT), 'missing', missing)
print('LIPS', len(lip_ids), 'jaw verts', sum(1 for x in jaw if x > 0.5), 'cheek verts', sum(1 for x in cheek if x > 0.5))
print('STILL (max move under 0.1 mm)', [n for n, mm in moving.items() if mm < 0.1])
bpy.ops.wm.save_as_mainfile(filepath=dst)
print('SAVED', dst)

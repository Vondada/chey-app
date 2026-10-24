"""Compatibility check before any Colab face test: Blender version, CHE's scene, packed textures, GPU devices.

  blender -b --factory-startup -P bl_run.py -- colab/check_project.py CHE.blend      env: REQUIRE_GPU (OPTIX or CUDA)

Prints one PASS/FAIL line per check and exits 4 when any fails, so the notebook stops before rendering.
"""
import sys

import bpy

ok = True


def check(name, good, detail=''):
    global ok
    ok &= bool(good)
    print('CHECK', 'PASS' if good else 'FAIL', name, detail, flush=True)


check('Blender 5.0 (the version CHE was built in)', bpy.app.version[:2] == (5, 0), bpy.app.version_string)
bpy.ops.wm.open_mainfile(filepath=sys.argv[-1])
names = {o.name for o in bpy.data.objects}
need = {'Rig', 'Body', 'Eye_l', 'Eye_r', 'Hair', 'Lashes'}
check('CHE scene objects', need <= names, f'missing {sorted(need - names)}' if need - names else f'{len(names)} objects')
check('skin and eye materials', {'Skin', 'Eyes'} <= {m.name for m in bpy.data.materials})
loose = [i.name for i in bpy.data.images if i.source == 'FILE' and not i.packed_file]
check('textures packed inside the .blend', not loose, f'not packed: {loose}' if loose else '')

prefs = bpy.context.preferences.addons['cycles'].preferences
gpus = {}
for kind in ('OPTIX', 'CUDA'):
    prefs.compute_device_type = kind
    prefs.refresh_devices()
    gpus[kind] = [d.name for d in prefs.devices if d.type == kind]
    print('DEVICES', kind, gpus[kind] or 'none', flush=True)
want = __import__('os').environ.get('REQUIRE_GPU', '').upper()
if want:
    check(f'{want} GPU visible to Cycles', gpus.get(want), ', '.join(gpus.get(want, [])))
sys.exit(0 if ok else 4)

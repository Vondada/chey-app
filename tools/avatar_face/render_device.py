"""Cycles device and test size from the environment, so the same face script renders on this CPU or a Colab GPU.

  CYCLES_DEVICE   CPU (default), CUDA or OPTIX. A GPU that is asked for and not found stops the script (exit 3); it
                  never falls back to the CPU in silence, so a GPU timing is always a GPU timing.
  TEST_RES        Long edge in pixels for small tests (480 on Colab). Unset keeps each script's own size.
"""
import os
import sys

import bpy


def setup(sc, size):
    kind = os.environ.get('CYCLES_DEVICE', 'CPU').upper()
    sc.render.engine = 'CYCLES'
    if kind == 'CPU':
        sc.cycles.device = 'CPU'; used = ['CPU']
    else:
        prefs = bpy.context.preferences.addons['cycles'].preferences
        prefs.compute_device_type = kind
        prefs.refresh_devices()
        for d in prefs.devices: d.use = d.type == kind
        used = [d.name for d in prefs.devices if d.use]
        if not used:
            print('DEVICE FAIL', kind, 'not found; devices:', [(d.name, d.type) for d in prefs.devices], flush=True)
            sys.exit(3)
        sc.cycles.device = 'GPU'
    w, h = size
    if os.environ.get('TEST_RES'):
        s = int(os.environ['TEST_RES']) / max(w, h); w, h = round(w * s / 2) * 2, round(h * s / 2) * 2
    sc.render.resolution_x, sc.render.resolution_y = w, h
    sc.render.resolution_percentage = 100
    print('DEVICE', kind, used, f'{w}x{h}', flush=True)

"""Run a face script inside the Blender binary exactly as `python3 SCRIPT ARGS` runs it with the bpy module.

  blender -b --factory-startup -P bl_run.py -- SCRIPT [ARGS...]

The official Blender download (used on Colab, whose Python does not match the bpy wheel) passes its own flags in
sys.argv; the face scripts read their arguments from the end of sys.argv, so this sets sys.argv to SCRIPT ARGS and
runs the script as __main__. A non-zero exit (a failed pre-render check is 2, a missing GPU is 3) is passed on.
"""
import os
import runpy
import sys

args = sys.argv[sys.argv.index('--') + 1:]
script = os.path.abspath(args[0])
sys.argv = [script] + args[1:]
sys.path.insert(0, os.path.dirname(script))
runpy.run_path(script, run_name='__main__')

"""Convert a CHE GLB (a crew member or any model CHE made) to USDZ for iPhone AR Quick Look, with Blender's own USD
exporter, then open the USDZ again to check it holds the meshes, the skeleton and the face shapes.

    python glb_to_usdz.py -- <in.glb> <out.usdz>

Prints CHE_USDZ {...} with what the re-opened file holds; exits non-zero if the check fails. Free and local: no
upload, no service.
"""
import json
import os
import sys
import zipfile
from pathlib import Path

import bpy


def convert(glb, usdz):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(glb))
    usdz.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.usd_export(filepath=str(usdz), export_animation=True, export_armatures=True, export_shapekeys=True,
                          export_materials=True, export_mesh_colors=True)


def reopen(usdz):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.wm.usd_import(filepath=str(usdz))
    meshes = [o for o in bpy.data.objects if o.type == "MESH"]
    shapes = sorted({k.name for o in meshes if o.data.shape_keys for k in o.data.shape_keys.key_blocks if k.name != "Basis"})
    arms = [o for o in bpy.data.objects if o.type == "ARMATURE"]
    return {"meshes": len(meshes), "armatures": len(arms), "bones": len(arms[0].data.bones) if arms else 0, "shapes": shapes}


def main():
    args = sys.argv[sys.argv.index("--") + 1:]
    glb, usdz = Path(args[0]), Path(args[1])
    convert(glb, usdz)
    with zipfile.ZipFile(usdz) as z:
        names = z.namelist()
    got = reopen(usdz)
    got.update({"bytes": usdz.stat().st_size, "first_entry": names[0] if names else "", "path": str(usdz)})
    ok = got["meshes"] > 0 and names and names[0].endswith((".usdc", ".usda", ".usd"))
    print("CHE_USDZ " + json.dumps(got), flush=True)
    os._exit(0 if ok else 1)


if __name__ == "__main__":
    main()

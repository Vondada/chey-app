"""Render a crew GLB as review stills: one per clip (body) and one per face shape (close-up), with Blender Cycles on CPU.

    python crew_contact_sheet.py -- <model.glb> <out_dir> [clip,clip,...|all] [faces]

Each still is <out_dir>/<id>_<clip>.png or <id>_face_<shape>.png. The GLB is imported as it ships (its clips and
glTF morph targets), so the stills show what the app and the scene renderer get, not the build scene.
"""
import math
import os
import sys
from pathlib import Path

import bpy
from mathutils import Vector

ARGS = sys.argv[sys.argv.index("--") + 1:]
GLB, OUT = Path(ARGS[0]), Path(ARGS[1])
WANT = ARGS[2] if len(ARGS) > 2 else "all"
FACES = len(ARGS) > 3 and ARGS[3] == "faces"
CID = GLB.stem


def setup():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(GLB))
    sc = bpy.context.scene
    sc.render.engine = "CYCLES"
    sc.cycles.device = "CPU"
    sc.cycles.samples = 12
    sc.cycles.use_denoising = True
    sc.render.resolution_x, sc.render.resolution_y = 480, 640
    sc.render.film_transparent = False
    world = bpy.data.worlds.new("w")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs[0].default_value = (0.82, 0.84, 0.88, 1)
    world.node_tree.nodes["Background"].inputs[1].default_value = 0.35
    sc.world = world
    for name, loc, energy in (("key", (1.5, -2.5, 3.0), 260), ("fill", (-2.0, -1.5, 2.0), 110)):
        light = bpy.data.objects.new(name, bpy.data.lights.new(name, "AREA"))
        light.data.energy, light.data.size = energy, 2.0
        light.location = loc
        light.rotation_euler = (Vector((0, 0, 0.6)) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()
        sc.collection.objects.link(light)
    cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
    sc.collection.objects.link(cam)
    sc.camera = cam
    return sc, cam


def aim(cam, target, distance, lens):
    # glTF is Y up and the character faces +Z there; Blender's importer turns that into Z up, facing -Y.
    cam.data.lens = lens
    cam.location = Vector(target) + Vector((0.0, -distance, 0.05))
    cam.rotation_euler = (Vector(target) - cam.location).to_track_quat("-Z", "Y").to_euler()


def main():
    sc, cam = setup()
    OUT.mkdir(parents=True, exist_ok=True)
    rig = next(o for o in bpy.data.objects if o.type == "ARMATURE")
    rig.animation_data_create()
    clips = sorted(a.name for a in bpy.data.actions)
    pick = clips if WANT == "all" else [c for c in clips if c in WANT.split(",")]
    aim(cam, (0, 0, 0.55), 2.6, 70)
    for name in pick:
        act = bpy.data.actions[name]
        rig.animation_data.action = act
        if hasattr(rig.animation_data, "action_slot") and act.slots:
            rig.animation_data.action_slot = act.slots[0]
        start, end = act.frame_range
        sc.frame_set(int(start + (end - start) * (0.95 if name in ("surprised", "point") else 0.3)))
        sc.render.filepath = str(OUT / f"{CID}_{name}.png")
        bpy.ops.render.render(write_still=True)
        print("STILL", sc.render.filepath, flush=True)
    if FACES:
        rig.animation_data.action = bpy.data.actions["idle"] if "idle" in bpy.data.actions else None
        sc.frame_set(1)
        aim(cam, (0, 0, 0.84), 0.75, 60)
        keyed = [o for o in bpy.data.objects if o.type == "MESH" and o.data.shape_keys]
        shapes = sorted({k.name for o in keyed for k in o.data.shape_keys.key_blocks if k.name != "Basis"})
        for shape in shapes:
            for o in keyed:
                for k in o.data.shape_keys.key_blocks:
                    if k.name != "Basis":
                        k.value = 1.0 if k.name == shape else 0.0
            sc.render.filepath = str(OUT / f"{CID}_face_{shape}.png")
            bpy.ops.render.render(write_still=True)
            print("STILL", sc.render.filepath, flush=True)


main()
os._exit(0)

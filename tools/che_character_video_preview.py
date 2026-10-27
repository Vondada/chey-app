#!/usr/bin/env python3
"""Render a short actual GLB character animation in Blender (not illustrated slides).

Usage: blender -b -t 2 --python tools/che_character_video_preview.py -- --model assets/characters/crew/che.glb --out rendered
"""
import argparse
import json
import math
import os
import sys
from pathlib import Path

import bpy
from mathutils import Vector

def main():
    p = argparse.ArgumentParser()
    p.add_argument("--model", required=True)
    p.add_argument("--out", default="rendered")
    p.add_argument("--frames", type=int, default=36)
    a = p.parse_args(sys.argv[sys.argv.index("--") + 1:])
    if not (12 <= a.frames <= 120):
        raise ValueError("frames must be between 12 and 120")
    model = Path(a.model).resolve()
    if not model.is_file():
        raise FileNotFoundError(model)
    out = Path(a.out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(model))
    scene = bpy.context.scene
    meshes = [obj for obj in scene.objects if obj.type == "MESH"]
    if not meshes:
        raise RuntimeError("GLB contains no meshes; refusing generic fallback")
    points = [obj.matrix_world @ Vector(corner) for obj in meshes for corner in obj.bound_box]
    lo = Vector(tuple(min(v[i] for v in points) for i in range(3)))
    hi = Vector(tuple(max(v[i] for v in points) for i in range(3)))
    center = (lo + hi) / 2
    height = max(hi.z - lo.z, 0.1)
    width = max(hi.x - lo.x, hi.y - lo.y, 0.1)
    radius = max(height * 1.35, width * 2.2)
    # Floor, area lights, and dark studio backdrop.
    bpy.ops.mesh.primitive_plane_add(size=200, location=(center.x, center.y, lo.z - 0.025))
    floor = bpy.context.object
    mat = bpy.data.materials.new("CHE studio floor")
    mat.diffuse_color = (0.025, 0.045, 0.075, 1)
    floor.data.materials.append(mat)
    world = bpy.data.worlds.new("CHE studio world")
    scene.world = world
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.015, 0.025, 0.045, 1)
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.5
    for name, xyz, power, color in [
        ("Key", (center.x - radius, center.y - radius, center.z + height), 950, (0.85, 0.95, 1)),
        ("Rim", (center.x + radius, center.y + radius, center.z + height), 1300, (0.2, 0.8, 1)),
    ]:
        light = bpy.data.lights.new(name, "AREA")
        light.energy = power
        light.color = color
        light.shape = "DISK"
        light.size = height * 1.4
        obj = bpy.data.objects.new(name, light)
        scene.collection.objects.link(obj)
        obj.location = xyz
        obj.rotation_euler = (center - obj.location).to_track_quat("-Z", "Y").to_euler()
    camera_data = bpy.data.cameras.new("CHE preview camera")
    camera = bpy.data.objects.new("CHE preview camera", camera_data)
    scene.collection.objects.link(camera)
    scene.camera = camera
    camera_data.type = "ORTHO"
    camera_data.ortho_scale = height * 1.6
    scene.render.engine = "BLENDER_EEVEE_NEXT" if hasattr(bpy.types, "RenderSettings") and bpy.app.version >= (4, 2, 0) else "BLENDER_EEVEE"
    scene.render.resolution_x = 360
    scene.render.resolution_y = 640
    scene.render.resolution_percentage = 100
    scene.render.fps = 12
    scene.frame_start = 1
    scene.frame_end = a.frames
    scene.render.image_settings.file_format = "PNG"
    scene.render.film_transparent = False
    # Existing GLB animation actions are sampled by frame_set; camera orbits for guaranteed motion.
    for frame in range(1, a.frames + 1):
        phase = (frame - 1) / max(1, a.frames - 1)
        angle = -0.22 + 0.44 * phase
        camera.location = (center.x + radius * math.sin(angle), center.y - radius * math.cos(angle), center.z + height * 0.12)
        camera.rotation_euler = (center - camera.location).to_track_quat("-Z", "Y").to_euler()
        scene.frame_set(frame)
        scene.render.filepath = str(out / f"frame_{frame:04d}.png")
        bpy.ops.render.render(write_still=True)
        print(f"CHE_3D_FRAME {frame}/{a.frames}", flush=True)
    manifest = {"source_glb": str(model.relative_to(Path.cwd())), "mesh_count": len(meshes), "frames": a.frames, "fps": 12, "renderer": "blender-real-glb", "animation": "camera-orbit"}
    (out / "scene_manifest.json").write_text(json.dumps(manifest, indent=2))
    print("CHE_3D_SCENE_VERIFIED " + json.dumps(manifest), flush=True)

if __name__ == "__main__":
    main()

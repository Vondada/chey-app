#!/usr/bin/env python3
"""CHE Scene Director renderer: one editable scene spec -> real 3D frames rendered by Blender (Cycles).

Owner, 2026-11-06: "CHE, make Nova walk into my office, sit beside me, and start talking", then "change her outfit, make
the camera circle around us, slow down the last five seconds, and add music" without rebuilding everything.

The spec is the project (server/cloudflare/scene_director.js writes it); this script only draws it:
  - the office set (floor, walls, window, desk, the owner's chair and the guest chair, lamp, plant),
  - each actor from its real crew GLB with its real clips (walk, sit, talk, ...), moved along its path,
    seated on its chair, talking from the waist up while seated,
  - the camera (static, or circling the seats),
  - an outfit colour on the actor's "cloth" material.
Frames are written as PNGs for the frame range asked, so several runners can each render a part.
Timing changes (slow-motion) and sound (voice, music) are applied afterwards by tools/che_scene_finish.py with ffmpeg,
so those edits never re-render 3D.

Usage (Blender's Python, or the bpy wheel):
  blender -b --python tools/che_scene_render.py -- --spec scene.json --out frames [--start 1 --end 48]
  python3.11 tools/che_scene_render.py --spec scene.json --out frames
"""
import argparse
import json
import math
import sys
from pathlib import Path

import bpy
from mathutils import Euler, Vector

LEG_BONES = ("pelvis", "thigh", "shin", "foot", "toe", "leg", "hip", "knee", "ankle")
ACTOR_HEIGHT = 1.62  # the crew are drawn small; scaled to an adult's height in a life-size office
SEAT_BELOW_PELVIS = 0.06  # the crew's sit pose keeps the hips where they are and folds the legs; the seat goes just under
HELPERS = ("icosphere",)  # each crew GLB carries a 2-unit helper sphere that is not part of the body


def args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else sys.argv[1:]
    p = argparse.ArgumentParser()
    p.add_argument("--spec", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--start", type=int, default=None)
    p.add_argument("--end", type=int, default=None)
    p.add_argument("--root", default=".", help="repository root for asset paths")
    return p.parse_args(argv)


def hex_rgba(value, alpha=1.0):
    v = str(value).lstrip("#")
    if len(v) != 6:
        raise ValueError(f"not a colour: {value}")
    srgb = [int(v[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    lin = [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in srgb]
    return (*lin, alpha)


def material(name, color, roughness=0.6, emission=None, strength=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = hex_rgba(color)
    bsdf.inputs["Roughness"].default_value = roughness
    if emission:
        bsdf.inputs["Emission Color"].default_value = hex_rgba(emission)
        bsdf.inputs["Emission Strength"].default_value = strength
    return m


def box(name, size, location, mat, rotation_z=0.0):
    bpy.ops.mesh.primitive_cube_add(size=1, location=location)
    o = bpy.context.object
    o.name = name
    o.scale = size
    o.rotation_euler = (0, 0, rotation_z)
    o.data.materials.append(mat)
    return o


def chair(name, seat, heading, mat, seat_h):
    """A simple chair: its seat centre at `seat` (x, y), facing `heading` degrees, seat top at `seat_h`."""
    x, y = seat
    r = math.radians(heading)
    parts = [box(f"{name} seat", (0.55, 0.55, 0.08), (x, y, seat_h - 0.04), mat, r)]
    back = Vector((0, 0.27, 0))  # actors face -Y, so the back is behind them at +Y
    back.rotate(Euler((0, 0, r)))
    parts.append(box(f"{name} back", (0.55, 0.07, 0.6), (x + back.x, y + back.y, seat_h + 0.3), mat, r))
    for dx in (-0.23, 0.23):
        for dy in (-0.23, 0.23):
            leg = Vector((dx, dy, 0))
            leg.rotate(Euler((0, 0, r)))
            parts.append(box(f"{name} leg", (0.05, 0.05, seat_h - 0.08), (x + leg.x, y + leg.y, (seat_h - 0.08) / 2), mat, r))
    return parts


# Relight (the owner's Higgsfield "Miracle" references, 2026-11-06): the time of day as light colours and strengths for
# the ceiling key, the desk lamp, the fill, the window glow and the sky. (name: (colour, power) or (colour, strength))
LIGHTING = {
    "warm": {"key": ("#ffd9a8", 380), "lamp": ("#ffc27a", 60), "fill": ("#cfe0ff", 160), "window": ("#7fa8ff", 1.2), "world": ("#1a1f2b", 0.35)},
    "cool": {"key": ("#e6f0ff", 380), "lamp": ("#dfe9ff", 60), "fill": ("#cfe0ff", 160), "window": ("#9fc4ff", 1.4), "world": ("#1a1f2b", 0.35)},
    "morning": {"key": ("#fff4e0", 300), "lamp": ("#ffe2b8", 30), "fill": ("#dcebff", 200), "window": ("#e8f3ff", 3.5), "world": ("#9fc4ff", 0.6)},
    "sunset": {"key": ("#ffb27a", 240), "lamp": ("#ffb060", 90), "fill": ("#a98bd8", 110), "window": ("#ff8a4a", 3.2), "world": ("#3a2030", 0.45)},
    "night": {"key": ("#9fb4ff", 110), "lamp": ("#ffc27a", 140), "fill": ("#5a6fa8", 60), "window": ("#2a3f7a", 0.7), "world": ("#05070d", 0.12)},
}


def build_set(spec, seat_h):
    s = spec.get("set", {})
    look = LIGHTING.get(s.get("light", "warm"), LIGHTING["warm"])
    floor = material("floor", s.get("floor", "#5b4636"), 0.45)
    wall = material("wall", s.get("wall", "#d9d2c5"), 0.8)
    wood = material("desk", "#3b2a20", 0.4)
    seat = material("chair", s.get("chair", "#1f2a36"), 0.5)
    bpy.ops.mesh.primitive_plane_add(size=14, location=(0, 0, 0))
    bpy.context.object.data.materials.append(floor)
    box("ceiling", (14, 14, 0.05), (0, 0, 3.2), material("ceiling", "#efeae0", 0.9))
    box("back wall", (14, 0.1, 3.2), (0, 3.2, 1.6), wall)
    # The side wall has the doorway the actors walk in through (a gap from y=-0.4 to y=1.2).
    box("side wall front", (0.1, 4.6, 3.2), (-3.6, -2.7, 1.6), wall)
    box("side wall back", (0.1, 2.0, 3.2), (-3.6, 2.2, 1.6), wall)
    box("door header", (0.1, 1.6, 0.9), (-3.6, 0.4, 2.75), wall)
    # A night-city window on the back wall (an emissive panel, so it lights the room a little).
    city = material("window", "#0b1630", 0.2, emission=look["window"][0], strength=look["window"][1])
    box("window", (3.2, 0.02, 1.5), (1.2, 3.13, 1.65), city)
    box("desk top", (1.8, 0.8, 0.06), (0.9, 1.5, 0.74), wood)
    box("desk side", (0.06, 0.75, 0.72), (0.03, 1.5, 0.36), wood)
    box("desk side", (0.06, 0.75, 0.72), (1.77, 1.5, 0.36), wood)
    box("monitor", (0.7, 0.04, 0.42), (0.9, 1.75, 1.05), material("screen", "#111111", 0.3, emission="#9fd4ff", strength=0.6))
    for name, pos in spec.get("seats", {}).items():
        # The sit pose moves the hips back about 0.19, so the seat centre sits that far behind the actor's spot.
        shift = Vector((0, 0.17, 0))
        shift.rotate(Euler((0, 0, math.radians(pos[2]))))
        chair(f"chair {name}", (pos[0] + shift.x, pos[1] + shift.y), pos[2], seat, seat_h)
    pot = material("pot", "#6b4f3a", 0.7)
    leaf = material("leaf", "#2f6b3a", 0.6)
    bpy.ops.mesh.primitive_cylinder_add(radius=0.22, depth=0.45, location=(2.9, 2.6, 0.225))
    bpy.context.object.data.materials.append(pot)
    bpy.ops.mesh.primitive_uv_sphere_add(radius=0.45, location=(2.9, 2.6, 0.85))
    bpy.context.object.data.materials.append(leaf)
    scene = bpy.context.scene
    world = bpy.data.worlds.new("office")
    scene.world = world
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = hex_rgba(look["world"][0])
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = look["world"][1]
    for name, loc, power, color in (
        ("ceiling key", (0.5, -0.5, 3.0), look["key"][1], look["key"][0]),
        ("lamp", (1.6, 1.4, 1.6), look["lamp"][1], look["lamp"][0]),
        ("fill", (-2.5, -3.0, 2.2), look["fill"][1], look["fill"][0]),
    ):
        light = bpy.data.lights.new(name, "AREA")
        light.energy = power
        light.color = hex_rgba(color)[:3]
        light.size = 1.6
        obj = bpy.data.objects.new(name, light)
        scene.collection.objects.link(obj)
        obj.location = loc
        obj.rotation_euler = (Vector((0.5, 0.8, 0.6)) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()


def import_actor(actor, root):
    before = set(bpy.data.objects)
    actions_before = set(bpy.data.actions)
    bpy.ops.import_scene.gltf(filepath=str(Path(root) / actor["model"]))
    objs = [o for o in bpy.data.objects if o not in before]
    arm = next(o for o in objs if o.type == "ARMATURE")
    clips = {a.name.split("_")[0]: a for a in bpy.data.actions if a not in actions_before}
    if actor.get("cloth"):
        for o in objs:
            if o.type != "MESH":
                continue
            for i, m in enumerate(o.data.materials):
                if m and m.name.split(".")[0] == "cloth":
                    o.data.materials[i] = material(f"{actor['id']} outfit", actor["cloth"], 0.7)
    return arm, objs, clips


def upper_body(action, name):
    """A copy of a clip with the pelvis and leg channels removed, to layer over a held sit pose."""
    copy = action.copy()
    copy.name = name
    for fc in list(copy.fcurves):
        bone = fc.data_path.split('"')[1] if '"' in fc.data_path else ""
        if any(k in bone.lower() for k in LEG_BONES):
            copy.fcurves.remove(fc)
    return copy


def strip(track, action, start, end, name, hold=False):
    # A repeated clip can end a fraction of a frame late; the next clip on the track starts after it, never on top.
    last = max([x.frame_end for x in track.strips] or [0])
    s = track.strips.new(name, int(max(start, math.ceil(last))), action)
    length = action.frame_range[1] - action.frame_range[0]
    if hold:
        s.frame_end = start + length
        s.extrapolation = "HOLD_FORWARD"
    else:
        s.repeat = max(1.0, (end - start) / max(1.0, length))
    s.blend_type = "REPLACE"
    return s


def heading_to(a, b):
    # The crew models face -Y; this turns them to face from a towards b.
    return math.degrees(math.atan2(b[1] - a[1], b[0] - a[0])) + 90


def animate_actor(arm, clips, actor, timeline, spec, fps):
    seats = spec.get("seats", {})
    arm.animation_data_create()
    arm.animation_data.action = None
    body = arm.animation_data.nla_tracks.new()
    body.name = "body"
    top = arm.animation_data.nla_tracks.new()
    top.name = "upper body"
    pos = list(actor["start"][:2])
    heading = actor["start"][2] if len(actor["start"]) > 2 else 0
    seated = False

    def key(frame, xy, head):
        arm.location = (xy[0], xy[1], 0)
        arm.rotation_mode = "XYZ"
        arm.rotation_euler = (0, 0, math.radians(head))
        arm.keyframe_insert("location", frame=frame)
        arm.keyframe_insert("rotation_euler", frame=frame)

    key(1, pos, heading)
    for step in [s for s in timeline if s["actor"] == actor["id"]]:
        f0 = 1 + round(step["t0"] * fps)
        f1 = 1 + round(step["t1"] * fps)
        act = step["action"]
        if act == "walk":
            target = step["to"]
            heading = heading_to(pos, target)
            key(f0, pos, heading)
            strip(body, clips["walk"], f0, f1, "walk")
            pos = list(target[:2])
            key(f1, pos, heading)
        elif act == "sit":
            seat = seats[step["seat"]]
            # Turn to face the way the chair faces, then sit.
            key(f0, seat[:2], heading)
            heading = seat[2]
            key(min(f1, f0 + 8), seat[:2], heading)  # a short turn to face the way the chair faces
            pos = list(seat[:2])
            strip(body, clips["sit"], f0, f1, "sit", hold=True)
            seated = True
        elif act in clips:
            if seated:
                strip(top, upper_body(clips[act], f"{act} seated"), f0, f1, f"{act} seated")
            else:
                strip(body, clips[act], f0, f1, act)
        key(f1, pos, heading)
    for fc in arm.animation_data.action.fcurves if arm.animation_data.action else []:
        for k in fc.keyframe_points:
            k.interpolation = "LINEAR"


def camera_for(spec, frames, fps):
    """Static, or orbit: holds the opening shot until t0, blends into a circle round the target, and circles until t1.
    While the camera is behind the back wall, that wall and its window are hidden so the shot sees into the room."""
    scene = bpy.context.scene
    data = bpy.data.cameras.new("camera")
    c = spec.get("camera", {})
    data.lens = c.get("lens", 28)
    cam = bpy.data.objects.new("camera", data)
    scene.collection.objects.link(cam)
    scene.camera = cam

    def pose(shot, angle_deg):
        tgt = Vector(shot.get("target", (0.2, 0.6, 1.0)))
        a = math.radians(angle_deg)
        d = shot.get("distance", 5.2)
        return Vector((tgt.x + d * math.sin(a), tgt.y - d * math.cos(a), shot.get("height", 1.7))), tgt

    move = c.get("move", "static")
    opening = c.get("from", c)
    t0 = 1 + round(float(c.get("t0", 0)) * fps)
    t1 = 1 + round(float(c.get("t1", frames / fps)) * fps)
    blend = 18  # frames to glide from the opening shot onto the circle
    behind = [o for o in bpy.data.objects if o.name in ("back wall", "window") or o.name.startswith("monitor")]
    for f in range(1, frames + 1):
        if move == "orbit" and f >= t0:
            p = min(1.0, (f - t0) / max(1, t1 - t0))
            loc, tgt = pose(c, c.get("angle", -25) + c.get("degrees", 360) * p)
            if f < t0 + blend:
                w = (f - t0) / blend
                w = w * w * (3 - 2 * w)
                loc0, tgt0 = pose(opening, opening.get("angle", -25))
                loc, tgt = loc0.lerp(loc, w), tgt0.lerp(tgt, w)
        else:
            loc, tgt = pose(opening, opening.get("angle", -25))
        cam.location = loc
        cam.rotation_euler = (tgt - loc).to_track_quat("-Z", "Y").to_euler()
        cam.keyframe_insert("location", frame=f)
        cam.keyframe_insert("rotation_euler", frame=f)
        hide = loc.y > 2.9
        for o in behind:
            o.hide_render = hide
            o.keyframe_insert("hide_render", frame=f)
    return cam


def main():
    a = args()
    spec = json.loads(Path(a.spec).read_text())
    fps = int(spec.get("fps", 24))
    frames = int(round(float(spec["seconds"]) * fps))
    start = a.start or 1
    end = min(a.end or frames, frames)
    out = Path(a.out).resolve()
    out.mkdir(parents=True, exist_ok=True)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.fps = fps
    scene.frame_start, scene.frame_end = 1, frames
    actors = []
    for actor in spec["actors"]:
        arm, objs, clips = import_actor(actor, a.root)
        arm["meshes"] = [o.name for o in objs if o.type == "MESH"]
        missing = {s["action"] for s in spec["timeline"] if s["actor"] == actor["id"]} - set(clips) - {"walk", "sit"}
        if missing or "walk" not in clips or "sit" not in clips:
            raise RuntimeError(f"{actor['id']} has no clip for: {sorted(missing | ({'walk', 'sit'} - set(clips)))}")
        actors.append((actor, arm, clips))
    # Measured from each actor's own skeleton and body meshes (never the helper sphere): its height, its feet, and where
    # its hips are in the sit pose. Each actor is scaled to an adult height, feet on the floor, and the chairs are built
    # so the seat is just under the seated hips.
    def body_meshes(arm):
        return [bpy.data.objects[n] for n in arm["meshes"] if not any(h in n.lower() for h in HELPERS)]

    def lowest_foot(arm):
        return min((arm.matrix_world @ b.tail).z for b in arm.pose.bones if b.name.lower().startswith(("foot", "toe")))

    seat_h = None
    for actor, arm, clips in actors:
        for n in arm["meshes"]:
            if any(h in n.lower() for h in HELPERS):
                bpy.data.objects[n].hide_render = True
        arm.animation_data.action = clips.get("idle")
        scene.frame_set(int(clips["idle"].frame_range[0]) if "idle" in clips else 1)
        dg = bpy.context.evaluated_depsgraph_get()
        tops = []
        for o in body_meshes(arm):
            m = o.evaluated_get(dg).to_mesh()
            tops += [(o.matrix_world @ v.co).z for v in m.vertices]
            o.evaluated_get(dg).to_mesh_clear()
        feet = lowest_foot(arm)
        k = float(actor.get("height", ACTOR_HEIGHT)) / max(0.2, max(tops) - feet)
        arm.scale = (k, k, k)
        arm["floor_offset"] = -feet * k
        arm.animation_data.action = clips["sit"]
        scene.frame_set(int(clips["sit"].frame_range[1]))
        pelvis = (arm.matrix_world @ arm.pose.bones[0].head).z  # matrix_world already includes the new scale
        if seat_h is None:
            seat_h = pelvis - SEAT_BELOW_PELVIS * k + arm["floor_offset"]
        arm.animation_data.action = None
    build_set(spec, seat_h)
    for actor, arm, clips in actors:
        animate_actor(arm, clips, actor, spec["timeline"], spec, fps)
        off = arm["floor_offset"]
        if arm.animation_data.action:
            for fc in arm.animation_data.action.fcurves:
                if fc.data_path == "location" and fc.array_index == 2:
                    for k in fc.keyframe_points:
                        k.co.y += off
    camera_for(spec, frames, fps)

    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = int(spec.get("samples", 24))
    scene.cycles.use_denoising = bool(spec.get("denoise", True))
    # Speed on CPU runners: few bounces, adaptive sampling, and the scene kept between frames (only poses change).
    scene.cycles.max_bounces = 4
    scene.cycles.diffuse_bounces = 2
    scene.cycles.glossy_bounces = 2
    scene.cycles.transmission_bounces = 2
    scene.cycles.use_adaptive_sampling = True
    scene.render.use_persistent_data = True
    scene.render.resolution_x = int(spec.get("width", 720))
    scene.render.resolution_y = int(spec.get("height", 1280))
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    for f in range(start, end + 1):
        scene.frame_set(f)
        scene.render.filepath = str(out / f"frame_{f:05d}.png")
        bpy.ops.render.render(write_still=True)
        print(f"CHE_SCENE_FRAME {f}/{frames}", flush=True)
    print("CHE_SCENE_RENDERED " + json.dumps({"frames": [start, end], "of": frames, "fps": fps, "engine": "cycles", "actors": [x[0]["id"] for x in actors]}), flush=True)


if __name__ == "__main__":
    main()
    # The bpy module can crash while tearing down after a successful render; every frame is already written.
    sys.stdout.flush()
    import os
    os._exit(0)

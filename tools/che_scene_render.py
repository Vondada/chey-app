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

from che_scene_layout import apply_layout  # touch edits (offset, scale); tools/ is on the path as this script's folder
import che_scene_look as look_data  # lights, props, materials, actor poses and camera keys as data (Stage 7)

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


# The office's inner walls (metres), shared with tools/che_scene_look.py. The seats sit near the middle; the door is on
# the left wall. The default static camera (scene_director.js DEFAULT_CAMERA) stands at about (1.3, -5.0), inside the
# front wall; the orbit (radius 3) stays inside the side walls and only passes behind the back wall, hidden while it does.
ROOM = look_data.ROOM
INSET = 0.3  # how close the camera may come to a side or front wall
TARGETS = {}  # material target id -> the objects it colours (spec.materials)


def tag(target, *objs):
    TARGETS.setdefault(target, []).extend(o for o in objs if o is not None)
    return objs[0] if objs else None


# Built-in props, drawn from simple shapes at the prop's own origin: it stands on z=0 (wall pieces are centred on it)
# and faces +Y, so rotation 0 suits the front wall and 90 the right wall (spec.props, tools/che_scene_look.py).
def prop_bookshelf(look):
    wood = material("shelf wood", "#6b4a33", 0.55)
    spines = [material(f"book {i}", c, 0.7) for i, c in enumerate(("#8c2f2f", "#2f4f8c", "#d9a441", "#3f7a4f", "#5b3f7a", "#c96a3a"))]
    box("bookshelf back", (1.6, 0.04, 2.0), (0, -0.14, 1.0), wood)
    for side in (-0.8, 0.8):
        box("bookshelf side", (0.04, 0.32, 2.0), (side, 0, 1.0), wood)
    for k in range(5):
        z = 0.05 + k * 0.48
        box("bookshelf shelf", (1.6, 0.32, 0.03), (0, 0, z), wood)
        if k < 4:
            x, i = -0.72, k
            while x < 0.62:
                w = 0.05 + 0.03 * ((i * 7) % 3)
                h = 0.26 + 0.04 * ((i * 5) % 3)
                box("book", (w, 0.22, h), (x + w / 2, 0, z + 0.015 + h / 2), spines[i % len(spines)])
                x += w + 0.01
                i += 1


def prop_whiteboard(look):
    box("whiteboard", (1.6, 0.03, 1.0), (0, 0, 0), material("whiteboard", "#f7f7f4", 0.25))
    box("whiteboard frame", (1.7, 0.02, 1.1), (0, -0.015, 0), material("cabinet", "#4a5560", 0.35))


def prop_print(look):
    box("print frame", (1.1, 0.03, 0.8), (0, 0, 0), material("frame", "#1b1b1b", 0.4))
    box("print", (0.96, 0.01, 0.66), (0, 0.02, 0), material("print", look["window"][0], 0.6))


def prop_sideboard(look):
    box("sideboard", (1.6, 0.5, 0.9), (0, 0, 0.45), material("shelf wood", "#6b4a33", 0.55))
    paper = material("paper", "#f3efe6", 0.9)
    for x in (0.25, 0.45):
        bpy.ops.mesh.primitive_cylinder_add(radius=0.045, depth=0.1, location=(x, 0.02, 0.95))
        bpy.context.object.data.materials.append(paper)


def prop_coffee_machine(look):
    box("coffee machine", (0.3, 0.32, 0.42), (0, 0, 0.21), material("coffee machine", "#2b2b2e", 0.3))
    box("coffee machine light", (0.06, 0.01, 0.03), (0, 0.17, 0.3), material("ready light", "#111111", 0.3, emission="#5cff9a", strength=4))


def prop_filing_cabinet(look):
    box("filing cabinet", (0.6, 0.5, 1.3), (0, 0, 0.65), material("cabinet", "#4a5560", 0.35))
    paper = material("paper", "#f3efe6", 0.9)
    for k in range(3):
        box("drawer handle", (0.2, 0.01, 0.03), (0, 0.26, 0.3 + k * 0.42), paper)


def prop_rug(look):
    box("rug", (3.0, 2.2, 0.01), (0, 0, 0.005), material("rug", "#384a5e", 0.95))


def prop_plant(look):
    bpy.ops.mesh.primitive_cylinder_add(radius=0.22, depth=0.45, location=(0, 0, 0.225))
    bpy.context.object.data.materials.append(material("pot", "#6b4f3a", 0.7))
    bpy.ops.mesh.primitive_uv_sphere_add(radius=0.45, location=(0, 0, 0.85))
    bpy.context.object.data.materials.append(material("leaf", "#2f6b3a", 0.6))


def prop_ceiling_panel(look):
    box("ceiling panel", (1.2, 0.6, 0.02), (0, 0, 0), material("panel", "#fffaf0", 0.5, emission=look["key"][0], strength=2.5))


def prop_box(look):
    box("box", (1, 1, 1), (0, 0, 0.5), material("box", "#8a7a66", 0.6))


PROP_BUILDERS = {k: globals()[f"prop_{k}"] for k in look_data.PROP_KINDS}


def place_props(spec, look, root):
    """Every prop in spec.props (or the default dressing), each under its own empty at its position, rotation, scale."""
    for p in look_data.props(spec):
        before = set(bpy.data.objects)
        if p["asset"] in PROP_BUILDERS:
            PROP_BUILDERS[p["asset"]](look)
        else:
            path = Path(root) / p["asset"]
            if not path.is_file():
                print(f"CHE_SCENE_WARN prop {p['id']}: {p['asset']} is not in the repository; skipped", flush=True)
                continue
            bpy.ops.import_scene.gltf(filepath=str(path))
        parts = [o for o in bpy.data.objects if o not in before]
        holder = bpy.data.objects.new(f"prop {p['id']}", None)
        bpy.context.scene.collection.objects.link(holder)
        for o in parts:
            if o.parent is None:
                o.parent = holder
        holder.location = p["position"]
        holder.rotation_euler = [math.radians(a) for a in p["rotation"]]
        holder.scale = p["scale"]
        tag(p["id"], *[o for o in parts if o.type == "MESH"])
        if p.get("material"):
            spec.setdefault("_prop_materials", {})[p["id"]] = p["material"]


def place_lights(spec, look):
    scene = bpy.context.scene
    kinds = {"area": "AREA", "sun": "SUN", "point": "POINT", "spot": "SPOT"}
    for l in look_data.lights(spec, look):
        light = bpy.data.lights.new(l["id"], kinds[l["type"]])
        light.energy = l["power"]
        light.color = hex_rgba(l["color"])[:3]
        if l["type"] == "area":
            light.size = l["size"]
        elif l["type"] == "spot":
            light.spot_size = math.radians(l["size"])
            light.shadow_soft_size = 0.25
        elif l["type"] == "point":
            light.shadow_soft_size = l["size"]
        obj = bpy.data.objects.new(f"light {l['id']}", light)
        scene.collection.objects.link(obj)
        obj.location = l["position"]
        if "rotation" in l:
            obj.rotation_euler = [math.radians(a) for a in l["rotation"]]
        else:
            obj.rotation_euler = (Vector(l["look_at"]) - Vector(l["position"])).to_track_quat("-Z", "Y").to_euler()


def edited_material(original, target, m):
    """A copy of `original` (or a new Principled material when there is none) with only the fields `m` names changed:
    its other colours, emission and image textures are kept (a partial edit never resets the rest of the look)."""
    mat = original.copy() if original else bpy.data.materials.new(f"{target} edited")
    mat.name = f"{target} edited"
    mat.use_nodes = True
    tree = mat.node_tree
    bsdf = next((n for n in tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
    if bsdf is None:
        bsdf = tree.nodes.new("ShaderNodeBsdfPrincipled")
        out = next((n for n in tree.nodes if n.type == "OUTPUT_MATERIAL"), None) or tree.nodes.new("ShaderNodeOutputMaterial")
        tree.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])

    def put(name, value):
        sock = bsdf.inputs[name]
        for link in list(sock.links):  # the owner named this field, so it wins over a texture feeding it
            tree.links.remove(link)
        sock.default_value = value

    if "base_color" in m:
        put("Base Color", hex_rgba(m["base_color"]))
    if "roughness" in m:
        put("Roughness", m["roughness"])
    if "metallic" in m:
        put("Metallic", m["metallic"])
    if "emission" in m:
        put("Emission Color", hex_rgba(m["emission"]))
        put("Emission Strength", m["emission_strength"])
    return mat


def apply_materials(spec):
    """spec.materials and each prop's own material: base colour, roughness, metallic and emission on the named target.
    An actor id recolours only that actor's outfit; a prop or set target recolours every part of it. Each edit starts
    from the material it replaces, so fields it does not name keep their values."""
    wanted = {**spec.get("_prop_materials", {}), **look_data.materials(spec)}
    for target, m in wanted.items():
        objs = TARGETS.get(target, [])
        if not objs:
            continue
        actor = target in ACTOR_IDS
        made = {}  # one edited copy per original material, shared by every part that used it
        for o in objs:
            for i, slot in enumerate(o.data.materials):
                if not actor or (slot and slot.name.split(".")[0] in ("cloth",) or (slot and slot.name.endswith(" outfit"))):
                    key = slot.name if slot else None
                    if key not in made:
                        made[key] = edited_material(slot, target, m)
                    o.data.materials[i] = made[key]


ACTOR_IDS = set()


def build_set(spec, seat_h, root="."):
    s = spec.get("set", {})
    look = LIGHTING.get(s.get("light", "warm"), LIGHTING["warm"])
    floor = material("floor", s.get("floor", "#5b4636"), 0.45)
    wall = material("wall", s.get("wall", "#d9d2c5"), 0.8)
    wood = material("desk", "#3b2a20", 0.4)
    seat = material("chair", s.get("chair", "#1f2a36"), 0.5)
    bpy.ops.mesh.primitive_plane_add(size=14, location=(0, 0, 0))
    bpy.context.object.data.materials.append(floor)
    tag("floor", bpy.context.object)
    tag("ceiling", box("ceiling", (14, 14, 0.05), (0, 0, 3.2), material("ceiling", "#efeae0", 0.9)))
    x0, x1, y0, y1 = ROOM["x0"], ROOM["x1"], ROOM["y0"], ROOM["y1"]
    # The room is closed on every side (Stage 7): an orbiting or wide camera never sees past the walls into the empty
    # world. The left wall keeps the doorway the actors walk in through (a gap from y=-0.4 to y=1.2), with a short lit
    # corridor behind it; the walls run a little past each corner so a camera near one still sees wall at the frame edge.
    tag("wall",
        box("back wall", (14, 0.1, 3.2), (0, y1, 1.6), wall),
        box("side wall front", (0.1, -0.4 - (y0 - 0.6), 3.2), (x0, (-0.4 + y0 - 0.6) / 2, 1.6), wall),
        box("side wall back", (0.1, (y1 + 0.6) - 1.2, 3.2), (x0, (1.2 + y1 + 0.6) / 2, 1.6), wall),
        box("door header", (0.1, 1.6, 0.9), (x0, 0.4, 2.75), wall),
        box("right wall", (0.1, (y1 + 0.6) - (y0 - 0.6), 3.2), (x1, (y1 + y0) / 2, 1.6), wall),
        box("front wall", ((x1 + 0.6) - (x0 - 0.6), 0.1, 3.2), ((x0 + x1) / 2, y0, 1.6), wall),
        box("corridor far wall", (0.1, 4.0, 3.2), (x0 - 1.6, 0.4, 1.6), wall),
        box("corridor wall front", (1.6, 0.1, 3.2), (x0 - 0.8, -1.6, 1.6), wall),
        box("corridor wall back", (1.6, 0.1, 3.2), (x0 - 0.8, 2.4, 1.6), wall))
    tag("ceiling", box("corridor light", (0.8, 0.4, 0.02), (x0 - 0.8, 0.4, 3.17), material("corridor light", "#fffaf0", 0.5, emission=look["key"][0], strength=1.5)))
    trim = material("trim", s.get("trim", "#ece6da"), 0.5)
    for name, size, loc in (
        ("skirting back", (x1 - x0, 0.03, 0.12), ((x0 + x1) / 2, y1 - 0.06, 0.06)),
        ("skirting front", (x1 - x0, 0.03, 0.12), ((x0 + x1) / 2, y0 + 0.06, 0.06)),
        ("skirting right", (0.03, y1 - y0, 0.12), (x1 - 0.06, (y0 + y1) / 2, 0.06)),
    ):
        tag("trim", box(name, size, loc, trim))
    # A night-city window on the back wall (an emissive panel, so it lights the room a little).
    city = material("window", "#0b1630", 0.2, emission=look["window"][0], strength=look["window"][1])
    tag("window", box("window", (3.2, 0.02, 1.5), (1.2, 3.13, 1.65), city))
    tag("desk",
        box("desk top", (1.8, 0.8, 0.06), (0.9, 1.5, 0.74), wood),
        box("desk side", (0.06, 0.75, 0.72), (0.03, 1.5, 0.36), wood),
        box("desk side", (0.06, 0.75, 0.72), (1.77, 1.5, 0.36), wood))
    box("monitor", (0.7, 0.04, 0.42), (0.9, 1.75, 1.05), material("screen", "#111111", 0.3, emission="#9fd4ff", strength=0.6))
    for name, pos in spec.get("seats", {}).items():
        # The sit pose moves the hips back about 0.19, so the seat centre sits that far behind the actor's spot.
        shift = Vector((0, 0.17, 0))
        shift.rotate(Euler((0, 0, math.radians(pos[2]))))
        tag("chair", *chair(f"chair {name}", (pos[0] + shift.x, pos[1] + shift.y), pos[2], seat, seat_h))
    place_props(spec, look, root)
    scene = bpy.context.scene
    world = bpy.data.worlds.new("office")
    scene.world = world
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = hex_rgba(look["world"][0])
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = look["world"][1]
    # spec.lights, or the default three-point rig on the seats (tools/che_scene_look.py default_lights).
    place_lights(spec, look)


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
    ACTOR_IDS.add(actor["id"])
    tag(actor["id"], *[o for o in objs if o.type == "MESH"])  # spec.materials[actor id] recolours the outfit
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
    start = look_data.actor_start(actor)  # actor.position / actor.rotation override the start (Stage 7)
    pos = start[:2]
    heading = start[2]
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


def inside_room(loc):
    """Keeps the camera inside the side and front walls (it may pass behind the back wall, which is then hidden)."""
    return Vector((min(ROOM["x1"] - INSET, max(ROOM["x0"] + INSET, loc.x)), max(ROOM["y0"] + INSET, loc.y), min(3.0, max(0.3, loc.z))))


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
    keys = look_data.camera_keys(spec)
    for f in range(1, frames + 1):
        if keys:
            p, look_at, lens = look_data.camera_at(keys, (f - 1) / fps)
            loc, tgt = Vector(p), Vector(look_at)
            data.lens = lens
            data.keyframe_insert("lens", frame=f)
        elif move == "orbit" and f >= t0:
            p = min(1.0, (f - t0) / max(1, t1 - t0))
            loc, tgt = pose(c, c.get("angle", -25) + c.get("degrees", 360) * p)
            if f < t0 + blend:
                w = (f - t0) / blend
                w = w * w * (3 - 2 * w)
                loc0, tgt0 = pose(opening, opening.get("angle", -25))
                loc, tgt = loc0.lerp(loc, w), tgt0.lerp(tgt, w)
        else:
            loc, tgt = pose(opening, opening.get("angle", -25))
        loc = inside_room(loc)
        cam.location = loc
        cam.rotation_euler = (tgt - loc).to_track_quat("-Z", "Y").to_euler()
        cam.keyframe_insert("location", frame=f)
        cam.keyframe_insert("rotation_euler", frame=f)
        hide = loc.y > ROOM["y1"] - INSET
        for o in behind:
            o.hide_render = hide
            o.keyframe_insert("hide_render", frame=f)
    return cam


def main():
    a = args()
    spec = apply_layout(json.loads(Path(a.spec).read_text()))
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
    build_set(spec, seat_h, a.root)
    for actor, arm, clips in actors:
        animate_actor(arm, clips, actor, spec["timeline"], spec, fps)
        off = arm["floor_offset"]
        if arm.animation_data.action:
            for fc in arm.animation_data.action.fcurves:
                if fc.data_path == "location" and fc.array_index == 2:
                    for k in fc.keyframe_points:
                        k.co.y += off
    camera_for(spec, frames, fps)
    apply_materials(spec)

    scene.render.engine = "CYCLES"
    # AgX (Blender 4.0+) rolls off bright lights and windows instead of clipping them; Filmic on older Blenders.
    # (The colour-management enums are dynamic, so they are set and checked rather than listed.)
    for transform, contrast in (("AgX", "AgX - Medium High Contrast"), ("Filmic", "Medium High Contrast")):
        try:
            scene.view_settings.view_transform = transform
        except TypeError:
            continue
        try:
            scene.view_settings.look = contrast
        except TypeError:
            pass
        break
    scene.view_settings.exposure = float(spec.get("exposure", 0.0))
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

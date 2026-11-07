"""The scene's look as data: lights, props, materials, actor poses and camera keys (Stage 7).

The Scene Director spec (server/cloudflare/scene_director.js, normalizeLook) may carry these fields. This module reads
them, clamps them a second time, and fills in the defaults, so tools/che_scene_render.py only draws what it is given.
It has no Blender dependency, so it is tested on its own (tools/test_che_scene_look.py).

  spec.lights    [{id, type: area|sun|point|spot, position [x,y,z], rotation [x,y,z] deg | look_at [x,y,z],
                   color "#rrggbb", power (W; sun: strength), size (m; spot: cone angle in degrees)}]
                 When absent, the default three-point rig below (coloured by spec.set.light) is used.
  spec.props     [{id, asset, position [x,y,z], rotation z deg | [x,y,z] deg, scale s | [x,y,z], material?}]
                 asset is a built-in prop (PROP_KINDS) or a GLB under assets/ ("assets/....glb").
                 When absent, the default office dressing below is used; [] means no props at all.
  spec.materials {target_id: {base_color "#rrggbb", roughness 0..1, metallic 0..1, emission "#rrggbb",
                   emission_strength 0..50}}   target_id: a prop id, an actor id (its outfit), or one of SET_TARGETS.
  actor.position [x, y] and actor.rotation (deg): where the actor starts, replacing spec.actors[].start.
  spec.camera.keys [{t (s), position [x,y,z], look_at [x,y,z], lens (mm)}]: when present, the camera follows these
                 keys (smoothly between them) instead of its static or orbit move.
Old specs carry none of these and render with the defaults.
"""
import math
import re

ROOM = {"x0": -3.6, "x1": 3.6, "y0": -5.4, "y1": 3.2}
SUBJECT = (0.0, 0.4, 1.0)  # what the default lights aim at: the two seats, at chest height
LIGHT_TYPES = ("area", "sun", "point", "spot")
PROP_KINDS = ("bookshelf", "whiteboard", "print", "sideboard", "coffee_machine", "filing_cabinet", "rug", "plant",
              "ceiling_panel", "box")
SET_TARGETS = ("floor", "wall", "ceiling", "desk", "chair", "window", "trim")
MAX_LIGHTS, MAX_PROPS, MAX_MATERIALS, MAX_KEYS = 8, 40, 40, 32
HEX = re.compile(r"^#[0-9a-fA-F]{6}$")
ID = re.compile(r"^[a-z0-9][a-z0-9_-]{0,31}$")
GLB = re.compile(r"^assets/[A-Za-z0-9_./-]{1,160}\.glb$")


def clamp(v, lo, hi, default):
    try:
        x = float(v)
    except (TypeError, ValueError):
        return default
    if math.isnan(x) or math.isinf(x):
        return default
    return max(lo, min(hi, x))


def vec(v, n, lo, hi, default):
    if not isinstance(v, (list, tuple)) or len(v) < n:
        return list(default)
    return [clamp(v[i], lo, hi, default[i]) for i in range(n)]


def colour(v, default):
    return v if isinstance(v, str) and HEX.match(v) else default


def default_lights(look):
    """The Stage 7 default rig: a big soft key from the front-left, a dimmer fill from the front-right, a rim from behind
    that lifts the actors off the back wall, and the desk lamp. Colours and strengths follow the time of day."""
    key, fill, lamp = look["key"], look["fill"], look["lamp"]
    return [
        {"id": "key", "type": "area", "position": [-1.8, -2.2, 2.8], "look_at": list(SUBJECT), "color": key[0], "power": key[1] * 1.1, "size": 2.2},
        {"id": "fill", "type": "area", "position": [2.4, -2.6, 1.8], "look_at": list(SUBJECT), "color": fill[0], "power": fill[1] * 0.8, "size": 2.5},
        {"id": "rim", "type": "area", "position": [0.4, 2.7, 2.6], "look_at": list(SUBJECT), "color": key[0], "power": key[1] * 0.45, "size": 1.2},
        {"id": "lamp", "type": "area", "position": [1.6, 1.4, 1.6], "look_at": list(SUBJECT), "color": lamp[0], "power": lamp[1], "size": 0.4},
    ]


def default_props():
    """The default office dressing, so every wall a moving camera can face has something on it."""
    x0, x1, y0 = ROOM["x0"], ROOM["x1"], ROOM["y0"]
    props = [
        {"id": "bookshelf", "asset": "bookshelf", "position": [-1.6, y0 + 0.2, 0], "rotation": 0},
        {"id": "whiteboard", "asset": "whiteboard", "position": [1.0, y0 + 0.07, 1.55], "rotation": 0},
        {"id": "print", "asset": "print", "position": [x1 - 0.07, -1.6, 1.7], "rotation": 90},
        {"id": "sideboard", "asset": "sideboard", "position": [x1 - 0.3, 1.2, 0], "rotation": 90},
        {"id": "coffee-machine", "asset": "coffee_machine", "position": [x1 - 0.32, 1.0, 0.9], "rotation": 90},
        {"id": "filing-cabinet", "asset": "filing_cabinet", "position": [x1 - 0.3, y0 + 0.4, 0], "rotation": 90},
        {"id": "rug", "asset": "rug", "position": [0, 0.4, 0], "rotation": 0},
        {"id": "plant", "asset": "plant", "position": [2.9, 2.6, 0], "rotation": 0},
    ]
    for i, (px, py) in enumerate(((-1.6, -2.4), (1.6, -2.4), (-1.6, 1.0), (1.6, 1.0))):
        props.append({"id": f"ceiling-panel-{i + 1}", "asset": "ceiling_panel", "position": [px, py, 3.17], "rotation": 0})
    del x0
    return props


def rotation3(v):
    if isinstance(v, (list, tuple)):
        return vec(v, 3, -360, 360, [0, 0, 0])
    return [0, 0, clamp(v, -360, 360, 0)]


def scale3(v):
    if isinstance(v, (list, tuple)):
        return vec(v, 3, 0.05, 10, [1, 1, 1])
    s = clamp(v, 0.05, 10, 1)
    return [s, s, s]


def lights(spec, look):
    raw = spec.get("lights")
    if not isinstance(raw, list):
        raw = default_lights(look)
    out = []
    for i, l in enumerate(raw[:MAX_LIGHTS]):
        if not isinstance(l, dict):
            continue
        kind = l.get("type") if l.get("type") in LIGHT_TYPES else "area"
        item = {
            "id": l.get("id") if isinstance(l.get("id"), str) and ID.match(l["id"]) else f"light-{i + 1}",
            "type": kind,
            "position": vec(l.get("position"), 3, -20, 20, [0, -2, 2.8]),
            "color": colour(l.get("color"), "#ffffff"),
            "power": clamp(l.get("power"), 0, 20 if kind == "sun" else 5000, 5 if kind == "sun" else 200),
            "size": clamp(l.get("size"), 1, 180, 45) if kind == "spot" else clamp(l.get("size"), 0.01, 10, 1.0),
        }
        if l.get("rotation") is not None:
            item["rotation"] = rotation3(l["rotation"])
        else:
            item["look_at"] = vec(l.get("look_at"), 3, -20, 20, list(SUBJECT))
        out.append(item)
    return out


def props(spec):
    raw = spec.get("props")
    if not isinstance(raw, list):
        raw = default_props()
    out, seen = [], set()
    for i, p in enumerate(raw[:MAX_PROPS]):
        if not isinstance(p, dict):
            continue
        asset = p.get("asset")
        if not (asset in PROP_KINDS or (isinstance(asset, str) and GLB.match(asset) and ".." not in asset)):
            continue
        pid = p.get("id") if isinstance(p.get("id"), str) and ID.match(p["id"]) and p["id"] not in seen else f"prop-{i + 1}"
        seen.add(pid)
        item = {"id": pid, "asset": asset, "position": vec(p.get("position"), 3, -20, 20, [0, 0, 0]),
                "rotation": rotation3(p.get("rotation", 0)), "scale": scale3(p.get("scale", 1))}
        if isinstance(p.get("material"), dict):
            item["material"] = material(p["material"])
        out.append(item)
    return out


def material(m):
    out = {}
    if HEX.match(str(m.get("base_color", ""))):
        out["base_color"] = m["base_color"]
    for k in ("roughness", "metallic"):
        if m.get(k) is not None:
            out[k] = clamp(m[k], 0, 1, 0.5)
    if HEX.match(str(m.get("emission", ""))):
        out["emission"] = m["emission"]
        out["emission_strength"] = clamp(m.get("emission_strength", 1), 0, 50, 1)
    return out


def materials(spec):
    raw = spec.get("materials")
    if not isinstance(raw, dict):
        return {}
    out = {}
    for k, m in list(raw.items())[:MAX_MATERIALS]:
        if isinstance(k, str) and ID.match(k) and isinstance(m, dict):
            got = material(m)
            if got:
                out[k] = got
    return out


def actor_start(actor):
    """[x, y, heading]: the actor's own position/rotation override, else its start."""
    start = list(actor.get("start") or [0, 0, 0]) + [0, 0, 0]
    pos = vec(actor.get("position"), 2, -20, 20, start[:2]) if actor.get("position") is not None else start[:2]
    head = clamp(actor.get("rotation"), -360, 360, start[2]) if actor.get("rotation") is not None else start[2]
    return [pos[0], pos[1], head]


def camera_keys(spec):
    raw = (spec.get("camera") or {}).get("keys")
    if not isinstance(raw, list):
        return []
    keys = []
    for k in raw[:MAX_KEYS]:
        if not isinstance(k, dict):
            continue
        keys.append({"t": clamp(k.get("t"), 0, 600, 0), "position": vec(k.get("position"), 3, -20, 20, [0, -4, 1.6]),
                     "look_at": vec(k.get("look_at"), 3, -20, 20, list(SUBJECT)), "lens": clamp(k.get("lens"), 12, 135, 28)})
    return sorted(keys, key=lambda k: k["t"])


def camera_at(keys, t):
    """Position, look_at and lens at time t: held before the first key and after the last, eased between keys."""
    if t <= keys[0]["t"]:
        k = keys[0]
        return k["position"], k["look_at"], k["lens"]
    for a, b in zip(keys, keys[1:]):
        if t <= b["t"]:
            w = (t - a["t"]) / max(1e-6, b["t"] - a["t"])
            w = w * w * (3 - 2 * w)
            mix = lambda p, q: [p[i] + (q[i] - p[i]) * w for i in range(len(p))]
            return mix(a["position"], b["position"]), mix(a["look_at"], b["look_at"]), a["lens"] + (b["lens"] - a["lens"]) * w
    k = keys[-1]
    return k["position"], k["look_at"], k["lens"]

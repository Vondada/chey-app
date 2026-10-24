"""Param specs for CHE's procedural objects and rooms (Create Object, Create Room): validation, defaults and the size
each build must measure. Pure Python (no bpy), so the Worker's rules (server/cloudflare/creation_objects.js) and the
Blender builders (objects.py, rooms.py) are checked against the same numbers in plain unit tests.

These are parametric builders over a fixed family list, not free-form text-to-3D: a spec names one family (or room
type) and a few numbers; anything else is refused with the reason.

  object spec: {"family": "lamp|chair|table|mug|vase|shelf", "size": 0.5-2.0, "color": "#rrggbb",
                "roughness": 0-1, "metallic": 0-1, "style": "modern|classic|industrial",
                "form": lamp desk|floor, table dining|coffee|desk (optional)}
  room spec:   {"type": "living_room|bedroom|office|studio", "width": 2.5-8, "depth": 2.5-8, "height": 2.3-4 (metres),
                "wall_color": "#rrggbb", "floor": "oak|walnut|tile|concrete|carpet", "furniture": [ROOM_ITEMS],
                "lighting": "warm|neutral|cool", "style": "modern|classic|industrial"}
"""
import json
import re

FAMILIES = ('lamp', 'chair', 'table', 'mug', 'vase', 'shelf')
STYLES = ('modern', 'classic', 'industrial')
FORMS = {'lamp': ('desk', 'floor'), 'table': ('dining', 'coffee', 'desk')}
ROOM_TYPES = ('living_room', 'bedroom', 'office', 'studio')
FLOORS = ('oak', 'walnut', 'tile', 'concrete', 'carpet')
LIGHTINGS = ('warm', 'neutral', 'cool')
# Room pieces: the object families plus the large pieces only rooms have (sofa, bed, rug, plant) and the desk, which
# is the table family in its desk form.
ROOM_ITEMS = ('sofa', 'bed', 'desk', 'table', 'chair', 'lamp', 'shelf', 'vase', 'mug', 'plant', 'rug')
MAX_ITEMS = 10
SIZE = (0.5, 2.0)
ROOM_LIMITS = {'width': (2.5, 8.0), 'depth': (2.5, 8.0), 'height': (2.3, 4.0)}

OBJECT_DEFAULTS = {
    'lamp': {'color': '#1f6f78', 'roughness': 0.35, 'metallic': 0.0, 'style': 'modern', 'form': 'desk'},
    'chair': {'color': '#8a5a36', 'roughness': 0.5, 'metallic': 0.0, 'style': 'modern'},
    'table': {'color': '#6b4226', 'roughness': 0.45, 'metallic': 0.0, 'style': 'modern', 'form': 'dining'},
    'mug': {'color': '#e8732e', 'roughness': 0.25, 'metallic': 0.0, 'style': 'modern'},
    'vase': {'color': '#2f5f8a', 'roughness': 0.2, 'metallic': 0.0, 'style': 'classic'},
    'shelf': {'color': '#5a3a22', 'roughness': 0.55, 'metallic': 0.0, 'style': 'modern'},
}
ROOM_DEFAULTS = {
    'living_room': {'width': 4.5, 'depth': 4.0, 'height': 2.7, 'wall_color': '#b8b2a8', 'floor': 'oak', 'lighting': 'warm',
                    'style': 'modern', 'furniture': ['sofa', 'table', 'rug', 'lamp', 'shelf', 'plant', 'vase']},
    'bedroom': {'width': 4.0, 'depth': 4.0, 'height': 2.6, 'wall_color': '#a9b4b8', 'floor': 'walnut', 'lighting': 'warm',
                'style': 'classic', 'furniture': ['bed', 'lamp', 'shelf', 'rug', 'plant']},
    'office': {'width': 3.5, 'depth': 3.5, 'height': 2.7, 'wall_color': '#c9ccc8', 'floor': 'concrete', 'lighting': 'cool',
               'style': 'industrial', 'furniture': ['desk', 'chair', 'lamp', 'shelf', 'plant', 'mug']},
    'studio': {'width': 5.0, 'depth': 4.5, 'height': 3.2, 'wall_color': '#d8d4cc', 'floor': 'tile', 'lighting': 'neutral',
               'style': 'modern', 'furniture': ['table', 'chair', 'lamp', 'shelf', 'rug', 'plant']},
}

# The bounding box each family measures at size 1 (metres, glTF axes: x width, y height, z depth). The builders are
# written to these numbers and verify_glb.py --static checks the exported file against them (OBJECT_TOLERANCE).
NOMINAL = {
    ('lamp', 'desk'): (0.22, 0.54, 0.32), ('lamp', 'floor'): (0.42, 1.57, 0.42),
    ('chair', None): (0.46, 0.86, 0.48),
    ('table', 'dining'): (1.2, 0.75, 0.75), ('table', 'coffee'): (1.0, 0.42, 0.55), ('table', 'desk'): (1.2, 0.75, 0.6),
    ('mug', None): (0.135, 0.1, 0.093), ('vase', None): (0.17, 0.32, 0.17), ('shelf', None): (0.91, 1.6, 0.31),
}
OBJECT_TOLERANCE = 0.25
ROOM_TOLERANCE = 0.08
WALL = 0.1   # wall thickness: the room's back and left walls stand outside the floor's width and depth

HEX = re.compile(r'^#[0-9a-f]{6}$')


class SpecError(ValueError):
    """A spec the builders refuse, with every reason."""

    def __init__(self, reasons):
        super().__init__('; '.join(reasons)); self.reasons = list(reasons)


def _num(spec, key, lo, hi, default, bad):
    v = spec.get(key, default)
    try:
        v = float(v)
    except (TypeError, ValueError):
        bad.append(f'{key} must be a number'); return default
    if v != v or not lo <= v <= hi:
        bad.append(f'{key} {v:g} is outside {lo:g} to {hi:g}'); return default
    return round(v, 3)


def _colour(spec, key, default, bad):
    v = str(spec.get(key, default)).strip().lower()
    if not HEX.match(v): bad.append(f'{key} must be a #rrggbb colour'); return default
    return v


def _choice(spec, key, options, default, bad, label=None):
    v = spec.get(key, default)
    if v not in options: bad.append(f"{label or key} {v!r} is not one of {', '.join(options)}"); return default
    return v


def validate_object(spec):
    """A complete, clean object spec, or SpecError naming every problem."""
    if not isinstance(spec, dict): raise SpecError(['the spec must be an object'])
    bad = []
    fam = spec.get('family')
    if fam not in FAMILIES:
        raise SpecError([f"family {fam!r} is not built; CHE builds only: {', '.join(FAMILIES)} (not free-form text-to-3D)"])
    d = OBJECT_DEFAULTS[fam]
    out = {'family': fam, 'size': _num(spec, 'size', *SIZE, 1.0, bad), 'color': _colour(spec, 'color', d['color'], bad),
           'roughness': _num(spec, 'roughness', 0.0, 1.0, d['roughness'], bad), 'metallic': _num(spec, 'metallic', 0.0, 1.0, d['metallic'], bad),
           'style': _choice(spec, 'style', STYLES, d['style'], bad)}
    if fam in FORMS: out['form'] = _choice(spec, 'form', FORMS[fam], d['form'], bad, f'{fam} form')
    elif spec.get('form') not in (None, ''): bad.append(f'{fam} has no forms')
    extra = sorted(set(spec) - set(out) - {'form'})
    if extra: bad.append(f"unknown keys: {', '.join(extra)}")
    if bad: raise SpecError(bad)
    return out


def validate_room(spec):
    """A complete, clean room spec, or SpecError naming every problem."""
    if not isinstance(spec, dict): raise SpecError(['the spec must be an object'])
    bad = []
    kind = spec.get('type')
    if kind not in ROOM_TYPES:
        raise SpecError([f"room type {kind!r} is not built; CHE builds only: {', '.join(ROOM_TYPES)}"])
    d = ROOM_DEFAULTS[kind]
    out = {'type': kind}
    for k, (lo, hi) in ROOM_LIMITS.items(): out[k] = _num(spec, k, lo, hi, d[k], bad)
    out['wall_color'] = _colour(spec, 'wall_color', d['wall_color'], bad)
    out['floor'] = _choice(spec, 'floor', FLOORS, d['floor'], bad)
    out['lighting'] = _choice(spec, 'lighting', LIGHTINGS, d['lighting'], bad)
    out['style'] = _choice(spec, 'style', STYLES, d['style'], bad)
    items = spec.get('furniture', d['furniture'])
    if not isinstance(items, list): bad.append('furniture must be a list'); items = []
    unknown = [x for x in items if x not in ROOM_ITEMS]
    if unknown: bad.append(f"furniture {unknown} is not built; rooms take: {', '.join(ROOM_ITEMS)}")
    if len(items) > MAX_ITEMS: bad.append(f'at most {MAX_ITEMS} pieces of furniture')
    if len(set(items)) != len(items): bad.append('each piece of furniture is listed once')
    out['furniture'] = [x for x in items if x in ROOM_ITEMS][:MAX_ITEMS]
    extra = sorted(set(spec) - set(out))
    if extra: bad.append(f"unknown keys: {', '.join(extra)}")
    if bad: raise SpecError(bad)
    return out


def validate(kind, spec):
    """kind object_model | room_model (the queue's job kinds) or object | room."""
    if kind in ('object', 'object_model'): return validate_object(spec)
    if kind in ('room', 'room_model'): return validate_room(spec)
    raise SpecError([f'kind {kind!r} is not object or room'])


def parse(text):
    """The SPEC job setting (JSON text) as a dict, or SpecError."""
    try:
        v = json.loads(text)
    except (TypeError, ValueError):
        raise SpecError(['SPEC is not JSON'])
    if not isinstance(v, dict): raise SpecError(['SPEC is not an object'])
    return v


def expected_bbox(kind, spec):
    """(x width, y height, z depth) in metres the exported GLB must measure, and the tolerance as a fraction."""
    if kind in ('object', 'object_model'):
        s = validate_object(spec)
        w, h, d = NOMINAL[(s['family'], s.get('form'))]
        return (round(w * s['size'], 3), round(h * s['size'], 3), round(d * s['size'], 3)), OBJECT_TOLERANCE
    s = validate_room(spec)
    return (round(s['width'] + WALL, 3), round(s['height'], 3), round(s['depth'] + WALL, 3)), ROOM_TOLERANCE


def hex_rgb(h):
    """'#rrggbb' as linear RGB floats (Blender's colour inputs are linear)."""
    def lin(c):
        x = int(c, 16) / 255
        return x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4
    return tuple(lin(h[i:i + 2]) for i in (1, 3, 5))


def describe(kind, spec):
    """One plain sentence of what the spec builds (receipt 'contents')."""
    if kind in ('object', 'object_model'):
        s = validate_object(spec)
        form = f" {s['form']}" if s.get('form') else ''
        return (f"procedural {s['style']}{form} {s['family']} at size {s['size']:g}, colour {s['color']}, "
                f"roughness {s['roughness']:g}, metallic {s['metallic']:g}")
    s = validate_room(spec)
    return (f"procedural {s['style']} {s['type'].replace('_', ' ')} {s['width']:g} x {s['depth']:g} m, {s['height']:g} m high, "
            f"{s['floor']} floor, walls {s['wall_color']}, {s['lighting']} light, furniture: {', '.join(s['furniture']) or 'none'}")

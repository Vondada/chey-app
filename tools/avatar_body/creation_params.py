"""Param specs for CHE's procedural objects and rooms (Create Object, Create Room): validation, defaults and the size
each build must measure. Pure Python (no bpy), so the Worker's rules (server/cloudflare/creation_objects.js) and the
Blender builders (objects.py, rooms.py) are checked against the same numbers in plain unit tests.

These are parametric builders over a fixed family list, not free-form text-to-3D: a spec names one family (or room
type) and a few numbers; anything else is refused with the reason.

  object spec: {"family": "lamp|chair|table|mug|vase|shelf", "size": 0.5-2.0, "color": "#rrggbb",
                "roughness": 0-1, "metallic": 0-1, "style": "modern|classic|industrial",
                "form": lamp desk|floor, table dining|coffee|desk (optional)}
  custom object (Create Object from a description, server/cloudflare/creation_freeform.js):
               {"family": "custom", "description": text, "size", "color", "roughness", "metallic", "style",
                "parts": [{"name", "shape": box|cylinder|sphere|cone|torus, "c": [x, y, z], "s": [w, h, d] (metres, glTF
                axes, y up), "axis": x|y|z, "sides": 3-64, "flip": bool, "color", "metallic", "roughness",
                "texture": wood|stone|metal|fabric|brick|concrete}]}
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

# Create Object from a description: the primitives the builder makes exactly (objects.py custom), and their limits.
SHAPES = ('box', 'cylinder', 'sphere', 'cone', 'torus')
AXES = ('x', 'y', 'z')
TEXTURES = ('wood', 'stone', 'metal', 'fabric', 'brick', 'concrete', 'tile')
CUSTOM_MAX_PARTS = 40
EXTENT = (0.005, 5.0)
DESCRIPTION_MAX = 200
CUSTOM_DEFAULTS = {'color': '#8a8580', 'roughness': 0.45, 'metallic': 0.0, 'style': 'modern'}


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
    if fam == 'custom': return validate_custom(spec)
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


def _vec(v, lo, hi):
    return isinstance(v, list) and len(v) == 3 and all(isinstance(x, (int, float)) and not isinstance(x, bool) and lo <= x <= hi for x in v)


def validate_custom(spec):
    """A described object composed of primitives (the Worker's creation_freeform.js customErrors, the same limits)."""
    bad = []
    d = CUSTOM_DEFAULTS
    desc = spec.get('description', '')
    if not isinstance(desc, str) or len(desc) > DESCRIPTION_MAX: bad.append(f'description must be text up to {DESCRIPTION_MAX} characters'); desc = ''
    out = {'family': 'custom', 'description': desc, 'size': _num(spec, 'size', *SIZE, 1.0, bad), 'color': _colour(spec, 'color', d['color'], bad),
           'roughness': _num(spec, 'roughness', 0.0, 1.0, d['roughness'], bad), 'metallic': _num(spec, 'metallic', 0.0, 1.0, d['metallic'], bad),
           'style': _choice(spec, 'style', STYLES, d['style'], bad)}
    parts = spec.get('parts')
    if not isinstance(parts, list) or not parts: raise SpecError(bad + ['parts must be a non-empty list'])
    if len(parts) > CUSTOM_MAX_PARTS: raise SpecError(bad + [f'{len(parts)} parts, more than the {CUSTOM_MAX_PARTS} CHE builds'])
    clean = []
    for i, p in enumerate(parts):
        if not isinstance(p, dict): bad.append(f'part {i} is not an object'); continue
        name = str(p.get('name', ''))
        if not re.fullmatch(r'[a-z0-9_]{1,40}', name): bad.append(f'part {i} needs a short lower-case name'); name = f'part_{i}'
        if p.get('shape') not in SHAPES: bad.append(f"part {name}: shape must be one of {', '.join(SHAPES)}"); continue
        if not _vec(p.get('c'), -5, 5): bad.append(f'part {name}: c must be three numbers within 5 m'); continue
        if not _vec(p.get('s'), *EXTENT): bad.append(f'part {name}: s must be three sizes from {EXTENT[0]} to {EXTENT[1]:g} m'); continue
        q = {'name': name, 'shape': p['shape'], 'c': [round(float(x), 4) for x in p['c']], 's': [round(float(x), 4) for x in p['s']]}
        if 'axis' in p:
            if p['axis'] not in AXES: bad.append(f'part {name}: axis must be x, y or z')
            else: q['axis'] = p['axis']
        if 'sides' in p:
            if not (isinstance(p['sides'], int) and not isinstance(p['sides'], bool) and 3 <= p['sides'] <= 64): bad.append(f'part {name}: sides must be 3 to 64')
            else: q['sides'] = p['sides']
        if 'flip' in p:
            if not isinstance(p['flip'], bool): bad.append(f'part {name}: flip must be true or false')
            else: q['flip'] = p['flip']
        if 'color' in p:
            v = str(p['color']).lower()
            if not HEX.match(v): bad.append(f'part {name}: color must be #rrggbb')
            else: q['color'] = v
        for k in ('metallic', 'roughness'):
            if k in p:
                v = p[k]
                if not (isinstance(v, (int, float)) and not isinstance(v, bool) and 0 <= v <= 1): bad.append(f'part {name}: {k} must be 0 to 1')
                else: q[k] = round(float(v), 3)
        if 'texture' in p:
            if p['texture'] not in TEXTURES: bad.append(f"part {name}: texture must be one of {', '.join(TEXTURES)}")
            else: q['texture'] = p['texture']
        extra = sorted(set(p) - {'name', 'shape', 'c', 's', 'axis', 'sides', 'flip', 'color', 'metallic', 'roughness', 'texture'})
        if extra: bad.append(f"part {name}: unknown keys {', '.join(extra)}")
        clean.append(q)
    extra = sorted(set(spec) - set(out) - {'parts'})
    if extra: bad.append(f"unknown keys: {', '.join(extra)}")
    if bad: raise SpecError(bad)
    out['parts'] = clean
    return out


def custom_bbox(spec):
    """(x, y, z) extents in metres of a validated custom spec at size 1 (the parts' boxes)."""
    lo = [min(p['c'][k] - p['s'][k] / 2 for p in spec['parts']) for k in range(3)]
    hi = [max(p['c'][k] + p['s'][k] / 2 for p in spec['parts']) for k in range(3)]
    return tuple(h - l for l, h in zip(lo, hi))


def textures_wanted(kind, spec):
    """The CC0 texture materials a validated spec asks for (cc0_textures.py fetches them at job time)."""
    if kind in ('object', 'object_model') and spec.get('family') == 'custom':
        return sorted({p['texture'] for p in spec['parts'] if p.get('texture')})
    if kind in ('room', 'room_model'):
        return [{'oak': 'wood', 'walnut': 'wood', 'tile': 'tile', 'concrete': 'concrete', 'carpet': 'fabric'}[spec['floor']]]
    return []


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


# Inventions (server/cloudflare/invention_visuals.js partsFor/paletteFor): the template's named parts, each a box in
# metres in glTF axes (x right, y up, z front) with an optional taper of its bottom face, and the four material colours.
INVENTION_MATS = ('primary', 'secondary', 'glow', 'joint')
MAX_PARTS = 80
INVENTION_TOLERANCE = 0.1   # bevels and one subdivision level round the corners; the extents stay within 10 %


def validate_invention(spec):
    if not isinstance(spec, dict): raise SpecError(['the spec must be an object'])
    bad = []; parts = spec.get('parts')
    tpl = str(spec.get('template', ''))
    if not re.fullmatch(r'[a-z_]{1,30}', tpl): bad.append('template must be a short lower-case name')
    if not isinstance(parts, list) or not parts: raise SpecError(bad + ['parts must be a non-empty list'])
    if len(parts) > MAX_PARTS: raise SpecError(bad + [f'{len(parts)} parts, more than the {MAX_PARTS} CHE builds'])
    out_parts = []
    for i, p in enumerate(parts):
        if not isinstance(p, dict): bad.append(f'part {i} is not an object'); continue
        name = str(p.get('name', '')).strip()[:60]
        if not name: bad.append(f'part {i} has no name')
        mat = p.get('mat')
        if mat not in INVENTION_MATS: bad.append(f'part {name or i}: material {mat!r} is not one of {", ".join(INVENTION_MATS)}')
        c, s = p.get('c'), p.get('s')
        if not (isinstance(c, list) and len(c) == 3 and all(isinstance(x, (int, float)) and -5 <= x <= 5 for x in c)):
            bad.append(f'part {name or i}: c must be three numbers within 5 m'); continue
        if not (isinstance(s, list) and len(s) == 3 and all(isinstance(x, (int, float)) and 0.002 <= x <= 5 for x in s)):
            bad.append(f'part {name or i}: s must be three sizes from 0.002 to 5 m'); continue
        taper = p.get('taper', 1)
        if not isinstance(taper, (int, float)) or not 0.2 <= taper <= 1: bad.append(f'part {name or i}: taper must be 0.2 to 1'); taper = 1
        out_parts.append({'name': name, 'subsystem': str(p.get('subsystem', ''))[:30], 'mat': mat, 'c': [round(float(x), 4) for x in c],
                          's': [round(float(x), 4) for x in s], 'taper': round(float(taper), 3)})
    pal = spec.get('palette') if isinstance(spec.get('palette'), dict) else {}
    palette = {}
    for m in INVENTION_MATS:
        v = str(pal.get(m, ''))
        if not HEX.match(v): bad.append(f'palette {m} must be a #rrggbb colour')
        palette[m] = v
    if bad: raise SpecError(bad)
    return {'template': tpl, 'parts': out_parts, 'palette': palette, 'colour': str(pal.get('name', ''))[:20]}


def invention_bbox(spec):
    lo = [min(p['c'][k] - p['s'][k] / 2 for p in spec['parts']) for k in range(3)]
    hi = [max(p['c'][k] + p['s'][k] / 2 for p in spec['parts']) for k in range(3)]
    return tuple(round(h - l, 3) for l, h in zip(lo, hi))


def validate(kind, spec):
    """kind object_model | room_model | invention_model (the queue's job kinds) or object | room | invention."""
    if kind in ('object', 'object_model'): return validate_object(spec)
    if kind in ('room', 'room_model'): return validate_room(spec)
    if kind in ('invention', 'invention_model'): return validate_invention(spec)
    raise SpecError([f'kind {kind!r} is not object, room or invention'])


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
        if s['family'] == 'custom':
            w, h, d = custom_bbox(s)
            return (round(w * s['size'], 3), round(h * s['size'], 3), round(d * s['size'], 3)), OBJECT_TOLERANCE
        w, h, d = NOMINAL[(s['family'], s.get('form'))]
        return (round(w * s['size'], 3), round(h * s['size'], 3), round(d * s['size'], 3)), OBJECT_TOLERANCE
    if kind in ('invention', 'invention_model'):
        return invention_bbox(validate_invention(spec)), INVENTION_TOLERANCE
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
    if kind in ('object', 'object_model') and spec.get('family') == 'custom':
        s = validate_custom(spec)
        shapes = sorted({p['shape'] for p in s['parts']})
        tex = sorted({p['texture'] for p in s['parts'] if p.get('texture')})
        return (f"described object \"{s['description'][:80]}\" composed of {len(s['parts'])} primitives ({', '.join(shapes)}) at size {s['size']:g}, "
                f"main colour {s['color']}" + (f", CC0 textures: {', '.join(tex)}" if tex else ''))
    if kind in ('object', 'object_model'):
        s = validate_object(spec)
        form = f" {s['form']}" if s.get('form') else ''
        return (f"procedural {s['style']}{form} {s['family']} at size {s['size']:g}, colour {s['color']}, "
                f"roughness {s['roughness']:g}, metallic {s['metallic']:g}")
    if kind in ('invention', 'invention_model'):
        s = validate_invention(spec)
        subs = sorted({p['subsystem'] for p in s['parts'] if p['subsystem']})
        return (f"refined {s['template'].replace('_', ' ')} invention model in Blender: {len(s['parts'])} bevelled, subdivided parts "
                f"({', '.join(subs)}), PBR metal and emissive materials, primary {s['palette']['primary']}")
    s = validate_room(spec)
    return (f"procedural {s['style']} {s['type'].replace('_', ' ')} {s['width']:g} x {s['depth']:g} m, {s['height']:g} m high, "
            f"{s['floor']} floor, walls {s['wall_color']}, {s['lighting']} light, furniture: {', '.join(s['furniture']) or 'none'}")

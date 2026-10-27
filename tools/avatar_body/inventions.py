"""An invention's refined 3D model in Blender (the Creation Engine's invention_model job), from the same named parts the
Worker uses for its instant box-parts placeholder (server/cloudflare/invention_visuals.js partsFor/paletteFor).

  python3 inventions.py      env: SPEC_JSON (or SPEC_FILE) {template, parts:[{name, subsystem, mat, c, s, taper}], palette},
                                  EXPORT_GLB (or OUT_DIR/model.glb)

Each part is built as its own mesh object named after the part (the subsystem rides along as a glTF extra): the box,
its bottom face narrowed by `taper`, bevelled (three segments, about a tenth of its smallest side, at most 2 cm) and
smoothed by one subdivision level over the bevels, so plates read as machined parts rather than raw boxes. Materials
are PBR: primary and secondary as painted and bare metal, joints as dark rubberised metal, glow as an emissive
light strip. The parts are in metres in glTF axes (x right, y up, z front); Blender gets x, -z, y.
Prints MODEL <path> <bytes> bytes <vertices> vertices (<contents>), like objects.py, and STAGE model.
"""
import os
import sys

import bpy
import bmesh  # noqa: E402  (bmesh is importable once bpy is)

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from creation_params import SpecError, describe, hex_rgb, validate_invention  # noqa: E402
from objects import export, mat, mesh_stats, spec_from_env  # noqa: E402

FINISH = {   # roughness, metallic, emission strength
    'primary': (0.32, 0.85, 0.0),     # painted armour plate: a metallic clear finish
    'secondary': (0.22, 1.0, 0.0),    # bare machined metal
    'joint': (0.55, 0.6, 0.0),        # dark rubberised actuators and cuffs
    'glow': (0.3, 0.0, 6.0),          # emissive light strips and lenses
}


def materials(palette):
    out = {}
    for name, (rough, metal, strength) in FINISH.items():
        rgb = hex_rgb(palette[name])
        out[name] = mat(f'Invention {name}', rgb, rough, metal, emit=rgb if strength else None, strength=strength)
    return out


def part_mesh(p):
    """The part's box in Blender axes, the bottom face narrowed by taper (as the Worker's boxGeometry does)."""
    (cx, cy, cz), (w, h, d), taper = p['c'], p['s'], p['taper']
    bm = bmesh.new()
    verts = {}
    for sx in (-1, 1):
        for sy in (-1, 1):
            for sz in (-1, 1):
                k = 1 if sy > 0 else taper; kz = 1 if sy > 0 else (1 + taper) / 2
                gx, gy, gz = cx + sx * w / 2 * k, cy + sy * h / 2, cz + sz * d / 2 * kz
                verts[(sx, sy, sz)] = bm.verts.new((gx, -gz, gy))
    for face in (((1, -1, -1), (1, 1, -1), (1, 1, 1), (1, -1, 1)), ((-1, -1, 1), (-1, 1, 1), (-1, 1, -1), (-1, -1, -1)),
                 ((-1, 1, 1), (1, 1, 1), (1, 1, -1), (-1, 1, -1)), ((-1, -1, -1), (1, -1, -1), (1, -1, 1), (-1, -1, 1)),
                 ((-1, -1, 1), (1, -1, 1), (1, 1, 1), (-1, 1, 1)), ((1, -1, -1), (-1, -1, -1), (-1, 1, -1), (1, 1, -1))):
        bm.faces.new([verts[v] for v in face])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new(p['name']); bm.to_mesh(me); bm.free()
    return me


def build(spec):
    mats = materials(spec['palette'])
    for p in spec['parts']:
        me = part_mesh(p); me.materials.append(mats[p['mat']])
        o = bpy.data.objects.new(p['name'], me); bpy.context.scene.collection.objects.link(o)
        o['subsystem'] = p['subsystem']; o['che_part'] = p['name']
        bev = o.modifiers.new('Bevel', 'BEVEL'); bev.width = min(0.02, min(p['s']) * 0.1); bev.segments = 3
        bev.limit_method = 'ANGLE'; bev.harden_normals = False
        sub = o.modifiers.new('Subdivision', 'SUBSURF'); sub.levels = 1; sub.render_levels = 1
        for f in me.polygons: f.use_smooth = True
    return len(spec['parts'])


def main():
    try:
        spec = validate_invention(spec_from_env())
    except (SpecError, ValueError) as e:
        print(f'SPEC FAILED: {e}', flush=True); sys.exit(2)
    print('STAGE model', flush=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    build(spec)
    path = os.environ.get('EXPORT_GLB') or os.path.join(os.environ.get('OUT_DIR', '.'), 'model.glb')
    n = export(path, spec, 'invention')
    print('MODEL', path, n, 'bytes', mesh_stats(), 'vertices', f"({describe('invention', spec)})", flush=True)


if __name__ == '__main__':
    main()

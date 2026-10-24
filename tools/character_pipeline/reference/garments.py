"""Outfit and jewellery for the reference characters, cut from the body's own surface.

Each garment is the set of body faces it covers, pushed out along the body's normals by an ease that varies over the
garment (looser at a blazer hem, flaring toward a wide trouser hem), smoothed so body detail does not show through,
and kept outside the body. Because every garment vertex comes from a body vertex, it inherits that vertex's skin
weights exactly. Body faces fully hidden under clothing are removed.

The executive suit follows the poster: white tailored blazer with black satin lapels and cuffs, black top, gold belt,
white wide-leg trousers. Unseen details (shoes, blazer back, trouser hem) are design proposals.
"""
import math

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector, bvhtree

TORSO = {"pelvis", "spine_01", "spine_02", "spine_03", "clavicle_l", "clavicle_r"}
ARMS = {"upperarm_l", "upperarm_r", "lowerarm_l", "lowerarm_r"}
LEGS = {"thigh_l", "thigh_r", "calf_l", "calf_r"}
FEET = {"foot_l", "foot_r", "ball_l", "ball_r"}
HEAD = {"head", "neck_01"}


def smoothstep(a, b, x):
    t = np.clip((x - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


class BodyData:
    """Per-vertex regions, normals, adjacency and a collision tree for the full shaped body."""

    def __init__(self, c):
        base = c.base
        self.c = c
        n = len(c.V)
        self.faces = [f for f, g in zip(base.faces, base.face_groups) if g == "body"]
        self.face_index = [i for i, g in enumerate(base.face_groups) if g == "body"]
        self.region = {k: np.zeros(n) for k in ("torso", "arms", "legs", "feet", "hands", "head")}
        for vi, items in c.per.items():
            if vi >= n:
                continue
            for bone, w in items:
                key = ("torso" if bone in TORSO else "arms" if bone in ARMS else "legs" if bone in LEGS
                       else "feet" if bone in FEET else "head" if bone in HEAD else "hands" if bone != "Root" else None)
                if key:
                    self.region[key][vi] += w
        bm = bmesh.new()
        verts = {}
        for f in self.faces:
            for v in f:
                if v not in verts:
                    verts[v] = bm.verts.new(c.V[v])
        for f in self.faces:
            try:
                bm.faces.new([verts[v] for v in f])
            except ValueError:
                pass
        bm.normal_update()
        self.normals = np.zeros((n, 3))
        for v, bv in verts.items():
            self.normals[v] = bv.normal
        bm.free()
        order = sorted(verts)
        local = {v: k for k, v in enumerate(order)}
        self.tree = bvhtree.BVHTree.FromPolygons([tuple(c.V[v]) for v in order], [[local[v] for v in f] for f in self.faces])
        self.nbrs = {}
        for f in self.faces:
            for k in range(len(f)):
                a, b = f[k], f[(k + 1) % len(f)]
                self.nbrs.setdefault(a, set()).add(b)
                self.nbrs.setdefault(b, set()).add(a)


class Landmarks:
    def __init__(self, c):
        j = c.joint
        self.neck = j("joint-neck")[2]
        self.neck_y = j("joint-neck")[1]
        self.shoulder = j("joint-l-shoulder")
        self.chest = j("joint-spine-1")[2]
        self.bust = (j("joint-spine-1")[2] + j("joint-spine-2")[2]) / 2
        self.waist = j("joint-spine-3")[2] + 0.02
        self.hip = j("joint-l-upper-leg")[2]
        self.crotch = self.hip - 0.065
        self.knee = j("joint-l-knee")[2]
        self.ankle = j("joint-l-ankle")[2]
        self.elbow, self.wrist = j("joint-l-elbow"), j("joint-l-hand")
        self.elbow_r, self.wrist_r = j("joint-r-elbow"), j("joint-r-hand")
        self.feet = {s: (j(f"joint-{s}-ankle"), j(f"joint-{s}-foot-1")) for s in "lr"}


class Cut:
    """The suit's cut lines in the front view (x, z), shared by the garments and by the skin-hiding test."""

    def __init__(self, lm, suit):
        self.v_bottom = lm.waist + suit.get("v_above_belt", 0.03)
        self.neck_half = suit.get("neck_half", 0.068)
        self.neck_top = lm.neck - 0.004
        self.lapel_bottom = (0.018, self.v_bottom + 0.012)
        self.lapel_top = (self.neck_half + suit.get("lapel_width", 0.06), lm.neck - 0.07)
        self.top_center = lm.bust + suit.get("top_dip", 0.02)
        self.top_side = (suit.get("top_side_x", 0.105), lm.bust + suit.get("top_side_rise", 0.072))
        self.hem = lm.crotch + suit.get("hem_below_crotch", 0.0)
        self.trouser_hem = lm.ankle + suit.get("trouser_above_ankle", 0.025)

    def v_x(self, z):
        t = np.clip((z - self.v_bottom) / (self.neck_top - self.v_bottom), 0, 1)
        return t * self.neck_half

    def top_z(self, ax):
        return self.top_center + (self.top_side[1] - self.top_center) * np.clip(ax / self.top_side[0], 0, 1.5)


class Regions:
    """Which body vertices each garment starts from, and which body faces stay visible."""

    def __init__(self, c, bd, lm, cut):
        V, R = c.V, bd.region
        z, ax = V[:, 2], np.abs(V[:, 0])
        n = len(V)
        is_body = np.zeros(n, bool)
        is_body[sorted(c.base.group_verts["body"])] = True
        front = (bd.normals[:, 1] < -0.1) | (V[:, 1] < lm.neck_y - 0.06)
        self.v_open = front & (z > cut.v_bottom) & (ax < cut.v_x(z))
        upper = R["torso"] + R["arms"] + R["legs"] * (z > cut.hem - 0.03)
        collar = (R["head"] > 0.3) & (z < lm.neck + 0.014) & (V[:, 1] > lm.neck_y - 0.02)
        self.blazer = is_body & ((upper > 0.5) | collar) & (z > cut.hem - 0.03) & (R["hands"] < 0.2) & (R["head"] < 0.7)
        self.top = is_body & front & (ax < cut.v_x(z) + 0.03) & (z > cut.v_bottom - 0.04) & \
            (z < cut.top_z(ax) + 0.03) & (R["head"] < 0.5)
        lower = R["legs"] + R["torso"] * (z < lm.hip + 0.06)
        self.trousers = is_body & (lower > 0.5) & (z < lm.waist + 0.01) & (z > cut.trouser_hem - 0.03) & \
            (R["feet"] < 0.45)
        self.shoes = is_body & (R["feet"] >= 0.3)
        wrist_l, wrist_r = Vector(lm.wrist), Vector(lm.wrist_r)
        near_cuff = np.array([min((Vector(p) - wrist_l).length, (Vector(p) - wrist_r).length) < 0.04 for p in V])
        hidden_v = (self.blazer & (z > cut.hem + 0.012) & ~self.v_open & ~near_cuff) | \
                   (self.top & self.v_open & (z < cut.top_z(ax) - 0.01)) | \
                   (self.trousers & (z > cut.trouser_hem + 0.015)) | \
                   (self.shoes & (z < self.pump_line(c, lm, V) - 0.01))
        border = np.zeros(n, bool)
        for f in bd.faces:
            if not all(hidden_v[v] for v in f):
                for v in f:
                    border[v] = True
        grown = border.copy()
        for v in np.nonzero(border)[0]:
            for nb in bd.nbrs.get(int(v), ()):
                grown[nb] = True
        hidden = hidden_v & ~grown
        self.hidden_faces = {i for i, f in zip(bd.face_index, bd.faces) if all(hidden[v] for v in f)}

    @staticmethod
    def pump_line(c, lm, V):
        """Height of a pump's opening above each point: parallel to the sole, a few centimetres up."""
        out = np.full(len(V), 9.0)
        for s, sx in (("l", 1), ("r", -1)):
            ankle, ball = lm.feet[s]
            slope = (ankle[2] - ball[2]) / max(1e-3, ball[1] - ankle[1]) * -1
            side = (V[:, 0] * sx) > 0
            line = 0.05 + max(0.0, slope) * (V[:, 1] - ball[1]) * 1.0
            out = np.where(side, line, out)
        return out

    def keep_face(self, i):
        return i not in self.hidden_faces


def bm_cut(ob, co, no, keep=lambda centre: True, clear=True):
    """Cut a mesh with a plane, removing the side the normal points to (among faces whose centre passes keep)."""
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    faces = [f for f in bm.faces if keep(f.calc_center_median())]
    if faces:
        edges = {e for f in faces for e in f.edges}
        verts = {v for f in faces for v in f.verts}
        bmesh.ops.bisect_plane(bm, geom=list(verts) + list(edges) + faces, plane_co=Vector(co), plane_no=Vector(no),
                               clear_outer=clear, dist=1e-5)
    bm.to_mesh(ob.data)
    bm.free()
    for p in ob.data.polygons:
        p.use_smooth = True


def line_plane(p0, p1, toward):
    """A vertical-in-depth plane through the front-view line p0-p1 (x, z), its normal pointing toward point toward."""
    d = np.array([p1[0] - p0[0], p1[1] - p0[1]])
    n = np.array([-d[1], d[0]])
    n /= np.linalg.norm(n)
    if (np.array(toward) - np.array(p0)) @ n < 0:
        n = -n
    return Vector((p0[0], 0, p0[1])), Vector((n[0], 0, n[1]))


def build_suit(c, bd, lm, rg, cut, mats):
    """The executive suit from the production sheet: white tailored blazer with notched lapels, black sweetheart
    bustier, gold belt, slim cropped white trousers, gold pointed stilettos."""
    V, R = c.V, bd.region
    z, ax = V[:, 2], np.abs(V[:, 0])
    n = len(V)
    shoulder_pad = smoothstep(lm.shoulder[2] - 0.06, lm.shoulder[2] + 0.02, z) * smoothstep(0.08, 0.14, ax)
    peplum = 0.06 * np.clip(lm.waist - 0.015 - z, 0, None) / max(1e-3, lm.waist - cut.hem)
    off = 0.009 + 0.005 * shoulder_pad + peplum + 0.002 * R["arms"]
    blazer, b_used = make_piece(c, bd, "Blazer", rg.blazer, off, [mats["blazer"]], smooth=6)
    front_y = lm.neck_y - 0.02
    bm_cut(blazer, (0, 0, cut.hem), (0, 0, -1))
    for elbow, wrist in ((lm.elbow, lm.wrist), (lm.elbow_r, lm.wrist_r)):
        axis = Vector(wrist) - Vector(elbow)
        axis.normalize()
        co = Vector(wrist) - axis * 0.012
        bm_cut(blazer, co, axis, keep=lambda p, e=Vector(elbow), w=Vector(wrist): (p - w).length < 0.16)
    for sx in (1, -1):
        p0, p1 = (0.0, cut.v_bottom), (sx * cut.neck_half, cut.neck_top)
        co, no = line_plane(p0, p1, (0.0, cut.neck_top))
        bm_cut(blazer, co, no, keep=lambda p, sx=sx: p.y < front_y and p.x * sx > -0.002 and
               cut.v_bottom - 0.03 < p.z < lm.neck + 0.05)
        # The lapel's outer edge: cut only (no removal), then raise the lapel so its fold catches the light.
        q0, q1 = (sx * cut.lapel_bottom[0], cut.lapel_bottom[1]), (sx * cut.lapel_top[0], cut.lapel_top[1])
        co, no = line_plane(q0, q1, (0.0, cut.neck_top))
        bm_cut(blazer, co, no, keep=lambda p, sx=sx: p.y < front_y and p.x * sx > 0 and p.z > cut.v_bottom - 0.01,
               clear=False)
    raise_lapels(blazer, cut, front_y)
    top, t_used = make_piece(c, bd, "Top", rg.top, np.full(n, 0.0055), [mats["satin_top"]], smooth=3, min_off=0.004)
    for sx in (1, -1):
        p0, p1 = (0.0, cut.top_center), (sx * cut.top_side[0], cut.top_side[1])
        co, no = line_plane(p0, p1, (0.0, cut.top_center + 0.2))
        bm_cut(top, co, no, keep=lambda p, sx=sx: p.x * sx > -0.002)
    t_off = 0.007 + 0.006 * smoothstep(lm.hip, lm.waist, z) + 0.004 * smoothstep(lm.knee + 0.1, lm.knee - 0.1, z)
    trousers, tr_used = make_piece(c, bd, "Trousers", rg.trousers, t_off, [mats["trousers"]], smooth=6)
    bm_cut(trousers, (0, 0, cut.trouser_hem), (0, 0, -1))
    shoes, s_used = make_piece(c, bd, "Shoes", rg.shoes, np.full(n, 0.0032), [mats["shoes"]], smooth=2, min_off=0.002)
    shape_pumps(shoes, lm)
    heels = stilettos(shoes, lm, mats["shoes"])
    belt = make_belt(c, blazer, lm, mats["gold"])
    return {"Blazer": (blazer, None), "Top": (top, None), "Trousers": (trousers, None),
            "Shoes": (shoes, None), "Heels": (heels, None), "Belt": (belt, None)}


def raise_lapels(ob, cut, front_y):
    """Lift the band between the V neckline and the lapel line by a few millimetres along its normals."""
    me = ob.data
    me.update()
    for v in me.vertices:
        p = v.co
        if p.y > front_y or p.z < cut.v_bottom - 0.005:
            continue
        ax = abs(p.x)
        t = np.clip((p.z - cut.lapel_bottom[1]) / (cut.lapel_top[1] - cut.lapel_bottom[1]), 0, 1.3)
        edge = cut.lapel_bottom[0] + (cut.lapel_top[0] - cut.lapel_bottom[0]) * t
        if ax < edge - 0.002:
            v.co = p + v.normal * 0.0045
        elif ax < edge + 0.002:
            v.co = p + v.normal * 0.002


def shape_pumps(ob, lm):
    """Pointed toes and a pump opening: the toe box narrows to a point; the top of the foot is left open."""
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    for s, sx in (("l", 1), ("r", -1)):
        verts = [v for v in bm.verts if v.co.x * sx > 0]
        if not verts:
            continue
        toe_y = min(v.co.y for v in verts)
        cx = sum(v.co.x for v in verts) / len(verts)
        for v in verts:
            f = smoothstep(toe_y + 0.05, toe_y, v.co.y)
            if f > 0:
                v.co.x = cx + (v.co.x - cx) * (1 - 0.55 * f)
                v.co.y -= 0.022 * f
                v.co.z = 0.004 + (v.co.z - 0.004) * (1 - 0.35 * f)
    bm.to_mesh(ob.data)
    bm.free()
    for s, sx in (("l", 1), ("r", -1)):
        ankle, ball = lm.feet[s]
        rise = max(0.0, (ankle[2] - ball[2])) / max(1e-3, abs(ball[1] - ankle[1]))
        no = Vector((0, -rise, 1)).normalized()
        co = Vector((ball[0], ball[1], 0.05))
        bm_cut(ob, co, no, keep=lambda p, sx=sx: p.x * sx > 0)


def stilettos(shoes, lm, mat):
    """A slim heel under each shoe, from the back of the heel cup to the floor."""
    verts, faces = [], []
    for s, sx in (("l", 1), ("r", -1)):
        pts = [v.co for v in shoes.data.vertices if v.co.x * sx > 0]
        if not pts:
            continue
        back_y = max(p.y for p in pts)
        cup = [p for p in pts if p.y > back_y - 0.035]
        bottom = min(p.z for p in cup)
        cx = sum(p.x for p in cup) / len(cup)
        top = Vector((cx, back_y - 0.022, bottom + 0.004))
        foot = Vector((cx, back_y - 0.012, 0.0))
        start = len(verts)
        sides = 8
        for k, (p, r) in enumerate(((top, 0.012), (top * 0.5 + foot * 0.5, 0.006), (foot, 0.0045))):
            for i in range(sides):
                a = 2 * math.pi * i / sides
                verts.append((p.x + math.cos(a) * r, p.y + math.sin(a) * r * 1.2, p.z))
        for k in range(2):
            for i in range(sides):
                a0, a1 = start + k * sides + i, start + k * sides + (i + 1) % sides
                faces.append((a0, a1, a1 + sides, a0 + sides))
        faces.append(tuple(start + 2 * sides + i for i in range(sides)))
    return mesh_object("Heels", verts, faces, mat)


def ring_on_surface(tree, z, center_y, segments=48, out=0.0):
    pts, nors = [], []
    for k in range(segments):
        a = 2 * math.pi * k / segments
        d = Vector((math.sin(a), -math.cos(a), 0))
        origin = Vector((0, center_y, z))
        loc, nor, _, _ = tree.ray_cast(origin, d, 1.0)
        if loc is None:
            loc, nor = origin + d * 0.15, d
        nor = nor if nor.dot(d) > 0 else -nor
        pts.append(loc + nor * out)
        nors.append(nor)
    return pts, nors


def make_belt(c, blazer, lm, mat):
    """A wide gold belt at the natural waist, over the blazer, with a rectangular buckle at the front."""
    deps = bpy.context.evaluated_depsgraph_get()
    tree = bvhtree.BVHTree.FromObject(blazer, deps)
    ys = [v.co.y for v in blazer.data.vertices if abs(v.co.z - lm.waist) < 0.02]
    cy = sum(ys) / len(ys) if ys else 0.0
    rows = []
    for dz in (-0.021, 0.0, 0.021):
        pts, _ = ring_on_surface(tree, lm.waist + dz, cy, out=0.0045)
        rows.append(pts)
    segs = len(rows[0])
    verts = [tuple(p) for row in rows for p in row]
    faces = []
    for r in range(len(rows) - 1):
        for k in range(segs):
            a, b = r * segs + k, r * segs + (k + 1) % segs
            faces.append((a, b, b + segs, a + segs))
    me = bpy.data.meshes.new("Belt")
    me.from_pydata(verts, [], faces)
    bm = bmesh.new()
    bm.from_mesh(me)
    front = rows[1][0]
    buckle = bmesh.ops.create_cube(bm, size=1.0)
    for v in buckle["verts"]:
        v.co = Vector((v.co.x * 0.062, v.co.y * 0.009, v.co.z * 0.05)) + front + Vector((0, -0.004, 0))
    bm.to_mesh(me)
    bm.free()
    for p in me.polygons:
        p.use_smooth = True
    sol = None
    ob = bpy.data.objects.new("Belt", me)
    bpy.context.scene.collection.objects.link(ob)
    ob.data.materials.append(mat)
    del sol
    return ob


def tube_ring(points, radius, sides=6, closed=True):
    """Vertices and faces of a thin tube along a closed polyline (chains, hoops, bangles)."""
    verts, faces = [], []
    n = len(points)
    for k in range(n):
        p = Vector(points[k])
        t = (Vector(points[(k + 1) % n]) - Vector(points[k - 1])).normalized()
        a = t.orthogonal().normalized()
        b = t.cross(a).normalized()
        for s in range(sides):
            ang = 2 * math.pi * s / sides
            verts.append(tuple(p + (a * math.cos(ang) + b * math.sin(ang)) * radius))
    rng = n if closed else n - 1
    for k in range(rng):
        for s in range(sides):
            a0, a1 = k * sides + s, k * sides + (s + 1) % sides
            b0, b1 = ((k + 1) % n) * sides + s, ((k + 1) % n) * sides + (s + 1) % sides
            faces.append((a0, a1, b1, b0))
    return verts, faces


def mesh_object(name, verts, faces, mat):
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], faces)
    for p in me.polygons:
        p.use_smooth = True
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    ob.data.materials.append(mat)
    return ob


def build_jewelry(c, bd, lm, mats):
    """Gold hoop earrings, a fine necklace with a pendant, a bangle and a diamond tennis bracelet."""
    V = c.V
    parts = []
    for side, sx in (("l", 1), ("r", -1)):
        lobe_disp = np.linalg.norm(c.base.to_blender(c.base.displacement(f"ears/{side}-ear-lobe-incr")), axis=1)
        lobe = V[int(np.argmax(lobe_disp))]
        R = 0.024
        center = Vector(lobe) + Vector((0.004 * sx, -0.003, -R))
        tilt = Matrix.Rotation(math.radians(28 * sx), 3, "Z")
        pts = [center + tilt @ Vector((0, math.sin(2 * math.pi * k / 32) * R, math.cos(2 * math.pi * k / 32) * R))
               for k in range(32)]
        parts.append(("Earring_" + side, tube_ring(pts, 0.0024, 6), mats["gold"], {"head": 1.0}))
    # Necklace: a fine chain lying on the base of the neck and the collarbones, dipping to a small pendant.
    neck_pts = []
    for k in range(64):
        a = 2 * math.pi * k / 64
        dip = 0.5 + 0.5 * math.cos(a)                       # 1 at the front, 0 at the back
        z = lm.neck - 0.012 - 0.07 * dip ** 2.2
        origin = Vector((0, 0.0, z))
        d = Vector((math.sin(a), -math.cos(a), 0))
        loc, nor, _, _ = bd.tree.ray_cast(origin, d, 0.3)
        if loc is None:
            continue
        neck_pts.append(loc + nor.normalized() * 0.0028)
    if len(neck_pts) > 8:
        parts.append(("Necklace", tube_ring(neck_pts, 0.0009, 4), mats["gold"], None))
        front = min(neck_pts, key=lambda p: p.y)
        bm = bmesh.new()
        bmesh.ops.create_icosphere(bm, subdivisions=1, radius=0.0042)
        for v in bm.verts:
            v.co = Vector((v.co.x, v.co.y * 0.6, v.co.z * 1.25)) + front + Vector((0, -0.003, -0.006))
        pv = [tuple(v.co) for v in bm.verts]
        pf = [tuple(v.index for v in f.verts) for f in bm.faces]
        bm.free()
        parts.append(("Pendant", (pv, pf), mats["diamond"], None))
    # Wrists: a gold bangle on the right, a diamond tennis bracelet on the left.
    for name, elbow, wrist, mat, thick in (("Bangle", lm.elbow_r, lm.wrist_r, mats["gold"], 0.0024),
                                           ("Bracelet", lm.elbow, lm.wrist, mats["diamond"], 0.0019)):
        axis = Vector(wrist) - Vector(elbow)
        axis.normalize()
        center = Vector(wrist) - axis * 0.03
        a = axis.orthogonal().normalized()
        b = axis.cross(a).normalized()
        radius = 0.0
        for k in range(16):
            ang = 2 * math.pi * k / 16
            d = a * math.cos(ang) + b * math.sin(ang)
            loc, _, _, _ = bd.tree.ray_cast(center + d * 0.1, -d, 0.2)
            if loc is not None:
                radius = max(radius, (loc - center).length)
        radius = (radius or 0.03) + 0.006
        pts = [center + (a * math.cos(2 * math.pi * k / 32) + b * math.sin(2 * math.pi * k / 32)) * radius
               for k in range(32)]
        parts.append((name, tube_ring(pts, thick, 6), mat, None))
    objs = []
    for name, (verts, faces), mat, fixed in parts:
        ob = mesh_object(name, verts, faces, mat)
        ob["fixed_weights"] = str(fixed or "")
        objs.append((ob, fixed))
    return objs

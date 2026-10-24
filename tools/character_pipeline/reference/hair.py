"""Long hair as textured cards grown from the scalp, for the reference characters.

Grooming: every lock leaves the parting along the scalp (hugging it, so the crown stays sleek), gains volume once it
leaves the head, falls under gravity, slides over the shoulders and clothing (collision against the clothed body), and
goes either in front of a shoulder or down the back. Waves start below the ears. Every strand becomes a card lying on
the hair surface, with a strand texture whose alpha tapers at the tips.

Skinning: hair at and above the jaw follows the head; lengths below the shoulders follow the upper spine, blended
between the two, so turning the head moves the top of the hair while the lengths stay on the body.
"""
import math

import bpy
import numpy as np
from mathutils import Vector, bvhtree


def _smooth(a, b, x):
    t = min(1.0, max(0.0, (x - a) / (b - a)))
    return t * t * (3 - 2 * t)


def collider_tree(objects):
    verts, polys = [], []
    for ob in objects:
        mw = ob.matrix_world
        off = len(verts)
        verts.extend([tuple(mw @ v.co) for v in ob.data.vertices])
        polys.extend([[off + i for i in p.vertices] for p in ob.data.polygons])
    return bvhtree.BVHTree.FromPolygons(verts, polys)


def head_tree(c, chin_z):
    faces = [f for f, g in zip(c.base.faces, c.base.face_groups)
             if g == "body" and min(c.V[v][2] for v in f) > chin_z - 0.04]
    used = sorted({v for f in faces for v in f})
    local = {v: k for k, v in enumerate(used)}
    return bvhtree.BVHTree.FromPolygons([tuple(c.V[v]) for v in used], [[local[v] for v in f] for f in faces])


def scalp_triangles(c):
    scalp = c.masks["scalp"]
    tris = []
    for f, g in zip(c.base.faces, c.base.face_groups):
        if g != "body" or min(scalp[v] for v in f) < 0.5:
            continue
        p = [c.V[v] for v in f]
        tris.append((p[0], p[1], p[2]))
        if len(f) == 4:
            tris.append((p[0], p[2], p[3]))
    tris = np.array(tris)
    areas = 0.5 * np.linalg.norm(np.cross(tris[:, 1] - tris[:, 0], tris[:, 2] - tris[:, 0]), axis=1)
    return tris, areas / areas.sum()


class Groom:
    def __init__(self, c, lm, spec, colliders):
        self.c, self.spec = c, spec
        self.tree = collider_tree(colliders)
        self.chin_z = float(c.eyes["l"][2]) - 0.115
        self.head = head_tree(c, self.chin_z)
        self.hc = Vector(c.head_center)
        self.eye_y = float(c.eyes["l"][1])
        self.brow_z = float(c.eyes["l"][2]) + 0.03
        self.ear_z = float(c.eyes["l"][2]) - 0.02
        self.shoulder_z = float(lm.shoulder[2])
        self.part_x = {"side_right": -0.026, "side_left": 0.026, "center": 0.0}[spec.get("part", "side_right")]
        self.volume = spec.get("volume", 1.0) * 0.03
        self.amp = spec.get("wave", 0.024)
        self.wave_len = spec.get("wavelength", 0.1)
        self.down = Vector((0, 0, -1))

    def flow(self, root, n0, side):
        """The groom direction at a root: away from the parting on top, downward on the sides and back."""
        top = _smooth(self.hc.z + 0.02, self.hc.z + 0.09, root.z)
        back = _smooth(self.hc.y - 0.01, self.hc.y + 0.07, root.y)
        front = 1 - _smooth(self.eye_y + 0.03, self.eye_y + 0.08, root.y)
        lateral = Vector((side, 0, 0))
        # Front roots sweep sideways and back, off the face; the crown parts away from the parting line.
        d = lateral * (0.25 + 1.1 * top + 0.6 * front) + self.down * (0.35 + 0.9 * (1 - top) + 0.4 * back) + \
            Vector((0, 1, 0)) * (0.25 * back + 0.45 * front)
        d = d - n0 * d.dot(n0)
        return d.normalized()

    def grow(self, root, n0, side, front, L, phase, layer):
        ds = 0.01
        p = root + n0 * 0.003
        d = self.flow(root, n0, side)
        path = [p.copy()]
        s = 0.0
        on_head = True
        vol = self.volume * (0.35 + 0.65 * layer)
        margin = 0.005 + vol * 0.5
        while s < L:
            if on_head:
                lift = 0.003 + vol * _smooth(0.02, 0.16, s)
                d = (d + self.down * 0.06).normalized()
                q = p + d * ds
                loc, nor, _, _ = self.head.find_nearest(q, 0.1)
                if loc is not None:
                    if nor.dot(q - self.hc) < 0:
                        nor = -nor
                    q = loc + nor * lift
                    t = q - p
                    if t.length > 1e-6:
                        d = t.normalized()
                p = q
                if p.z < self.ear_z or (p.y > self.hc.y + 0.075 and p.z < self.hc.z) or s > 0.22:
                    on_head = False
                    # Leave the head along its surface and downward, never sticking out (no loops over the crown).
                    if loc is not None:
                        d = (d - nor * max(0.0, d.dot(nor))).normalized()
                    d = (d + self.down * 0.6).normalized()
            else:
                g = 0.6 + 1.0 * min(1.0, s / 0.3)
                d = (d + self.down * g * ds * 5.0).normalized()
                if p.z < self.shoulder_z + 0.1:
                    # Over the shoulder to the front, or down the back; then the lengths hang close to the body.
                    pull = Vector((0, -1, 0)) if front else Vector((0, 1, 0))
                    k = 0.05 if p.z > self.shoulder_z - 0.04 else 0.0
                    axis = Vector((p.x * 0.5, p.y - self.hc.y, 0))
                    inward = -axis.normalized() * 0.035 if axis.length > 0.09 else Vector()
                    d = (d + pull * k + inward).normalized()
                p = p + d * ds
                if p.y < self.eye_y + 0.02 and self.chin_z - 0.04 < p.z < self.brow_z and abs(p.x) < 0.078:
                    p.x = math.copysign(0.078, p.x if abs(p.x) > 1e-4 else side)
                loc, nor, _, _ = self.tree.find_nearest(p, 0.2)
                if loc is not None:
                    off = (p - loc).dot(nor)
                    if off < margin:
                        p = loc + nor * margin
                        if d.dot(nor) < 0:
                            d = (d - nor * d.dot(nor)).normalized()
            path.append(p.copy())
            s += ds
        return self.finish(path, phase, layer, margin)

    def finish(self, path, phase, layer, margin):
        # Smooth the grown path, then resample it at a fixed spacing so waves are drawn with enough rows to be curves.
        for _ in range(3):
            path = [path[0]] + [(path[k - 1] + path[k] * 2 + path[k + 1]) / 4 for k in range(1, len(path) - 1)] + [path[-1]]
        row = self.spec.get("row", 0.02)
        pts = [path[0]]
        acc = 0.0
        for k in range(1, len(path)):
            acc += (path[k] - path[k - 1]).length
            if acc >= row or k == len(path) - 1:
                pts.append(path[k])
                acc = 0.0
        out, frames = [], []
        total = 0.0
        for k, p in enumerate(pts):
            if k:
                total += (pts[k] - pts[k - 1]).length
            T = (pts[min(k + 1, len(pts) - 1)] - pts[max(k - 1, 0)]).normalized()
            if p.z > self.chin_z:
                R = (p - self.hc).normalized()
            else:
                R = (p - Vector((0.0, self.hc.y - 0.03, p.z))).normalized()
            R = (R - T * R.dot(T)).normalized()
            B = T.cross(R).normalized()
            below_ears = _smooth(self.ear_z + 0.02, self.ear_z - 0.08, p.z)
            A = self.amp * below_ears * (0.6 + 0.8 * layer)
            wph = 2 * math.pi * total / self.wave_len + phase
            q = p + B * A * math.sin(wph) + R * A * 0.5 * (0.5 + 0.5 * math.cos(wph))
            loc, nor, _, _ = self.tree.find_nearest(q, 0.2)
            if loc is not None and (q - loc).dot(nor) < margin * 0.8:
                q = loc + nor * margin * 0.8
            out.append(q)
            frames.append(B)
        return out, frames


def build_hair(c, colliders, mat, spec, lm):
    rng = np.random.default_rng(spec.get("seed", 3))
    gm = Groom(c, lm, spec, colliders)
    tris, prob = scalp_triangles(c)

    def sample_root():
        t = tris[rng.choice(len(tris), p=prob)]
        a, b = rng.random(), rng.random()
        if a + b > 1:
            a, b = 1 - a, 1 - b
        p = t[0] + a * (t[1] - t[0]) + b * (t[2] - t[0])
        n = np.cross(t[1] - t[0], t[2] - t[0])
        n = n / (np.linalg.norm(n) or 1)
        if np.dot(n, p - np.array(gm.hc)) < 0:
            n = -n
        return Vector(p), Vector(n)

    strands = []
    length = spec.get("length", 0.75)
    for _ in range(spec.get("clumps", 72)):
        center, _n = sample_root()
        side = 1.0 if center.x > gm.part_x else -1.0
        front_half = center.y < gm.hc.y + 0.0
        p_front = (spec.get("front_right", 0.55) if side < 0 else spec.get("front_left", 0.35)) if front_half else 0.05
        front = rng.random() < p_front
        L = length * rng.uniform(0.88, 1.04) * (0.85 if front else 1.0)
        phase = rng.uniform(0, 2 * math.pi)
        layer = rng.uniform(0, 1)
        for _s in range(spec.get("per_clump", 5)):
            for _try in range(40):
                root, n0 = sample_root()
                if (root - center).length < 0.022:
                    break
            pts, frames = gm.grow(root, n0, side, front, L * rng.uniform(0.95, 1.03),
                                  phase + rng.uniform(-0.3, 0.3), min(1.0, layer * 0.85 + 0.15 * rng.random()))
            strands.append((pts, frames))

    verts, faces, uvs, weights = [], [], [], []
    chin_z, shoulder_z = gm.chin_z, gm.shoulder_z
    for pts, frames in strands:
        width = rng.uniform(*spec.get("card_width", (0.028, 0.042)))
        u0 = rng.choice([0.0, 0.5])
        start = len(verts)
        n = len(pts)
        Ltot = sum((pts[k + 1] - pts[k]).length for k in range(n - 1)) or 1
        s_acc = 0.0
        for k, (p, B) in enumerate(zip(pts, frames)):
            if k:
                s_acc += (pts[k] - pts[k - 1]).length
            f = s_acc / Ltot
            w = width * (0.45 + 0.75 * math.sin(math.pi * min(1.0, 0.1 + f * 0.92)))
            for side_u in (0.0, 1.0):
                q = p + B * (side_u - 0.5) * w
                verts.append(tuple(q))
                uvs.append((u0 + side_u * 0.5, 1.0 - f))
                hw = _smooth(shoulder_z + 0.02, chin_z + 0.03, q.z)
                weights.append({"head": hw, "spine_03": 1.0 - hw} if hw < 0.999 else {"head": 1.0})
        for k in range(n - 1):
            a = start + 2 * k
            faces.append((a, a + 1, a + 3, a + 2))
    me = bpy.data.meshes.new("Hair")
    me.from_pydata(verts, [], faces)
    uv = me.uv_layers.new(name="UVMap")
    for poly in me.polygons:
        poly.use_smooth = True
        for li in poly.loop_indices:
            uv.data[li].uv = uvs[me.loops[li].vertex_index]
    ob = bpy.data.objects.new("Hair", me)
    bpy.context.scene.collection.objects.link(ob)
    ob.data.materials.append(mat)
    groups = {}
    for i, ws in enumerate(weights):
        for bone, w in ws.items():
            if w < 0.005:
                continue
            g = groups.get(bone) or ob.vertex_groups.new(name=bone)
            groups[bone] = g
            g.add([i], w, "REPLACE")
    return ob, len(strands)

"""The MakeHuman base human for CHE World's reference characters.

The base mesh, shape targets, rigs and skin weights come from MPFB2's data folder (MakeHuman community, CC0 1.0:
LICENSE.ASSETS.md in https://github.com/makehumancommunity/mpfb2). fetch_mpfb.sh downloads a pinned copy. This
module reads them directly, so vertex order stays exactly as the targets and weights index it.

Units: MakeHuman stores decimetres with Y up and the body facing +Z. Blender gets metres with Z up and the body facing
-Y; the glTF exporter turns that into Y up facing +Z, which is what the CHE app's three.js scene expects.
"""
import gzip
import json
import os

import numpy as np


class BaseHuman:
    def __init__(self, data_dir):
        self.data = data_dir
        verts, uvs, faces, face_uvs, face_groups = [], [], [], [], []
        group = None
        with open(os.path.join(data_dir, "3dobjs", "base.obj")) as fh:
            for line in fh:
                if line.startswith("v "):
                    verts.append([float(x) for x in line.split()[1:4]])
                elif line.startswith("vt "):
                    uvs.append([float(x) for x in line.split()[1:3]])
                elif line.startswith("g "):
                    group = line.split()[1]
                elif line.startswith("f "):
                    parts = [t.split("/") for t in line.split()[1:]]
                    faces.append([int(p[0]) - 1 for p in parts])
                    face_uvs.append([int(p[1]) - 1 for p in parts])
                    face_groups.append(group)
        self.rest = np.array(verts, dtype=np.float64)
        self.v = self.rest.copy()
        self.uv = np.array(uvs, dtype=np.float64)
        self.faces = faces
        self.face_uvs = face_uvs
        self.face_groups = face_groups
        self.group_verts = {}
        for f, g in zip(faces, face_groups):
            self.group_verts.setdefault(g, set()).update(f)
        self._cache = {}

    # ---------- targets
    def target(self, rel):
        """(indices, deltas) of one target file, relative to data/targets, without the .target.gz suffix."""
        if rel not in self._cache:
            path = os.path.join(self.data, "targets", rel + ".target.gz")
            idx, delta = [], []
            with gzip.open(path, "rt") as fh:
                for line in fh:
                    p = line.split()
                    if len(p) == 4 and not line.startswith("#"):
                        idx.append(int(p[0]))
                        delta.append([float(p[1]), float(p[2]), float(p[3])])
            # Some targets are intentionally empty (the neutral shape of a macro axis).
            self._cache[rel] = (np.array(idx, dtype=np.int64), np.array(delta, dtype=np.float64).reshape(-1, 3))
        return self._cache[rel]

    def has_target(self, rel):
        return os.path.exists(os.path.join(self.data, "targets", rel + ".target.gz"))

    def apply(self, rel, weight, into=None):
        idx, delta = self.target(rel)
        (self.v if into is None else into)[idx] += weight * delta

    def displacement(self, rel, weight=1.0):
        """A whole-mesh displacement array for one target (zeros elsewhere)."""
        out = np.zeros_like(self.v)
        self.apply(rel, weight, into=out)
        return out

    def apply_modifier(self, name, value):
        """A two-sided modifier ("nose-scale-horiz" with value -0.4 applies ...-decr at 0.4) or a one-sided target."""
        if value == 0:
            return
        folder = name.split("/")[0]
        base = name
        for lo, hi in (("decr", "incr"), ("down", "up"), ("in", "out"), ("backward", "forward"), ("concave", "convex")):
            if self.has_target(f"{base}-{hi}") and self.has_target(f"{base}-{lo}"):
                self.apply(f"{base}-{hi}" if value > 0 else f"{base}-{lo}", abs(value))
                return
        if self.has_target(base):
            self.apply(base, value)
            return
        raise FileNotFoundError(f"no target for modifier {name} in {folder}")

    # ---------- macro shape (gender, age, muscle, weight, height, proportions, breast, ethnicity)
    @staticmethod
    def _components(value, parts):
        out = []
        for low, high, lowest, highest in parts:
            if lowest < value < highest:
                pos = (value - lowest) / (highest - lowest)
                if low:
                    out.append((low, round(1 - pos, 4)))
                if high:
                    out.append((high, round(pos, 4)))
        return out

    def macro_targets(self, m, cutoff=0.01):
        """Weighted macro targets for macro values m (MakeHuman's interpolation scheme)."""
        cfg = json.load(open(os.path.join(self.data, "targets", "macrodetails", "macro.json")))["macrotargets"]
        comp = {k: self._components(m[k], [(p["low"], p["high"], p["lowest"], p["highest"]) for p in cfg[k]["parts"]])
                for k in ("gender", "age", "muscle", "weight", "proportions", "height", "cupsize", "firmness")}
        out = []
        for race, rv in m["race"].items():
            for a, aw in comp["age"]:
                for g, gw in comp["gender"]:
                    w = rv * gw * aw
                    if w > cutoff:
                        out.append((f"macrodetails/{race}-{g}-{a}", w))
        for g, gw in comp["gender"]:
            for a, aw in comp["age"]:
                for mu, mw in comp["muscle"]:
                    for we, ww in comp["weight"]:
                        w = gw * aw * mw * ww
                        if w > cutoff:
                            out.append((f"macrodetails/universal-{g}-{a}-{mu}-{we}", w))
                        for h, hw in comp["height"]:
                            if gw * aw * mw * ww * hw > cutoff:
                                out.append((f"macrodetails/height/{g}-{a}-{mu}-{we}-{h}", gw * aw * mw * ww * hw))
                        for p, pw in comp["proportions"]:
                            if gw * aw * mw * ww * pw > cutoff and a != "baby":
                                out.append((f"macrodetails/proportions/{g}-{a}-{mu}-{we}-{p}", gw * aw * mw * ww * pw))
                        if g == "female":
                            for c, cw in comp["cupsize"]:
                                for f, fw in comp["firmness"]:
                                    w = aw * mw * ww * cw * fw
                                    name = f"breast/{g}-{a}-{mu}-{we}-{c}-{f}"
                                    if w > cutoff and "averagecup-averagefirmness" not in name and a != "baby":
                                        out.append((name, w))
        return out

    def apply_macros(self, m):
        applied = []
        for rel, w in self.macro_targets(m):
            if self.has_target(rel):
                self.apply(rel, w)
                applied.append((rel, w))
        return applied

    # ---------- geometry helpers
    def joint(self, name):
        """Centre of a joint helper cube (MakeHuman places the skeleton from these)."""
        vs = sorted(self.group_verts[name])
        return self.v[vs].mean(axis=0)

    @staticmethod
    def to_blender(p):
        p = np.asarray(p, dtype=np.float64)
        return np.stack([p[..., 0], -p[..., 2], p[..., 1]], axis=-1) * 0.1

    def blender_verts(self, ground=None):
        out = self.to_blender(self.v)
        if ground is None:
            ground = out[sorted(self.group_verts["body"])][:, 2].min()
        out[:, 2] -= ground
        return out, ground

    def load_rig(self, name="game_engine"):
        rig = json.load(open(os.path.join(self.data, "rigs", "standard", f"rig.{name}.json")))
        weights = json.load(open(os.path.join(self.data, "rigs", "standard", f"weights.{name}.json")))["weights"]
        return rig, weights

    def rig_point(self, spec):
        if spec["strategy"] == "CUBE":
            return self.joint(spec["cube_name"])
        if spec["strategy"] == "VERTEX":
            return self.v[spec["vertex_index"]]
        if spec["strategy"] == "MEAN":
            return self.v[spec["vertex_indices"]].mean(axis=0)
        raise ValueError(spec["strategy"])

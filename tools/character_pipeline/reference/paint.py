"""Textures for the reference characters, painted from data instead of by hand.

Skin and makeup are painted in the MakeHuman base mesh's UV space. Region masks come from two sources: MPFB2's CC0
region masks (lips, eyelids, nails, inside of the mouth) and the shape targets themselves. A target moves exactly the
vertices of its feature, so the size of that movement is a mask for the feature (the eyebrow-raise target outlines the
brows, the eye-closure target outlines the lid margin).
"""
import os

import numpy as np
from PIL import Image, ImageFilter


def srgb(h):
    h = h.lstrip("#")
    return np.array([int(h[i:i + 2], 16) for i in (0, 2, 4)], dtype=np.float32) / 255.0


def triangles(base, face_ids):
    """(vertex index triples, uv triples) for the given base faces, quads split in two."""
    vi, uv = [], []
    for f in face_ids:
        vs, ts = base.faces[f], base.face_uvs[f]
        for a, b, c in ((0, 1, 2), (0, 2, 3)) if len(vs) == 4 else ((0, 1, 2),):
            vi.append((vs[a], vs[b], vs[c]))
            uv.append((base.uv[ts[a]], base.uv[ts[b]], base.uv[ts[c]]))
    return np.array(vi), np.array(uv)


def raster(size, tri_uv, tri_val):
    """Rasterise per-corner scalar values into a UV image, keeping the maximum where triangles overlap."""
    img = np.zeros((size, size), np.float32)
    for uv, val in zip(tri_uv, tri_val):
        if val.max() <= 1e-4:
            continue
        px, py = uv[:, 0] * size, (1 - uv[:, 1]) * size
        x0, x1 = max(0, int(px.min()) - 1), min(size - 1, int(px.max()) + 1)
        y0, y1 = max(0, int(py.min()) - 1), min(size - 1, int(py.max()) + 1)
        if x1 < x0 or y1 < y0:
            continue
        xs, ys = np.meshgrid(np.arange(x0, x1 + 1) + 0.5, np.arange(y0, y1 + 1) + 0.5)
        d = (py[1] - py[2]) * (px[0] - px[2]) + (px[2] - px[1]) * (py[0] - py[2])
        if abs(d) < 1e-9:
            continue
        l0 = ((py[1] - py[2]) * (xs - px[2]) + (px[2] - px[1]) * (ys - py[2])) / d
        l1 = ((py[2] - py[0]) * (xs - px[2]) + (px[0] - px[2]) * (ys - py[2])) / d
        l2 = 1 - l0 - l1
        inside = (l0 >= -0.02) & (l1 >= -0.02) & (l2 >= -0.02)
        v = l0 * val[0] + l1 * val[1] + l2 * val[2]
        sub = img[y0:y1 + 1, x0:x1 + 1]
        np.maximum(sub, np.where(inside, v, 0), out=sub)
    return img


def position_map(size, tri_uv, tri_pos):
    """The 3D position under every texel (x, y, z images plus a coverage mask), for painting by face geometry."""
    pos = np.zeros((size, size, 3), np.float32)
    cov = np.zeros((size, size), bool)
    for uv, p in zip(tri_uv, tri_pos):
        px, py = uv[:, 0] * size, (1 - uv[:, 1]) * size
        x0, x1 = max(0, int(px.min()) - 1), min(size - 1, int(px.max()) + 1)
        y0, y1 = max(0, int(py.min()) - 1), min(size - 1, int(py.max()) + 1)
        if x1 < x0 or y1 < y0:
            continue
        xs, ys = np.meshgrid(np.arange(x0, x1 + 1) + 0.5, np.arange(y0, y1 + 1) + 0.5)
        d = (py[1] - py[2]) * (px[0] - px[2]) + (px[2] - px[1]) * (py[0] - py[2])
        if abs(d) < 1e-9:
            continue
        l0 = ((py[1] - py[2]) * (xs - px[2]) + (px[2] - px[1]) * (ys - py[2])) / d
        l1 = ((py[2] - py[0]) * (xs - px[2]) + (px[0] - px[2]) * (ys - py[2])) / d
        l2 = 1 - l0 - l1
        inside = (l0 >= -0.03) & (l1 >= -0.03) & (l2 >= -0.03)
        val = l0[..., None] * p[0] + l1[..., None] * p[1] + l2[..., None] * p[2]
        sub, csub = pos[y0:y1 + 1, x0:x1 + 1], cov[y0:y1 + 1, x0:x1 + 1]
        sub[inside] = val[inside]
        csub[inside] = True
    return pos, cov


def stroke_mask(pos, cov, curve, widths, front_y, soft=0.35):
    """Texels whose front-projected (|x|, z) position lies within a tapered stroke along a 2D polyline."""
    x, y, z = np.abs(pos[..., 0]), pos[..., 1], pos[..., 2]
    curve = np.asarray(curve, np.float32)
    widths = np.asarray(widths, np.float32)
    best = np.full(x.shape, 1e9, np.float32)
    wbest = np.zeros(x.shape, np.float32)
    for i in range(len(curve) - 1):
        a, b = curve[i], curve[i + 1]
        ab = b - a
        L2 = float(ab @ ab) or 1e-12
        t = np.clip(((x - a[0]) * ab[0] + (z - a[1]) * ab[1]) / L2, 0, 1)
        dx, dz = x - (a[0] + t * ab[0]), z - (a[1] + t * ab[1])
        d = np.sqrt(dx * dx + dz * dz)
        w = widths[i] * (1 - t) + widths[i + 1] * t
        closer = d < best
        best = np.where(closer, d, best)
        wbest = np.where(closer, w, wbest)
    m = np.clip((wbest - best) / (soft * np.maximum(wbest, 1e-6)), 0, 1)
    return m * cov * (y < front_y)


def blur(a, r):
    im = Image.fromarray(np.clip(a * 255, 0, 255).astype(np.uint8))
    return np.asarray(im.filter(ImageFilter.GaussianBlur(r)), dtype=np.float32) / 255.0


def mask_file(data, name, size):
    im = Image.open(os.path.join(data, "textures", f"mpfb_{name}.jpg")).convert("L")
    if im.size != (size, size):
        im = im.resize((size, size), Image.LANCZOS)
    return np.asarray(im, dtype=np.float32) / 255.0


def noise(size, scale, seed):
    rng = np.random.default_rng(seed)
    small = rng.random((max(2, size // scale), max(2, size // scale))).astype(np.float32)
    im = Image.fromarray((small * 255).astype(np.uint8)).resize((size, size), Image.BICUBIC)
    return np.asarray(im, dtype=np.float32) / 255.0


def lerp(base, color, alpha):
    return base * (1 - alpha[..., None]) + color[None, None, :] * alpha[..., None]


def skin_textures(base, masks, palette, data, out_dir, size=2048, seed=7, pixel_masks=None):
    """Base colour and roughness for the skin, with makeup.

    masks: name -> per-vertex scalar (0..1); pixel_masks(size, tri_v, tri_uv) -> name -> texel mask, for strokes
    finer than the mesh (brows, eyeliner)."""
    face_ids = [i for i, g in enumerate(base.face_groups) if g == "body"]
    tri_v, tri_uv = triangles(base, face_ids)
    px_masks = pixel_masks(size, tri_v, tri_uv) if pixel_masks else {}

    def m(name, r=0.0):
        if name in px_masks:
            img = px_masks[name]
        else:
            img = raster(size, tri_uv, masks[name][tri_v])
        return blur(img, r) if r else img

    skin = srgb(palette["skin"])
    col = np.ones((size, size, 3), np.float32) * skin[None, None, :]
    # Gentle tone variation so the skin is not a flat fill: warmer cheeks, slightly deeper creases.
    n1, n2 = noise(size, 48, seed), noise(size, 9, seed + 1)
    col *= (0.96 + 0.06 * n1[..., None]) * (0.985 + 0.03 * n2[..., None])
    rough = np.full((size, size), 0.52, np.float32)

    blush = m("cheek", 18) * 0.22
    col = lerp(col, srgb(palette.get("blush", "#a5523a")), blush)
    contour = m("contour", 14) * 0.18
    col = lerp(col, skin * 0.78, contour)

    lids = mask_file(data, "eyelids", size)
    shadow = blur(lids, 3) * 0.75
    col = lerp(col, srgb(palette["eyeshadow"]), shadow)
    shimmer = blur(lids * m("lid_center", 6), 5) * 0.35
    col = lerp(col, np.clip(srgb(palette["eyeshadow"]) * 1.9, 0, 1), shimmer)
    rough = rough * (1 - shimmer) + 0.3 * shimmer

    liner = np.clip(m("liner", 1.2) * 1.6, 0, 1)
    col = lerp(col, srgb(palette["liner"]), liner)

    brow = m("brow", 1.5)
    strokes = np.clip(noise(size, 2, seed + 3) * 1.6 - 0.25, 0, 1)
    brow_a = np.clip(brow * (0.75 + 0.35 * strokes), 0, 0.95)
    col = lerp(col, srgb(palette["brows"]), brow_a)
    rough = rough * (1 - brow_a) + 0.75 * brow_a

    lips = blur(mask_file(data, "lips", size), 2)
    lip_col = srgb(palette["lips"])
    gloss = np.clip(lips * (0.6 + 0.4 * noise(size, 24, seed + 5)), 0, 1)
    col = lerp(col, lip_col, lips * 0.92)
    col = lerp(col, np.clip(lip_col * 1.45, 0, 1), m("lip_center", 8) * lips * 0.35)
    rough = rough * (1 - lips) + 0.24 * lips

    mouth = mask_file(data, "inside-mouth", size)
    col = lerp(col, srgb("#5a1f1c"), mouth)
    for nails in ("fingernails", "toenails"):
        nm = mask_file(data, nails, size)
        col = lerp(col, srgb(palette.get("nails", "#c98e82")), nm * 0.9)
        rough = rough * (1 - nm) + 0.18 * nm

    scalp = m("scalp", 4)
    col = lerp(col, srgb(palette["hair"]), np.clip(scalp * 1.2, 0, 1))
    rough = rough * (1 - scalp) + 0.6 * scalp

    os.makedirs(out_dir, exist_ok=True)
    color_path = os.path.join(out_dir, "skin_color.png")
    rough_path = os.path.join(out_dir, "skin_rough.png")
    Image.fromarray(np.clip(col * 255, 0, 255).astype(np.uint8)).save(color_path)
    Image.fromarray(np.clip(rough * 255, 0, 255).astype(np.uint8)).save(rough_path)
    return color_path, rough_path


def iris_texture(palette, out_dir, size=512, iris_deg=44, pupil_deg=15):
    """Eyeball texture in an azimuthal projection: the front pole at the centre, the back pole on the rim."""
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float32)
    cx = cy = (size - 1) / 2
    r = np.hypot(xx - cx, yy - cy) / (size / 2)          # 0 at the front pole, 1 at the back pole
    theta = r * 180.0                                      # degrees from the front pole
    ang = np.arctan2(yy - cy, xx - cx)
    sclera = srgb("#efe7df")
    col = np.ones((size, size, 3), np.float32) * sclera
    col *= (1 - 0.06 * np.clip((theta - 50) / 60, 0, 1))[..., None]
    iris = srgb(palette["iris"])
    t = np.clip(theta / iris_deg, 0, 1)
    fibres = 0.5 + 0.5 * np.sin(ang * 70 + np.sin(ang * 13) * 3)
    iris_col = iris[None, None, :] * (0.75 + 0.55 * t[..., None] * (0.6 + 0.4 * fibres[..., None]))
    iris_col = iris_col * (1 - 0.55 * np.clip((t - 0.85) / 0.15, 0, 1))[..., None]   # dark limbal ring
    inside = theta < iris_deg
    edge = np.clip((iris_deg + 1.5 - theta) / 3.0, 0, 1)
    col = col * (1 - edge[..., None]) + iris_col * edge[..., None]
    pupil = np.clip((pupil_deg + 1 - theta) / 2.0, 0, 1)
    col = col * (1 - pupil[..., None]) + np.array([0.02, 0.015, 0.012]) * pupil[..., None]
    del inside
    path = os.path.join(out_dir, "eye_color.png")
    Image.fromarray(np.clip(col * 255, 0, 255).astype(np.uint8)).save(path)
    return path


def strand_texture(palette, out_dir, name="hair", w=512, h=1024, strands=1000, seed=11, taper=0.16):
    """RGBA hair-card texture: fine strands along V (root at the top), alpha tapering at the tips."""
    rng = np.random.default_rng(seed)
    alpha = np.zeros((h, w), np.float32)
    shade = np.zeros((h, w), np.float32)
    ys = np.arange(h, dtype=np.float32)
    for _ in range(strands):
        x0 = rng.uniform(0.04, 0.96) * w
        width = rng.uniform(0.8, 2.4)
        wob = rng.uniform(1.5, 5.0)
        phase = rng.uniform(0, 6.28)
        length = rng.uniform(0.82, 1.0)
        bright = rng.uniform(0.0, 1.0) ** 2.2
        xs = x0 + wob * np.sin(ys / h * 6.28 * rng.uniform(0.6, 1.6) + phase)
        for y in range(0, h, 2):
            if y / h > length:
                break
            xi = int(xs[y])
            for dx in range(-3, 4):
                xx = xi + dx
                if 0 <= xx < w:
                    a = max(0.0, 1 - abs(xx - xs[y]) / width)
                    if a > alpha[y, xx]:
                        alpha[y, xx] = a
                        alpha[min(h - 1, y + 1), xx] = max(alpha[min(h - 1, y + 1), xx], a)
                        shade[y, xx] = bright
                        shade[min(h - 1, y + 1), xx] = bright
    v = ys[:, None] / h
    u = np.arange(w, dtype=np.float32)[None, :] / w
    core = 0.62 * np.clip(1 - np.abs(u - 0.5) / 0.42, 0, 1) ** 0.7
    alpha = np.maximum(alpha, core * (0.75 + 0.25 * np.sin(u * 37 + 1.3)))
    tip = np.clip((1 - v) / taper, 0, 1)
    alpha *= tip
    alpha = np.clip(alpha * 1.25, 0, 1)
    dark, sheen = srgb(palette["hair"]), srgb(palette["hair_sheen"])
    col = dark[None, None, :] * (1 - shade[..., None]) + sheen[None, None, :] * shade[..., None]
    col *= (0.85 + 0.25 * v[..., None])
    rgba = np.dstack([np.clip(col * 255, 0, 255), np.clip(alpha * 255, 0, 255)]).astype(np.uint8)
    path = os.path.join(out_dir, f"{name}_cards.png")
    Image.fromarray(rgba, "RGBA").save(path)
    return path


def lash_texture(palette, out_dir, w=512, h=128, seed=5):
    """RGBA eyelash strip: root along the top edge, curved tapering lashes, denser and longer toward the outer end."""
    rng = np.random.default_rng(seed)
    alpha = np.zeros((h, w), np.float32)
    for i in range(170):
        u = rng.uniform(0.02, 0.98)
        length = (0.55 + 0.45 * u) * rng.uniform(0.75, 1.0)
        x0 = u * w
        lean = rng.uniform(4, 14) * (0.4 + u)
        steps = int(h * length)
        for s in range(steps):
            t = s / h
            x = x0 + lean * (t ** 1.6)
            width = 1.6 * (1 - s / max(1, steps)) + 0.4
            for dx in range(-2, 3):
                xx = int(x) + dx
                if 0 <= xx < w:
                    a = max(0.0, 1 - abs(xx - x) / width)
                    alpha[s, xx] = max(alpha[s, xx], a)
    col = np.ones((h, w, 3), np.float32) * srgb(palette["liner"])
    rgba = np.dstack([col * 255, np.clip(alpha * 255, 0, 255)]).astype(np.uint8)
    path = os.path.join(out_dir, "lashes.png")
    Image.fromarray(rgba, "RGBA").save(path)
    return path

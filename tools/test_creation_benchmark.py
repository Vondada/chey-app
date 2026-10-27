"""The benchmark's own measuring tools (tools/creation_benchmark.py) and the render profiles (render_profiles.py),
without Blender: PNG decoding against known pixels, the noise estimate, SSIM, PSNR, and the settings each profile sets.
  python3 -m pytest tools/test_creation_benchmark.py   (or python3 tools/test_creation_benchmark.py)"""
import os
import struct
import sys
import tempfile
import types
import unittest
import zlib

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE); sys.path.insert(0, os.path.join(HERE, 'avatar_body'))
import creation_benchmark as B  # noqa: E402
import render_profiles as P  # noqa: E402


def png(path, px, filters):
    """Write an 8-bit RGBA PNG with the given filter type on each row (0..4), encoding exactly as the spec says."""
    h, w, _ = px.shape; bpp = 4; raw = b''
    prev = np.zeros(w * bpp, dtype=np.int32)
    for y in range(h):
        line = px[y].reshape(-1).astype(np.int32); f = filters[y % len(filters)]; out = np.zeros_like(line)
        for x in range(len(line)):
            a = line[x - bpp] if x >= bpp else 0; b = prev[x]; c = prev[x - bpp] if x >= bpp else 0
            pred = {0: 0, 1: a, 2: b, 3: (a + b) >> 1}.get(f)
            if f == 4:
                p = a + b - c; pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                pred = a if pa <= pb and pa <= pc else (b if pb <= pc else c)
            out[x] = (line[x] - pred) & 255
        raw += bytes([f]) + bytes(out.astype(np.uint8)); prev = line

    def chunk(k, d): return struct.pack('>I', len(d)) + k + d + struct.pack('>I', zlib.crc32(k + d) & 0xffffffff)
    with open(path, 'wb') as fh:
        fh.write(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b''))


class Png(unittest.TestCase):
    def test_every_filter_type_decodes_to_the_pixels_written(self):
        rng = np.random.default_rng(7)
        px = rng.integers(0, 256, size=(10, 7, 4), dtype=np.uint8)
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, 't.png'); png(p, px, [0, 1, 2, 3, 4])
            got = B.read_png(p)
        self.assertEqual(got.shape, (10, 7, 3))
        self.assertTrue(np.allclose(got, px[..., :3] / 255.0))

    def test_not_a_png_is_refused(self):
        with tempfile.NamedTemporaryFile(suffix='.png') as f:
            f.write(b'GIF89a'); f.flush()
            with self.assertRaises(ValueError): B.read_png(f.name)


class Measures(unittest.TestCase):
    def test_noise_estimate_is_zero_on_smooth_and_tracks_added_noise(self):
        y, x = np.mgrid[0:64, 0:64] / 64.0
        smooth = np.dstack([x, y, (x + y) / 2])
        self.assertLess(B.noise_sigma(smooth), 0.01)
        rng = np.random.default_rng(1)
        lo = np.clip(smooth + rng.normal(0, 2 / 255, smooth.shape), 0, 1); hi = np.clip(smooth + rng.normal(0, 8 / 255, smooth.shape), 0, 1)
        self.assertLess(B.noise_sigma(lo), B.noise_sigma(hi))
        # Independent noise of sigma 8 per channel is sigma 8 x 0.749 (the luma weights' norm) in luma: about 6 levels.
        self.assertAlmostEqual(B.noise_sigma(hi), 8 * float(np.linalg.norm([0.2126, 0.7152, 0.0722])), delta=1.0)

    def test_ssim_and_psnr(self):
        rng = np.random.default_rng(2); a = rng.random((40, 30, 3))
        self.assertAlmostEqual(B.ssim(a, a), 1.0, places=6); self.assertEqual(B.psnr(a, a), float('inf'))
        b = np.clip(a + rng.normal(0, 0.1, a.shape), 0, 1)
        self.assertLess(B.ssim(a, b), 0.95); self.assertLess(B.psnr(a, b), 25)
        with self.assertRaises(ValueError): B.ssim(a, a[:-1])


class Comparison(unittest.TestCase):
    def test_first_picture_uses_each_runs_own_render_time(self):
        # legacy_r1 of the local run on 2026-10-24: 23.84 s wall, views 9.83 + 7.05 + 5.92 s. Its first picture came
        # 23.84 - 22.80 + 9.83 = 10.87 s after start; an earlier version subtracted the median of all rounds instead.
        r1 = {'ok': True, 'wall_seconds': 23.84, 'view_seconds': {'0': 9.83, '45': 7.05, '90': 5.92}, 'peak_rss_mib': 485.2, 'load_before': 2.7}
        r2 = {'ok': True, 'wall_seconds': 12.58, 'view_seconds': {'0': 4.54, '45': 3.7, '90': 3.29}, 'peak_rss_mib': 485.7, 'load_before': 6.2}
        self.assertEqual(B.first_picture(r1, '0'), 10.87)
        self.assertIsNone(B.first_picture(dict(r1, ok=False), '0'))
        f1 = {'ok': True, 'wall_seconds': 11.37, 'view_seconds': {'0': 4.19, '45': 3.23, '90': 3.06}, 'peak_rss_mib': 490.0, 'load_before': 7.0}
        quick = {'ok': True, 'wall_seconds': 2.08, 'view_seconds': {'0': 0.44, '45': 0.32, '90': 0.38}, 'peak_rss_mib': 390.9, 'profile': {'engine': 'CYCLES'}}
        c = B.compare({'legacy': [r1, r2], 'final': [f1, f1]}, quick, '0')
        self.assertEqual(c['legacy_first_picture_seconds_each_round'], [10.87, 5.59])
        self.assertEqual(c['legacy_first_picture_seconds_median'], 8.23)
        self.assertEqual(c['upgraded_first_picture_seconds'], 1.38)
        self.assertEqual(c['rounds'], 2); self.assertEqual(c['peak_rss_mib']['legacy'], 485.7)


def scene():
    cycles = types.SimpleNamespace(samples=0, use_denoising=False, adaptive_threshold=0.01, denoiser='OPENIMAGEDENOISE', use_adaptive_sampling=True,
                                   adaptive_min_samples=0, max_bounces=12, diffuse_bounces=4, glossy_bounces=4, transmission_bounces=12,
                                   transparent_max_bounces=8, sample_clamp_indirect=10.0, caustics_reflective=True, caustics_refractive=True,
                                   blur_glossy=1.0, denoising_input_passes='RGB', denoising_prefilter='FAST', denoising_use_gpu=False)
    return types.SimpleNamespace(cycles=cycles, render=types.SimpleNamespace(use_persistent_data=False, resolution_percentage=100, engine='CYCLES'),
                                 eevee=types.SimpleNamespace(taa_render_samples=64))


class Profiles(unittest.TestCase):
    def setUp(self):
        self.env = dict(os.environ)
        for k in ('RENDER_PROFILE', 'ADAPTIVE_THRESHOLD', 'PREVIEW_ENGINE', 'PREVIEW_SAMPLES', 'PREVIEW_SCALE'): os.environ.pop(k, None)

    def tearDown(self):
        os.environ.clear(); os.environ.update(self.env)

    def test_legacy_is_the_old_pipeline_unchanged(self):
        sc = scene(); rec = P.apply(sc, 'legacy', 64)
        self.assertEqual((sc.cycles.samples, sc.cycles.use_denoising, sc.cycles.max_bounces, sc.render.use_persistent_data), (64, True, 12, False))
        self.assertEqual(rec['engine'], 'CYCLES')

    def test_final_sets_adaptive_stop_denoise_passes_capped_paths_and_persistent_data(self):
        sc = scene(); rec = P.apply(sc, 'final', 64, gpu=True)
        c = sc.cycles
        self.assertEqual((c.samples, c.adaptive_threshold, c.adaptive_min_samples, c.max_bounces), (64, 0.02, 16, 6))
        self.assertEqual((c.denoising_input_passes, c.caustics_reflective, c.denoising_use_gpu), ('RGB_ALBEDO_NORMAL', False, True))
        self.assertTrue(sc.render.use_persistent_data); self.assertTrue(rec['persistent_data'])

    def test_preview_is_a_small_fast_cycles_pass_unless_eevee_is_asked_for(self):
        sc = scene(); rec = P.apply(sc, 'preview', 64)
        self.assertEqual((rec['engine'], sc.cycles.samples, sc.render.resolution_percentage), ('CYCLES', 4, 50))
        os.environ['PREVIEW_ENGINE'] = 'eevee'; sc = scene(); rec = P.apply(sc, 'preview', 64)
        self.assertEqual((rec['engine'], sc.render.engine, sc.eevee.taa_render_samples), ('BLENDER_EEVEE', 'BLENDER_EEVEE', 16))

    def test_an_unknown_profile_stops_the_render(self):
        os.environ['RENDER_PROFILE'] = 'turbo'
        with self.assertRaises(SystemExit): P.profile_name()
        os.environ['RENDER_PROFILE'] = 'FINAL'; self.assertEqual(P.profile_name(), 'final')


if __name__ == '__main__':
    unittest.main()

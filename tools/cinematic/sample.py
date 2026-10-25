"""A real Blender/Cycles sample of CHE (identity preset 'che', built by the real mpfb_body.py pipeline): she walks into
her office, turns, sits, gestures and speaks a line (Kokoro TTS, Rhubarb visemes), with a close-up and a skeleton
overlay segment. Everything in the picture is the rigged model; nothing is AI-generated video.

  python3 sample.py -- --out DIR --line-wav che_line.wav --rhubarb che_line_rhubarb.json [--res 1280x720]
                       [--samples 16] [--close-samples 24] [--frames 0-426] [--no-render] [--fps 24]
  (blender -b --factory-startup -P sample.py -- ...  or the pip bpy module's python)

Writes DIR/frames/####.png, DIR/che_interactive.glb (+ interactive.json), DIR/receipt.json (stage timings, device,
foot-lock slip, lip-sync lag, shots), and prints STAGE / FRAME lines. tools/cinematic/mux.py makes the MP4.
"""
import argparse
import faulthandler
import json
import math
import os
import platform
import resource
import sys
import time
import wave

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import character  # noqa: E402  (puts the other tool folders on sys.path)

import bpy  # noqa: E402
import numpy as np  # noqa: E402
from mathutils import Vector  # noqa: E402

import blend as B  # noqa: E402
import blender_rig  # noqa: E402
import face_anim as FA  # noqa: E402
import library  # noqa: E402
import quat as Q  # noqa: E402
import retarget as RT  # noqa: E402

T0 = time.time()
faulthandler.enable()
STAGES = {}


def stage(name):
    now = time.time()
    if STAGES.get('_last'): STAGES[STAGES['_last'][0]] = round(now - STAGES['_last'][1], 2)
    STAGES['_last'] = (name, now)
    print('STAGE', name, flush=True)


def device():
    cpu = ''
    try:
        cpu = next(l.split(':', 1)[1].strip() for l in open('/proc/cpuinfo') if l.startswith('model name'))
        ram = int(next(l.split()[1] for l in open('/proc/meminfo') if l.startswith('MemTotal'))) / 1048576
    except (OSError, StopIteration):
        ram = None
    return {'cpu': cpu or platform.processor(), 'threads': os.cpu_count(), 'ram_gb': round(ram, 1) if ram else None,
            'gpu': 'none (nvidia-smi absent; Cycles on CPU)', 'blender': bpy.app.version_string}


def shard_range(n, k, N):
    """Frames of the k-th (0-based) of N contiguous, near-equal ranges over n frames."""
    if not 0 <= k < N: raise ValueError(f'shard {k}/{N}')
    a, b = (n * k) // N, (n * (k + 1)) // N
    return list(range(a, b))


def rig_check(sc, arm, H, n, fps):
    """Plays the action on the armature in Blender and reads the evaluated foot and ball heads back each frame:
    max distance from the numpy timeline (the rig plays exactly the planned motion) and the foot-contact slip measured
    on what Blender evaluated (tools/avatar_motion/retarget.contact_slip)."""
    import retarget as RT_
    pb = {b: arm.pose.bones[b] for b in ('foot_l', 'ball_l', 'foot_r', 'ball_r', 'pelvis', 'head')}
    got = {b: np.zeros((n, 3)) for b in pb}
    for f in range(n):
        sc.frame_set(f)
        for b, p in pb.items(): got[b][f] = np.asarray(arm.matrix_world @ p.head)
    dev = max(float(np.linalg.norm(got[b] - H[b], axis=1).max()) for b in pb)
    return {'frames': n, 'max_deviation_from_plan_mm': round(1000 * dev, 2),
            'contact': {s: RT_.contact_slip(got[f'foot_{s}'], got[f'ball_{s}'], fps) for s in 'lr'},
            'pelvis_path_m': round(float(np.linalg.norm(np.diff(got['pelvis'][:, :2], axis=0), axis=1).sum()), 2)}


def args():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', required=True); ap.add_argument('--line-wav', required=True); ap.add_argument('--rhubarb', required=True)
    ap.add_argument('--res', default='1280x720'); ap.add_argument('--samples', type=int, default=8); ap.add_argument('--close-samples', type=int, default=12)
    ap.add_argument('--frames', default=''); ap.add_argument('--no-render', action='store_true'); ap.add_argument('--fps', type=int, default=24)
    ap.add_argument('--speech-gap', type=float, default=2.2, help='seconds after she sits before she speaks')
    ap.add_argument('--fit', default=os.environ.get('FIT', ''))
    ap.add_argument('--guides', type=int, default=420); ap.add_argument('--children', type=int, default=36)
    ap.add_argument('--threads', type=int, default=0)
    ap.add_argument('--shard', default='', help='K/N: render only the K-th of N contiguous frame ranges (CI matrix)')
    ap.add_argument('--save-blend', default='', help='also save the set-up scene (debugging and timing experiments)')
    return ap.parse_args(argv)


def smooth(x, k):
    if k <= 1: return x
    pad = np.pad(x, [(k, k)] + [(0, 0)] * (x.ndim - 1), mode='edge')
    ker = np.ones(2 * k + 1) / (2 * k + 1)
    return np.stack([np.convolve(pad[:, i], ker, 'valid') for i in range(x.shape[1])], 1) if x.ndim > 1 else np.convolve(pad, ker, 'valid')


def main():
    a = args()
    os.makedirs(os.path.join(a.out, 'frames'), exist_ok=True)
    FPS = a.fps
    receipt = {'device': device(), 'identity': 'che', 'style': 'photoreal', 'fps': FPS}
    # ── character through the real pipeline ──────────────────────────────────────────────────────────────────────
    stage('model')
    env = character.identity_env('che', fit=a.fit or None)
    os.environ.update(env)
    import mpfb_body
    import realism
    import scene as S
    realism.capture(mpfb_body)
    c = character.build(env)
    c.update({'brow_n': env.get('BROW_N', 1000), 'brow_w': env.get('BROW_W', 1.8), 'lash_len': env.get('LASH_LEN', 0.55)})
    arm, body, sc = c['arm'], c['body'], c['scene']
    bones0 = list(c['bones'])
    receipt['mouth'] = realism.add_mouth(c)
    # ── motion: licensed clips, blended, foot-locked, placed ─────────────────────────────────────────────────────
    stage('motion')
    rig = blender_rig.rig_from_armature(arm)
    m = library.manifest()
    clip_reports = {}
    # every library clip goes into the interactive GLB as its own animation (30 fps, foot-locked)
    for name in m['clips']:
        cl, rep = library.build(name, rig, fps=30)
        blender_rig.write_clip(arm, rig, cl)
        clip_reports[name] = rep
    receipt['clips'] = clip_reports
    import timeline as TL
    tl = TL.build(rig, fps=FPS, m=m)
    seq, seated_f, fade = tl.clip, tl.seated_f, tl.fade
    walk_s = tl.walk_seconds
    n = seq.frames
    t = np.arange(n) / FPS
    receipt['timeline'] = tl.report
    G, H, T = RT.pose_world(rig, {k: Q.to_matrix(v) for k, v in seq.q.items()}, seq.root_loc(rig))
    hips, seat_top = tl.hips, tl.seat_top
    receipt['seat'] = {'hip_height_m': round(float(hips[2]), 3), 'seat_top_m': round(seat_top, 3)}
    # ── camera plan (needs head positions) ───────────────────────────────────────────────────────────────────────
    stage('camera')
    T_SPEECH = walk_s + a.speech_gap
    shots = [('wide', 0.0, walk_s + 0.2), ('medium', walk_s + 0.2, T_SPEECH - 0.2),
             ('closeup', T_SPEECH - 0.2, T_SPEECH + 4.8), ('skeleton', T_SPEECH + 4.8, n / FPS + 1)]
    hx = float(hips[0]); hy = float(hips[1]); Rh = rig.rest['head']
    eye_mid_rest = (np.asarray(c['eyes'][0].location) + np.asarray(c['eyes'][1].location)) / 2

    def plan(H, G):
        head = H['head']; pel = H['pelvis']; pel_s = smooth(pel, int(0.5 * FPS))
        cam_loc = np.zeros((n, 3)); cam_tgt = np.zeros((n, 3)); lens = np.zeros(n); fstop = np.zeros(n); kind = []
        el, er = np.asarray(c['eyes'][0].location), np.asarray(c['eyes'][1].location)
        eye_mid_rest = (el + er) / 2
        eyes_w = np.array([H['head'][i] + (G['head'][i] @ Rh.T) @ (eye_mid_rest - rig.head['head']) for i in range(n)])
        eyes_s = smooth(eyes_w, 4)
        for i in range(n):
            s = next(k for k, s0, s1 in shots if s0 <= t[i] < s1)
            kind.append(s)
            if s == 'wide':
                cam_loc[i] = (hx + 1.8, hy - 3.5, 1.45); cam_tgt[i] = pel_s[i] + (0, 0, 0.2); lens[i] = 30; fstop[i] = 4.0
            elif s == 'medium':
                u = (t[i] - shots[1][1]) / (shots[1][2] - shots[1][1])
                cam_loc[i] = (hx + 0.85 - 0.15 * u, hy - 2.0 + 0.15 * u, 1.2); cam_tgt[i] = (eyes_s[i] + pel[i]) / 2 + (0, 0, 0.1); lens[i] = 45; fstop[i] = 2.8
            elif s == 'closeup':
                u = (t[i] - shots[2][1]) / (shots[2][2] - shots[2][1])
                cam_loc[i] = (hx + 0.38 - 0.06 * u, hy - 1.45 + 0.08 * u, float(eyes_s[i][2]) + 0.01); cam_tgt[i] = eyes_s[i] + (0, 0, -0.06); lens[i] = 50; fstop[i] = 2.8
            else:
                cam_loc[i] = (hx + 1.4, hy - 2.6, 1.3); cam_tgt[i] = pel[i] + (0, 0, 0.25); lens[i] = 35; fstop[i] = 5.6
        for s in ('closeup', 'medium'):
            idx = [i for i in range(n) if kind[i] == s]
            if idx: cam_tgt[idx] = smooth(cam_tgt[idx], 3)
        return cam_loc, cam_tgt, lens, fstop, kind
    cam_loc, cam_tgt, lens, fstop, kind = plan(H, G)
    # ── head turns toward the camera while she talks (additive, layered over the mocap) ─────────────────────────
    w_look = np.clip((t - (walk_s + 0.3)) / 0.8, 0, 1)
    Rn = rig.rest['neck_01']
    yaw_c, pit_c = np.zeros(n), np.zeros(n)
    for i in range(n):
        Gh = G['head'][i] @ Rh.T
        d = Gh.T @ (cam_loc[i] - H['head'][i])
        yaw_c[i] = math.degrees(math.atan2(d[0], -d[1])); pit_c[i] = math.degrees(math.atan2(d[2] - 0.08, -d[1]))
    yaw_add = np.clip(0.65 * yaw_c, -25, 25) * w_look; pit_add = np.clip(0.75 * pit_c, -8, 26) * w_look
    yaw_add = smooth(yaw_add, 6); pit_add = smooth(pit_add, 6)
    for b, R, share in (('neck_01', Rn, 0.45), ('head', Rh, 0.55)):
        seq = B.additive(seq, b, R.T @ np.array([0, 0, 1.0]), share * yaw_add)
        seq = B.additive(seq, b, R.T @ np.array([1.0, 0, 0]), -share * pit_add)
    G, H, T = RT.pose_world(rig, {k: Q.to_matrix(v) for k, v in seq.q.items()}, seq.root_loc(rig))
    # less head roll while she talks to the camera (the mocap actor tilts her head a lot), then re-plan the camera
    def roll_of(G):
        x = np.einsum('fij,j->fi', G['head'] @ Rh.T, np.array([1.0, 0, 0]))
        return np.degrees(np.arctan2(x[:, 2], np.hypot(x[:, 0], x[:, 1])))
    r0 = roll_of(G); fix = -0.7 * smooth(r0, 6) * w_look
    axis = Rh.T @ np.array([0, -1.0, 0])
    trial = B.additive(seq, 'head', axis, fix)
    G2, _, _ = RT.pose_world(rig, {k: Q.to_matrix(v) for k, v in trial.q.items()}, trial.root_loc(rig))
    if np.abs(roll_of(G2) * w_look).mean() > np.abs(r0 * w_look).mean(): trial = B.additive(seq, 'head', axis, -fix)
    seq = trial
    G, H, T = RT.pose_world(rig, {k: Q.to_matrix(v) for k, v in seq.q.items()}, seq.root_loc(rig))
    receipt['head_roll_deg'] = {'before_mean': round(float(np.abs(r0 * w_look).sum() / max(1, w_look.sum())), 2),
                                'after_mean': round(float(np.abs(roll_of(G) * w_look).sum() / max(1, w_look.sum())), 2)}
    cam_loc, cam_tgt, lens, fstop, kind = plan(H, G)
    # ── face: visemes, blinks, gaze with saccades, expressions ──────────────────────────────────────────────────
    stage('face')
    cues = FA.load_rhubarb(a.rhubarb)
    vis = FA.visemes(cues, FPS, n, offset_s=T_SPEECH)
    sp_end = T_SPEECH + cues[-1][1]
    yaw_e, pit_e = np.zeros(n), np.zeros(n)
    for i in range(n):
        Gh = G['head'][i] @ Rh.T
        e_w = H['head'][i] + Gh @ (eye_mid_rest - rig.head['head'])
        if t[i] > walk_s - 0.5 or 4.6 < t[i] < 5.2:   # at the camera (and one glance while turning)
            d = Gh.T @ (cam_loc[i] - e_w)
            yaw_e[i] = math.degrees(math.atan2(d[0], -d[1])); pit_e[i] = math.degrees(math.atan2(d[2], -d[1]))
        else:
            yaw_e[i], pit_e[i] = 0.0, -9.0   # where she walks: ahead and a little down
    sy_, sp_, big = FA.gaze(n, FPS, seed=11, targets=[(0.0, (0.0, 0.0))], fix_s=(0.4, 1.4))
    talking = (t > T_SPEECH) & (t < sp_end)
    yaw_e = yaw_e + np.where(talking, 0.4, 1.0) * sy_ * 0.6; pit_e = pit_e + np.where(talking, 0.4, 1.0) * sp_ * 0.6
    yaw_e = np.clip(yaw_e, -22, 22); pit_e = np.clip(pit_e, -18, 10)
    looks = FA.look_keys(yaw_e, pit_e); lids = FA.lid_follow(pit_e)
    bl, btimes = FA.blinks(n, FPS, seed=7, forced=[walk_s - 0.6, T_SPEECH - 0.5] + list(big))
    expr = FA.expression(n, FPS, [(0.0, {'smile': 0.04, 'brow_inner_up': 0.0}), (walk_s - 0.2, {'smile': 0.22}),
                                  (T_SPEECH + 0.1, {'smile': 0.12}), (T_SPEECH + 3.3, {'smile': 0.42}),
                                  (sp_end + 0.2, {'smile': 0.3})], blend_s=0.45)
    micro = FA.combine(FA.pulse(n, FPS, T_SPEECH - 0.45, 'mouth_press', 0.3, 0.08, 0.1, 0.15),
                       FA.pulse(n, FPS, T_SPEECH + 0.95, 'brows_up', 0.45, 0.1, 0.25, 0.35),
                       FA.pulse(n, FPS, T_SPEECH + 2.35, 'brow_inner_up', 0.3, 0.1, 0.3, 0.4),
                       FA.pulse(n, FPS, T_SPEECH + 3.4, 'eye_squint', 0.18, 0.15, 0.6, 0.5))
    face = FA.combine(vis, expr, micro, lids, {'blink_l': bl, 'blink_r': bl})
    with wave.open(a.line_wav) as w:
        sr = w.getframerate(); x = np.frombuffer(w.readframes(w.getnframes()), np.int16) / 32768.0
    lag, corr = FA.lip_sync_lag(FA.mouth_opening(vis), x, sr, FPS, offset_s=T_SPEECH)
    receipt['face'] = {'visemes': 'Rhubarb Lip Sync 1.13.0 cues (' + str(len(cues)) + ') -> unit blends with coarticulation',
                       'lip_sync_lag_ms': lag, 'lip_sync_corr': corr, 'blinks': len(btimes), 'big_saccades': len(big),
                       'speech_s': [round(T_SPEECH, 2), round(sp_end, 2)]}
    # ── write the animation ───────────────────────────────────────────────────────────────────────────────────────
    act = blender_rig.write_clip(arm, rig, seq, name='cinematic_sample', track=False)
    arm.animation_data.action = act
    keys = body.data.shape_keys
    blender_rig.write_shape_keys(keys, 'cinematic_face', {k: v for k, v in face.items() if k in keys.key_blocks}, track=False)
    keys.animation_data.action = bpy.data.actions['cinematic_face']
    for e in c['eyes']:
        blender_rig.write_shape_keys(e.data.shape_keys, 'eyes_' + e.name, looks, track=False)
        e.data.shape_keys.animation_data.action = bpy.data.actions['eyes_' + e.name]
    for o in c.get('mouth', []):
        k2 = o.data.shape_keys
        cur = {k: v for k, v in face.items() if k in k2.key_blocks}
        if cur:
            blender_rig.write_shape_keys(k2, 'mouth_' + o.name, cur, track=False)
            k2.animation_data.action = bpy.data.actions['mouth_' + o.name]
    # ── interactive GLB (before the cinematic-only layers) ──────────────────────────────────────────────────────
    # ── proof that the rig itself performs the motion: read the evaluated pose back from Blender every frame ────
    stage('rig_check')
    receipt['rig_check'] = rig_check(sc, arm, H, n, FPS)
    print('RIG_CHECK', json.dumps(receipt['rig_check']), flush=True)
    stage('interactive_export')
    import interactive
    # a face track for the original talk clip already exists; the GLB carries every NLA clip
    holders = [arm] + [o.data.shape_keys for o in sc.objects if o.type == 'MESH' and o.data.shape_keys]
    saved_actions = [(h, h.animation_data.action) for h in holders if h.animation_data]
    for h, _ in saved_actions: h.animation_data.action = None
    irec = interactive.export(os.path.join(a.out, 'che_interactive.glb'), c)
    for h, act_ in saved_actions: h.animation_data.action = act_
    json.dump(irec, open(os.path.join(a.out, 'interactive.json'), 'w'), indent=1)
    receipt['interactive'] = {k: irec[k] for k in ('bytes', 'vertices', 'triangles', 'bones', 'budget_ok')}
    receipt['interactive']['animations'] = len(irec['animations']); receipt['interactive']['morph_targets'] = len(irec['morph_targets'])
    character.check_skeleton(arm, bones0)
    # ── cinematic layers and the set ─────────────────────────────────────────────────────────────────────────────
    stage('cinematic_layers')
    receipt['realism'] = realism.apply_all(c, guides=a.guides, children=a.children)
    props = S.office(seat=(float(hips[0]), float(hips[1]) + 0.03), desk_side=-1.0, seat_top=seat_top)
    S.lights(seat=(float(hips[0]), float(hips[1])), desk_side=-1.0)
    cam = S.camera()
    shake = S.Handheld(seed=5)
    overlay = S.skeleton_overlay(arm)
    receipt['shots'] = [{'name': k, 'start_s': round(s0, 2), 'end_s': round(min(s1, n / FPS), 2)} for k, s0, s1 in shots]
    # ── render ───────────────────────────────────────────────────────────────────────────────────────────────────
    stage('render')
    W, Hh = (int(v) for v in a.res.split('x'))
    sc.render.resolution_x, sc.render.resolution_y = W, Hh; sc.render.resolution_percentage = 100
    sc.render.fps = FPS; sc.render.engine = 'CYCLES'
    cy = sc.cycles; cy.device = 'CPU'
    cy.use_adaptive_sampling = True; cy.adaptive_threshold = 0.04; cy.use_denoising = True; cy.denoiser = 'OPENIMAGEDENOISE'
    cy.max_bounces = 5; cy.diffuse_bounces = 2; cy.glossy_bounces = 2; cy.transmission_bounces = 2; cy.transparent_max_bounces = 8
    cy.caustics_reflective = False; cy.caustics_refractive = False; cy.sample_clamp_indirect = 5.0
    sc.render.use_persistent_data = True
    if a.threads: sc.render.threads_mode = 'FIXED'; sc.render.threads = a.threads
    try: sc.cycles_curves.shape = 'RIBBONS'
    except (AttributeError, TypeError): pass
    sc.view_settings.view_transform = 'AgX'; sc.view_settings.look = 'AgX - Medium High Contrast'
    sc.render.film_transparent = False
    sc.render.image_settings.file_format = 'PNG'
    f0, f1 = 0, n - 1
    todo = list(range(n))
    if a.frames and ',' in a.frames: todo = [int(v) for v in a.frames.split(',') if int(v) < n]; f0, f1 = todo[0], todo[-1]
    elif a.frames: f0, f1 = (int(v) for v in a.frames.split('-')); todo = list(range(f0, min(f1, n - 1) + 1))
    if a.shard:
        k, N = (int(v) for v in a.shard.split('/'))
        todo = shard_range(n, k, N); f0, f1 = todo[0], todo[-1]
    receipt['render'] = {'res': a.res, 'samples': a.samples, 'close_samples': a.close_samples, 'engine': 'Cycles CPU', 'frames': [f0, f1],
                         'denoiser': 'OpenImageDenoise', 'adaptive_threshold': 0.04,
                         'hair': f'{a.guides} guides x {a.children} children in close-ups; every 4th strand (2x radius) in wider shots'}
    frame_times = {}
    char_objs = [o for o in sc.objects if o.type == 'MESH' and o.parent == arm and not o.name.startswith(('ov_', 'oj_'))]
    ghost_on = False
    json.dump(receipt, open(os.path.join(a.out, 'receipt.json'), 'w'), indent=1)
    if a.save_blend: bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(a.save_blend), copy=True)
    if not a.no_render:
        for f in todo:
            k = kind[f]
            want_ghost = k == 'skeleton'
            if want_ghost != ghost_on:
                S.ghost(char_objs, want_ghost)
                for o in overlay: o.hide_render = not want_ghost
                for nm in ('Brow_strands', 'Lashes_strands'):
                    if nm in sc.objects: sc.objects[nm].hide_render = want_ghost
                ghost_on = want_ghost
            full = k == 'closeup'
            if 'HeadHair' in sc.objects:
                sc.objects['HeadHair'].hide_render = not full or want_ghost
                sc.objects['HeadHairLite'].hide_render = full or want_ghost
            cy.samples = a.close_samples if k == 'closeup' else a.samples
            cam.data.lens = float(lens[f]); cam.data.dof.aperture_fstop = float(fstop[f])
            sc.frame_set(f)
            S.aim(cam, cam_loc[f], cam_tgt[f], shake, t=f / FPS)
            if c.get('hair_follow'): c['hair_follow'].update()
            sc.render.filepath = os.path.join(a.out, 'frames', f'{f:04d}.png')
            ts = time.time(); bpy.ops.render.render(write_still=True); dt = time.time() - ts
            frame_times[f] = round(dt, 2)
            print('FRAME', f, k, f'{dt:.1f}s', flush=True)
            if f % 10 == 0:
                receipt['frame_seconds'] = frame_times
                json.dump(receipt, open(os.path.join(a.out, 'receipt.json'), 'w'), indent=1)
    stage('done')
    STAGES.pop('_last', None)
    receipt['stage_seconds'] = STAGES; receipt['frame_seconds'] = frame_times
    by = {}
    for f, dt in frame_times.items(): by.setdefault(kind[f], []).append(dt)
    receipt['render_seconds_by_shot'] = {k: {'frames': len(v), 'mean_s': round(sum(v) / len(v), 2), 'total_s': round(sum(v), 1)} for k, v in by.items()}
    receipt['total_seconds'] = round(time.time() - T0, 1)
    receipt['peak_rss_gb'] = round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1048576, 2)
    json.dump(receipt, open(os.path.join(a.out, 'receipt.json'), 'w'), indent=1)
    print('RECEIPT', os.path.join(a.out, 'receipt.json'), flush=True)


if __name__ == '__main__':
    main()

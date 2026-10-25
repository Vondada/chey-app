"""Build one CHE character in the current Blender session through the real pipeline (tools/avatar_body/mpfb_body.py:
identity preset -> MPFB2 body, 53-bone game_engine skeleton, clothing, hair, the five original clips), plus the
realism layers from this lane: expression-unit shape keys (tools/avatar_facial/expressions.py), eye look keys and the
licensed mocap clips (tools/avatar_motion). The skeleton is never changed: bone names and count are checked.
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
TOOLS = os.path.dirname(HERE)
for p in (os.path.join(TOOLS, 'avatar_body'), os.path.join(TOOLS, 'avatar_face'), os.path.join(TOOLS, 'avatar_motion'),
          os.path.join(TOOLS, 'avatar_facial')):
    if p not in sys.path: sys.path.insert(0, p)


def identity_env(identity='che', style='photoreal', fit=None):
    """The environment mpfb_body.py reads for one identity preset (tools/avatar_face/identity.py)."""
    import identity as I
    s = I.to_settings(I.load()[identity], style)
    if fit: s['FIT'] = fit
    return s


def build(env, extra_units=True):
    """Builds the character from `env` (os.environ is updated with it). Returns a dict with scene, armature, body,
    eyes, meshes, info, clips (original names) and the bone list."""
    os.environ.update({k: str(v) for k, v in env.items()})
    import mpfb_body
    import expressions
    if extra_units: expressions.install(mpfb_body)
    sc, arm, meshes, info = mpfb_body.build()
    clips = mpfb_body.animate(sc, arm, meshes[0])
    eyes = [o for o in meshes if o.name.startswith('Eye_')]
    expressions.add_eye_look_keys(eyes)
    bones = [b.name for b in arm.data.bones]
    return {'scene': sc, 'arm': arm, 'body': meshes[0], 'eyes': eyes, 'meshes': meshes, 'info': info, 'clips': clips,
            'bones': bones, 'morphs': list(mpfb_body.MORPHS), 'mpfb_body': mpfb_body}


def check_skeleton(arm, expected):
    names = [b.name for b in arm.data.bones]
    if names != list(expected):
        raise RuntimeError(f'skeleton changed: {len(names)} bones vs {len(expected)} expected')
    return len(names)


def print_json(tag, obj):
    print(tag, json.dumps(obj, separators=(',', ':')), flush=True)

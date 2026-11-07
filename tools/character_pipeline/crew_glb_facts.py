"""What a crew GLB holds, read from the file itself with the standard library (no glTF package needed).

    python3 tools/character_pipeline/crew_glb_facts.py assets/characters/crew/nova.glb

Prints bones, clips, morph target names per mesh, triangle count and size. tools/test_crew_glbs.py uses the same
reader to hold every crew model to the contract below.
"""
import json
import struct
import sys
from pathlib import Path

CREW = ("che", "nova", "atlas", "mira", "knox", "sage", "lyra", "iris", "orion", "vale")
BONES = 31
# The original eleven clips, then the Stage 4 clips (2026-11-06).
CLIPS = ("idle", "walk", "run", "wave", "sit", "stand", "talk", "think", "celebrate", "nod", "shake",
         "dance", "happy", "sad", "surprised", "angry", "point", "clap")
VISEMES = ("viseme_rest", "viseme_A", "viseme_E", "viseme_O", "viseme_U", "viseme_MBP", "viseme_FV")
BLINK = "blink"


def read_glb(path):
    data = Path(path).read_bytes()
    magic, version, length = struct.unpack_from("<4sII", data, 0)
    if magic != b"glTF" or version != 2 or length != len(data):
        raise ValueError(f"{path} is not a GLB v2 file")
    size, kind = struct.unpack_from("<I4s", data, 12)
    if kind != b"JSON":
        raise ValueError(f"{path}: the first chunk is not JSON")
    return json.loads(data[20:20 + size]), len(data)


def facts(path):
    gltf, size = read_glb(path)
    morphs, weights = {}, {}
    tris = 0
    for mesh in gltf.get("meshes", []):
        names = (mesh.get("extras") or {}).get("targetNames") or []
        if names:
            morphs[mesh.get("name", "")] = list(names)
            weights[mesh.get("name", "")] = list(mesh.get("weights") or [0] * len(names))
        for prim in mesh.get("primitives", []):
            if "indices" in prim:
                tris += gltf["accessors"][prim["indices"]]["count"] // 3
    skins = gltf.get("skins", [])
    return {
        "bytes": size,
        "bones": len(skins[0]["joints"]) if skins else 0,
        "clips": [a.get("name", "") for a in gltf.get("animations", [])],
        "morphs": morphs,
        "default_weights": weights,
        "triangles": tris,
    }


if __name__ == "__main__":
    for p in sys.argv[1:]:
        f = facts(p)
        print(p, json.dumps(f, indent=1))

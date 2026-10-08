# CHE character pipeline (prototype)

`build_che_character.py` builds CHE's rigged, skinned character with Blender's Python
module and exports it as a GLB with 11 animation clips.

Run it:

```
pip install bpy==5.0.1          # Python 3.11 only
python build_che_character.py -- ../../assets/characters/che_proto.glb
```

What is in the GLB: 31 bones, skinned body, jacket and trousers (automatic weights),
rigid eyes, hair, shoes and fingers, and clips idle, walk, run, wave, sit, stand, talk,
think, celebrate, nod, shake head.

Viewer: `assets/characters/che_viewer.html` (serve the folder over http; file:// blocks
module imports). It uses three.js r160 (`vendor/`).

Known limits (this is a prototype, not final art):
- Shapes are metaball-built and not hand-sculpted. Hair, hands and face read as rough.
- No IK, no foot placement, no lip-sync, no facial expression rig.
- The character is not yet mapped to the other agents or the rooms.

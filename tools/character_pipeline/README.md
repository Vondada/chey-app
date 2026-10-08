# CHE character pipeline

`build_che_character.py` builds CHE and her seven office agents as rigged chibi characters
with Blender's Python module and exports each as a GLB with 11 animation clips.

Run it:

```
pip install bpy==5.0.1          # Python 3.11 only
python build_che_character.py -- ../../assets/characters/crew/ all       # all eight
python build_che_character.py -- ../../assets/characters/crew/che.glb che  # one
```

The looks follow the owner's reference images in `assets/characters/reference/`
(ref-02 agents list, ref-04 and ref-05 office concepts): big round head, large glossy
eyes with lashes, small smile, blush, full hair, short body, jackets and sneakers.

| id | name | role (lib/che_ui/che_brain.dart) | look |
|---|---|---|---|
| che | CHE | Office Boss | long wavy dark hair, teal open jacket, black top, gold hoops |
| nova | Nova | Product / listings | lavender hair in a high bun, lilac hoodie |
| atlas | Atlas | Research / sourcing | short curly hair, orange jacket, white sneakers |
| mira | Mira | Support copy / translation | brown low bun, round glasses, cream sweater |
| knox | Knox | Engineering | big curly hair, blue headphones, denim jacket |
| sage | Sage | Finance (read-only) | curly hair, glasses, beard, olive jacket |
| lyra | Lyra | Content / social | shoulder-length wavy hair, mustard jacket |
| iris | Iris | Ad Studio | blond hair, black beanie, blue eyes, denim jacket |

What is in each GLB: 31 bones (same rig and bone names for everyone), skinned body, top
and trousers (automatic weights); the head is an exact ellipsoid mesh so face parts sit
on it; eyes use a painted texture; hair, brows, lashes, mouth, shoes, fingers and
accessories are rigid. Colours are vertex colours. Clips: idle, walk, run, wave, sit,
stand, talk, think, celebrate, nod, shake. Blink is built into the looping clips.

Viewer: `assets/characters/che_viewer.html` (serve the folder over http; file:// blocks
module imports). CHE walks with the pad; the seven agents stand in the office playing
their own clip; choosing an agent (button or tap) says their name and role and they wave.

Known limits:
- About 60k to 80k triangles and 2.3 to 3 MB per character; 8 characters is about 20 MB.
  Needs mesh compression or a lower-poly build before shipping in the app.
- No facial blend shapes (mouth does not move when talking), no IK or foot placement.
- Hands are small mitten shapes; hair is shaped shells and curls, not strands.
- Not yet embedded in the Flutter app; not measured on an iPhone.

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

The app embeds `assets/characters/app/index.html` through
`lib/rooms/che_characters_room.dart`; its scripts and eight GLBs are bundled in
`pubspec.yaml`. The separate `assets/characters/che_viewer.html` is a development
viewer (serve over HTTP; file:// blocks module imports). The animations are a
character demonstration, not evidence of live agent work.

Before packaging an export, run these dependency-free checks from the repo root:

```
node tools/character_pipeline/validate_assets.mjs
node --test tools/character_pipeline/assets.test.mjs
```

CI runs the same contract: binary header/chunk bounds, embedded buffers/textures,
skeleton and animation references, all eleven required clips, Flutter asset
registration and locally available scene scripts. The command reports actual byte
and triangle counts. It is not a full glTF validator or an iPhone rendering test.

Known limits:
- About 60k to 80k triangles and 2.3 to 3 MB per character; 8 characters is about 20 MB.
  Needs mesh compression or a lower-poly build before shipping in the app.
- No facial blend shapes (mouth does not move when talking), no IK or foot placement.
- Hands are small mitten shapes; hair is shaped shells and curls, not strands.
- Embedded in Flutter; rendering performance has not been measured on an iPhone.
- The app currently announces ready before the page acknowledges asynchronous GLB
  parsing, and the character scene does not suspend its animation loop when hidden.
  These runtime gaps still require a scene/Flutter bridge fix and device validation.

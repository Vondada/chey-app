# CHE character pipeline

`build_che_character.py` builds CHE and her nine office agents (Orion and Vale since 2026-11-06) as rigged chibi
characters with Blender's Python module and exports each as a GLB with 18 animation clips, viseme mouth shapes and
blink as glTF morph targets. Add `usdz` to also write a USDZ for iPhone AR; `glb_to_usdz.py` converts any CHE GLB
and re-opens the file to check it. `crew_glb_facts.py` prints what a GLB holds; `crew_contact_sheet.py` renders review
stills of every clip and face shape (Cycles on CPU).

Run it:

```
pip install bpy==5.0.1          # Python 3.11 only
python build_che_character.py -- ../../assets/characters/crew/ all       # all ten
python build_che_character.py -- ../../assets/characters/crew/ all usdz  # and a .usdz for each
python build_che_character.py -- ../../assets/characters/crew/che.glb che  # one
```

The looks follow the owner's CHE WORLD character sheets (2026-11-06), written down in
`server/cloudflare/film_cast.js` `CREW_LOOKS`: skin, hair, colours and outfits. The chibi proportions stay (big round
head, large glossy eyes, short body), so the crew read as the sheets' people in this style, not as the sheets' realistic
figures.

| id | name | look (CHE WORLD) |
|---|---|---|
| che | CHE | long voluminous black wavy hair, gold hoops, white blazer and trousers over a black top, gold belt |
| nova | Nova | sleek black high ponytail, black track jacket with white stripes, white top |
| atlas | Atlas | short black curly hair, full beard, black hoodie |
| mira | Mira | platinum blonde high bun, gold hoops, black outfit |
| knox | Knox | dark sunglasses, short hair, beard, black tactical jacket with patches |
| sage | Sage | long dark wavy hair, clear glasses, black turtleneck under a black jacket |
| lyra | Lyra | long wavy crimson-red hair, headphones around her neck, black outfit |
| iris | Iris | long silver-white high ponytail, hoop earrings, black outfit |
| orion | Orion | dark hair swept back, short beard, black leather jacket |
| vale | Vale | long black hair with blunt bangs, black leather jacket over a white top |

What is in each GLB: 31 bones (same rig and bone names for everyone), skinned body, top
and trousers (automatic weights); the head is an exact ellipsoid mesh so face parts sit
on it; eyes use a painted texture; hair, brows, lashes, mouth, shoes, fingers and
accessories are rigid. Colours are vertex colours. Clips: idle, walk, run, wave, sit,
stand, talk, think, celebrate, nod, shake, dance, happy, sad, surprised, angry, point, clap
(surprised and point play once). Blink is built into the looping clips.

Face shapes (glTF morph targets, all at weight 0 by default): the `mouth` mesh has `viseme_rest`, `viseme_A`,
`viseme_E`, `viseme_O`, `viseme_U`, `viseme_MBP` and `viseme_FV`; each eye, its glints and its lash line have `blink`.
A renderer or the app sets the weights for lip sync; nothing in the clips animates them.

The app embeds `assets/characters/app/index.html` through
`lib/rooms/che_characters_room.dart`; its scripts and the crew GLBs are bundled in
`pubspec.yaml`. The separate `assets/characters/che_viewer.html` is a development
viewer (serve over HTTP; file:// blocks module imports). In the app, each character plays
the clip for its agent's real runtime status (`lib/rooms/che_crew_states.dart`, sent with
`CHE.setStates`); everyone starts idle, and a model with no live agent stays idle.

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
- About 58k to 70k triangles and 2.5 to 2.9 MB per character; 10 characters is about 26.6 MB.
  Needs mesh compression or a lower-poly build before shipping in the app.
- Face shapes cover the mouth and blink only (no brows, cheeks or emotion shapes); emotion clips are body
  language. No IK or foot placement.
- Hands are small mitten shapes; hair is shaped shells and curls, not strands.
- Embedded in Flutter; rendering performance has not been measured on an iPhone.
- The page reports ready to the app only after all eight GLBs parse (`CheBridge`), and its
  render loop stops while the page is hidden or the app is in the background.
  These runtime gaps still require a scene/Flutter bridge fix and device validation.

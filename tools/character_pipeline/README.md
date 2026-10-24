# CHE character pipeline

`build_che_character.py` builds CHE and her seven office agents as rigged semi-realistic game characters
with Blender's Python module and exports each as a GLB with 12 animation clips and facial shape keys.

Run it:

```
pip install bpy==5.0.1          # Python 3.11 only
python build_che_character.py -- ../../assets/characters/crew/ all       # all eight
python build_che_character.py -- ../../assets/characters/crew/che.glb che  # one
```

Version 2 (owner brief, 2026-10-24) replaces the chibi look (big round head) with semi-realistic
proportions: about seven and a half heads on a 1.12 unit figure, a lofted torso, real-scale eyes with lids,
brows, nose, ears and lips built into the skin. Identity comes from hair style and colour, eye colour, outfit,
glasses, beanie, headphones and beard, and from each face's scale values (`face=` in CHARACTERS).

| id | name | role (lib/che_ui/che_brain.dart) | look |
|---|---|---|---|
| che | CHE | Office Boss | long wavy dark hair, teal open jacket, gold hoops |
| nova | Nova | Product / listings | lavender hair in a high bun, lilac hoodie |
| atlas | Atlas | Research / sourcing | short curly hair, orange jacket, white sneakers |
| mira | Mira | Support copy / translation | brown low bun, round glasses, cream sweater |
| knox | Knox | Engineering | big curly hair, blue headphones, denim jacket |
| sage | Sage | Finance (read-only) | curly hair, glasses, beard, olive jacket |
| lyra | Lyra | Content / social | shoulder-length wavy hair, mustard jacket |
| iris | Iris | Ad Studio | blond hair, black beanie, blue eyes, denim jacket |

What is in each GLB:
- 31 bones (same rig and bone names for everyone): pelvis, spine, chest, neck, head, eye.L/R, shoulder,
  upper_arm, forearm, hand, five finger chains per hand, thigh, shin, foot.
- Skinned torso, legs, arms, neck, head and ears (automatic weights). Hair, brows, lashes, eyes, glints,
  nose, shoes, fingers and accessories are rigid to one bone.
- Shape keys on the skin: `blink`, `mouth_open`, `mouth_wide`, `mouth_round`. The app drives them for
  blinking and lip sync.
- 12 clips: idle, walk, run, wave, sit, stand, talk, think, celebrate, nod, shake, type (seated at a desk,
  typing). Every clip keys every bone each frame, so the app can add head and eye tracking on top.
- Colours are vertex colours (glTF COLOR_0); the export is GLB with morph targets.

The app embeds `assets/characters/app/index.html` through `lib/rooms/che_characters_room.dart`; its
scripts and eight GLBs are bundled in `pubspec.yaml`. The separate `assets/characters/che_viewer.html` is a
development viewer (serve over HTTP; file:// blocks module imports). In the app, each character plays the
clip for its agent's real runtime status (`lib/rooms/che_crew_states.dart`, sent with `CHE.setStates`);
"building" types at the desk, and everyone starts idle.

Preview a build without the app. These render with Cycles on the CPU (a few seconds per frame):

```
CHE_PREVIEW=/tmp/che.png CHE_PREVIEW_MODE=portrait CHE_PREVIEW_POSE=rest \
  python build_che_character.py -- /tmp/che.glb che
```

Before packaging an export, run these dependency-free checks from the repo root:

```
node tools/character_pipeline/validate_assets.mjs
node --test tools/character_pipeline/assets.test.mjs
```

CI runs the same contract: binary header/chunk bounds, embedded buffers/textures, skeleton and animation
references, all twelve required clips, the four required shape keys, a 40,000 triangle budget per character,
Flutter asset registration and locally available scene scripts. It is not a full glTF validator or an
iPhone rendering test.

Known limits (be honest about these in any report):
- The look is procedural. It is clearly better proportioned than the chibi build, but hair is shells and
  strands, skin is a single material, and the face is not sculpted by an artist. It does not yet meet a
  premium GTA-style standard. The next step is an artist-made or licensed base mesh.
- Lip sync is an approximation: the app opens the mouth while the character is in its talk clip. It is not
  phoneme-accurate, because the speech engine does not expose visemes.
- No IK or foot placement; feet are placed by the clip's root motion.
- Triangle budget: about 30k to 40k per character (8 characters is about 270k). Performance on an iPhone has
  not been measured on a device.
- The page reports ready to the app only after all eight GLBs parse (`CheBridge`), and its render loop stops
  while the page is hidden or the app is in the background.

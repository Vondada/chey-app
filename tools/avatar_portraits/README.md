# CHE avatar portraits (Blender Cycles, strand hair)

Renders CHE's Route-B model (`che.blend`, the rigged body with 21 face shape keys and 24 baked
clips) as portraits and full-body shots with real hair strands instead of the flat hair cards.

Status (2026-10-24): **semi-realistic, not photoreal.** Actual CPU renders; see the defect list below.
No production asset is changed; the blend file is not in this repository.

## Run

```
BLEND=/path/to/che.blend OUTDIR=out VIEWS=front,threequarter,side EXPRS=neutral,smile,talk,think \
SAMPLES=48 RES=640x800 python3 tools/avatar_portraits/portrait.py
FRAMING=body VIEWS=front,threequarter EXPRS=neutral RES=640x1000 python3 tools/avatar_portraits/portrait.py
```

`python3` must be the Blender Python (`bpy` 5.0.1 as a module). One 640x800 portrait at 48 samples
takes about one minute on 4 CPU cores (the full-body 640x1000 shots take longer); there is no GPU in
the build environment.

Env: `BLEND`, `OUTDIR`, `VIEWS` (front, threequarter, side), `EXPRS` (neutral, smile, talk, think),
`SAMPLES`, `RES` (WxH), `STRANDS` (strands per hair card, default 110), `FRAMING=body`,
`ROOTMAX` / `EARLYMAX` (metres: drop cards whose root, or fourth row, floats off the head),
`SKIPCARDS` (card ids to drop, default `141,142`), `DIAG=1` (card-id false-colour render).

## What it does

1. Applies the baked `idle_relaxed` clip at frame 12, so CHE stands naturally instead of in the rest T-pose.
2. Evaluates the posed hair-card mesh, splits it into its 192 card islands, and grows strands across each
   card between its two edges, with per-strand depth, clumping toward the tips and a small wave.
3. Builds a `bpy.data.hair_curves` object (about 20,700 strands, 0.18 mm root to 0.06 mm tip) with a
   Principled Hair BSDF (melanin 1.0, roughness 0.45, no coat) and hides the cards.
4. Three area lights (key, fill, rim) tracking a point just below the eyes; 85 mm portrait / 50 mm body.
5. Expression presets drive the Body and Lashes shape keys; one PNG per view x expression.

`card_probe.py` prints each card's distance to the head per row. `DIAG=1` renders every card in a
different flat colour so a stray clump in the picture maps back to a card id; that is how 141 and 142
were found. `contact_sheet.py` builds a labelled grid from any renders.

## Known defects

- Face: semi-realistic game character, not photoreal (no skin micro-detail, subsurface or pore maps).
- Eyebrows are a painted texture, not strands.
- Feet look wrong in full-body shots (mesh, not the pose).
- Hair is dense but has no flyaways or real clumping; parting is a straight line.
- No GPU: a 12-portrait batch takes about 15 minutes at 640x800.

# Realism references: what the owner's two videos show (inspected 2026-10-25)

The owner sent two iPhone screen recordings (Instagram, 1126x2436, 60 fps; 9.8 s and 3.4 s) as the realism and
natural-movement target. The videos are not stored in the repository (third-party content); these are the notes.

## What they are
- Both come from an account labelled by Instagram as **"AI-generated profile"** (a serialized drama). The footage is
  almost certainly made by a **video diffusion model** (Veo/Kling/Wan-class), not by a rigged 3D character rendered in
  a game engine or Blender. That matters: this look comes from generated pixels, not from a skeleton, so it is the
  target for CHE's *cinematic* path. A rig cannot reach it on its own, and no AI video will be used as proof that the
  rig performs a movement.
- Reference 1: drone highway shot → hospital room; a woman with voluminous curly red hair in a high bun, yellow
  zip hoodie over a pink top, jewelry; a man in a black hoodie with large chains; a city window. Medium close-ups,
  then a two-shot where she sits on a hospital bed holding a charger cable.
- Reference 2: warm, dim bedroom; close-up of hands holding a phone (a messages screen); a woman with a high curly bun
  looking down at a phone, a sleeping man in a grey hoodie on her lap.

## Qualities to match (checklist for every sample)
| Area | In the references | What CHE needs |
|---|---|---|
| Skin | Pores, specular sheen on lips, nose and forehead, uneven tone, no plastic look | Subsurface + detail normal + roughness variation; cinematic only |
| Eyes | Wet highlights, lashes, eye direction changes (eye roll, glance up), lids that track the gaze | Cornea/wet layer, lashes, saccades, look-at, blink with lid follow |
| Hair | Individual curls, flyaways, baby hairs/edges, volume | Curve strands for cinematic; cards for interactive |
| Expression | Micro-expressions: lip purse, brow raise, skeptical look, slow blink | Expression shape keys/face poses blended over time, not only a jaw open |
| Body | Weight on one hip, settling onto the bed, shoulder shifts, breathing | Mocap clips with blending, weight shifts, idle breathing |
| Hands | Holding a cable and a phone, finger detail, contact | Finger poses, IK to props; the hardest part for a rig |
| Cloth | Hoodie folds, drape over the lap, sleeves bunching | Cloth sim (cinematic) or corrective shape keys (interactive) |
| Camera/light | Handheld micro-shake, shallow depth of field, warm practical light, window light | Camera shake, DOF, HDRI + practical lights, film grain |
| Identity | Same faces across shots | Same CHE identity preset; for AI video, a CHE render as the conditioning image |

## Honest consequence for the plan
- **Blender/Cycles on the free CPU worker** can improve skin, eyes, lighting, DOF and camera; mocap clips and face
  animation improve movement. It will still look like a high-quality CG character, not like these generated frames,
  and CPU render time limits samples and resolution.
- **Reference-level frames** come from a video diffusion model such as Wan2.2 run locally, conditioned on a CHE render
  for identity. Wan2.2 needs a GPU (no free unattended GPU exists for CHE; the owner's Colab T4 only while its
  notebook is open). Every AI-generated shot is labelled as generated, separately from rig footage.

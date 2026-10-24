# CHE cinematic sample (12 s, CPU Blender)

Source for the 12-second sample MP4. It is a genuine render, not a photoreal result.

- `scene.py`: opens Route-B CHE (`renders/full6/che.blend`, not in the repo), builds a procedural office
  (walls, floor, ceiling, window light, desk blocks, LED strips), keyframes a 4-key camera path, and drives
  mouth and blink shape keys from Rhubarb cues on the skin and lashes. Renders PNG frames with Cycles on CPU.
- `scene_v2.py`: the same shot on the stationary `gesture_chat` body clip (looped with Cycles modifiers; the
  idle and talk captures walk 2.5 m), with the strand hair from `tools/avatar_portraits/strand_hair.py`
  parented to the torso, pose-based framing, 50 mm close shots at eye height and a dimmer window.
- `mux.sh`: muxes the frames with the audio, delayed to the speech start at 6 s, into H.264 + AAC.
  `FRAMES`, `OUT` and `LINE` override the frame folder, the MP4 path and the voice file.
- `line.txt`, `cues.json`: the sample line and its Rhubarb mouth cues. The Piper `line.wav` is not in the repo.

Run: `DEMO_BLEND=<path>/che.blend DEMO_OUT=<dir> DEMO_FRAMES=288 DEMO_SAMPLES=24 python3 scene_v2.py`, then
`LINE=<path>/line.wav FRAMES=<dir> OUT=<mp4> bash mux.sh`.
Requires Blender 5.0.1 (bpy), ffmpeg and the Route-B blend. Render time on this CPU: about 50 min for 288
frames with `scene.py`, about 60 min with the strand hair in `scene_v2.py`.

## Honest status (2026-10-24)
- Verified: MP4 12.000 s, 360x640, 288 H.264 frames, AAC audio (-16.9 dB mean), decodes cleanly.
- Audio is the free local Piper voice (en-us-lessac-medium) speaking the sample line. It is NOT CHE's selected
  voice, which was not used or verified.
- Lip sync is driven by Rhubarb cues. The mouth opens and closes; not verified frame by frame.
- Defects: the hair is stiff card geometry; the arms stay in a T-pose; the face is semi-realistic, not photoreal;
  the office is a sparse placeholder set (no visible screens or furniture detail in shot); no real speech audio of
  CHE's voice; the 15-30 s version is not made.

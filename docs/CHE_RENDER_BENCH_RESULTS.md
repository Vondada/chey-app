# Rendering benchmark results and status (owner iPhone run, 2026-10-26)

## Owner's iPhone run (iOS 27.0.1, pixel ratio 3)
| Pass | Result | Reading |
|---|---|---|
| Native painter (Flutter canvas) | 0.3 fps, 1 frame in 4 s, 4.3 ms canvas, 4.5 ms raster | **Invalid count.** The painter repainted once; the orbit never ticked the controller. |
| WebGL 2.0 (bundled Three.js, synthetic orbs) | 60 fps, 239 frames in 4 s | Page's own requestAnimationFrame count. Synthetic scene, not CHE's Brain. |
| WebGPU (raw, synthetic orbs) | 59 fps, 238 frames in 4 s | Same caveat as WebGL. |

## Cause and fix (branch `claude/render-bench-fix`, commit e66e52d1)
- `lib/widgets/che_render_bench.dart`: the orbit ticker only rotated the camera. The Brain view advances the scene with
  `tick(dt, repaint: budget.admitTick())`, which is what bumps the repaint counter. The benchmark now does the same.
- `test/che_render_bench_test.dart`: regression assertion, more than 10 frames counted in one second. Not run here (no Flutter in this container).

## Not done yet
- Real-scene benchmark: `assets/brain3d/bench.html` draws synthetic orbs only. A WebGL/WebGPU comparison on CHE's actual Brain
  and 3D character scenes is not built.
- Native numbers after the fix: need a device run. Not verified.
- Production rendering is unchanged. Do not switch the Brain to WebGL until the iPhone run shows performance, memory,
  interactions, accessibility and navigation working.

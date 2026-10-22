// Writes an animated beach scene from CHE's internal renderer as numbered PNG frames, plus a timeline spec.
// Usage: node tools/che_internal_frames.mjs <out dir> [look] [frames] [fps]. Used by tools/test_internal_video.py.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beachFrames, beachRecipe } from '../server/cloudflare/internal_renderer.js';

const [out, look = 'day', count = '24', fps = '12'] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const recipe = beachRecipe(`a ${look} beach with two palm trees`);
const frames = await beachFrames(recipe, { frames: Number(count), size: { w: 320, h: 180 } });
frames.forEach((png, i) => writeFileSync(join(out, `frame_${String(i).padStart(4, '0')}.png`), png));
writeFileSync(join(out, 'timeline.json'), JSON.stringify({ kind: 'image_sequence', fps: Number(fps), frames: frames.length, width: 320, height: 180, recipe, source: 'che_internal_renderer' }));

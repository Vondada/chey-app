// Provider-specific request payloads for Workers AI image models. Each model's input schema is strict: an unknown property is
// refused with "Additional or unevaluated properties ... not allowed" (owner, 2026-10-28: "CHE image engine: 5006 ... '/seed'").
// So a payload is built from the model's own accepted fields, and every dropped field is reported, never sent and never hidden.
// Source of the schemas: the Workers AI model pages (developers.cloudflare.com/workers-ai/models/<model>/), checked 2026-10-28.
// A model not listed here is sent with prompt only, and its payload says so.

export const FLUX_SCHNELL = '@cf/black-forest-labs/flux-1-schnell';
export const LUCID_ORIGIN = '@cf/leonardo/lucid-origin';

// `fields`: the only properties the model accepts. `max`: numeric limits. `seed`: whether the model takes a seed.
export const IMAGE_SCHEMAS = Object.freeze({
  // Parameters: prompt (required, 1 to 2048 characters) and steps (up to 8). No seed, width or height.
  [FLUX_SCHNELL]: Object.freeze({ fields: ['prompt', 'steps'], max: { prompt: 2048, steps: 8 }, min: { steps: 1 }, seed: false }),
  // Parameters (docs, checked 2026-10-28): prompt (required, minLength 1), guidance 0-10, seed (integer, minimum 0),
  // width and height 0-2500, num_steps and steps 1-40. It takes a seed, so the seed is kept.
  [LUCID_ORIGIN]: Object.freeze({ fields: ['prompt', 'steps', 'guidance', 'seed', 'width', 'height'], max: { prompt: 2048, steps: 40, guidance: 10, width: 2500, height: 2500 }, min: { steps: 1, guidance: 0, width: 0, height: 0, seed: 0 }, seed: true }),
});

/**
 * The payload to send to `model`, from the caller's wish, with what was dropped and why.
 * `wish` may carry prompt, steps, seed, width, height, guidance, negative_prompt. Only the model's own fields are sent.
 * Returns { payload, dropped: [{ field, reason }], seed_applied, schema_known }.
 */
export function imagePayload(model, wish = {}) {
  const schema = IMAGE_SCHEMAS[model];
  const dropped = [];
  if (!schema) {
    // Unknown model: only the prompt is certain to be accepted. The rest is reported, not sent.
    const payload = { prompt: String(wish.prompt || '') };
    for (const field of Object.keys(wish)) if (field !== 'prompt' && wish[field] !== undefined) dropped.push({ field, reason: 'the model\'s schema is not known to CHE, so only the prompt is sent' });
    return { payload, dropped, seed_applied: false, schema_known: false };
  }
  const payload = {};
  const prompt = String(wish.prompt || '');
  payload.prompt = prompt.slice(0, schema.max.prompt);
  if (prompt.length > schema.max.prompt) dropped.push({ field: 'prompt', reason: `cut to ${schema.max.prompt} characters, the model's limit` });
  let seedApplied = false;
  for (const field of Object.keys(wish)) {
    if (field === 'prompt' || wish[field] === undefined) continue;
    if (!schema.fields.includes(field)) {
      dropped.push({ field, reason: field === 'seed' ? 'this model does not take a seed, so the same prompt can give a different picture' : `the model does not accept ${field}` });
      continue;
    }
    if (field === 'seed') {
      if (!schema.seed || !Number.isInteger(wish.seed) || wish.seed < schema.min.seed) { dropped.push({ field, reason: 'not a whole number the model accepts' }); continue; }
      payload.seed = wish.seed; seedApplied = true; continue;
    }
    // Numeric fields: clamped to the model's range, the change reported. A non-number is dropped.
    const n = Number(wish[field]);
    if (!Number.isFinite(n)) { dropped.push({ field, reason: 'not a number' }); continue; }
    const lo = schema.min[field] ?? -Infinity; const hi = schema.max[field] ?? Infinity;
    const clamped = Math.min(hi, Math.max(lo, field === 'guidance' ? n : Math.trunc(n)));
    payload[field] = clamped;
    if (clamped !== n) dropped.push({ field, reason: `set to ${clamped}, the model accepts ${lo} to ${hi}` });
  }
  // Only fields the schema lists are ever in the payload.
  for (const field of Object.keys(payload)) if (!schema.fields.includes(field)) delete payload[field];
  return { payload, dropped, seed_applied: seedApplied, schema_known: true };
}

/** The receipt line for a payload: what was sent and what was dropped, for the record and the owner. */
export function payloadReceipt(model, result) {
  return { model, schema_known: result.schema_known, fields_sent: Object.keys(result.payload), dropped: result.dropped, seed_applied: result.seed_applied };
}

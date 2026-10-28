// Provider-specific request payloads for Workers AI image models. Each model's input schema is strict: an unknown property is
// refused with "Additional or unevaluated properties ... not allowed" (owner, 2026-10-28: "CHE image engine: 5006 ... '/seed'").
// So a payload is built from the model's own accepted fields, and every dropped field is reported, never sent and never hidden.
// Source of the schemas: the Workers AI model pages (developers.cloudflare.com/workers-ai/models/<model>/), checked 2026-10-28.
// A model not listed here is sent with prompt only, and its payload says so.

export const FLUX_SCHNELL = '@cf/black-forest-labs/flux-1-schnell';

// `fields`: the only properties the model accepts. `max`: numeric limits. `seed`: whether the model takes a seed.
export const IMAGE_SCHEMAS = Object.freeze({
  // Parameters: prompt (required, 1 to 2048 characters) and steps (up to 8). No seed, width or height.
  [FLUX_SCHNELL]: Object.freeze({ fields: ['prompt', 'steps'], max: { prompt: 2048, steps: 8 }, min: { steps: 1 }, seed: false }),
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
  if (schema.fields.includes('steps') && wish.steps !== undefined) {
    const steps = Math.min(schema.max.steps, Math.max(schema.min.steps, Math.trunc(Number(wish.steps)) || schema.min.steps));
    payload.steps = steps;
    if (steps !== Number(wish.steps)) dropped.push({ field: 'steps', reason: `set to ${steps}, the model accepts ${schema.min.steps} to ${schema.max.steps}` });
  }
  let seedApplied = false;
  for (const field of Object.keys(wish)) {
    if (field === 'prompt' || field === 'steps' || wish[field] === undefined) continue;
    if (field === 'seed' && schema.seed && Number.isInteger(wish.seed) && wish.seed >= 0) { payload.seed = wish.seed; seedApplied = true; continue; }
    if (schema.fields.includes(field)) { payload[field] = wish[field]; continue; }
    dropped.push({ field, reason: field === 'seed' ? 'this model does not take a seed, so the same prompt can give a different picture' : `the model does not accept ${field}` });
  }
  // Only fields the schema lists are ever in the payload.
  for (const field of Object.keys(payload)) if (!schema.fields.includes(field)) delete payload[field];
  return { payload, dropped, seed_applied: seedApplied, schema_known: true };
}

/** The receipt line for a payload: what was sent and what was dropped, for the record and the owner. */
export function payloadReceipt(model, result) {
  return { model, schema_known: result.schema_known, fields_sent: Object.keys(result.payload), dropped: result.dropped, seed_applied: result.seed_applied };
}

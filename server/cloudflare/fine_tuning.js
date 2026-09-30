// CHE model fine-tuning connectors.
//
// CHE does not train a large model on the iPhone. It prepares a bounded,
// reviewable LoRA/adapter job and sends it only to an owner-configured training
// service. VMware Private AI is preferred when connected; a Hugging Face
// training endpoint can be used as the fallback. No job starts without the
// owner's explicit approval flag.

function clean(value, max = 4000) {
  return String(value ?? '').trim().slice(0, max);
}

function httpsUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    return url.protocol === 'https:' ? url.toString() : '';
  } catch (_) {
    return '';
  }
}

export function fineTuneReadiness(env) {
  return {
    vmware: Boolean(httpsUrl(env.CHE_VMWARE_TRAINING_URL)),
    huggingface: Boolean(httpsUrl(env.CHE_HF_TRAINING_URL) && (env.CHE_HF_TRAINING_TOKEN || env.HF_TOKEN)),
    preferred: httpsUrl(env.CHE_VMWARE_TRAINING_URL)
      ? 'vmware'
      : httpsUrl(env.CHE_HF_TRAINING_URL)
        ? 'huggingface'
        : null,
    method: 'lora_adapter',
  };
}

function endpointFor(env, requested) {
  const ready = fineTuneReadiness(env);
  const provider = requested === 'huggingface' && ready.huggingface
    ? 'huggingface'
    : requested === 'vmware' && ready.vmware
      ? 'vmware'
      : ready.preferred;
  if (provider === 'vmware') {
    return {
      provider,
      url: httpsUrl(env.CHE_VMWARE_TRAINING_URL),
      token: clean(env.CHE_VMWARE_TRAINING_TOKEN, 2000),
    };
  }
  if (provider === 'huggingface') {
    return {
      provider,
      url: httpsUrl(env.CHE_HF_TRAINING_URL),
      token: clean(env.CHE_HF_TRAINING_TOKEN || env.HF_TOKEN, 2000),
    };
  }
  return null;
}

export function validateFineTuneRequest(body = {}) {
  const baseModel = clean(body.base_model, 240);
  const dataset = clean(body.dataset_id || body.dataset, 500);
  const objective = clean(body.objective, 1600);
  if (!baseModel) return { error: 'Choose a base model.' };
  if (!dataset) return { error: 'Choose an approved dataset or dataset id.' };
  if (!objective) return { error: 'Describe what the tuning should improve.' };
  return {
    job: {
      base_model: baseModel,
      dataset_id: dataset,
      objective,
      method: 'lora',
      adapter_only: true,
      evaluation_required: true,
      holdout_fraction: Math.max(0.05, Math.min(0.3, Number(body.holdout_fraction || 0.1))),
      max_steps: Math.max(10, Math.min(5000, Number(body.max_steps || 500))),
      owner_approved: body.approved === true,
    },
  };
}

export async function submitFineTuneJob(env, body = {}, fetcher = fetch) {
  const checked = validateFineTuneRequest(body);
  if (checked.error) return { status: 400, detail: checked.error };
  const target = endpointFor(env, clean(body.provider, 40).toLowerCase());
  if (!target) {
    return {
      status: 409,
      detail: 'No VMware Private AI or Hugging Face training endpoint is connected.',
      readiness: fineTuneReadiness(env),
      prepared: checked.job,
    };
  }
  if (!checked.job.owner_approved) {
    return {
      status: 202,
      provider: target.provider,
      prepared: checked.job,
      requires_owner_approval: true,
      detail: 'Fine-tuning plan prepared. No training job has started.',
    };
  }

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (target.token) headers.Authorization = `Bearer ${target.token}`;
    const response = await fetcher(target.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        ...checked.job,
        requested_by: 'CHE',
        require_evaluation_gate: true,
        artifact_policy: 'adapter_only',
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const raw = (await response.text()).slice(0, 12000);
    let data;
    try { data = JSON.parse(raw); } catch (_) { data = { detail: raw }; }
    if (!response.ok) {
      return {
        status: 502,
        provider: target.provider,
        detail: `${target.provider} training connector returned ${response.status}.`,
        connector: data,
      };
    }
    return {
      status: 200,
      provider: target.provider,
      submitted: true,
      job_id: clean(data?.job_id || data?.id || data?.run_id, 240) || null,
      connector: data,
    };
  } catch (error) {
    return {
      status: 502,
      provider: target.provider,
      detail: clean(error?.message || error, 500) || 'Training connector unavailable.',
    };
  }
}

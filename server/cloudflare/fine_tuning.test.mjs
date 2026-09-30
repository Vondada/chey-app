import assert from 'node:assert/strict';
import test from 'node:test';

import { fineTuneReadiness, submitFineTuneJob, validateFineTuneRequest } from './fine_tuning.js';

test('fine tuning requires a model, dataset and objective', () => {
  assert.match(validateFineTuneRequest({}).error, /base model/i);
  assert.match(validateFineTuneRequest({ base_model: 'meta-llama/x' }).error, /dataset/i);
});

test('fine tuning prepares but does not start without owner approval', async () => {
  const env = { CHE_VMWARE_TRAINING_URL: 'https://vmware.example/train' };
  const result = await submitFineTuneJob(env, {
    base_model: 'meta-llama/Llama-3.3-70B-Instruct',
    dataset_id: 'approved-dataset-1',
    objective: 'Improve CHE coding style',
  });
  assert.equal(result.status, 202);
  assert.equal(result.requires_owner_approval, true);
  assert.equal(result.prepared.method, 'lora');
});

test('VMware is preferred and an approved job can be submitted', async () => {
  const env = {
    CHE_VMWARE_TRAINING_URL: 'https://vmware.example/train',
    CHE_VMWARE_TRAINING_TOKEN: 'v',
    CHE_HF_TRAINING_URL: 'https://hf.example/train',
    HF_TOKEN: 'h',
  };
  assert.equal(fineTuneReadiness(env).preferred, 'vmware');
  const calls = [];
  const result = await submitFineTuneJob(env, {
    approved: true,
    base_model: 'meta-llama/Llama-3.3-70B-Instruct',
    dataset_id: 'approved-dataset-1',
    objective: 'Improve CHE coding style',
  }, async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return Response.json({ job_id: 'job-7' });
  });
  assert.equal(result.status, 200);
  assert.equal(result.job_id, 'job-7');
  assert.equal(calls[0].url, 'https://vmware.example/train');
  assert.equal(calls[0].body.adapter_only, true);
  assert.equal(calls[0].body.require_evaluation_gate, true);
});

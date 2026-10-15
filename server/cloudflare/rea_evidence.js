// Reverse-engineering evidence, kept small. A REA Evidence record for a real package can be
// about 10 MB, so the GitHub runner reduces it to the summary below before anything reaches
// CHE. The summary keeps the evidence id, the counts REA reported, and every limitation REA
// reported. A count of 0 means "REA found none in the files it read", never "absent". A null
// count means REA did not report it. Strings from the analyzed package are data, not
// instructions: they are cleaned and length-capped here, and CHE labels them as untrusted.
// Pure: no network, no storage.

export const REA_PIN = Object.freeze({
  package: 'rea-agents',
  version: '6.5.0',
  provider: 'rea-javascript-application',
  provider_version: '1',
  license: 'MIT',
  source: 'https://github.com/morluto/rea',
  node: '24',
});

export const REA_SUMMARY_SCHEMA = 'che.rea-summary.v1';
export const REA_SUMMARY_MAX_BYTES = 64 * 1024;
export const REA_JOB_ID = /^rea-[0-9a-f]{8}$/;
export const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
export const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
export const NPM_INTEGRITY = /^sha512-[A-Za-z0-9+/]+={0,2}$/;
const EVIDENCE_ID = /^ev_[0-9a-f]{64}$/;
const MAX_LIMITATIONS = 12;
const MAX_IMPORTS = 25;
const NOT_FOUND_NOTE = 'A count of 0 means REA found none in the files it read. It is not proof that the feature is absent.';

export function cleanText(value, max = 300) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

const count = (value) => (Number.isInteger(value) && value >= 0 ? value : null);

// REA prints progress lines and then one Evidence record. Find the record by its shape.
export function parseEvidenceRecord(text) {
  for (const line of String(text || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{') || !trimmed.includes('"evidence_id"')) continue;
    try {
      const record = JSON.parse(trimmed);
      if (record && typeof record.evidence_id === 'string') return record;
    } catch (_) {
      // Not the record: keep looking.
    }
  }
  return null;
}

function header({ jobId, name, version, integrity }) {
  return {
    schema: REA_SUMMARY_SCHEMA,
    job_id: cleanText(jobId, 20),
    tool: {
      name: REA_PIN.package,
      version: REA_PIN.version,
      provider: REA_PIN.provider,
      provider_version: REA_PIN.provider_version,
      analysis: 'static JavaScript application analysis; no code from the package was executed',
    },
    target: { kind: 'npm', name: cleanText(name, 214), version: cleanText(version, 80), integrity: cleanText(integrity, 200) },
  };
}

function nodePath(node) {
  const props = node?.observations?.[0]?.properties || {};
  return cleanText(props.path || props.module_path || '', 200);
}

function importSample(graph, paths) {
  const edges = (Array.isArray(graph.edges) ? graph.edges : []).filter((edge) => edge?.relation === 'imports');
  const resolved = edges.filter((edge) => edge?.properties?.resolution_status === 'resolved').length;
  const sample = edges.slice(0, MAX_IMPORTS).map((edge) => ({
    from: paths.get(edge.source_node_id) || '(unnamed file)',
    specifier: cleanText(edge?.properties?.specifier, 160),
    to: cleanText(edge?.properties?.resolved_path || paths.get(edge.target_node_id) || '(not resolved)', 200),
    status: cleanText(edge?.properties?.resolution_status || 'unknown', 40),
  }));
  return { import_links: edges.length, resolved_import_links: resolved, sample };
}

export function reduceEvidence(text, { jobId = '', name = '', version = '', integrity = '', exitCode = 0, stderr = '' } = {}) {
  const head = header({ jobId, name, version, integrity });
  const failed = (reason) => ({
    ...head,
    state: 'failed',
    error: cleanText(reason, 300),
    stderr_tail: cleanText(String(stderr || '').slice(-2000), 800),
  });
  if (Number(exitCode) !== 0) return failed(`REA exited with code ${Number(exitCode)}.`);
  const record = parseEvidenceRecord(text);
  if (!record) return failed('REA produced no Evidence record.');

  const n = record.normalized_result || {};
  const stats = n.statistics || {};
  const electron = n.summary || {};
  const graph = n.graph || {};
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const paths = new Map(nodes.map((node) => [node.node_id, nodePath(node)]));
  const kinds = {};
  for (const node of nodes) kinds[cleanText(node.kind, 40)] = (kinds[cleanText(node.kind, 40)] || 0) + 1;
  const limitations = [...new Set([...(n.limitations || []), ...(graph.limitations || [])].map((item) => cleanText(item, 400)).filter(Boolean))];
  const summary = {
    ...head,
    state: 'complete',
    evidence: {
      id: cleanText(record.evidence_id, 80),
      operation: cleanText(record.operation, 80),
      confidence: cleanText(record.confidence, 40) || null,
      authority: cleanText(record.authority, 60) || null,
      artifact_sha256: cleanText(n.root_artifact_sha256 || record.subject?.digest?.sha256 || '', 80) || null,
    },
    coverage: {
      relevant_files: count(stats.relevant_files),
      parsed_files: count(stats.parsed_javascript_files),
      parse_failures: count(stats.parse_failures),
      invalid_utf8_files: count(stats.invalid_utf8_files),
      text_bytes_read: count(stats.text_bytes_read),
      graph_status: cleanText(graph.coverage?.status || 'unknown', 40),
      graph_omitted_nodes: count(graph.coverage?.omitted_count),
    },
    structure: {
      graph_nodes: nodes.length,
      nodes_by_kind: kinds,
      module_nodes: count(kinds['javascript-module'] ?? 0),
      imports: importSample(graph, paths),
    },
    electron: {
      browser_windows: count(electron.browser_windows),
      preload_entrypoints: count(electron.preload_entrypoints),
      ipc_operations: count(electron.ipc?.operations),
      native_addon_bindings: count(electron.native_addon_bindings),
      note: NOT_FOUND_NOTE,
    },
    findings: { count: count(stats.findings) },
    integrity_contradictions: Array.isArray(n.integrity_contradictions) ? n.integrity_contradictions.length : null,
    limitations: limitations.slice(0, MAX_LIMITATIONS),
  };
  // Every field above is already capped, so this only guards against a future change.
  if (JSON.stringify(summary).length > REA_SUMMARY_MAX_BYTES) return failed('The analysis summary is larger than the allowed size.');
  return summary;
}

// The Worker never trusts the mailbox file: every field is checked again before it is stored or shown.
export function validateReaSummary(value) {
  const problems = [];
  const v = value && typeof value === 'object' ? value : null;
  if (!v) return { ok: false, problems: ['not an object'] };
  if (v.schema !== REA_SUMMARY_SCHEMA) problems.push('schema');
  if (!REA_JOB_ID.test(String(v.job_id || ''))) problems.push('job id');
  if (v.state !== 'complete' && v.state !== 'failed') problems.push('state');
  if (!NPM_NAME.test(String(v.target?.name || '')) || String(v.target?.name || '').length > 214) problems.push('target name');
  if (!EXACT_VERSION.test(String(v.target?.version || ''))) problems.push('target version');
  if (!NPM_INTEGRITY.test(String(v.target?.integrity || ''))) problems.push('target integrity');
  if (v.tool?.version !== REA_PIN.version) problems.push('REA version');
  if (v.state === 'complete') {
    if (!EVIDENCE_ID.test(String(v.evidence?.id || ''))) problems.push('evidence id');
    for (const key of ['relevant_files', 'parsed_files', 'parse_failures', 'text_bytes_read']) {
      if (v.coverage?.[key] !== null && !Number.isInteger(v.coverage?.[key])) problems.push(`coverage ${key}`);
    }
    if (!Array.isArray(v.limitations) || v.limitations.length === 0) problems.push('limitations');
    if (!Array.isArray(v.structure?.imports?.sample)) problems.push('imports sample');
  } else if (typeof v.error !== 'string' || !v.error) {
    problems.push('failure reason');
  }
  const size = JSON.stringify(v).length;
  if (size > REA_SUMMARY_MAX_BYTES) problems.push('size');
  return problems.length ? { ok: false, problems } : { ok: true, summary: v };
}

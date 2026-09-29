// CHE Postgres + pgvector memory layer.
//
// Configure CHE_PGVECTOR_REST_URL to a server-side PostgREST/Supabase REST
// endpoint (for example https://PROJECT.supabase.co/rest/v1) and keep
// CHE_PGVECTOR_TOKEN only on the Worker. The phone never receives DB keys.
//
// The Worker creates query embeddings with Workers AI, asks Postgres/pgvector
// for nearest memories before chat replies, and can mirror approved CHE memory
// into the same store. Retrieved rows are reference data, never instructions.

const DEFAULT_EMBEDDING_MODEL = '@cf/baai/bge-base-en-v1.5';
const DEFAULT_MATCH_COUNT = 8;
const DEFAULT_MATCH_THRESHOLD = 0.58;

function clip(value, max = 2400) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function baseUrl(env) {
  return String(env.CHE_PGVECTOR_REST_URL || '').trim().replace(/\/+$/, '');
}

function token(env) {
  return String(env.CHE_PGVECTOR_TOKEN || '').trim();
}

export function vectorMemoryReadiness(env) {
  return {
    configured: Boolean(baseUrl(env) && token(env) && env.AI),
    postgres_pgvector: Boolean(baseUrl(env) && token(env)),
    embeddings: Boolean(env.AI),
    embedding_model: String(env.CHE_EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL),
  };
}

function vectorFrom(output) {
  const candidates = [
    output?.data?.[0],
    output?.result?.data?.[0],
    output?.embeddings?.[0],
    output?.embedding,
    output?.result?.embedding,
  ];
  for (const value of candidates) {
    if (Array.isArray(value) && value.length && value.every((n) => Number.isFinite(Number(n)))) {
      return value.map(Number);
    }
  }
  return null;
}

export async function embedForMemory(env, text) {
  const input = clip(text, 12000);
  if (!input || !env.AI) return null;
  const output = await env.AI.run(
    env.CHE_EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL,
    { text: [input] },
  );
  return vectorFrom(output);
}

function headers(env, extra = {}) {
  const key = token(env);
  return {
    Authorization: `Bearer ${key}`,
    apikey: key,
    'Content-Type': 'application/json',
    ...extra,
  };
}

function sanitizeMatch(row) {
  const content = clip(row?.content ?? row?.text ?? row?.memory, 2200);
  if (!content) return null;
  return {
    id: clip(row?.id, 120),
    external_id: clip(row?.external_id, 180),
    kind: clip(row?.kind || row?.type || 'knowledge', 80),
    title: clip(row?.title, 220),
    content,
    source: clip(row?.source, 220),
    similarity: Number.isFinite(Number(row?.similarity))
      ? Math.max(0, Math.min(1, Number(row.similarity)))
      : null,
    metadata: row?.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
      ? row.metadata
      : {},
  };
}

export async function retrieveVectorContext(env, query, fetcher = fetch) {
  const ready = vectorMemoryReadiness(env);
  if (!ready.postgres_pgvector) {
    return { status: 'not_configured', checked: false, matches: [], detail: 'Postgres/pgvector is not configured.' };
  }
  if (!ready.embeddings) {
    return { status: 'embedding_unavailable', checked: false, matches: [], detail: 'Embedding engine is unavailable.' };
  }

  try {
    const embedding = await embedForMemory(env, query);
    if (!embedding) {
      return { status: 'embedding_failed', checked: false, matches: [], detail: 'CHE could not create a query embedding.' };
    }
    const response = await fetcher(`${baseUrl(env)}/rpc/match_che_memory`, {
      method: 'POST',
      headers: headers(env),
      body: JSON.stringify({
        query_embedding: embedding,
        match_threshold: Number(env.CHE_PGVECTOR_MATCH_THRESHOLD || DEFAULT_MATCH_THRESHOLD),
        match_count: Math.max(1, Math.min(20, Number(env.CHE_PGVECTOR_MATCH_COUNT || DEFAULT_MATCH_COUNT))),
      }),
      signal: AbortSignal.timeout(1800),
    });
    if (!response.ok) {
      const body = (await response.text()).slice(0, 500);
      return {
        status: 'error',
        checked: false,
        matches: [],
        detail: `pgvector search returned ${response.status}${body ? `: ${body}` : ''}`,
      };
    }
    const raw = await response.json().catch(() => []);
    const rows = Array.isArray(raw) ? raw : Array.isArray(raw?.matches) ? raw.matches : [];
    const matches = rows.map(sanitizeMatch).filter(Boolean).slice(0, DEFAULT_MATCH_COUNT);
    return { status: 'checked', checked: true, matches, detail: matches.length ? '' : 'No relevant vector memories matched.' };
  } catch (error) {
    return {
      status: 'error',
      checked: false,
      matches: [],
      detail: String(error?.name === 'TimeoutError' ? 'pgvector search timed out.' : error?.message || error).slice(0, 500),
    };
  }
}

export function vectorContextText(recall, maxChars = 9000) {
  if (!recall?.checked) return '';
  let used = 0;
  const lines = [];
  for (const item of recall.matches || []) {
    const label = [item.kind, item.title].filter(Boolean).join(' · ');
    const score = item.similarity == null ? '' : ` (similarity ${item.similarity.toFixed(3)})`;
    const line = `[${label || 'memory'}${score}] ${item.content}${item.source ? ` — source: ${item.source}` : ''}`;
    if (used + line.length > maxChars) break;
    used += line.length;
    lines.push(line);
  }
  return lines.join('\n');
}

export async function storeVectorMemory(env, item, fetcher = fetch) {
  if (!vectorMemoryReadiness(env).configured) return { stored: false, status: 'not_configured' };
  const content = clip(item?.content ?? item?.text, 12000);
  const externalId = clip(item?.external_id || item?.id, 180);
  if (!content || !externalId) return { stored: false, status: 'invalid' };

  try {
    const embedding = await embedForMemory(env, content);
    if (!embedding) return { stored: false, status: 'embedding_failed' };
    const response = await fetcher(`${baseUrl(env)}/che_memory?on_conflict=external_id`, {
      method: 'POST',
      headers: headers(env, { Prefer: 'resolution=merge-duplicates,return=minimal' }),
      body: JSON.stringify({
        external_id: externalId,
        kind: clip(item?.kind || item?.type || 'knowledge', 80),
        title: clip(item?.title, 220),
        content,
        source: clip(item?.source, 220),
        metadata: item?.metadata && typeof item.metadata === 'object' && !Array.isArray(item.metadata)
          ? item.metadata
          : {},
        embedding,
        updated_at: new Date().toISOString(),
      }),
      signal: AbortSignal.timeout(2500),
    });
    return response.ok
      ? { stored: true, status: 'stored' }
      : { stored: false, status: 'error', detail: `pgvector upsert returned ${response.status}` };
  } catch (error) {
    return { stored: false, status: 'error', detail: String(error?.message || error).slice(0, 300) };
  }
}

export async function deleteVectorMemory(env, externalId, fetcher = fetch) {
  if (!baseUrl(env) || !token(env)) return { deleted: false, status: 'not_configured' };
  const id = clip(externalId, 180);
  if (!id) return { deleted: false, status: 'invalid' };
  try {
    const response = await fetcher(
      `${baseUrl(env)}/che_memory?external_id=eq.${encodeURIComponent(id)}`,
      {
        method: 'DELETE',
        headers: headers(env, { Prefer: 'return=minimal' }),
        signal: AbortSignal.timeout(1800),
      },
    );
    return { deleted: response.ok, status: response.ok ? 'deleted' : 'error' };
  } catch (_) {
    return { deleted: false, status: 'error' };
  }
}

export async function clearVectorMemoryKind(env, kind, fetcher = fetch) {
  if (!baseUrl(env) || !token(env)) return { deleted: false, status: 'not_configured' };
  const clean = clip(kind, 80);
  try {
    const response = await fetcher(
      `${baseUrl(env)}/che_memory?kind=eq.${encodeURIComponent(clean)}`,
      {
        method: 'DELETE',
        headers: headers(env, { Prefer: 'return=minimal' }),
        signal: AbortSignal.timeout(1800),
      },
    );
    return { deleted: response.ok, status: response.ok ? 'deleted' : 'error' };
  } catch (_) {
    return { deleted: false, status: 'error' };
  }
}

// Run link for the video engine. CHE does not start this notebook.
// The Colab page runs in the owner's Google account and dies when the session stops.

export const VIDEO_ENGINE = {
  id: 'money-printer-turbo',
  repo: 'https://github.com/harry0703/MoneyPrinterTurbo',
  run: 'https://colab.research.google.com/github/harry0703/MoneyPrinterTurbo/blob/main/docs/MoneyPrinterTurbo.ipynb',
  local: 'http://127.0.0.1:8501',
  env: 'CHE_VIDEO_GEN_URL',
};

export function videoEngineStatus(env = {}) {
  const url = String(env.CHE_VIDEO_GEN_URL || '').trim();
  const legacy = String(env.CHE_VIDEO_RENDER_URL || '').trim();
  return {
    ...VIDEO_ENGINE,
    configured: Boolean(url || legacy || (env.CHE_GITHUB_TOKEN && env.CHE_GITHUB_REPO === 'Vondada/chey-app')),
    backend: url ? 'moneyprinter-turbo' : legacy ? 'faceless-renderer'
      : (env.CHE_GITHUB_TOKEN && env.CHE_GITHUB_REPO === 'Vondada/chey-app') ? 'github-actions-offline' : 'none',
    ready: false,
    reason: url ? 'MoneyPrinter configured but not checked online.'
      : legacy ? 'Faceless renderer configured; availability not verified.'
        : env.CHE_GITHUB_TOKEN && env.CHE_GITHUB_REPO === 'Vondada/chey-app'
          ? 'GitHub renderer configured; each job must still be verified.'
          : 'No video renderer configured or running.',
  };
}

/** A configured URL alone is not proof that a renderer is online. */
export async function probeVideoEngine(env = {}, fetcher = fetch) {
  const status = videoEngineStatus(env);
  if (!status.configured) return status;
  if (!env.CHE_VIDEO_GEN_URL) return { ...status, reason: 'Legacy renderer has no standard health endpoint. Render a test to confirm it is online.' };
  try {
    const origin = new URL(String(env.CHE_VIDEO_GEN_URL).trim());
    if (origin.protocol !== 'https:') return { ...status, reason: 'Video renderer requires HTTPS.' };
    let base = origin.toString();
    while (base.endsWith('/')) base = base.slice(0, -1);
    if (base.endsWith('/api/v1')) base = base.slice(0, -7);
    const response = await fetcher(`${base}/api/v1/tasks?page=1&page_size=1`, {
      headers: env.CHE_VIDEO_GEN_TOKEN ? { 'X-API-Key': env.CHE_VIDEO_GEN_TOKEN } : {},
      signal: AbortSignal.timeout(12000),
    });
    return { ...status, ready: response.ok, reason: response.ok ? 'Renderer API responded.' : `Renderer returned HTTP ${response.status}.` };
  } catch {
    return { ...status, reason: 'Renderer API was unreachable.' };
  }
}

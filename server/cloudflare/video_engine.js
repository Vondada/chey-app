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
  return {
    ...VIDEO_ENGINE,
    configured: Boolean(url),
    ready: false,
    reason: url ? 'Renderer configured but not checked online.' : 'No video renderer configured or running.',
  };
}

/** A configured URL alone is not proof that a renderer is online. */
export async function probeVideoEngine(env = {}, fetcher = fetch) {
  const status = videoEngineStatus(env);
  if (!status.configured) return status;
  try {
    const origin = new URL(String(env.CHE_VIDEO_GEN_URL).trim());
    if (origin.protocol !== 'https:') return { ...status, reason: 'Video renderer requires HTTPS.' };
    const base = origin.toString().replace(/\\/+$/, '').replace(/\\/api\\/v1$/, '');
    const response = await fetcher(`${base}/api/v1/tasks?page=1&page_size=1`, {
      headers: env.CHE_VIDEO_GEN_TOKEN ? { 'X-API-Key': env.CHE_VIDEO_GEN_TOKEN } : {},
      signal: AbortSignal.timeout(12000),
    });
    return { ...status, ready: response.ok, reason: response.ok ? 'Renderer API responded.' : `Renderer returned HTTP ${response.status}.` };
  } catch {
    return { ...status, reason: 'Renderer API was unreachable.' };
  }
}

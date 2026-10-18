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
  if (!env.CHE_VIDEO_GEN_URL && !env.CHE_VIDEO_RENDER_URL &&
      env.CHE_GITHUB_TOKEN && env.CHE_GITHUB_REPO === 'Vondada/chey-app') {
    try {
      const response = await fetcher('https://api.github.com/repos/Vondada/chey-app/actions/workflows/che-video-render.yml', {
        headers: {
          'Authorization': 'Bearer ' + env.CHE_GITHUB_TOKEN,
          'Accept': 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          // GitHub refuses requests without a User-Agent (HTTP 403).
          'User-Agent': 'CHE-Video-Renderer',
        },
        signal: AbortSignal.timeout(12000),
      });
      return { ...status, ready: response.ok, reason: response.ok
        ? 'Free GitHub video workflow is reachable; render output must still be verified.'
        : 'GitHub video workflow returned HTTP ' + response.status + '.' };
    } catch {
      return { ...status, reason: 'GitHub video workflow could not be reached.' };
    }
  }
  if (!env.CHE_VIDEO_GEN_URL) return { ...status, reason: 'Legacy renderer requires a real render to verify it is online.' };
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

const BACKEND_NAME = {
  'github-actions-offline': 'the free GitHub renderer',
  'moneyprinter-turbo': 'the MoneyPrinter renderer',
  'faceless-renderer': 'the faceless renderer',
};

/** The read-only answer to "which renderer is connected and what was the last verified MP4": settings and the
 * media library only. Nothing is rendered, queued or uploaded. */
export function videoStatusSpeech(status = {}, items = []) {
  const name = BACKEND_NAME[status.backend] || '';
  const renderer = name
    ? `Renderer: ${name} is set up. ${status.ready ? 'It answered just now.' : `It is not confirmed working: ${String(status.reason || 'not checked').replace(/\.$/, '')}.`}`
    : 'Renderer: none is set up, so I cannot make a video right now.';
  const last = (Array.isArray(items) ? items : [])
    .filter((item) => item?.kind === 'video' && item.verified === true)
    .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))[0];
  const when = last?.created_at ? new Date(last.created_at) : null;
  const date = when && !Number.isNaN(when.getTime())
    ? when.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '';
  const seconds = last?.duration_verified && Number(last.duration_seconds) > 0 ? `, ${Math.round(Number(last.duration_seconds))} seconds` : '';
  const proof = last
    ? `Last verified MP4: "${String(last.title || 'untitled').slice(0, 80)}"${seconds}${date ? `, made ${date}` : ''}, in your media library.`
    : 'Last verified MP4: none. Your media library has no verified video yet.';
  return `I did not render or upload anything, sir. ${renderer} ${proof} Only a verified MP4 proves a playable video; settings alone do not.`;
}

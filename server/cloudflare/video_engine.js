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
    ready: Boolean(url),
    reason: url ? 'Renderer URL set' : 'Run link is stored. No video server is running.',
  };
}

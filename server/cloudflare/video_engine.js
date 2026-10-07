// Top starred repo that turns a topic into a video.
// https://github.com/harry0703/MoneyPrinterTurbo (~128k stars)
// CHE does not run it. CHE_VIDEO_RENDER_URL must be that server.

export const VIDEO_ENGINE = {
  id: 'money-printer-turbo',
  name: 'MoneyPrinterTurbo',
  repo: 'https://github.com/harry0703/MoneyPrinterTurbo',
  env: 'CHE_VIDEO_RENDER_URL',
};

export function videoEngineStatus(env = {}) {
  const url = String(env.CHE_VIDEO_RENDER_URL || '').trim();
  return {
    ...VIDEO_ENGINE,
    ready: Boolean(url),
    reason: url ? 'Renderer URL set' : 'Needs CHE_VIDEO_RENDER_URL pointed at a running MoneyPrinterTurbo server',
  };
}

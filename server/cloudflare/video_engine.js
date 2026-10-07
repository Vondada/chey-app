// The video engine generateVideo already runs.
// First choice: CHE_VIDEO_GEN_URL, a server that returns {"url":"https://...mp4"}.
// MoneyPrinterTurbo is the repo to run at that URL:
// https://github.com/harry0703/MoneyPrinterTurbo
// Second choice, already in media.js: Gemini, only if GEMINI_API_KEY is set
// and CHE_ALLOW_PAID_MEDIA plus CHE_ALLOW_PAID_AI are on.
// No URL and no paid switch means no video.

export const VIDEO_ENGINE = {
  id: 'che-video',
  env: 'CHE_VIDEO_GEN_URL',
  repo: 'https://github.com/harry0703/MoneyPrinterTurbo',
  returns: 'url',
};

export function videoEngineStatus(env = {}) {
  const url = String(env.CHE_VIDEO_GEN_URL || '').trim();
  const paid = /^(?:1|true|yes|on)$/i.test(String(env.CHE_ALLOW_PAID_MEDIA || ''))
    && /^(?:1|true|yes)$/i.test(String(env.CHE_ALLOW_PAID_AI || ''))
    && Boolean(env.GEMINI_API_KEY);
  return {
    ready: Boolean(url) || paid,
    engine: url ? 'CHE_VIDEO_GEN_URL' : (paid ? 'gemini' : ''),
    reason: url || paid ? 'A video engine is configured' : 'No video engine. Set CHE_VIDEO_GEN_URL, or turn on paid media and Gemini.',
  };
}

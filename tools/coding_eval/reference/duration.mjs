const UNIT_SECONDS = { d: 86400, h: 3600, m: 60, s: 1 };

export function parseDuration(text) {
  const compact = String(text).trim().toLowerCase();
  if (!compact) throw new Error('empty duration');
  const parts = compact.match(/\d+(\.\d+)?[dhms]/g);
  if (!parts || parts.join('') !== compact.replace(/\s+/g, '')) throw new Error(`unknown duration: ${text}`);
  return parts.reduce((total, part) => {
    const unit = part.slice(-1);
    return total + Number(part.slice(0, -1)) * UNIT_SECONDS[unit];
  }, 0);
}

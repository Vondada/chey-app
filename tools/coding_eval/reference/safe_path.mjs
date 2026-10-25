const ENCODED_SEPARATOR = /%(2e|2f|5c)/i;

export function safeJoinPath(base, userPath) {
  if (typeof base !== 'string' || typeof userPath !== 'string') throw new TypeError('base and userPath must be strings');
  if (!base.startsWith('/')) throw new Error('base must be an absolute path');
  if (userPath.includes('\0') || userPath.includes('\\')) throw new Error('unsafe character in path');
  if (ENCODED_SEPARATOR.test(userPath)) throw new Error('encoded separators are not allowed');
  if (userPath.startsWith('/')) throw new Error('absolute paths are not allowed');
  const root = base.replace(/\/+$/, '') || '/';
  const parts = [];
  for (const segment of userPath.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (parts.length === 0) throw new Error('path leaves its base');
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  const joined = parts.join('/');
  return joined ? `${root}/${joined}` : root;
}

// Code citations checked against the source CHE actually read (owner, 2026-11-06). Jay's screen audit (certification
// run 42179558904) answered from the source-analysis route with six findings that quoted code which is not in CHE's
// files ("che_desk: _desk", "ChartBar(feed: _feed)", "conversation ?? CheOfficeConversation()") at line numbers that
// do not hold it. The model saw only excerpts, so every quoted snippet, code name and line it cites must be in those
// excerpts; a finding that cites anything else is removed and said so. Pure: no storage, no network, no model.

const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
// Words that are prose or Dart/JS keywords, never a claim about CHE's code.
const COMMON = new Set(['null', 'true', 'false', 'const', 'final', 'var', 'let', 'new', 'return', 'if', 'else', 'this', 'await', 'async', 'void', 'class', 'import', 'export', 'function', 'widget', 'string', 'int', 'double', 'bool', 'list', 'map', 'object', 'dynamic']);

/** Code-looking names in [s]: identifiers with a capital inside, an underscore or a dot, or a call. */
function codeNames(s) {
  const out = new Set();
  for (const m of String(s).matchAll(/[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/g)) {
    const w = m[0];
    if (w.length < 3 || COMMON.has(w.toLowerCase())) continue;
    if (/[a-z][A-Z]|_|\.|^[A-Z][a-z]+[A-Z]/.test(w)) out.add(w);
  }
  return [...out];
}

/** What one finding claims: quoted snippets (fenced or inline code), code names inside them, and file:line pairs. */
export function citationsOf(text) {
  const t = String(text || '');
  const snippets = [];
  for (const m of t.matchAll(/```[a-z]*\n?([\s\S]*?)```/g)) snippets.push(m[1]);
  for (const m of t.replace(/```[\s\S]*?```/g, ' ').matchAll(/`([^`\n]+)`/g)) snippets.push(m[1]);
  const lines = [];
  for (const m of t.matchAll(/([\w./-]+\.(?:dart|js|mjs|ts|py|swift|kt))\**\s*\(?\s*(?:line|ln|l\.)\s*(\d+)/gi)) lines.push({ path: m[1], line: Number(m[2]) });
  return { snippets, names: [...new Set(snippets.flatMap(codeNames))], lines };
}

/**
 * Checks each numbered finding of [text] against the excerpts in [files] ({path, excerpt}). Returns the text with the
 * findings that cite code CHE did not read removed, the removed findings, and whether any finding survived.
 */
export function verifyCitations(text, files = []) {
  const excerpts = files.map((f) => ({ path: String(f.path || ''), text: String(f.excerpt || f.text || '') }));
  const all = norm(excerpts.map((e) => e.text).join('\n'));
  const byFile = (p) => excerpts.find((e) => e.path === p || e.path.endsWith(`/${p}`) || p.endsWith(`/${e.path.split('/').pop()}`));
  const problems = (item) => {
    const c = citationsOf(item);
    const why = [];
    for (const s of c.snippets) {
      const n = norm(s);
      if (n.length >= 12 && /[(){}=:;]/.test(n) && !all.includes(n)) why.push(`quoted code not in the files read: "${n.slice(0, 60)}"`);
    }
    for (const name of c.names) if (!all.includes(name)) why.push(`names ${name}, which is not in the files read`);
    for (const { path, line } of c.lines) {
      const file = byFile(path);
      const shown = file ? file.text.split('\n') : [];
      if (!file) why.push(`cites ${path}, which was not read`);
      else if (line > shown.length) why.push(`cites ${path} line ${line}, past what was read (${shown.length} lines)`);
      else if (c.names.length && !c.names.some((name) => shown.slice(Math.max(0, line - 3), line + 2).join('\n').includes(name))) why.push(`cites ${path} line ${line}, which does not hold that code`);
    }
    return why;
  };
  const parts = String(text || '').split(/(?=^\s*\d+[.)]\s)/m);
  const numbered = parts.filter((p) => /^\s*\d+[.)]\s/.test(p));
  if (!numbered.length) {
    const why = problems(text);
    return why.length ? { text: '', removed: [{ finding: String(text).slice(0, 200), why }], kept: 0 } : { text: String(text), removed: [], kept: 1 };
  }
  const removed = [];
  const out = [];
  for (const p of parts) {
    if (!/^\s*\d+[.)]\s/.test(p)) { out.push(p); continue; }
    const why = problems(p);
    if (why.length) removed.push({ finding: norm(p).slice(0, 200), why });
    else out.push(p);
  }
  return { text: out.join('').trim(), removed, kept: numbered.length - removed.length };
}

/** The owner-facing answer after the check: verified findings only, and plainly what was removed. */
export function citedAnswer(text, files = []) {
  const v = verifyCitations(text, files);
  if (!v.removed.length) return String(text);
  // The note says why, never repeats the invented code it removed.
  const note = `I removed ${v.removed.length} ${v.removed.length === 1 ? 'finding' : 'findings'} that cited code I did not read: the quoted code, names or line numbers are not in the source files I was given.`;
  if (!v.kept) return `I could not verify any finding against the source I read, sir, so I am not giving you one. ${note} Nothing was changed and no job was started.`;
  return `${v.text}\n\n${note} Only findings whose code I could find in the source are listed.`;
}

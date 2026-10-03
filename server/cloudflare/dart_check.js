// Pre-flight static checks for CHE's crew: catch the analyze-class mistakes
// (unbalanced delimiters, leftover placeholders, unused imports, undefined
// obvious refs) BEFORE a change is ever proposed — not after a failed build.
// This is not a full Dart analyzer, but it blocks the errors that actually
// break builds most often.

// Strip strings and comments so brace/paren counting isn't fooled by them.
// Handles Dart raw strings (r'...'), triple-quoted strings, nested block
// comments and string interpolation (`${map['key']}`), whose inner quotes
// used to desynchronise the scanner and produce false "unused import" /
// "mismatched brace" failures on large real files such as lib/main.dart.
export function stripStringsAndComments(src, { lang = 'dart' } = {}) {
  const text = String(src || '');
  const n = text.length;
  let i = 0;

  const lastSignificant = (out) => {
    for (let k = out.length - 1; k >= 0; k -= 1) {
      if (!/\s/.test(out[k])) return out.slice(Math.max(0, k - 6), k + 1);
    }
    return '';
  };

  // Scans code until an unmatched '}' (when insideInterpolation) or EOF.
  const scanCode = (insideInterpolation) => {
    let out = '';
    let depth = 0;
    while (i < n) {
      const c = text[i];
      const d = text[i + 1];
      if (c === '/' && d === '/') { while (i < n && text[i] !== '\n') i += 1; continue; }
      if (c === '/' && d === '*') {
        let nest = 0;
        while (i < n) {
          if (text[i] === '/' && text[i + 1] === '*') { nest += 1; i += 2; continue; }
          if (text[i] === '*' && text[i + 1] === '/') { nest -= 1; i += 2; if (nest <= 0 || lang !== 'dart') break; continue; }
          i += 1;
        }
        continue;
      }
      if (lang === 'js' && c === '/') {
        const before = lastSignificant(out);
        const regexContext = !before || /[(,=:\[!&|?{};+\-*%<>~^]$/.test(before) || /\b(?:return|typeof|case|in|of|delete|void|throw|new)$/.test(before);
        if (regexContext) {
          i += 1;
          let inClass = false;
          while (i < n && text[i] !== '\n') {
            if (text[i] === '\\') { i += 2; continue; }
            if (text[i] === '[') inClass = true;
            else if (text[i] === ']') inClass = false;
            else if (text[i] === '/' && !inClass) { i += 1; break; }
            i += 1;
          }
          while (i < n && /[a-z]/i.test(text[i])) i += 1;
          out += '/r/';
          continue;
        }
      }
      const raw = lang === 'dart' && (c === 'r' || c === 'R') && (d === "'" || d === '"') && !/[A-Za-z0-9_$]/.test(text[i - 1] || '');
      if (raw || c === "'" || c === '"' || (lang === 'js' && c === '`')) {
        if (raw) i += 1;
        scanString(raw);
        out += '""';
        continue;
      }
      if (insideInterpolation) {
        if (c === '{') depth += 1;
        if (c === '}') {
          if (depth === 0) { i += 1; return out; }
          depth -= 1;
        }
      }
      out += c;
      i += 1;
    }
    return out;
  };

  const scanString = (raw) => {
    const q = text[i];
    const triple = text.slice(i, i + 3) === q + q + q;
    const close = triple ? q + q + q : q;
    i += close.length;
    const interpolates = !raw && (lang === 'dart' || q === '`');
    while (i < n) {
      if (!raw && text[i] === '\\') { i += 2; continue; }
      if (text.slice(i, i + close.length) === close) { i += close.length; return; }
      if (interpolates && text[i] === '$' && text[i + 1] === '{') {
        i += 2;
        scanCode(true);
        continue;
      }
      if (!triple && q !== '`' && text[i] === '\n') { i += 1; return; }
      i += 1;
    }
  };

  return scanCode(false);
}

function balanced(code, path) {
  const pairs = { ')': '(', ']': '[', '}': '{' };
  const opens = new Set(['(', '[', '{']);
  const stack = [];
  for (const ch of code) {
    if (opens.has(ch)) stack.push(ch);
    else if (pairs[ch]) {
      if (stack.pop() !== pairs[ch]) return `${path}: mismatched '${ch}'.`;
    }
  }
  if (stack.length) return `${path}: ${stack.length} unclosed '${stack[stack.length - 1]}' — check braces/parentheses.`;
  return null;
}

// Imported symbols that are never referenced → Dart 'unused_import' warning,
// which fails `flutter analyze`. Checks local part-imports only (package/dart
// imports are too dynamic to judge safely).
function unusedLocalImports(src, stripped, path) {
  // A library with `part` files shares its imports with them; usages live in
  // the parts, which this single-file check cannot see.
  if (/^\s*part\s+'[^']+'\s*;/m.test(src)) return null;
  const importRe = /import\s+'([^']+)'(?:\s+as\s+(\w+))?(?:\s+show\s+([^;]+))?;/g;
  let m;
  while ((m = importRe.exec(src))) {
    const uri = m[1];
    const alias = m[2];
    const shown = m[3];
    if (alias) {
      const used = new RegExp(`\\b${alias}\\s*\\.`).test(stripped);
      if (!used) return `${path}: import '${uri}' as ${alias} is unused (would fail analyze).`;
    } else if (shown) {
      for (const name of shown.split(',').map((s) => s.trim()).filter(Boolean)) {
        const bare = name.replace(/\s+as\s+\w+/, '').trim();
        // The import line itself is one occurrence; a real use is a second.
        const ident = bare.replace(/[^\w$]/g, '');
        const uses = ident ? (stripped.match(new RegExp(`(?<![\\w$])${ident.replace(/\$/g, '\\$')}(?![\\w$])`, 'g')) || []).length : 1;
        if (ident && uses < 2) {
          return `${path}: import '${uri}' shows ${bare}, which is unused.`;
        }
      }
    }
  }
  return null;
}

export function dartStaticCheck(path, content) {
  const src = String(content || '');
  if (!src.trim()) return `${path}: empty file.`;
  // Leftover model placeholders that mean the patch is incomplete.
  const placeholder = /(\.\.\.\s*rest\s+unchanged|\/\/\s*(?:TODO|FIXME|\.\.\.|rest of|unchanged|your code here)|<placeholder>|INSERT[_ ]HERE)/i;
  if (placeholder.test(src)) return `${path}: contains a placeholder / "rest unchanged" — the file must be complete.`;
  const stripped = stripStringsAndComments(src);
  return balanced(stripped, path) || unusedLocalImports(src, stripped, path) || null;
}

export function checkDartFiles(files) {
  for (const f of files) {
    if (!/\.dart$/.test(f.path)) continue;
    const err = dartStaticCheck(f.path, f.content);
    if (err) return err;
  }
  return null;
}

export function jsStaticCheck(path, content) {
  const src = String(content || '');
  if (!src.trim()) return `${path}: empty file.`;
  const placeholder = /(\.\.\.\s*rest\s+unchanged|\/\/\s*(?:\.\.\.|rest of (?:the )?(?:file|code)|unchanged|your code here)\b|<placeholder>|INSERT[_ ]HERE)/i;
  if (placeholder.test(src)) return `${path}: contains a placeholder / "rest unchanged" — the file must be complete.`;
  return balanced(stripStringsAndComments(src, { lang: 'js' }), path);
}

export function staticCheckFor(path, content) {
  if (/\.dart$/.test(path)) return dartStaticCheck(path, content);
  if (/\.(?:m?js|cjs)$/.test(path)) return jsStaticCheck(path, content);
  return null;
}

// Baseline-relative static validation: a change is rejected only for problems
// it introduces. A pre-existing quirk in a file (or a scanner limitation) must
// never make every future edit to that file impossible.
export function staticRegression(path, before, after) {
  const now = staticCheckFor(path, after);
  if (!now) return null;
  if (typeof before === 'string' && before.length) {
    const was = staticCheckFor(path, before);
    if (was && was === now) return null;
  }
  return now;
}

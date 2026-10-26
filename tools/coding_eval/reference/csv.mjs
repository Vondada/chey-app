export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let i = 0;
  if (text === '') return rows;
  while (i < text.length) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i += 2; continue; }
      if (ch === '"') { quoted = false; i++; continue; }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') { quoted = true; i++; continue; }
    if (ch === ',') { row.push(field); field = ''; i++; continue; }
    if (ch === '\r' && text[i + 1] === '\n') { row.push(field); rows.push(row); row = []; field = ''; i += 2; continue; }
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += ch;
    i++;
  }
  if (quoted) throw new Error('unclosed quote');
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

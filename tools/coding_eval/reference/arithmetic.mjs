export function evalArithmetic(text) {
  if (typeof text !== 'string') throw new TypeError('expression must be a string');
  const tokens = text.match(/\d+(\.\d+)?|[-+*/^()]|\S/g) || [];
  if (tokens.join('') !== text.replace(/\s+/g, '')) throw new SyntaxError('unsupported character');
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];
  const expect = (t) => { if (next() !== t) throw new SyntaxError(`expected ${t}`); };

  function primary() {
    const t = next();
    if (t === undefined) throw new SyntaxError('unexpected end');
    if (t === '-') return -unary();
    if (t === '(') { const v = expression(); expect(')'); return v; }
    if (/^\d/.test(t)) return Number(t);
    throw new SyntaxError(`unexpected ${t}`);
  }
  function unary() { return primary(); }
  function power() {
    const base = primary();
    if (peek() === '^') { next(); return base ** power(); }
    return base;
  }
  function term() {
    let v = power();
    while (peek() === '*' || peek() === '/') {
      const op = next();
      const r = power();
      if (op === '/') {
        if (r === 0) throw new RangeError('division by zero');
        v /= r;
      } else v *= r;
    }
    return v;
  }
  function expression() {
    let v = term();
    while (peek() === '+' || peek() === '-') {
      const op = next();
      const r = term();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  }

  const value = expression();
  if (pos !== tokens.length) throw new SyntaxError('unexpected trailing input');
  return value;
}

Write `arithmetic.mjs`, an ES module with a named export `evalArithmetic(text)`. It evaluates a plain arithmetic expression that a user typed.

- Supported: integers and decimals, `+ - * / ^` (power, right-associative), parentheses, unary minus, and spaces.
- Precedence: `^` binds tighter than `* /`, which bind tighter than `+ -`.
- `2^3^2` is `2^(3^2)`, which is `512`.
- Division by zero throws `RangeError`.
- Anything else throws `SyntaxError`: letters, function calls, property access, other symbols, empty input, unbalanced parentheses, and two numbers in a row.
- Never run the text as JavaScript. Do not use `eval`, `Function`, `new Function` or `require`.
- A non-string argument throws `TypeError`.

Example: `2+3*(4-1)` returns `11`.

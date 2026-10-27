Write `csv.mjs`, an ES module with a named export `parseCsv(text)`.

Follow RFC 4180:

- Fields are separated by commas.
- A double-quoted field may contain commas, line breaks and escaped quotes (`""` means one `"`).
- Accept both `\n` and `\r\n` line endings.
- A trailing line break does not create an empty row.
- Empty fields are kept: `a,,b` gives `['a','','b']`.
- Empty text returns `[]`.
- An unclosed quote throws `Error`.

Return an array of rows, and each row is an array of strings.

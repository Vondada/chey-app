// Minimal MessagePack encoder for request bodies. Fish Audio's official SDKs
// send their text-to-speech request as application/msgpack, so CHE does too.
// Supports null, booleans, numbers, strings, byte arrays, arrays and plain maps.

export function encodeMsgpack(value) {
  const out = [];
  const pushUint = (number, size) => {
    for (let i = size - 1; i >= 0; i -= 1) out.push(Math.floor(number / 2 ** (8 * i)) & 0xff);
  };
  const pushBytes = (bytes) => { for (const b of bytes) out.push(b); };
  const pushLength = (length, small, smallMax, codes) => {
    if (small !== null && length <= smallMax) out.push(small | length);
    else if (codes[0] !== null && length < 0x100) { out.push(codes[0]); pushUint(length, 1); }
    else if (length < 0x10000) { out.push(codes[1]); pushUint(length, 2); }
    else { out.push(codes[2]); pushUint(length, 4); }
  };
  const write = (v) => {
    if (v === null || v === undefined) { out.push(0xc0); return; }
    if (v === false) { out.push(0xc2); return; }
    if (v === true) { out.push(0xc3); return; }
    if (typeof v === 'number') {
      if (Number.isInteger(v) && Math.abs(v) <= Number.MAX_SAFE_INTEGER) {
        if (v >= 0) {
          if (v < 0x80) out.push(v);
          else if (v < 0x100) { out.push(0xcc); pushUint(v, 1); }
          else if (v < 0x10000) { out.push(0xcd); pushUint(v, 2); }
          else if (v < 0x100000000) { out.push(0xce); pushUint(v, 4); }
          else { out.push(0xcf); pushBytes(bigEndian(BigInt(v), 8)); }
        } else if (v >= -32) out.push(v & 0xff);
        else if (v >= -0x80) { out.push(0xd0); out.push(v & 0xff); }
        else if (v >= -0x8000) { out.push(0xd1); pushBytes(bigEndian(BigInt(v), 2)); }
        else if (v >= -0x80000000) { out.push(0xd2); pushBytes(bigEndian(BigInt(v), 4)); }
        else { out.push(0xd3); pushBytes(bigEndian(BigInt(v), 8)); }
        return;
      }
      const view = new DataView(new ArrayBuffer(8));
      view.setFloat64(0, v);
      out.push(0xcb);
      pushBytes(new Uint8Array(view.buffer));
      return;
    }
    if (typeof v === 'string') {
      const bytes = new TextEncoder().encode(v);
      pushLength(bytes.length, 0xa0, 31, [0xd9, 0xda, 0xdb]);
      pushBytes(bytes);
      return;
    }
    if (v instanceof Uint8Array) {
      pushLength(v.length, null, -1, [0xc4, 0xc5, 0xc6]);
      pushBytes(v);
      return;
    }
    if (Array.isArray(v)) {
      pushLength(v.length, 0x90, 15, [null, 0xdc, 0xdd]);
      for (const item of v) write(item);
      return;
    }
    if (typeof v === 'object') {
      const entries = Object.entries(v).filter(([, item]) => item !== undefined);
      pushLength(entries.length, 0x80, 15, [null, 0xde, 0xdf]);
      for (const [key, item] of entries) { write(key); write(item); }
      return;
    }
    throw new TypeError(`Cannot encode ${typeof v} as MessagePack`);
  };
  write(value);
  return new Uint8Array(out);
}

// Two's-complement big-endian bytes of a BigInt in `size` bytes.
function bigEndian(value, size) {
  let n = BigInt.asUintN(size * 8, value);
  const bytes = new Array(size);
  for (let i = size - 1; i >= 0; i -= 1) { bytes[i] = Number(n & 0xffn); n >>= 8n; }
  return bytes;
}

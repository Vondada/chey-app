// MessagePack decoder used only by tests, to read the bodies CHE sends to Fish.
export function decodeMsgpack(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 0;
  const uint = (size) => { let n = 0; for (let i = 0; i < size; i += 1) n = n * 256 + bytes[at++]; return n; };
  const str = (length) => { const s = new TextDecoder().decode(bytes.subarray(at, at + length)); at += length; return s; };
  const arr = (length) => Array.from({ length }, () => read());
  const map = (length) => { const out = {}; for (let i = 0; i < length; i += 1) { const k = read(); out[k] = read(); } return out; };
  function read() {
    const b = bytes[at++];
    if (b <= 0x7f) return b;
    if (b >= 0xe0) return b - 0x100;
    if ((b & 0xe0) === 0xa0) return str(b & 0x1f);
    if ((b & 0xf0) === 0x90) return arr(b & 0x0f);
    if ((b & 0xf0) === 0x80) return map(b & 0x0f);
    switch (b) {
      case 0xc0: return null;
      case 0xc2: return false;
      case 0xc3: return true;
      case 0xcc: return uint(1);
      case 0xcd: return uint(2);
      case 0xce: return uint(4);
      case 0xd0: { const v = view.getInt8(at); at += 1; return v; }
      case 0xd1: { const v = view.getInt16(at); at += 2; return v; }
      case 0xd2: { const v = view.getInt32(at); at += 4; return v; }
      case 0xcb: { const v = view.getFloat64(at); at += 8; return v; }
      case 0xd9: return str(uint(1));
      case 0xda: return str(uint(2));
      case 0xdb: return str(uint(4));
      case 0xdc: return arr(uint(2));
      case 0xdd: return arr(uint(4));
      case 0xde: return map(uint(2));
      case 0xdf: return map(uint(4));
      default: throw new Error(`Unsupported MessagePack byte 0x${b.toString(16)}`);
    }
  }
  return read();
}

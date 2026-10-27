export class LruCache {
  #capacity;
  #map = new Map();

  constructor(capacity) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError('capacity must be a positive integer');
    this.#capacity = capacity;
  }

  get size() {
    return this.#map.size;
  }

  has(key) {
    return this.#map.has(key);
  }

  get(key) {
    if (!this.#map.has(key)) return undefined;
    const value = this.#map.get(key);
    this.#map.delete(key);
    this.#map.set(key, value);
    return value;
  }

  set(key, value) {
    if (this.#map.has(key)) this.#map.delete(key);
    else if (this.#map.size >= this.#capacity) this.#map.delete(this.#map.keys().next().value);
    this.#map.set(key, value);
  }

  delete(key) {
    return this.#map.delete(key);
  }
}

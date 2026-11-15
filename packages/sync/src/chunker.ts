// Content-defined chunking (gear rolling hash, FastCDC-style cut points).
// Small records stay one chunk; a large blob is cut where its content says so,
// so an edit near the end of a long document only changes the last chunk(s).

export type ChunkParams = { min: number; avg: number; max: number };

export const DEFAULT_CHUNKS: ChunkParams = { min: 256 * 1024, avg: 1024 * 1024, max: 4 * 1024 * 1024 };

// Deterministic 256-entry gear table (xorshift32). Every device must use the same table.
const GEAR = (() => {
  const table = new Uint32Array(256);
  let x = 0x9e3779b9;
  for (let i = 0; i < 256; i += 1) {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    table[i] = x;
  }
  return table;
})();

export function chunk(data: Uint8Array, params: ChunkParams = DEFAULT_CHUNKS): Uint8Array[] {
  if (data.length <= params.min) return [data];
  const bits = Math.max(1, Math.round(Math.log2(params.avg)));
  const mask = ((1 << Math.min(bits, 31)) - 1) >>> 0;
  const out: Uint8Array[] = [];
  let start = 0;
  while (start < data.length) {
    const remaining = data.length - start;
    if (remaining <= params.min) {
      out.push(data.subarray(start));
      break;
    }
    const end = Math.min(start + params.max, data.length);
    let hash = 0;
    let cut = end;
    for (let i = start + params.min; i < end; i += 1) {
      hash = ((hash << 1) + GEAR[data[i]]) >>> 0;
      if ((hash & mask) === 0) {
        cut = i + 1;
        break;
      }
    }
    out.push(data.subarray(start, cut));
    start = cut;
  }
  return out;
}

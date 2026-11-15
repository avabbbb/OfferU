// Minimal ZIP reader for OOXML (PPTX): central directory + stored/deflate entries.
// Inflate uses the platform DecompressionStream("deflate-raw"), present in
// browsers, Cloudflare Workers and Node 22, so this runs on every runtime.

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  offset: number;
}

export class ZipError extends Error {}

const u16 = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8);
const u32 = (b: Uint8Array, at: number) => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16)) + b[at + 3] * 0x1000000;

export function zipEntries(bytes: Uint8Array): ZipEntry[] {
  // End of central directory: scan back over the max comment length.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i -= 1) {
    if (u32(bytes, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new ZipError("not a zip");
  const count = u16(bytes, eocd + 10);
  let at = u32(bytes, eocd + 16);
  const decoder = new TextDecoder();
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i += 1) {
    if (at + 46 > bytes.length || u32(bytes, at) !== 0x02014b50) throw new ZipError("bad central directory");
    const nameLength = u16(bytes, at + 28);
    const extra = u16(bytes, at + 30);
    const comment = u16(bytes, at + 32);
    entries.push({
      method: u16(bytes, at + 10),
      compressedSize: u32(bytes, at + 20),
      size: u32(bytes, at + 24),
      offset: u32(bytes, at + 42),
      name: decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength)),
    });
    at += 46 + nameLength + extra + comment;
  }
  return entries;
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as unknown as ArrayBuffer]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function zipRead(bytes: Uint8Array, entry: ZipEntry): Promise<Uint8Array> {
  const at = entry.offset;
  if (u32(bytes, at) !== 0x04034b50) throw new ZipError("bad local header");
  const start = at + 30 + u16(bytes, at + 26) + u16(bytes, at + 28);
  const data = bytes.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return data;
  if (entry.method === 8) return inflateRaw(data);
  throw new ZipError(`unsupported zip method ${entry.method}`);
}

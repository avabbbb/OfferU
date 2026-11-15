// 校徽抠成透明底（port of services/web_assets.transparent_logo, the numpy part）. Works on a decoded RGBA buffer so it
// runs anywhere; decoding/encoding PNG/JPEG is the caller's job (companion: pngjs / jpeg-js; browser: canvas).
//
// 从四条边连通、颜色接近边框主色的像素变透明；校徽内部和背景同色的区域不动；轮廓外一圈按色差给半透明。
// 只抠白底/黑底：彩色方块底本身就是校徽的一部分，原样保留。

export type Rgba = { width: number; height: number; data: Uint8Array };

/** PIL Image.thumbnail target size: fit inside max×max, keep aspect, never upscale. */
export function thumbnailSize(width: number, height: number, max = 800): [number, number] {
  if (width <= max && height <= max) return [width, height];
  let x = max;
  let y = max;
  const aspect = width / height;
  const roundAspect = (value: number, key: (n: number) => number) => {
    const lo = Math.floor(value);
    const hi = Math.ceil(value);
    return Math.max(key(lo) <= key(hi) ? lo : hi, 1);
  };
  if (x / y >= aspect) x = roundAspect(y * aspect, (n) => Math.abs(aspect - n / y));
  else y = roundAspect(x / aspect, (n) => (n === 0 ? 0 : Math.abs(aspect - x / n)));
  return [x, y];
}

/** Area-average downscale (PIL uses bicubic with reducing_gap; sizes match, pixels are close, not identical). */
export function resizeRgba(image: Rgba, width: number, height: number): Rgba {
  if (width === image.width && height === image.height) return image;
  const out = new Uint8Array(width * height * 4);
  const sx = image.width / width;
  const sy = image.height / height;
  for (let y = 0; y < height; y += 1) {
    const y0 = y * sy;
    const y1 = Math.min(image.height, (y + 1) * sy);
    for (let x = 0; x < width; x += 1) {
      const x0 = x * sx;
      const x1 = Math.min(image.width, (x + 1) * sx);
      const acc = [0, 0, 0, 0];
      let total = 0;
      for (let yy = Math.floor(y0); yy < Math.ceil(y1); yy += 1) {
        const wy = Math.min(yy + 1, y1) - Math.max(yy, y0);
        for (let xx = Math.floor(x0); xx < Math.ceil(x1); xx += 1) {
          const wx = Math.min(xx + 1, x1) - Math.max(xx, x0);
          const w = wx * wy;
          const at = (yy * image.width + xx) * 4;
          const a = image.data[at + 3] * w; // premultiply so transparent pixels don't bleed colour
          acc[0] += image.data[at] * a; acc[1] += image.data[at + 1] * a; acc[2] += image.data[at + 2] * a; acc[3] += a;
          total += w;
        }
      }
      const at = (y * width + x) * 4;
      const alpha = acc[3] / total;
      out[at + 3] = Math.round(alpha);
      for (let c = 0; c < 3; c += 1) out[at + c] = acc[3] ? Math.round(acc[c] / acc[3]) : 0;
    }
  }
  return { width, height, data: out };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** numpy round(): half to even. */
function roundHalfEven(value: number): number {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

/** Cut out a white/black background connected to the border. Returns a new buffer (input untouched). */
export function transparentLogoRgba(input: Rgba, maxSide = 800): Rgba {
  const [tw, th] = thumbnailSize(input.width, input.height, maxSide);
  const image = resizeRgba(input, tw, th);
  const { width: w, height: h } = image;
  const px = image.data;
  const border: number[] = [];
  for (let x = 0; x < w; x += 1) border.push(x);
  for (let x = 0; x < w; x += 1) border.push((h - 1) * w + x);
  for (let y = 0; y < h; y += 1) border.push(y * w);
  for (let y = 0; y < h; y += 1) border.push(y * w + w - 1);
  const opaque = border.filter((i) => px[i * 4 + 3] > 8);
  const data = new Uint8Array(px);
  if (!(opaque.length > Math.floor(border.length / 2))) return { width: w, height: h, data };
  const bg = [0, 1, 2].map((c) => median(opaque.map((i) => px[i * 4 + c])));
  const hi = Math.max(...bg);
  const lo = Math.min(...bg);
  if (!(hi - lo <= 24 && (lo >= 200 || hi <= 50))) return { width: w, height: h, data };

  const n = w * h;
  const dist = new Float64Array(n);
  const cand = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) {
    dist[i] = Math.max(Math.abs(px[i * 4] - bg[0]), Math.abs(px[i * 4 + 1] - bg[1]), Math.abs(px[i * 4 + 2] - bg[2]));
    cand[i] = px[i * 4 + 3] <= 8 || dist[i] <= 40 ? 1 : 0;
  }
  // Flood fill (4-neighbour) from border candidates = numpy's repeated grow() & cand until stable.
  const reached = new Uint8Array(n);
  const queue: number[] = [];
  for (const i of border) if (cand[i] && !reached[i]) { reached[i] = 1; queue.push(i); }
  for (let q = 0; q < queue.length; q += 1) {
    const i = queue[q];
    const x = i % w;
    const neighbours = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w];
    for (const j of neighbours) {
      if (j >= 0 && j < n && cand[j] && !reached[j]) { reached[j] = 1; queue.push(j); }
    }
  }
  for (let i = 0; i < n; i += 1) {
    if (reached[i]) { data[i * 4 + 3] = 0; continue; }
    const x = i % w;
    const touches = (x > 0 && reached[i - 1]) || (x < w - 1 && reached[i + 1]) || (i >= w && reached[i - w]) || (i + w < n && reached[i + w]);
    if (!touches || !(dist[i] < 100)) continue;
    const soft = Math.min(1, Math.max(0, (dist[i] - 40) / 60));
    data[i * 4 + 3] = roundHalfEven(Math.fround(px[i * 4 + 3] * soft));
  }
  return { width: w, height: h, data };
}

// PNG / JPEG ↔ RGBA with pure-JS codecs (fast-png, jpeg-js): no native modules, so it also runs on a Worker.
// Python used Pillow, which also opens GIF/WebP/BMP; those now get the same "不是能识别的图片" 400.

import { CoreError, transparentLogoRgba, type Rgba } from "@offeru/core";
import { decode as decodePng, encode as encodePng, hasPngSignature, type DecodedPng } from "fast-png";
import jpeg from "jpeg-js";

const NOT_IMAGE = "不是能识别的图片";

function unpack(png: DecodedPng): Uint8Array {
  // Samples as 8-bit, one per channel; sub-byte greyscale / indices unpacked row by row.
  const { width, height, depth, channels } = png;
  const samples = width * height * channels;
  const out = new Uint8Array(samples);
  if (depth === 8) out.set(png.data as Uint8Array);
  else if (depth === 16) for (let i = 0; i < samples; i += 1) out[i] = (png.data as Uint16Array)[i] >> 8;
  else {
    const rowBytes = Math.ceil((width * channels * depth) / 8);
    const data = png.data as Uint8Array;
    const max = (1 << depth) - 1;
    const scale = png.palette ? 1 : 255 / max;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width * channels; x += 1) {
        const bit = x * depth;
        const byte = data[y * rowBytes + (bit >> 3)];
        const value = (byte >> (8 - depth - (bit & 7))) & max;
        out[y * width * channels + x] = Math.round(value * scale);
      }
    }
  }
  return out;
}

function pngToRgba(png: DecodedPng): Rgba {
  const { width, height, channels } = png;
  const src = unpack(png);
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const o = i * 4;
    if (png.palette) {
      const color = png.palette[src[i]] ?? [0, 0, 0, 0];
      rgba[o] = color[0]; rgba[o + 1] = color[1]; rgba[o + 2] = color[2]; rgba[o + 3] = color[3] ?? 255;
    } else if (channels === 1 || channels === 2) {
      const g = src[i * channels];
      rgba[o] = g; rgba[o + 1] = g; rgba[o + 2] = g; rgba[o + 3] = channels === 2 ? src[i * 2 + 1] : 255;
    } else {
      rgba[o] = src[i * channels]; rgba[o + 1] = src[i * channels + 1]; rgba[o + 2] = src[i * channels + 2];
      rgba[o + 3] = channels === 4 ? src[i * 4 + 3] : 255;
    }
  }
  return { width, height, data: rgba };
}

/** Decode PNG or JPEG into RGBA; anything else (or a broken file) is CoreError invalid. */
export function decodeImage(bytes: Uint8Array): Rgba {
  try {
    if (hasPngSignature(bytes)) return pngToRgba(decodePng(bytes));
    if (bytes[0] === 0xff && bytes[1] === 0xd8) {
      const img = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 512 });
      return { width: img.width, height: img.height, data: new Uint8Array(img.data) };
    }
  } catch {
    // fall through
  }
  throw new CoreError(NOT_IMAGE);
}

export function encodeRgbaPng(image: Rgba): Uint8Array {
  return encodePng({ width: image.width, height: image.height, data: image.data, channels: 4, depth: 8 });
}

/** services/web_assets.transparent_logo: bytes in, transparent PNG bytes out. */
export function transparentLogo(bytes: Uint8Array, maxSide = 800): Uint8Array {
  return encodeRgbaPng(transparentLogoRgba(decodeImage(bytes), maxSide));
}

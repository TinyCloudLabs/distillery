// Generate the PWA icon set: a droplet mark (distillery) on the Folio dark
// field. No deps, no network — pixels are rasterized here and encoded as PNG
// by hand (zlib via node:zlib, CRC32 below).
//
//   bun scripts/make-icons.ts        → writes feed/web/public/icons/*.png
//
// Output: icon-192, icon-512 (purpose any), icon-maskable-192/512 (mark
// shrunk into the 80% safe zone), apple-touch-icon (180px).

import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ---- palette (DESIGN_MEMORY tokens) ----
const BG: RGB = [0x0d, 0x0d, 0x0e];
const INK: RGB = [0xeb, 0xea, 0xe6];

type RGB = [number, number, number];

// ---- PNG encoder (truecolor 8-bit, no alpha) ----

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function encodePng(size: number, rgb: Uint8Array): Uint8Array {
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, size);
  dv.setUint32(4, size);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor
  // 10..12: compression / filter / interlace = 0

  // raw scanlines, filter byte 0 per row
  const raw = new Uint8Array(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) {
    raw.set(rgb.subarray(y * size * 3, (y + 1) * size * 3), y * (size * 3 + 1) + 1);
  }
  const idat = new Uint8Array(deflateSync(raw, { level: 9 }));

  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const parts = [sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", new Uint8Array(0))];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// ---- droplet rasterizer ----
//
// The mark in unit coordinates: a circle bulb at C=(0.5, 0.60), r=0.21, with
// a tapering cone up to the apex A=(0.5, 0.22). `scale` shrinks the mark
// about the icon center (maskable safe zone).

function insideDroplet(x: number, y: number, scale: number): boolean {
  // un-scale about center
  const ux = 0.5 + (x - 0.5) / scale;
  const uy = 0.5 + (y - 0.5) / scale;

  const cx = 0.5;
  const cy = 0.6;
  const r = 0.21;
  const ax = 0.5;
  const ay = 0.22;

  // bulb
  const dx = ux - cx;
  const dy = uy - cy;
  if (dx * dx + dy * dy <= r * r) return true;

  // taper: the cone bounded by the two tangent lines from the apex to the
  // bulb, clipped at the tangent points so the join is smooth (no notches).
  const len = cy - ay;
  const sin = r / len;
  if (sin >= 1) return false; // apex inside the bulb — circle only
  const tan = sin / Math.sqrt(1 - sin * sin);
  const sT = len * (1 - sin * sin); // axial distance of the tangent points
  const s = uy - ay;
  if (s < 0 || s > sT) return false;
  return Math.abs(ux - ax) <= s * tan;
}

function render(size: number, scale: number): Uint8Array {
  const rgb = new Uint8Array(size * size * 3);
  const SS = 4; // supersampling grid per axis
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let hit = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) / SS) / size;
          const y = (py + (sy + 0.5) / SS) / size;
          if (insideDroplet(x, y, scale)) hit++;
        }
      }
      const a = hit / (SS * SS);
      const i = (py * size + px) * 3;
      rgb[i] = Math.round(BG[0] + (INK[0] - BG[0]) * a);
      rgb[i + 1] = Math.round(BG[1] + (INK[1] - BG[1]) * a);
      rgb[i + 2] = Math.round(BG[2] + (INK[2] - BG[2]) * a);
    }
  }
  return rgb;
}

const outDir = join(import.meta.dir, "..", "web", "public", "icons");
mkdirSync(outDir, { recursive: true });

const FULL = 1.0; // mark drawn at natural size
const SAFE = 0.72; // maskable: mark inside the 80% safe-zone circle

const files: Array<[string, number, number]> = [
  ["icon-192.png", 192, FULL],
  ["icon-512.png", 512, FULL],
  ["icon-maskable-192.png", 192, SAFE],
  ["icon-maskable-512.png", 512, SAFE],
  ["apple-touch-icon.png", 180, 0.85],
];

for (const [name, size, scale] of files) {
  const png = encodePng(size, render(size, scale));
  writeFileSync(join(outDir, name), png);
  console.log(`${name}  ${size}x${size}  ${png.length} bytes`);
}

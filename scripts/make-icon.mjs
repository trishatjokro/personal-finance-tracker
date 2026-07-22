/**
 * Draws the bow mark as a 1024px PNG for the macOS app icon.
 *
 * Written against node:zlib directly rather than pulling in an image library —
 * the shapes are ellipses and polygons, which are just inequalities, and the
 * PNG container is a handful of length-prefixed chunks.
 *
 *   node scripts/make-icon.mjs  ->  build/icon.png
 */

import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";

const SIZE = 1024;
const SS = 3; // supersampling factor per axis, for antialiased edges

const hex = (h) => [
  parseInt(h.slice(1, 3), 16),
  parseInt(h.slice(3, 5), 16),
  parseInt(h.slice(5, 7), 16),
];

const BG = hex("#FBE9EF");
const LOOP = hex("#CE6D93");
const TAIL = hex("#BC5480");
const KNOT = hex("#A63A61");

/* ---------- shape tests, all in 1024-space ---------- */

function inRoundedRect(x, y, r = 225) {
  const [x0, y0, x1, y1] = [0, 0, SIZE, SIZE];
  if (x < x0 || y < y0 || x > x1 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

/** Ellipse rotated by `rot` radians about (cx, cy). */
function inEllipse(x, y, cx, cy, rx, ry, rot = 0) {
  const dx = x - cx;
  const dy = y - cy;
  const c = Math.cos(-rot);
  const s = Math.sin(-rot);
  const px = dx * c - dy * s;
  const py = dx * s + dy * c;
  return (px / rx) ** 2 + (py / ry) ** 2 <= 1;
}

function inPolygon(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * A bow loop is a teardrop: a wedge running from the knot out to a rounded
 * end. Modelled as a triangle unioned with an ellipse at the outer tip —
 * pointed where it meets the knot, full where the ribbon folds back.
 */
const LEFT_WEDGE = [[512, 498], [286, 356], [286, 634]];
const RIGHT_WEDGE = [[512, 498], [738, 356], [738, 634]];

/* Ribbon tails: narrow at the knot, widening to a notched, angled cut. */
const LEFT_TAIL = [[500, 548], [444, 562], [352, 812], [406, 802], [424, 846], [510, 600]];
const RIGHT_TAIL = [[524, 548], [580, 562], [672, 812], [618, 802], [600, 846], [514, 600]];

/** Returns the colour at a sample point, or null for transparent. */
function sample(x, y) {
  if (!inRoundedRect(x, y)) return null;

  // The tails hang well below the loops, so the shapes are drawn low and the
  // whole mark is lifted to sit on the canvas's optical centre.
  y += 74;

  if (inEllipse(x, y, 512, 502, 62, 78)) return KNOT;
  if (inPolygon(x, y, LEFT_TAIL) || inPolygon(x, y, RIGHT_TAIL)) return TAIL;

  if (inPolygon(x, y, LEFT_WEDGE) || inEllipse(x, y, 286, 495, 96, 139)) return LOOP;
  if (inPolygon(x, y, RIGHT_WEDGE) || inEllipse(x, y, 738, 495, 96, 139)) return LOOP;

  return BG;
}

/* ---------- rasterize ---------- */

const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
let p = 0;

for (let y = 0; y < SIZE; y++) {
  raw[p++] = 0; // filter type: none
  for (let x = 0; x < SIZE; x++) {
    let r = 0, g = 0, b = 0, a = 0, hits = 0;

    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const c = sample(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS);
        if (c) {
          r += c[0]; g += c[1]; b += c[2];
          hits++;
        }
        a++;
      }
    }

    if (hits === 0) {
      raw[p++] = 0; raw[p++] = 0; raw[p++] = 0; raw[p++] = 0;
    } else {
      raw[p++] = Math.round(r / hits);
      raw[p++] = Math.round(g / hits);
      raw[p++] = Math.round(b / hits);
      raw[p++] = Math.round((hits / a) * 255);
    }
  }
}

/* ---------- PNG container ---------- */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;  // bit depth
ihdr[9] = 6;  // colour type: RGBA
ihdr[10] = 0; // deflate
ihdr[11] = 0; // adaptive filtering
ihdr[12] = 0; // no interlace

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

mkdirSync("build", { recursive: true });
writeFileSync("build/icon.png", png);
console.log(`build/icon.png — ${SIZE}×${SIZE}, ${(png.length / 1024).toFixed(0)}KB`);

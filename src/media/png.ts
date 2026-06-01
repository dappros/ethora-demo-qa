import { deflateSync } from "node:zlib";

/** CRC32 (PNG) */
function crc32(buf: Uint8Array): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]!;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBytes, Buffer.from(data)]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** Encode RGBA pixel buffer (w*h*4) to a PNG Buffer. */
function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  // 10,11,12 = compression, filter, interlace = 0
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter type none
    rgba.subarray(y * stride, (y + 1) * stride).forEach((v, i) => {
      raw[y * (stride + 1) + 1 + i] = v;
    });
  }
  const idat = deflateSync(raw);
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", new Uint8Array(0))]);
}

/**
 * A simple "moonlit forest" scene: vertical night-sky gradient, a moon disc
 * with soft glow, scattered stars, and a black tree-line silhouette. Pure
 * computation — no fonts, no external assets.
 */
export function moonlitForestPng(width = 720, height = 480): Buffer {
  const rgba = new Uint8Array(width * height * 4);
  const moonX = width * 0.74, moonY = height * 0.3, moonR = Math.min(width, height) * 0.12;
  // deterministic pseudo-stars
  const stars: [number, number][] = [];
  let seed = 1337;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < 90; i++) stars.push([rnd() * width, rnd() * height * 0.7]);

  // tree-line: a jagged horizon
  const treeTop = (x: number) =>
    height * 0.72 - Math.abs(Math.sin(x * 0.045) * 36) - Math.abs(Math.sin(x * 0.011 + 2) * 60);

  for (let y = 0; y < height; y++) {
    const t = y / height;
    // sky gradient: deep indigo -> twilight purple
    let r = Math.round(18 + t * 40);
    let g = Math.round(16 + t * 26);
    let b = Math.round(46 + t * 70);
    for (let x = 0; x < width; x++) {
      let cr = r, cg = g, cb = b;
      // moon glow + disc
      const dm = Math.hypot(x - moonX, y - moonY);
      if (dm < moonR) {
        cr = 250; cg = 247; cb = 230;
      } else if (dm < moonR * 2.4) {
        const k = 1 - (dm - moonR) / (moonR * 1.4);
        cr += Math.round(120 * k); cg += Math.round(115 * k); cb += Math.round(95 * k);
      }
      // tree silhouette
      if (y > treeTop(x)) { cr = 6; cg = 10; cb = 12; }
      const o = (y * width + x) * 4;
      rgba[o] = Math.min(255, cr);
      rgba[o + 1] = Math.min(255, cg);
      rgba[o + 2] = Math.min(255, cb);
      rgba[o + 3] = 255;
    }
  }
  // stars (above tree-line)
  for (const [sx, sy] of stars) {
    const x = Math.floor(sx), y = Math.floor(sy);
    if (y < treeTop(x) - 4) {
      const o = (y * width + x) * 4;
      rgba[o] = rgba[o + 1] = rgba[o + 2] = 240;
    }
  }
  return encodePng(width, height, rgba);
}

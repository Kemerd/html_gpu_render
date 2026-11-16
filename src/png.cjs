/**
 * png.cjs: a minimal PNG writer and reader (8-bit, no interlace) on Node's zlib, so the tool needs no image library.
 *
 *   encodePng(rgba, width, height, level) -> Promise<Buffer>
 *   encodePng16(float32, width, height, level, { transfer, primaries }) -> Promise<Buffer>     16 bits per channel
 *   decodePng(buffer)                     -> { width, height, data, depth, cicp }   (data is RGBA: bytes for an
 *                                            8-bit file, a Uint16Array for a 16-bit one)
 *
 * rgba is width * height * 4 bytes of straight (not premultiplied) alpha, rows top to bottom, no padding.
 * level is the zlib level: 1 is fast and still lossless; 0 stores the pixels uncompressed.
 */
'use strict';
const zlib = require('node:zlib');

// crc32 from zlib where the runtime has it (Node 20.15+ / 22.2+), a table otherwise
const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf);
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** One PNG chunk: length, type, data, crc over type + data. */
function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, tail]);
}

/**
 * Encodes one RGBA picture as a PNG.
 * @param {Uint8Array} rgba   width * height * 4 bytes, straight alpha
 * @param {number} width
 * @param {number} height
 * @param {number} level      zlib level 0..9
 * @returns {Promise<Buffer>}
 */
function encodePng(rgba, width, height, level = 1) {
  if (!rgba || !(width > 0) || !(height > 0) || rgba.length < width * height * 4) {
    return Promise.reject(new Error(`encodePng: ${rgba ? rgba.length : 0} bytes for ${width} x ${height}`));
  }
  // every row gets a filter byte in front; filter 0 (none) keeps this a straight copy
  const stride = width * 4;
  const rows = Buffer.allocUnsafe((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    rows[y * (stride + 1)] = 0;
    rows.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;        // 8 bits, colour type 6 = RGBA
  return new Promise((res, rej) => {
    // deflate runs on the libuv pool, off the thread that takes the frames
    zlib.deflate(rows, { level }, (err, idat) => {
      if (err) return rej(err);
      const magic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      res(Buffer.concat([magic, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]));
    });
  });
}

// cICP (PNG third edition): the code points of ITU-T H.273 for what the values mean
const CICP_PRIMARIES = { srgb: 1, rec2020: 9, p3: 12 };
const CICP_TRANSFER = { linear: 8, srgb: 13, pq: 16, hlg: 18 };

/**
 * Encodes a float RGBA picture as a 16-bit PNG: each value is clipped to 0..1 and scaled to 0..65535. A cICP
 * chunk says what the values are (primaries, transfer function, RGB, full range), so a reader that knows cICP
 * (ffmpeg does) shows them correctly, PQ included.
 * @param {Float32Array} rgba   width * height * 4 values, straight alpha
 * @param {{ transfer?: string, primaries?: string }} colour
 * @returns {Promise<Buffer>}
 */
function encodePng16(rgba, width, height, level = 1, { transfer = 'srgb', primaries = 'srgb' } = {}) {
  if (!rgba || !(width > 0) || !(height > 0) || rgba.length < width * height * 4) {
    return Promise.reject(new Error(`encodePng16: ${rgba ? rgba.length : 0} values for ${width} x ${height}`));
  }
  // rows of big-endian 16-bit samples, each with a filter byte (0 = none) in front
  const stride = width * 8;
  const rows = Buffer.allocUnsafe((stride + 1) * height);
  let o = 0, i = 0;
  for (let y = 0; y < height; y++) {
    rows[o++] = 0;
    for (let x = 0; x < width * 4; x++, i++) {
      const f = rgba[i];
      // NaN compares false both ways and lands on 0
      const v = f >= 1 ? 65535 : f > 0 ? Math.round(f * 65535) : 0;
      rows[o++] = v >> 8; rows[o++] = v & 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 16; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;       // 16 bits, colour type 6 = RGBA
  // primaries, transfer, matrix 0 (RGB), 1 = full range
  const cicp = Buffer.from([CICP_PRIMARIES[primaries] || 1, CICP_TRANSFER[transfer] || 13, 0, 1]);
  return new Promise((res, rej) => {
    zlib.deflate(rows, { level }, (err, idat) => {
      if (err) return rej(err);
      const magic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      res(Buffer.concat([magic, chunk('IHDR', ihdr), chunk('cICP', cicp), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]));
    });
  });
}

/**
 * Reads an 8-bit or 16-bit RGBA or RGB, non-interlaced PNG (what browsers and this file write).
 * @param {Buffer} buf
 * @returns {{ width: number, height: number, data: Buffer }} data is RGBA; an RGB file gets alpha 255
 */
function decodePng(buf) {
  if (!buf || buf.length < 33 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error('decodePng: not a PNG');
  let p = 8, width = 0, height = 0, type = 6, depth = 8, cicp = null;
  const parts = [];
  // walk the chunks, keeping the header and the compressed picture
  while (p + 8 <= buf.length) {
    const len = buf.readUInt32BE(p);
    const name = buf.toString('latin1', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (name === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4); type = data[9]; depth = data[8];
      if ((depth !== 8 && depth !== 16) || (type !== 6 && type !== 2) || data[12] !== 0) throw new Error('decodePng: only 8-bit or 16-bit RGB / RGBA, not interlaced');
    } else if (name === 'cICP') cicp = [data[0], data[1], data[2], data[3]];
    else if (name === 'IDAT') parts.push(data);
    else if (name === 'IEND') break;
    p += 12 + len;
  }
  if (!width || !height || !parts.length) throw new Error('decodePng: no picture in the file');
  const channels = type === 6 ? 4 : 3, bpp = channels * (depth / 8), stride = width * bpp;
  const raw = zlib.inflateSync(Buffer.concat(parts));
  if (raw.length < (stride + 1) * height) throw new Error('decodePng: the picture is cut short');
  const out = depth === 16 ? new Uint16Array(width * height * 4) : Buffer.alloc(width * height * 4);
  const cur = Buffer.alloc(stride), prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    // undo the row filter (PNG specification, section 9): a = left, b = above, c = above left
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0, b = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
      let v = row[x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[x] = v & 0xff;
    }
    // widen to RGBA (16-bit samples are big-endian in the file)
    if (depth === 16) {
      for (let x = 0, o = y * width * 4; x < width; x++, o += 4) {
        for (let c = 0; c < 4; c++) out[o + c] = c < channels ? (cur[x * bpp + c * 2] << 8) | cur[x * bpp + c * 2 + 1] : 65535;
      }
    } else {
      for (let x = 0, o = y * width * 4; x < width; x++, o += 4) {
        out[o] = cur[x * bpp]; out[o + 1] = cur[x * bpp + 1]; out[o + 2] = cur[x * bpp + 2];
        out[o + 3] = bpp === 4 ? cur[x * bpp + 3] : 255;
      }
    }
    cur.copy(prev);
  }
  return { width, height, data: out, depth, cicp };
}

module.exports = { encodePng, encodePng16, decodePng };

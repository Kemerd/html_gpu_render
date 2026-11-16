/**
 * exr.cjs: a minimal OpenEXR writer and reader, enough for this tool's own frames: one part, scanlines, RGBA
 * half float, no compression, rows top to bottom.
 *
 *   encodeExr(half, width, height, { primaries }) -> Buffer      half: Uint16Array of width * height * 4 (RGBA)
 *   decodeExr(buffer) -> { width, height, data }                 data: Uint16Array RGBA (half float bits)
 *   exrSize(width, height, { primaries }) -> number              the exact size of a file encodeExr writes
 *
 * The layout follows the OpenEXR file layout document: magic and version, the header (attributes, each
 * name\0 type\0 size value), the offset table (one 64-bit offset per scanline), then per scanline: y, the byte
 * count, and the pixels channel by channel in alphabetical order (A, B, G, R). EXR alpha is premultiplied by
 * convention, and its values are scene-linear by convention; the caller is responsible for both.
 */
'use strict';

// CIE xy of red, green, blue and white (D65) for the `chromaticities` attribute
const CHROMATICITIES = {
  srgb: [0.64, 0.33, 0.30, 0.60, 0.15, 0.06, 0.3127, 0.3290],
  p3: [0.680, 0.320, 0.265, 0.690, 0.150, 0.060, 0.3127, 0.3290],
  rec2020: [0.708, 0.292, 0.170, 0.797, 0.131, 0.046, 0.3127, 0.3290],
};

/** One header attribute: name\0 type\0 size value. */
function attribute(name, type, value) {
  const head = Buffer.from(`${name}\0${type}\0`, 'latin1');
  const size = Buffer.alloc(4);
  size.writeInt32LE(value.length, 0);
  return Buffer.concat([head, size, value]);
}

/** The whole header, from the magic number to the byte that ends the attributes. */
function header(width, height, primaries) {
  // the channel list: alphabetical, each HALF (pixel type 1), not perceptually linear, sampled at every pixel
  const channels = [];
  for (const name of ['A', 'B', 'G', 'R']) {
    const c = Buffer.alloc(name.length + 1 + 16);
    c.write(name, 0, 'latin1');
    c.writeInt32LE(1, name.length + 1);          // HALF
    c.writeUInt8(0, name.length + 5);            // pLinear
    c.writeInt32LE(1, name.length + 9);          // xSampling
    c.writeInt32LE(1, name.length + 13);         // ySampling
    channels.push(c);
  }
  channels.push(Buffer.from([0]));
  const box = Buffer.alloc(16);
  box.writeInt32LE(0, 0); box.writeInt32LE(0, 4); box.writeInt32LE(width - 1, 8); box.writeInt32LE(height - 1, 12);
  const f32 = (...values) => { const b = Buffer.alloc(4 * values.length); values.forEach((v, i) => b.writeFloatLE(v, 4 * i)); return b; };
  const parts = [
    Buffer.from([0x76, 0x2f, 0x31, 0x01, 2, 0, 0, 0]),      // magic, version 2, no flags: single part, scanlines
    attribute('channels', 'chlist', Buffer.concat(channels)),
    attribute('chromaticities', 'chromaticities', f32(...(CHROMATICITIES[primaries] || CHROMATICITIES.srgb))),
    attribute('compression', 'compression', Buffer.from([0])),
    attribute('dataWindow', 'box2i', box),
    attribute('displayWindow', 'box2i', box),
    attribute('lineOrder', 'lineOrder', Buffer.from([0])),
    attribute('pixelAspectRatio', 'float', f32(1)),
    attribute('screenWindowCenter', 'v2f', f32(0, 0)),
    attribute('screenWindowWidth', 'float', f32(1)),
    Buffer.from([0]),
  ];
  return Buffer.concat(parts);
}

/** The exact size of the file for a picture of this size. */
function exrSize(width, height, { primaries = 'srgb' } = {}) {
  return header(width, height, primaries).length + height * 8 + height * (8 + width * 8);
}

/**
 * @param {Uint16Array} half   width * height * 4 half floats, RGBA, rows top to bottom
 * @returns {Buffer} the file
 */
function encodeExr(half, width, height, { primaries = 'srgb' } = {}) {
  if (!half || !(width > 0) || !(height > 0) || half.length < width * height * 4) throw new Error(`encodeExr: ${half ? half.length : 0} values for ${width} x ${height}`);
  const head = header(width, height, primaries);
  const lineBytes = width * 8;
  const file = Buffer.allocUnsafe(head.length + height * 8 + height * (8 + lineBytes));
  head.copy(file, 0);
  const tableAt = head.length, dataAt = tableAt + height * 8;
  // the pixel part is all 16-bit values at even offsets from here, so it is filled through a 16-bit view
  for (let y = 0; y < height; y++) {
    const at = dataAt + y * (8 + lineBytes);
    file.writeBigUInt64LE(BigInt(at), tableAt + y * 8);
    file.writeInt32LE(y, at);
    file.writeInt32LE(lineBytes, at + 4);
    // one scanline: all A, then all B, all G, all R
    const row = y * width * 4;
    let o = at + 8;
    for (const c of [3, 2, 1, 0]) {
      for (let x = 0; x < width; x++, o += 2) { const v = half[row + x * 4 + c]; file[o] = v & 0xff; file[o + 1] = v >> 8; }
    }
  }
  return file;
}

/** Reads a file of the kind encodeExr writes (uncompressed scanlines, HALF channels A, B, G, R). */
function decodeExr(buf) {
  if (!buf || buf.length < 16 || buf.readUInt32LE(0) !== 0x01312f76) throw new Error('decodeExr: not an OpenEXR file');
  let p = 8, width = 0, height = 0, compression = -1;
  const names = [];
  const cstr = () => { let e = p; while (buf[e] !== 0) e++; const s = buf.toString('latin1', p, e); p = e + 1; return s; };
  // the attributes, until the empty name
  for (;;) {
    const name = cstr();
    if (!name) break;
    const type = cstr();
    const size = buf.readInt32LE(p); p += 4;
    const value = buf.subarray(p, p + size); p += size;
    if (name === 'dataWindow') { width = value.readInt32LE(8) - value.readInt32LE(0) + 1; height = value.readInt32LE(12) - value.readInt32LE(4) + 1; }
    else if (name === 'compression') compression = value[0];
    else if (name === 'channels' && type === 'chlist') {
      let q = 0;
      while (value[q] !== 0) { let e = q; while (value[e] !== 0) e++; names.push(value.toString('latin1', q, e)); if (value.readInt32LE(e + 1) !== 1) throw new Error('decodeExr: only HALF channels'); q = e + 17; }
    }
  }
  if (compression !== 0 || names.join('') !== 'ABGR') throw new Error('decodeExr: only uncompressed A, B, G, R files');
  const data = new Uint16Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const at = Number(buf.readBigUInt64LE(p + y * 8));
    const line = buf.readInt32LE(at);
    let o = at + 8;
    for (const c of [3, 2, 1, 0]) for (let x = 0; x < width; x++, o += 2) data[(line * width + x) * 4 + c] = buf[o] | (buf[o + 1] << 8);
  }
  return { width, height, data };
}

module.exports = { encodeExr, decodeExr, exrSize };

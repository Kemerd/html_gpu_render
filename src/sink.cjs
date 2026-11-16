/**
 * sink.cjs: where the frames go. Used from Node in both backends (the Electron preload, and the frame server of
 * the browser backend).
 *
 *   const sink = await makeSink({ out, format, width, height, frames, pngLevel, fsync, preallocate });
 *   await sink.write(i, rgba);        // rgba: width * height * 4 bytes, no padding
 *   await sink.close();               // also CHECKS that every frame written is on disk with its full size
 *
 * format:  raw     <out>/frame_000000.rgba, one file per frame
 *          png     <out>/frame_000000.png
 *          stream  <out>/frames.rgba, the frames end to end (each written at its own offset, so order is free)
 *          none    nothing is written (timing runs)
 *          raw16f  <out>/frame_000000.rgba16f, RGBA half floats, little-endian, tight      (8 bytes per pixel in)
 *          raw32f  <out>/frame_000000.rgba32f, RGBA 32-bit floats, little-endian, tight    (16 bytes per pixel in)
 *          exr     <out>/frame_000000.exr, OpenEXR half float, uncompressed scanlines      (8 bytes per pixel in)
 *          png16   <out>/frame_000000.png, 16-bit RGBA with a cICP chunk                   (16 bytes per pixel in)
 *
 * Writes go through the operating system's file cache: write() resolves when the system has taken the bytes, not
 * when the device has them. That is the normal contract of a file write and loses nothing unless the machine
 * itself goes down. With fsync: true every file is flushed to the device before write() resolves (stream: before
 * close() resolves), which shows what the device itself can take. Either way a failed or short write rejects, and
 * close() rejects if a file is missing or has the wrong size: a frame that is not on disk fails the run.
 *
 * The writes themselves run on Node's thread pool (libuv), not on the thread that drives the page.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { encodePng, encodePng16 } = require('./png.cjs');
const { encodeExr, exrSize } = require('./exr.cjs');

/** Bytes per pixel a frame arrives with, and the file extension, per format. */
const FORMATS = {
  raw: [4, 'rgba'], stream: [4, 'rgba'], png: [4, 'png'], none: [4, ''],
  raw16f: [8, 'rgba16f'], raw32f: [16, 'rgba32f'], exr: [8, 'exr'], png16: [16, 'png'],
};

/** The file name of frame i. */
const frameName = (i, ext) => `frame_${String(i).padStart(6, '0')}.${ext}`;

async function makeSink({ out, format, width, height, frames = 0, pngLevel = 1, fsync = false, preallocate = false, transfer = 'srgb', primaries = 'srgb' }) {
  if (!out) throw new Error('makeSink: no output folder');
  if (!(width > 0 && height > 0)) throw new Error(`makeSink: bad frame size ${width} x ${height}`);
  if (!FORMATS[format]) throw new Error(`makeSink: unknown format "${format}"`);
  const [bytesPerPixel, ext] = FORMATS[format];
  const frameBytes = width * height * bytesPerPixel;
  // the float formats hand over views of 16-bit or 32-bit values; a Buffer keeps its offset inside its memory
  const view = (Type, rgba) => new Type(rgba.buffer, rgba.byteOffset, frameBytes / Type.BYTES_PER_ELEMENT);
  if (format !== 'none') fs.mkdirSync(out, { recursive: true });

  // the stream file, given its full size at once when asked: the file system then never has to grow it
  const stream = format === 'stream' ? await fs.promises.open(path.join(out, 'frames.rgba'), 'w') : null;
  if (stream && preallocate && frames > 0) await stream.truncate(frames * frameBytes);

  // what has been written, for the check at the end
  const written = new Set();

  /** One whole file: open, write everything, flush if asked, close. Rejects on a short write. */
  const writeFile = async (file, bytes) => {
    const fh = await fs.promises.open(file, 'w');
    try {
      const { bytesWritten } = await fh.write(bytes, 0, bytes.length, 0);
      if (bytesWritten !== bytes.length) throw new Error(`${file}: only ${bytesWritten} of ${bytes.length} bytes were written (disk full?)`);
      if (fsync) await fh.datasync();
    } finally {
      await fh.close();
    }
  };

  return {
    frameBytes,
    /** Resolves when frame i has been handed to the file system in full (and to the device, with fsync). */
    async write(i, rgba) {
      if (!rgba || rgba.length < frameBytes) throw new Error(`frame ${i}: ${rgba ? rgba.length : 0} bytes, expected ${frameBytes}`);
      if (format === 'none') return;
      if (stream) {
        const { bytesWritten } = await stream.write(rgba, 0, frameBytes, i * frameBytes);
        if (bytesWritten !== frameBytes) throw new Error(`frame ${i}: only ${bytesWritten} of ${frameBytes} bytes were written (disk full?)`);
      } else if (format === 'png') {
        await writeFile(path.join(out, frameName(i, 'png')), await encodePng(rgba, width, height, pngLevel));
      } else if (format === 'png16') {
        await writeFile(path.join(out, frameName(i, 'png')), await encodePng16(view(Float32Array, rgba), width, height, pngLevel, { transfer, primaries }));
      } else if (format === 'exr') {
        await writeFile(path.join(out, frameName(i, 'exr')), encodeExr(view(Uint16Array, rgba), width, height, { primaries }));
      } else {
        // raw, raw16f, raw32f: the bytes as they are
        await writeFile(path.join(out, frameName(i, ext)), rgba.length === frameBytes ? rgba : rgba.subarray(0, frameBytes));
      }
      written.add(i);
    },
    /** Closes the stream and checks the result: every frame written must be there with its full size. */
    async close() {
      if (stream) {
        try {
          if (fsync) await stream.datasync();
          const size = (await stream.stat()).size;
          const need = (written.size ? Math.max(...written) + 1 : 0) * frameBytes;
          if (size < need) throw new Error(`frames.rgba is ${size} bytes, ${need} were written: frames are missing on disk.`);
        } finally {
          await stream.close();
        }
        return;
      }
      // the formats without compression have one known file size, so each file can be checked
      const fixed = format === 'raw' || format === 'raw16f' || format === 'raw32f' ? frameBytes : format === 'exr' ? exrSize(width, height, { primaries }) : 0;
      if (fixed) {
        for (const i of written) {
          let size = -1;
          try { size = (await fs.promises.stat(path.join(out, frameName(i, ext)))).size; } catch { size = -1; }
          if (size !== fixed) throw new Error(`frame ${i} is not on disk in full (${size < 0 ? 'the file is missing' : size + ' of ' + fixed + ' bytes'}).`);
        }
      }
    },
  };
}

module.exports = { makeSink, frameName, FORMATS };

// ESC/POS encoding for thermal printers. The receipt is printed as a
// black-and-white image (raster), so Hindi item names and the ₹ sign print
// correctly even though most printers' built-in fonts cannot show them.

export const PRINTER_DOTS = { 58: 384, 80: 576 }; // printable width in dots at 203 dpi

const ESC = 0x1b;
const GS = 0x1d;

/**
 * Pack greyscale pixels (0 = black … 255 = white, one byte per pixel) into
 * 1-bit rows, 8 pixels per byte, most significant bit first. Width is padded
 * to a multiple of 8.
 */
export function packBitmap(gray, width, height, threshold = 160) {
  const bytesPerRow = Math.ceil(width / 8);
  const data = new Uint8Array(bytesPerRow * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (gray[y * width + x] < threshold) data[y * bytesPerRow + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return { width: bytesPerRow * 8, height, bytesPerRow, data };
}

/**
 * Build the bytes for one receipt: initialise, the image in bands (small
 * printer buffers overflow on one huge image), feed, and cut where a cutter
 * exists (printers without one ignore the command).
 */
export function encodeRaster(bitmap, { bandHeight = 128, feedLines = 4, cut = true } = {}) {
  const parts = [Uint8Array.of(ESC, 0x40)]; // ESC @ initialise
  for (let y = 0; y < bitmap.height; y += bandHeight) {
    const rows = Math.min(bandHeight, bitmap.height - y);
    const xBytes = bitmap.bytesPerRow;
    // GS v 0 m xL xH yL yH d1…dk
    parts.push(Uint8Array.of(GS, 0x76, 0x30, 0, xBytes & 0xff, xBytes >> 8, rows & 0xff, rows >> 8));
    parts.push(bitmap.data.subarray(y * xBytes, (y + rows) * xBytes));
  }
  parts.push(Uint8Array.of(ESC, 0x64, feedLines)); // ESC d n: feed n lines
  if (cut) parts.push(Uint8Array.of(GS, 0x56, 0x42, 0)); // GS V B 0: partial cut
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) { out.set(p, offset); offset += p.length; }
  return out;
}

/** Split bytes into chunks small enough for one Bluetooth LE write. */
export function chunk(bytes, size) {
  const out = [];
  for (let i = 0; i < bytes.length; i += size) out.push(bytes.subarray(i, i + size));
  return out;
}

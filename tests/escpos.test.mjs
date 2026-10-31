import { test } from 'node:test';
import assert from 'node:assert/strict';
import { packBitmap, encodeRaster, chunk, PRINTER_DOTS } from '../assets/js/billing/escpos.js';

test('packs pixels into 1-bit rows, MSB first', () => {
  const w = 10, h = 2;
  const gray = new Uint8Array(w * h).fill(255);
  gray[0] = 0; gray[9] = 0; gray[w + 8] = 50;
  const bmp = packBitmap(gray, w, h);
  assert.equal(bmp.bytesPerRow, 2);
  assert.deepEqual([...bmp.data], [0b10000000, 0b01000000, 0, 0b10000000]);
});

test('encodes a raster receipt in bands with init, feed and cut', () => {
  const width = PRINTER_DOTS[58];
  const height = 300;
  const bmp = packBitmap(new Uint8Array(width * height), width, height);
  const bytes = encodeRaster(bmp, { bandHeight: 128 });
  assert.deepEqual([...bytes.subarray(0, 2)], [0x1b, 0x40]);
  // first band header: GS v 0, 48 bytes wide, 128 rows
  assert.deepEqual([...bytes.subarray(2, 10)], [0x1d, 0x76, 0x30, 0, 48, 0, 128, 0]);
  const bands = [128, 128, 44];
  assert.equal(bytes.length, 2 + bands.length * 8 + 48 * height + 3 + 4);
  assert.deepEqual([...bytes.subarray(bytes.length - 7)], [0x1b, 0x64, 4, 0x1d, 0x56, 0x42, 0]);
});

test('chunks bytes for Bluetooth writes', () => {
  const parts = chunk(new Uint8Array(450), 180);
  assert.deepEqual(parts.map((p) => p.length), [180, 180, 90]);
});

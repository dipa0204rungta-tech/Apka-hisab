// Printer adapters. Each printer implements:
//
//   name: string
//   isAvailable(): boolean
//   print(receipt, { paperWidth: '58' | '80' }): Promise<void>
//
// `receipt` is the model from buildReceipt(). The browser printer uses the
// system print dialog; the Bluetooth printer sends ESC/POS bytes straight to
// a Bluetooth Low Energy thermal printer (Chrome on Android/desktop). A USB
// printer could be added the same way with Web Serial or WebUSB.

import { renderReceiptHtml, PAPER } from './receipt.js';
import { encodeRaster } from './escpos.js';
import { receiptBitmap } from './receipt-image.js';

const printers = new Map();

export function registerPrinter(printer) {
  printers.set(printer.name, printer);
}

export function getPrinter(name = 'browser') {
  return printers.get(name) ?? printers.get('browser');
}

export function listPrinters() {
  return [...printers.values()].filter((p) => p.isAvailable());
}

export const browserPrinter = {
  name: 'browser',
  label: 'Browser print dialog',
  isAvailable: () => typeof window !== 'undefined' && typeof window.print === 'function',
  async print(receipt, { paperWidth = '58' } = {}) {
    const paper = PAPER[paperWidth] || PAPER[58];
    const root = document.getElementById('print-root');
    root.innerHTML = renderReceiptHtml(receipt, { paperWidth });
    const pageStyle = document.createElement('style');
    pageStyle.id = 'print-page-size';
    pageStyle.textContent = `@page { size: ${paper.widthMm}mm auto; margin: 0 }`;
    document.getElementById('print-page-size')?.remove();
    document.head.appendChild(pageStyle);
    document.body.classList.add('printing-receipt');
    try {
      window.print(); // blocks until the dialog closes in most browsers
    } finally {
      // Some mobile browsers return from print() before printing finishes,
      // so wait for afterprint (with a timeout) before cleaning up.
      await new Promise((resolve) => {
        const done = () => { window.removeEventListener('afterprint', done); resolve(); };
        window.addEventListener('afterprint', done);
        setTimeout(done, 1000);
      });
      document.body.classList.remove('printing-receipt');
      root.innerHTML = '';
    }
  },
};

registerPrinter(browserPrinter);

// GATT services used by common BLE thermal printers. Web Bluetooth only lets
// the page use services listed here, so unknown printers may need adding.
const PRINTER_SERVICES = [
  '000018f0-0000-1000-8000-00805f9b34fb',
  'e7810a71-73ae-499d-8c15-faa9aef0c3f2',
  '49535343-fe7d-4ae5-8fa9-9fafd205e455',
  '0000ff00-0000-1000-8000-00805f9b34fb',
  '0000ffe0-0000-1000-8000-00805f9b34fb',
  '0000ae30-0000-1000-8000-00805f9b34fb',
  '0000fee7-0000-1000-8000-00805f9b34fb',
  '0000ff80-0000-1000-8000-00805f9b34fb',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findWritable(server) {
  const services = await server.getPrimaryServices();
  for (const service of services) {
    let chars = [];
    try { chars = await service.getCharacteristics(); } catch { continue; }
    const c = chars.find((ch) => ch.properties.writeWithoutResponse) || chars.find((ch) => ch.properties.write);
    if (c) return c;
  }
  return null;
}

export class PrinterError extends Error {}

export const bluetoothPrinter = {
  name: 'bluetooth',
  label: 'Bluetooth printer',
  device: null,
  characteristic: null,
  chunkSize: 180,
  listeners: new Set(),

  isAvailable: () => typeof navigator !== 'undefined' && Boolean(navigator.bluetooth),
  isConnected() { return Boolean(this.device?.gatt?.connected && this.characteristic); },
  deviceName() { return this.device?.name || 'Bluetooth printer'; },
  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); },
  notify() { for (const fn of this.listeners) fn(this.isConnected()); },

  /** Ask the user to pick a printer. Must be called from a tap. */
  async connect() {
    if (!this.isAvailable()) {
      throw new PrinterError('Bluetooth printing needs Chrome on Android or a computer. On iPhone use the Bluefy browser, or print with the phone print option.');
    }
    const device = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: PRINTER_SERVICES });
    await this.attach(device);
  },

  /** Reconnect without asking, to a printer this site was allowed before (where the browser supports it). */
  async reconnectKnown() {
    if (!this.isAvailable() || !navigator.bluetooth.getDevices) return false;
    const devices = await navigator.bluetooth.getDevices();
    for (const d of devices) {
      try { await this.attach(d); return true; } catch { /* printer off or out of range */ }
    }
    return false;
  },

  async attach(device) {
    const server = await device.gatt.connect();
    const characteristic = await findWritable(server);
    if (!characteristic) {
      device.gatt.disconnect();
      throw new PrinterError(`${device.name || 'This device'} does not look like a supported Bluetooth LE printer.`);
    }
    if (this.device !== device) {
      device.addEventListener('gattserverdisconnected', () => { this.characteristic = null; this.notify(); });
    }
    this.device = device;
    this.characteristic = characteristic;
    this.notify();
  },

  async ensureConnected() {
    if (this.isConnected()) return;
    if (!this.device) throw new PrinterError('No printer connected. Tap “Connect printer” first.');
    try {
      await this.attach(this.device);
    } catch {
      throw new PrinterError(`Could not reach ${this.deviceName()}. Check that it is switched on and nearby.`);
    }
  },

  async write(bytes) {
    await this.ensureConnected();
    const c = this.characteristic;
    const noResponse = c.properties.writeWithoutResponse && c.writeValueWithoutResponse;
    const send = async (part) => {
      if (noResponse) {
        await c.writeValueWithoutResponse(part);
        await sleep(this.chunkSize > 20 ? 15 : 5); // let the printer's small buffer drain
      } else if (c.writeValueWithResponse) {
        await c.writeValueWithResponse(part);
      } else {
        await c.writeValue(part);
      }
    };
    let first = true;
    for (let i = 0; i < bytes.length;) {
      const part = bytes.subarray(i, i + this.chunkSize);
      try {
        await send(part);
      } catch (e) {
        // Some printers only take 20-byte packets; retry the first one smaller.
        if (first && this.chunkSize > 20) { this.chunkSize = 20; continue; }
        throw new PrinterError(`Printing stopped part-way (${e.message}). Check the printer and print again.`);
      }
      first = false;
      i += part.length;
    }
  },

  async print(receipt, { paperWidth = '58' } = {}) {
    await this.write(encodeRaster(receiptBitmap(receipt, { paperWidth })));
  },
};

registerPrinter(bluetoothPrinter);

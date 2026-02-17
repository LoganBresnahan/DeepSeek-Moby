/**
 * Tests for vendored nayuki QR Code generator
 *
 * Validates that the QR encoder produces valid matrices
 * for URL encoding (the primary use case in this extension).
 */

import { describe, it, expect } from 'vitest';
import { qrcodegen } from '../../../src/vendor/qrcodegen';

const QrCode = qrcodegen.QrCode;
const Ecc = qrcodegen.QrCode.Ecc;

describe('qrcodegen', () => {
  describe('encodeText', () => {
    it('encodes a short URL into a valid QR matrix', () => {
      const qr = QrCode.encodeText('http://localhost:8839', Ecc.MEDIUM);

      expect(qr.size).toBeGreaterThanOrEqual(21); // Minimum QR size (version 1)
      expect(qr.size % 2).toBe(1); // QR sizes are always odd
    });

    it('encodes a LAN URL', () => {
      const qr = QrCode.encodeText('http://192.168.0.135:8839', Ecc.MEDIUM);

      expect(qr.size).toBeGreaterThanOrEqual(21);
      // Verify we can read modules without error
      expect(typeof qr.getModule(0, 0)).toBe('boolean');
    });

    it('produces a square boolean matrix', () => {
      const qr = QrCode.encodeText('http://example.com', Ecc.MEDIUM);
      const size = qr.size;

      // Check all positions are accessible and return boolean
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const module = qr.getModule(x, y);
          expect(typeof module).toBe('boolean');
        }
      }
    });

    it('has finder patterns in three corners', () => {
      const qr = QrCode.encodeText('http://test.com', Ecc.LOW);
      const size = qr.size;

      // Top-left 7x7 finder pattern: first row should be all black
      for (let x = 0; x < 7; x++) {
        expect(qr.getModule(x, 0)).toBe(true);
      }

      // Top-right 7x7 finder pattern
      for (let x = size - 7; x < size; x++) {
        expect(qr.getModule(x, 0)).toBe(true);
      }

      // Bottom-left 7x7 finder pattern
      for (let x = 0; x < 7; x++) {
        expect(qr.getModule(x, size - 1)).toBe(true);
      }
    });

    it('produces larger QR for longer URLs', () => {
      const shortQr = QrCode.encodeText('http://a.co', Ecc.LOW);
      const longQr = QrCode.encodeText(
        'http://192.168.0.135:8839/very/long/path/with/extra/segments?query=value&more=params',
        Ecc.LOW
      );

      expect(longQr.size).toBeGreaterThanOrEqual(shortQr.size);
    });
  });

  describe('error correction levels', () => {
    it('supports all error correction levels', () => {
      const url = 'http://192.168.0.135:8839';

      const low = QrCode.encodeText(url, Ecc.LOW);
      const medium = QrCode.encodeText(url, Ecc.MEDIUM);
      const quartile = QrCode.encodeText(url, Ecc.QUARTILE);
      const high = QrCode.encodeText(url, Ecc.HIGH);

      // All should produce valid QR codes
      expect(low.size).toBeGreaterThanOrEqual(21);
      expect(medium.size).toBeGreaterThanOrEqual(21);
      expect(quartile.size).toBeGreaterThanOrEqual(21);
      expect(high.size).toBeGreaterThanOrEqual(21);

      // Higher ECC generally needs equal or larger size
      expect(high.size).toBeGreaterThanOrEqual(low.size);
    });
  });

  describe('getModule bounds', () => {
    it('returns false for out-of-bounds coordinates', () => {
      const qr = QrCode.encodeText('test', Ecc.LOW);

      // Out of bounds should return false (per nayuki spec)
      expect(qr.getModule(-1, 0)).toBe(false);
      expect(qr.getModule(0, -1)).toBe(false);
      expect(qr.getModule(qr.size, 0)).toBe(false);
      expect(qr.getModule(0, qr.size)).toBe(false);
    });
  });

  describe('matrix conversion (extension use case)', () => {
    it('can be converted to boolean[][] for webview transport', () => {
      const url = 'http://192.168.0.135:8839';
      const qr = QrCode.encodeText(url, Ecc.MEDIUM);
      const size = qr.size;

      // This is the exact pattern used in chatProvider.ts
      const matrix: boolean[][] = [];
      for (let y = 0; y < size; y++) {
        const row: boolean[] = [];
        for (let x = 0; x < size; x++) {
          row.push(qr.getModule(x, y));
        }
        matrix.push(row);
      }

      expect(matrix.length).toBe(size);
      expect(matrix[0].length).toBe(size);
      // Should contain both true and false values
      const allValues = matrix.flat();
      expect(allValues.some(v => v === true)).toBe(true);
      expect(allValues.some(v => v === false)).toBe(true);
    });
  });
});

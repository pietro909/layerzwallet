import { describe, expect, test } from 'vitest';
import { SingleKey } from '@arkade-os/sdk';

import { installCryptoSubtlePolyfill, subtleShim } from '../../modules/crypto-subtle-polyfill';

describe('crypto.subtle polyfill for Hermes', () => {
  test('digest matches the platform SHA-256', async () => {
    const message = new Uint8Array([1, 2, 3, 4, 5]);
    const polyfilled = new Uint8Array(await subtleShim.digest('SHA-256', message));
    const native = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', message));
    expect(Array.from(polyfilled)).toEqual(Array.from(native));
  });

  test('HMAC importKey + sign produce a 32-byte tag', async () => {
    const key = new Uint8Array(32).fill(3);
    const message = new Uint8Array([9, 8, 7]);
    const hmacKey = await subtleShim.importKey('raw', key, { name: 'HMAC', hash: { name: 'SHA-256' } }, false, ['sign']);
    const tag = new Uint8Array(await subtleShim.sign('HMAC', hmacKey, message));
    expect(tag.length).toBe(32);
  });

  test('the Arkade SDK can sign messages with no native crypto.subtle', async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto')!;
    const { getRandomValues } = globalThis.crypto;
    // Hermes: getRandomValues is present, subtle is not.
    Object.defineProperty(globalThis, 'crypto', {
      value: { getRandomValues: getRandomValues.bind(globalThis.crypto) },
      configurable: true,
    });

    try {
      expect(installCryptoSubtlePolyfill()).toBe(true);

      const key = SingleKey.fromHex('11'.repeat(32));
      const message = new Uint8Array(32).fill(7);

      const ecdsa = await key.signMessage(message, 'ecdsa');
      expect(ecdsa.length).toBeGreaterThan(0);
      const schnorr = await key.signMessage(message, 'schnorr');
      expect(schnorr.length).toBeGreaterThan(0);

      // deterministic schnorr goes through hmacSha256Async (importKey + sign)
      const deterministic = await key.signSchnorrDeterministic(message);
      expect(Array.from(await key.signSchnorrDeterministic(message))).toEqual(Array.from(deterministic));
    } finally {
      Object.defineProperty(globalThis, 'crypto', original);
    }
  });
});

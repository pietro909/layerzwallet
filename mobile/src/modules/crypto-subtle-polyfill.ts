/**
 * Hermes (React Native) has `crypto.getRandomValues` via react-native-get-random-values,
 * but no `crypto.subtle`. The Arkade SDK 0.5 signs messages through its nested
 * @noble/secp256k1 3.0.0, whose async hash slots default to WebCrypto and resolve
 * `globalThis.crypto.subtle` at call time. Install the three operations noble uses:
 * SHA-256 digest, HMAC importKey and HMAC sign. Everything is computed with
 * @noble/hashes, so no platform crypto implementation is needed.
 */
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha256';

type HmacKey = { raw: Uint8Array };

const toBytes = (data: unknown): Uint8Array => {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data as ArrayBufferView)) {
    const view = data as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  throw new TypeError('crypto.subtle: expected BufferSource');
};

const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

const algorithmName = (algorithm: unknown): string => {
  const name = typeof algorithm === 'string' ? algorithm : (algorithm as { name?: string } | undefined)?.name;
  return String(name ?? '').toUpperCase();
};

/** Minimal SubtleCrypto-like surface: only what @noble/secp256k1 v3 asks for. */
export const subtleShim = {
  digest: async (algorithm: unknown, data: unknown): Promise<ArrayBuffer> => {
    if (algorithmName(algorithm) !== 'SHA-256') throw new Error(`crypto.subtle.digest: unsupported algorithm ${algorithmName(algorithm)}`);
    return toArrayBuffer(sha256(toBytes(data)));
  },
  importKey: async (_format: string, keyData: unknown, algorithm: unknown, _extractable: boolean, _keyUsages: string[]): Promise<HmacKey> => {
    if (algorithmName(algorithm) !== 'HMAC') throw new Error(`crypto.subtle.importKey: unsupported algorithm ${algorithmName(algorithm)}`);
    return { raw: toBytes(keyData) };
  },
  sign: async (algorithm: unknown, key: HmacKey, data: unknown): Promise<ArrayBuffer> => {
    if (algorithmName(algorithm) !== 'HMAC' || !key?.raw) throw new Error('crypto.subtle.sign: expected an HMAC key');
    return toArrayBuffer(hmac(sha256, key.raw, toBytes(data)));
  },
};

/** Returns true when a shim was installed (i.e. the runtime lacked crypto.subtle). */
export const installCryptoSubtlePolyfill = (): boolean => {
  const cryptoObj = globalThis.crypto as (Crypto & { subtle?: SubtleCrypto }) | undefined;
  if (!cryptoObj || cryptoObj.subtle) return false;

  try {
    Object.defineProperty(cryptoObj, 'subtle', { value: subtleShim, configurable: true, writable: true });
  } catch {
    // Some runtimes expose a frozen crypto object; replace it, preserving the CSPRNG.
    const getRandomValues = typeof cryptoObj.getRandomValues === 'function' ? cryptoObj.getRandomValues.bind(cryptoObj) : undefined;
    const randomUUID = typeof (cryptoObj as { randomUUID?: () => string }).randomUUID === 'function' ? (cryptoObj as { randomUUID: () => string }).randomUUID.bind(cryptoObj) : undefined;
    Object.defineProperty(globalThis, 'crypto', {
      value: { getRandomValues, randomUUID, subtle: subtleShim },
      configurable: true,
      writable: true,
    });
  }
  return true;
};

// entry.js imports this module first: the shim must be in place before any SDK code loads.
installCryptoSubtlePolyfill();

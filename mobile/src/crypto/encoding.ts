const BASE64URL_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

const BASE64URL_LOOKUP = (() => {
  const table = new Int16Array(128).fill(-1);
  for (let i = 0; i < BASE64URL_ALPHABET.length; i += 1) {
    table[BASE64URL_ALPHABET.charCodeAt(i)] = i;
  }
  return table;
})();

/**
 * Strictly decodes an RFC 4648 Section 5 base64url string into raw bytes.
 * Rejects standard base64 (+, /), whitespace, or malformed lengths.
 */
export function decodeBase64Url(input: string, fieldName = 'token'): Uint8Array {
  if (typeof input !== 'string' || input.length === 0) {
    throw new Error(`Missing ${fieldName}.`);
  }

  let unpadded = input;
  if (unpadded.endsWith('==')) {
    unpadded = unpadded.slice(0, -2);
  } else if (unpadded.endsWith('=')) {
    unpadded = unpadded.slice(0, -1);
  }

  if (unpadded.includes('=')) {
    throw new Error(`Invalid base64url padding in ${fieldName}.`);
  }

  const len = unpadded.length;
  const rem = len % 4;
  if (rem === 1) {
    throw new Error(`Invalid base64url length in ${fieldName}.`);
  }

  const byteLength = (len * 3) >> 2;
  const out = new Uint8Array(byteLength);
  let outIdx = 0;

  for (let i = 0; i < len; i += 4) {
    const c0 = charToVal(unpadded, i, fieldName);
    const c1 = charToVal(unpadded, i + 1, fieldName);
    const hasC2 = i + 2 < len;
    const hasC3 = i + 3 < len;
    const c2 = hasC2 ? charToVal(unpadded, i + 2, fieldName) : 0;
    const c3 = hasC3 ? charToVal(unpadded, i + 3, fieldName) : 0;

    out[outIdx++] = (c0 << 2) | (c1 >> 4);
    if (hasC2) {
      out[outIdx++] = ((c1 & 0x0f) << 4) | (c2 >> 2);
    }
    if (hasC3) {
      out[outIdx++] = ((c2 & 0x03) << 6) | c3;
    }
  }

  return out;
}

function charToVal(str: string, index: number, fieldName: string): number {
  const code = str.charCodeAt(index);
  if (code >= 128) {
    throw new Error(`Invalid base64url character in ${fieldName}.`);
  }
  const val = BASE64URL_LOOKUP[code];
  if (val < 0) {
    throw new Error(`Invalid base64url character in ${fieldName}.`);
  }
  return val;
}

/**
 * Decodes UTF-8 bytes into a JS string with strict UTF-8 validation.
 * Works across all Hermes / JavaScriptCore / Web runtimes.
 */
export function utf8Decode(bytes: Uint8Array): string {
  if (typeof TextDecoder !== 'undefined') {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (err) {
      if (err instanceof TypeError) {
        throw new Error('Decrypted payload is not valid UTF-8.');
      }
      // Fall through to pure-JS decoder if TextDecoder option is unsupported.
    }
  }

  let result = '';
  let i = 0;
  while (i < bytes.length) {
    const b0 = bytes[i++];
    if (b0 < 0x80) {
      result += String.fromCharCode(b0);
    } else if ((b0 & 0xe0) === 0xc0) {
      if (i >= bytes.length) throw new Error('Truncated UTF-8 sequence.');
      const b1 = bytes[i++];
      if ((b1 & 0xc0) !== 0x80) throw new Error('Invalid UTF-8 continuation byte.');
      const cp = ((b0 & 0x1f) << 6) | (b1 & 0x3f);
      if (cp < 0x80) throw new Error('Overlong UTF-8 sequence.');
      result += String.fromCharCode(cp);
    } else if ((b0 & 0xf0) === 0xe0) {
      if (i + 1 >= bytes.length) throw new Error('Truncated UTF-8 sequence.');
      const b1 = bytes[i++];
      const b2 = bytes[i++];
      if ((b1 & 0xc0) !== 0x80 || (b2 & 0xc0) !== 0x80) {
        throw new Error('Invalid UTF-8 continuation byte.');
      }
      const cp = ((b0 & 0x0f) << 12) | ((b1 & 0x3f) << 6) | (b2 & 0x3f);
      if (cp < 0x800 || (cp >= 0xd800 && cp <= 0xdfff)) {
        throw new Error('Invalid UTF-8 code point.');
      }
      result += String.fromCharCode(cp);
    } else if ((b0 & 0xf8) === 0xf0) {
      if (i + 2 >= bytes.length) throw new Error('Truncated UTF-8 sequence.');
      const b1 = bytes[i++];
      const b2 = bytes[i++];
      const b3 = bytes[i++];
      if ((b1 & 0xc0) !== 0x80 || (b2 & 0xc0) !== 0x80 || (b3 & 0xc0) !== 0x80) {
        throw new Error('Invalid UTF-8 continuation byte.');
      }
      const cp =
        ((b0 & 0x07) << 18) | ((b1 & 0x3f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f);
      if (cp < 0x10000 || cp > 0x10ffff) {
        throw new Error('Out-of-range UTF-8 code point.');
      }
      const adj = cp - 0x10000;
      result += String.fromCharCode(0xd800 + (adj >> 10), 0xdc00 + (adj & 0x3ff));
    } else {
      throw new Error('Invalid UTF-8 lead byte.');
    }
  }
  return result;
}

/**
 * Returns a short display-safe room identifier; never displays readKey or AES key.
 */
export function safeRoomFingerprint(room: string): string {
  if (!room || room.length < 10) return 'unknown';
  return `${room.slice(0, 6)}…${room.slice(-4)}`;
}

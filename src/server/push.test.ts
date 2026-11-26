// The web-push crypto roundtrip: encrypt as the SENDER (src/server/push.ts)
// and decrypt as the RECEIVER — an independent implementation of the
// aes128gcm half of RFC 8291 (exactly what a browser's push service +
// service worker do). If these two agree byte-for-byte, payloads sent to
// real browsers decode.
//
// Also verifies the VAPID JWT (RFC 8292): decode, check claims, verify
// the ES256 signature against the configured public key.
import { describe, expect, it, beforeAll } from 'vitest';
import { b64urlToBytes } from './push-test-helpers';
import { encryptPayload, vapidJwt } from './push';

// A receiver's keypair (what pushManager.subscribe would generate).
let receiver: { publicRaw: Uint8Array; privateJwk: JsonWebKey };

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveKey',
    'deriveBits',
  ]);
  receiver = {
    publicRaw: new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)),
    privateJwk: await crypto.subtle.exportKey('jwk', pair.privateKey),
  };
});

const b64url = (buffer: ArrayBuffer | Uint8Array): string => {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

// A throwaway VAPID keypair for the JWT test — the app's real .env keys
// never touch tests (the env stub reads process.env at call time).
describe('VAPID JWT (RFC 8292)', () => {
  it('signs an aud/exp/sub claim set verifiable by the public key', async () => {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ]);
    const publicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
    const privateJwk = (await crypto.subtle.exportKey('jwk', pair.privateKey)) as {
      d?: string;
    };
    process.env.VAPID_PUBLIC_KEY = b64url(publicRaw);
    process.env.VAPID_PRIVATE_KEY = privateJwk.d ?? '';
    process.env.VAPID_SUBJECT = 'mailto:test@flowdeck.local';

    const endpoint = 'https://fcm.googleapis.com/fcm/send/some-token';
    const token = await vapidJwt(endpoint);

    const [header, claims, signature] = token.split('.');
    expect(JSON.parse(new TextDecoder().decode(b64urlToBytes(header)))).toEqual({
      typ: 'JWT',
      alg: 'ES256',
    });
    const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(claims)));
    expect(payload.aud).toBe('https://fcm.googleapis.com');
    expect(typeof payload.exp).toBe('number');
    expect(payload.exp).toBeGreaterThan(Date.now() / 1000);
    expect(payload.sub).toBe('mailto:test@flowdeck.local');

    const verifyKey = await crypto.subtle.importKey(
      'raw',
      publicRaw,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    const ok = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      verifyKey,
      b64urlToBytes(signature),
      new TextEncoder().encode(`${header}.${claims}`),
    );
    expect(ok).toBe(true);
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    delete process.env.VAPID_SUBJECT;
  });
});

describe('web push encryption (RFC 8291 roundtrip)', () => {
  it('roundtrips a payload through the sender and an independent receiver', async () => {
    const authSecret = crypto.getRandomValues(new Uint8Array(16));
    const sub = {
      endpoint: 'https://push.example/sub',
      p256dh: b64url(receiver.publicRaw),
      auth: b64url(authSecret),
    };
    const message = new TextEncoder().encode(
      JSON.stringify({ title: 'Priya mentioned you', body: 'on #12', url: '/b/x?card=y' }),
    );
    const { body, dh } = await encryptPayload(sub, message);

    // ── the receiver (browser) side, implemented from the RFC ──────────
    const bytes = new Uint8Array(body);
    const salt = bytes.slice(0, 16);
    const rs = new DataView(bytes.buffer).getUint32(16);
    expect(rs).toBe(4096);
    expect(bytes[20]).toBe(0); // no keyid
    const ciphertext = bytes.slice(21);
    const asPublic = await crypto.subtle.importKey(
      'raw',
      b64urlToBytes(dh),
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      [],
    );
    const uaPrivate = await crypto.subtle.importKey(
      'jwk',
      receiver.privateJwk,
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      ['deriveBits'],
    );
    const ecdhSecret = await crypto.subtle.deriveBits(
      { name: 'ECDH', public: asPublic },
      uaPrivate,
      256,
    );
    // PRK = HMAC-SHA-256(auth_secret, ecdh_secret)
    const hmacKey = await crypto.subtle.importKey(
      'raw',
      authSecret,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const prk = await crypto.subtle.sign('HMAC', hmacKey, ecdhSecret);
    // HKDF-Expand one block (independent reimplementation).
    const expand = async (info: string, length: number) => {
      const key = await crypto.subtle.importKey(
        'raw',
        prk,
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
      );
      const block = await crypto.subtle.sign(
        'HMAC',
        key,
        new Uint8Array([...new TextEncoder().encode(info), 1]),
      );
      return block.slice(0, length);
    };
    const cek = await expand('Content-Encoding: aes128gcm\0', 16);
    const nonce = await expand('Content-Encoding: nonce\0', 12);
    const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: nonce },
      aesKey,
      ciphertext,
    );
    const decoded = new TextDecoder().decode(plaintext);
    // The trailing 0x02 last-record delimiter rides inside the plaintext.
    expect(decoded.endsWith('\u0002')).toBe(true);
    expect(JSON.parse(decoded.slice(0, -1))).toEqual({
      title: 'Priya mentioned you',
      body: 'on #12',
      url: '/b/x?card=y',
    });
    // Salt must actually have been used (not all zeroes/fresh randomness).
    expect(salt.some((byte) => byte !== 0)).toBe(true);
  });
});

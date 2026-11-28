// Server-only: web push without dependencies — RFC 8291 (aes128gcm) message
// encryption and RFC 8292 (VAPID) signing on WebCrypto, which runs in both
// workerd and Node. The service worker's `push` handler turns these into
// OS-level notifications that work even when the site is closed.
import 'server-only';

import { env } from 'virtual:solid-env/server';

import { createSupabaseServiceClient } from './supabase';
import { brand } from '../lib/brand';

/** What the service worker needs to raise a notification: it shows
 *  `title`/`body` and navigates to `url` when clicked. */
export type PushPayload = {
  title: string;
  body: string;
  url: string;
  tag: string;
};

type SubRow = { endpoint: string; p256dh: string; auth: string };

const encoder = new TextEncoder();
const b64url = (buffer: ArrayBuffer | Uint8Array): string => {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

function keysReady(): boolean {
  return Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);
}

/** base64url → bytes (an ArrayBuffer-backed Uint8Array, which is what
 *  WebCrypto's BufferSource types want). */
function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob(base64 + padding);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/** The VAPID signing keypair, imported once per request. */
async function vapidKeys(): Promise<{ sign: CryptoKey; publicKey: string }> {
  const raw = fromBase64Url(env.VAPID_PUBLIC_KEY!);
  if (raw.length !== 65 || raw[0] !== 4)
    throw new Error('VAPID_PUBLIC_KEY: expected a 65-byte uncompressed P-256 point');
  const jwk = {
    kty: 'EC',
    crv: 'P-256',
    x: b64url(raw.subarray(1, 33)),
    y: b64url(raw.subarray(33, 65)),
    d: b64url(fromBase64Url(env.VAPID_PRIVATE_KEY!)),
  };
  const sign = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  return { sign, publicKey: env.VAPID_PUBLIC_KEY! };
}

/** RFC 8292: the ES256 JWT in the Authorization header. Exported for the
 *  roundtrip test (signature verification against the public key). */
export async function vapidJwt(endpoint: string): Promise<string> {
  const { sign } = await vapidKeys();
  const header = b64url(encoder.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64url(
    encoder.encode(
      JSON.stringify({
        aud: new URL(endpoint).origin,
        exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
        sub: env.VAPID_SUBJECT ?? 'mailto:notifications@orbit.local',
      }),
    ),
  );
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    sign,
    encoder.encode(`${header}.${claims}`),
  );
  return `${header}.${claims}.${b64url(signature)}`;
}

/** RFC 8291 §2: one-block HKDF-Expand (our CEK/nonce are ≤ 32 bytes). */
async function hkdfExpand(prk: ArrayBuffer, info: string, length: number): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey('raw', prk, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  const out = await crypto.subtle.sign('HMAC', key, new Uint8Array([...encoder.encode(info), 1]));
  return out.slice(0, length);
}

/** Encrypt the payload for one subscription (aes128gcm). Returns the
 *  sealed body plus the sender public key for the Crypto-Key header.
 *  Exported for the roundtrip test — push.test.ts decrypts with an
 *  independent receiver-side implementation of RFC 8291. */
export async function encryptPayload(
  sub: SubRow,
  plaintext: Uint8Array,
): Promise<{ body: ArrayBuffer; dh: string }> {
  const uaPublic = await crypto.subtle.importKey(
    'raw',
    fromBase64Url(sub.p256dh),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  const as = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ]);
  const ecdhSecret = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: uaPublic },
    as.privateKey,
    256,
  );
  const authSecret = await crypto.subtle.importKey(
    'raw',
    fromBase64Url(sub.auth),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const prk = await crypto.subtle.sign('HMAC', authSecret, ecdhSecret);
  const cek = await hkdfExpand(prk, 'Content-Encoding: aes128gcm\0', 16);
  const nonce = await hkdfExpand(prk, 'Content-Encoding: nonce\0', 12);
  // aes128gcm header: salt (16) | record size (4, big-endian) | keyid len (0)
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096);
  // One record: plaintext + the last-record delimiter 0x02, GCM-sealed.
  const cekKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce },
    cekKey,
    new Uint8Array([...plaintext, 2]),
  );
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', as.publicKey));
  const total = 21 + ciphertext.byteLength;
  const out = new Uint8Array(total);
  out.set(salt, 0);
  out.set(rs, 16);
  out[20] = 0; // no inline keyid — the sender key rides the Crypto-Key header
  out.set(new Uint8Array(ciphertext), 21);
  return { body: out.buffer, dh: b64url(asPublic) };
}

/** Send one push. Returns false when the endpoint is gone (410/404). */
async function sendOne(sub: SubRow, payload: PushPayload): Promise<boolean> {
  // The SW is a static file with no build step — the brand name rides in
  // the payload's title (the SW's literal is only a fallback).
  const withTitle = { ...payload, title: payload.title || brand.name };
  const { body, dh } = await encryptPayload(sub, encoder.encode(JSON.stringify(withTitle)));
  const { publicKey } = await vapidKeys();
  const jwt = await vapidJwt(sub.endpoint);
  const response = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      TTL: '86400',
      Urgency: 'high',
      'Content-Type': 'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      Authorization: `vapid t=${jwt}, k=${publicKey}`,
      'Crypto-Key': `dh=${dh}`,
    },
    body,
  });
  return response.status !== 404 && response.status !== 410;
}

/**
 * Push `payload` to every browser subscription of these users. Best effort
 * by contract: failures are logged, never thrown — notifications rows are
 * the source of truth and pushes are the delivery nicety. Dead endpoints
 * are pruned so they don't linger.
 */
export async function pushToUsers(userIds: string[], payload: PushPayload): Promise<void> {
  const unique = [...new Set(userIds)].filter(Boolean);
  if (unique.length === 0 || !keysReady()) return;
  try {
    const supabase = createSupabaseServiceClient();
    // Respect do-not-disturb: no pushes while a status with DND is in
    // effect (an expired status no longer counts).
    const { data: statuses } = await supabase
      .from('user_status')
      .select('user_id, clear_at')
      .eq('dnd', true)
      .in('user_id', unique);
    const silenced = new Set(
      ((statuses ?? []) as { user_id: string; clear_at: string | null }[])
        .filter((row) => row.clear_at === null || new Date(row.clear_at).getTime() > Date.now())
        .map((row) => row.user_id),
    );
    const recipients = silenced.size > 0 ? unique.filter((id) => !silenced.has(id)) : unique;
    if (recipients.length === 0) return;
    const { data: subs } = await supabase
      .from('push_subscriptions')
      .select('endpoint, p256dh, auth')
      .in('user_id', recipients);
    const rows = (subs ?? []) as SubRow[];
    if (rows.length === 0) return;
    const results = await Promise.allSettled(rows.map((sub) => sendOne(sub, payload)));
    const dead = rows.filter((_, index) => {
      const result = results[index];
      return result.status === 'fulfilled' && result.value === false;
    });
    if (dead.length > 0) {
      await supabase
        .from('push_subscriptions')
        .delete()
        .in(
          'endpoint',
          dead.map((sub) => sub.endpoint),
        );
    }
  } catch (error) {
    console.error('pushToUsers failed:', error);
  }
}

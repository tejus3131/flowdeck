// The browser-push client half: the public VAPID key for subscribing, and
// saving the subscription this browser mints. The server half lives in
// src/server/push.ts — together they make notifications arrive even when
// the tab is closed.
import { env } from 'virtual:solid-env/server';

import { createSupabaseRequestClient } from '../server/supabase';

/** The VAPID public key (base64url) — null when push isn't configured. */
export async function getVapidPublicKey(): Promise<string | null> {
  'use server';
  return env.VAPID_PUBLIC_KEY ?? null;
}

/** Persist (or refresh) this browser's push subscription. Idempotent on
 *  the endpoint. */
export async function savePushSubscription(input: {
  endpoint: string;
  p256dh: string;
  auth: string;
}): Promise<boolean> {
  'use server';
  const supabase = createSupabaseRequestClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return false;
  if (!input.endpoint || !input.p256dh || !input.auth) return false;
  const { error } = await supabase.from('push_subscriptions').upsert(
    {
      user_id: auth.user.id,
      endpoint: input.endpoint,
      p256dh: input.p256dh,
      auth: input.auth,
    },
    { onConflict: 'endpoint' },
  );
  if (error) throw new Error(error.message);
  return true;
}

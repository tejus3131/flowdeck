// Board presence + drag broadcast: ephemeral multi-user signals that never
// touch the database (Excalidraw's split: durable state in storage,
// ephemeral signals over the relay). Presence shows who's viewing the
// board; broadcast carries "this card is being dragged" ghosts so you see
// movement before the drop commits server-side.
import { createEffect, createSignal, onCleanup } from 'solid-js';
import type { RealtimeChannel } from '@supabase/supabase-js';

import { browserClient } from './supabase-client';
import type { MeProfile } from './auth';

export interface PresenceUser {
  userId: string;
  name: string;
  avatarUrl: string | null;
}

export interface RemoteDrag {
  cardId: string;
  name: string;
}

export function createBoardPresence(boardId: string, me: () => MeProfile | null) {
  const [others, setOthers] = createSignal<PresenceUser[]>([]);
  const [remoteDrag, setRemoteDrag] = createSignal<RemoteDrag | null>(null);

  let channel: RealtimeChannel | null = null;
  let client: ReturnType<typeof browserClient> = null;

  // Subscribe once the signed-in profile resolves (the async model holds
  // the effect until then; signed-out boards never subscribe).
  createEffect(
    () => ({ profile: me(), enabled: !!browserClient() }),
    ({ profile, enabled }) => {
      if (!profile || !enabled || channel) return;
      client = browserClient();
      const self = channel ?? client!.channel(`presence-board-${boardId}`, {
        config: { presence: { key: profile.id } },
      });
      channel = self;

      self
        .on('presence', { event: 'sync' }, () => {
          const state = self.presenceState<Record<string, unknown>>();
          const users: PresenceUser[] = [];
          for (const [key, metas] of Object.entries(state)) {
            if (key === profile.id) continue;
            const meta = metas[metas.length - 1] as Partial<PresenceUser>;
            users.push({
              userId: key,
              name: meta?.name ?? 'Someone',
              avatarUrl: meta?.avatarUrl ?? null,
            });
          }
          setOthers(users);
        })
        .on('broadcast', { event: 'drag' }, ({ payload }) => {
          const data = payload as RemoteDrag | null;
          if (!data || data.cardId === '') {
            setRemoteDrag(null);
          } else if (data.cardId) {
            setRemoteDrag(data);
            setTimeout(() => {
              // Ghosts expire if the drag-end broadcast is lost.
              if (remoteDrag()?.cardId === data.cardId) setRemoteDrag(null);
            }, 4000);
          }
        });

      void self.subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          void self.track({
            name: profile.display_name || profile.email.split('@')[0],
            avatarUrl: profile.avatar_url,
          });
        }
      });
    },
  );

  /** Broadcast a drag-in-progress ghost (null cardId ends it). */
  const broadcastDrag = (cardId: string | null, name: string) => {
    void channel?.send({
      type: 'broadcast',
      event: 'drag',
      payload: { cardId: cardId ?? '', name },
    });
  };

  onCleanup(() => {
    if (client && channel) void client.removeChannel(channel);
  });

  return { others, remoteDrag, broadcastDrag };
}

/** An avatar: the image when present, otherwise initials on a color. */
export function presenceColor(userId: string): string {
  const palette = ['#6366f1', '#ec4899', '#f59e0b', '#10b981', '#06b6d4', '#8b5cf6'];
  let hash = 0;
  for (let i = 0; i < userId.length; i++) hash = (hash * 31 + userId.charCodeAt(i)) >>> 0;
  return palette[hash % palette.length];
}

// Board presence + drag broadcast: ephemeral multi-user signals that never
// touch the database (Excalidraw's split: durable state in storage,
// ephemeral signals over the relay). Presence shows who's viewing the
// board; broadcast carries "this card is being dragged" ghosts so you see
// movement before the drop commits server-side.
import { createEffect, createSignal, onCleanup } from 'solid-js';
import type { RealtimeChannel } from '@supabase/supabase-js';

import { browserClient } from './supabase-client';
import type { MeProfile } from './auth';
import type { BoardOp, BoardOpFail } from './board-ops';
export interface PresenceUser {
  userId: string;
  name: string;
  avatarUrl: string | null;
}

export interface RemoteDrag {
  cardId: string;
  name: string;
  /** The dragged card's height — peers' ghosts open exactly that much space. */
  height?: number | null;
  /** The hover slot the mover currently points at (the peer ghost). */
  listId?: string | null;
  index?: number | null;
}

export function createBoardPresence(
  boardId: string,
  me: () => MeProfile | null,
  onOp?: (op: BoardOp | BoardOpFail) => void,
) {
  const [others, setOthers] = createSignal<PresenceUser[]>([]);
  const [remoteDrag, setRemoteDrag] = createSignal<RemoteDrag | null>(null);

  let channel: RealtimeChannel | null = null;
  let client: ReturnType<typeof browserClient> = null;
  /** The renewable drag-ghost expiry — re-armed by every drag broadcast. */
  let dragExpiry: ReturnType<typeof setTimeout> | null = null;
  // Subscribe once the signed-in profile resolves (the async model holds
  // the effect until then; signed-out boards never subscribe).
  createEffect(
    () => ({ profile: me(), enabled: !!browserClient() }),
    ({ profile, enabled }) => {
      if (!profile || !enabled || channel) return;
      client = browserClient();
      const self =
        channel ??
        client!.channel(`presence-board-${boardId}`, {
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
          // One RENEWABLE timer per drag, not one per broadcast: every
          // message (hover, heartbeat) re-arms the same window, so a live
          // drag never expires mid-flight — the ghost dies only when the
          // drag goes silent (lost dragend, closed tab).
          if (dragExpiry) {
            clearTimeout(dragExpiry);
            dragExpiry = null;
          }
          if (!data || data.cardId === '') {
            setRemoteDrag(null);
          } else if (data.cardId) {
            setRemoteDrag(data);
            dragExpiry = setTimeout(() => setRemoteDrag(null), 4000);
          }
        })
        // Provisional ops: another viewer changed something — apply it as a
        // prediction now; the durable echo reconciles it. The fail relay
        // drops the prediction when the author's write didn't land.
        .on('broadcast', { event: 'op' }, ({ payload }) => {
          const op = payload as BoardOp | null;
          if (op?.opId) onOp?.(op);
        })
        .on('broadcast', { event: 'op-fail' }, ({ payload }) => {
          const fail = payload as BoardOpFail | null;
          if (fail?.opId) onOp?.(fail);
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
  const broadcastDrag = (cardId: string | null, name: string, height?: number | null) => {
    void channel?.send({
      type: 'broadcast',
      event: 'drag',
      payload: { cardId: cardId ?? '', name, height: height ?? null },
    });
  };

  /** Broadcast the mover's hover slot — peers see the ghost move live. */
  const broadcastDragHover = (
    cardId: string | null,
    name: string,
    height: number | null,
    listId: string | null,
    index: number | null,
  ) => {
    if (!cardId) return;
    void channel?.send({
      type: 'broadcast',
      event: 'drag',
      payload: {
        cardId,
        name,
        height: height ?? null,
        listId: listId ?? '',
        index: index ?? -1,
      },
    });
  };

  /** Relay an op to the other viewers (provisional application on arrival;
   *  the durable echo remains the source of truth). */
  const broadcastOp = (op: BoardOp) => {
    void channel?.send({ type: 'broadcast', event: 'op', payload: op });
  };

  /** Tell the other viewers the write failed: drop the prediction. */
  const broadcastOpFail = (opId: string) => {
    void channel?.send({ type: 'broadcast', event: 'op-fail', payload: { opId } });
  };

  onCleanup(() => {
    if (dragExpiry) clearTimeout(dragExpiry);
    if (client && channel) void client.removeChannel(channel);
  });

  return { others, remoteDrag, broadcastDrag, broadcastDragHover, broadcastOp, broadcastOpFail };
}

/** An avatar: the image when present, otherwise initials on a color. */
export function presenceColor(userId: string): string {
  const palette = ['#6366f1', '#ec4899', '#f59e0b', '#10b981', '#06b6d4', '#8b5cf6'];
  let hash = 0;
  for (let i = 0; i < userId.length; i++) hash = (hash * 31 + userId.charCodeAt(i)) >>> 0;
  return palette[hash % palette.length];
}

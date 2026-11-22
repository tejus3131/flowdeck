// The workspace relay channel: the same ephemeral op relay the board page
// runs (see presence.ts), scoped to a workspace. The members page, the
// dashboard and the board page (for access flips) each join it and apply
// the op kinds they know as provisional predictions; the database echo
// reconciles. Broadcasts are display hints only — never trusted as truth.
import { createEffect, onCleanup } from 'solid-js';
import type { RealtimeChannel } from '@supabase/supabase-js';

import { browserClient } from './supabase-client';
import type { MeProfile } from './auth';
import type { WorkspaceOp } from './workspace-ops';
export function createWorkspaceRelay(
  workspaceId: () => string | null | undefined,
  me: () => MeProfile | null,
  onOp?: (op: WorkspaceOp | { opId: string }) => void,
) {
  let channel: RealtimeChannel | null = null;
  let client: ReturnType<typeof browserClient> = null;
  let joinedId: string | null = null;

  createEffect(
    () => ({ id: workspaceId(), profile: me(), enabled: !!browserClient() }),
    ({ id, profile, enabled }) => {
      if (!id || !profile || !enabled) return;
      if (channel && joinedId === id) return;
      // A workspace switch re-subscribes to the new workspace's relay.
      if (client && channel) void client.removeChannel(channel);
      client = browserClient();
      joinedId = id;
      channel = client!.channel(`ws-relay-${id}`);
      channel
        .on('broadcast', { event: 'op' }, ({ payload }) => {
          const op = payload as WorkspaceOp | null;
          if (op?.opId) onOp?.(op);
        })
        .on('broadcast', { event: 'op-fail' }, ({ payload }) => {
          const fail = payload as { opId: string } | null;
          if (fail?.opId) onOp?.(fail);
        });
      void channel.subscribe();
    },
  );

  const broadcastOp = (op: WorkspaceOp) => {
    void channel?.send({ type: 'broadcast', event: 'op', payload: op });
  };

  const broadcastOpFail = (opId: string) => {
    void channel?.send({ type: 'broadcast', event: 'op-fail', payload: { opId } });
  };

  onCleanup(() => {
    if (client && channel) void client.removeChannel(channel);
  });

  return { broadcastOp, broadcastOpFail };
}

/**
 * One-off relay for a page that isn't mounted on a workspace view: the
 * invite-accept flow announces the new member to everyone already on the
 * members page. Best-effort — a missed broadcast costs one echo beat
 * (~1s), nothing more.
 */
export async function broadcastMemberJoined(
  workspaceId: string,
  member: {
    userId: string;
    role: string;
    displayName: string | null;
    email: string | null;
    avatarUrl: string | null;
  },
): Promise<void> {
  const client = browserClient();
  if (!client) return;
  const channel = client.channel(`ws-relay-${workspaceId}`);
  const subscribed = new Promise<void>((resolve) => {
    channel.subscribe((status) => {
      if (status === 'SUBSCRIBED') resolve();
    });
  });
  // Relay subscription is best-effort: the echo covers a missed announce.
  await Promise.race([subscribed, new Promise((resolve) => setTimeout(resolve, 2000))]);
  await channel.send({
    type: 'broadcast',
    event: 'op',
    payload: {
      opId: crypto.randomUUID(),
      payload: {
        kind: 'member-joined',
        userId: member.userId,
        role: member.role,
        displayName: member.displayName,
        email: member.email,
        avatarUrl: member.avatarUrl,
      },
    },
  });
  void client.removeChannel(channel);
}

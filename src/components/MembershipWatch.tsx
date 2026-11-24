// The "my workspace disappeared" guard — mounted on pages that lack
// their own workspace-scoped stream (dashboard, search, profile, user
// profile, docs). When one of my memberships vanishes (removed, left,
// or the workspace was deleted underneath me), the workspace + board
// queries revalidate everywhere; if the CURRENT workspace is gone, the
// page falls back to the workspace picker. Board/members/team pages
// feel membership loss through their own streams ending instead.
import { onSettled } from 'solid-js';
import { createMemo } from 'solid-js';
import { liveQuery, revalidate, useNavigate } from '@solidjs/router';

import { getMe } from '../lib/auth';
import { getMyWorkspaces, myMembershipWatch } from '../lib/workspaces';

export function MembershipWatch() {
  const navigate = useNavigate();
  const watch = liveQuery(myMembershipWatch, 'my-ws');
  const me = createMemo(() => getMe());
  onSettled(() => {
    if (!me()?.id) return;
    void (async () => {
      try {
        for await (const _event of await watch()) {
          revalidate('workspaces');
          revalidate('boards');
          // The MCP permission caps (role + board-creation policy) re-read
          // too: the consent and connection pages must not serve stale
          // offerings after a role change or a policy change.
          revalidate('my-ws-choices');
          // Only bounce to the picker when there is no current workspace
          // left — people on OTHER workspaces stay exactly where they are.
          const list = await getMyWorkspaces();
          if (!list.some((ws) => ws.current)) navigate('/');
        }
      } catch {
        // best effort — the next navigation revalidates anyway
      }
    })();
  });
  return null;
}

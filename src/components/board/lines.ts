// Extracted from the board route (phase 6): shared display text for
// tombstone rows — used by the chat panel and the card drawer.
import type { Member, TeamView } from '../../lib/workspaces';

export /**
 * The deletion trail for a tombstone row (0057): a markdown line whose
 * people are REAL user: mentions, so chips carry avatars + hovers and
 * survive renames — two people with the same name can't be confused.
 * Rendered through the same renderMarkdown context as message bodies.
 */
function tombstoneLine(
  row: {
    deleted_by?: string | null;
    deleted_as?: 'author' | 'owner' | 'admin' | 'team_admin' | null;
    deleted_as_team_id?: string | null;
    author_id: string | null;
  },
  meId: string | null,
  members: Member[],
  teams: TeamView[],
  kind: 'message' | 'comment',
): string {
  const nameOf = (id: string | null | undefined): string => {
    if (!id) return 'a former member';
    const member = members.find((entry) => entry.user_id === id);
    return (member?.display_name ?? member?.email?.split('@')[0] ?? 'a former member').replace(
      /[\][()]/g,
      '',
    );
  };
  // The author's own delete reads as a simple line — no role needed.
  if (row.deleted_as === 'author') {
    return row.deleted_by === meId
      ? `You deleted this ${kind}`
      : `[${nameOf(row.deleted_by)}](user:${row.deleted_by}) deleted this ${kind}`;
  }
  const role =
    row.deleted_as === 'owner'
      ? ' as Owner'
      : row.deleted_as === 'admin'
        ? ' as Admin'
        : row.deleted_as === 'team_admin'
          ? ` as ${teams.find((t) => t.id === row.deleted_as_team_id)?.name ?? 'a team'} team admin`
          : '';
  return `[${nameOf(row.deleted_by)}](user:${row.deleted_by}) deleted a ${kind} from [${nameOf(
    row.author_id,
  )}](user:${row.author_id})${role}`;
}

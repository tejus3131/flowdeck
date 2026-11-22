// Shared vocabulary for rendering a notification row everywhere it shows
// up — toasts, the bell panel. One place decides what each kind says and
// where it clicks through to.
import type { NotificationRow } from './notifications';

/** Extract mention user ids from markdown text (client-side twin of the
 *  server's parser — `[Name](user:<uuid>)` links). */
export function mentionIds(source: string): string[] {
  const ids: string[] = [];
  for (const match of source.matchAll(/\]\(user:([0-9a-f-]{36})\)/g)) ids.push(match[1]);
  return ids;
}

/** Extract TEAM mention ids (`[Team](team:<uuid>)` links). */
export function mentionTeamIds(source: string): string[] {
  const ids: string[] = [];
  for (const match of source.matchAll(/\]\(team:([0-9a-f-]{36})\)/g)) ids.push(match[1]);
  return ids;
}

/** One line of prose for the row, plus its supporting detail. */
export function notificationLine(
  row: NotificationRow,
  meId: string | null,
): { text: string; detail: string } {
  const actor = row.actor_name ?? 'Someone';
  const subject = row.subject_name ?? 'someone';
  const team = row.subject_team_name ?? row.subject_team_id ?? 'a team';
  const board = row.board_name ?? 'a board';
  const where = row.card_number !== null ? `#${row.card_number}` : board;
  switch (row.kind) {
    case 'mention':
      return {
        text: `${actor} mentioned you on ${where}`,
        detail: [row.card_title, board].filter(Boolean).join(' · '),
      };
    case 'assignment':
      return {
        text: `${actor} assigned you to ${where}`,
        detail: [row.card_title, board].filter(Boolean).join(' · '),
      };
    case 'comment':
      return {
        text: `${actor} commented on ${where}`,
        detail: [row.card_title, board].filter(Boolean).join(' · '),
      };
    case 'access_request':
      return {
        text: row.subject_team_id
          ? `${actor} asked you to give @${team} access to ${board}`
          : `${actor} asked you to give ${subject} access to ${board}`,
        detail: row.card_title ?? 'Grant or deny from here',
      };
    case 'access_provided':
      return {
        text:
          row.actor_id && row.actor_id === meId
            ? row.subject_team_id
              ? `You gave @${team} access to ${board}`
              : `You gave ${subject} access to ${board}`
            : row.subject_team_id
              ? `${actor} granted @${team} access to ${board}`
              : `${actor} granted ${subject} access to ${board}`,
        detail: row.card_number !== null ? `They can now see ${where}` : row.card_title ?? '',
      };
    case 'access_denied':
      return {
        text: row.subject_team_id
          ? `${actor} denied @${team}'s request for ${board}`
          : `${actor} denied ${subject}'s request for ${board}`,
        detail: '',
      };
    case 'access_granted':
      return {
        text: `${actor} gave you access to ${board}`,
        detail: '',
      };
    case 'access_revoked':
      return {
        text: `${actor} removed your access to ${board}`,
        detail: '',
      };
    case 'role_changed':
      return {
        text: `${actor} made you ${row.body ?? 'a member'}`,
        detail: 'Workspace role updated',
      };
    case 'chat':
      return {
        text: row.card_number !== null
          ? `${actor} commented on ${where}`
          : `${actor} messaged ${board}`,
        detail: row.body ?? row.card_title ?? '',
      };
    case 'team_added':
      return {
        text: `${actor} added you to @${team}`,
        detail: '',
      };
    case 'team_removed':
      return {
        text: `${actor} removed you from @${team}`,
        detail: '',
      };
    case 'invite':
      return {
        text: `${actor} invited you to ${row.body ?? 'a workspace'}`,
        detail: 'Tap to accept',
      };
  }
}

/** Notification hrefs are stored as absolute URLs (they also ride email
 *  + OS notifications). The router wants a PATH — this normalizes. */
export function hrefToPath(href: string): string {
  if (/^https?:\/\//i.test(href)) {
    try {
      return new URL(href).pathname + new URL(href).search;
    } catch {
      return '/';
    }
  }
  return href.startsWith('/') ? href : `/${href}`;
}

/** Where clicking the row (toast, panel) goes. */
export function notificationHref(row: NotificationRow): string {  if (row.href) return row.href;
  switch (row.kind) {
    case 'access_request':
      return row.board_id ? `/b/${row.board_id}` : '/';
    case 'access_denied':
    case 'team_added':
    case 'team_removed':
    case 'role_changed':
    case 'access_revoked':
      return '/';
    default:
      if (row.card_id) return `/b/${row.board_id}?card=${row.card_id}`;
      // Board-scope rows (chat + its mentions) land with the chat open.
      if (row.board_id) return `/b/${row.board_id}?chat=1`;
      return '/';
  }
}

/** The quiet rows: chat activity lives in the bell panel's hidden section
 *  (no sound, no toast, not in the unread badge). */
export function isChatRow(row: Pick<NotificationRow, 'kind'>): boolean {
  return row.kind === 'chat';
}

import { describe, expect, it } from 'vitest';
import { notificationLine } from './notification-text';
import type { NotificationRow } from './notifications';

const row = (kind: NotificationRow['kind'], body: string | null = null): NotificationRow =>
  ({
    id: 'n1',
    kind,
    card_id: null,
    board_id: null,
    actor_id: 'a1',
    actor_name: 'Tejus',
    subject_id: null,
    subject_name: null,
    card_number: null,
    board_name: null,
    subject_team_id: null,
    subject_team_name: null,
    href: null,
    body,
    created_at: '2026-11-25T00:00:00Z',
    seen_at: null,
    agent: false,
  }) as NotificationRow;

describe('notificationLine degrades instead of throwing', () => {
  it('workspace_purged renders the purge line with the counts as detail', () => {
    const line = notificationLine(
      row('workspace_purged', 'purged every board — 3 boards and 12 cards removed permanently'),
      null,
    );
    expect(line.text).toBe('Tejus purged every board in this workspace');
    expect(line.detail).toContain('3 boards');
  });

  it('an unknown kind falls back to the stored body — the bell never crashes', () => {
    const line = notificationLine(row('mention', 'someone mentioned you'), null);
    expect(line.text).toBeTruthy();
    expect(typeof line.text).toBe('string');
    // And the agent suffix path must find a string, never undefined
    // (this was the TypeError: humanLine returning undefined for an
    // unhandled kind).
    const agentLine = notificationLine({ ...row('mention', null), agent: true }, null);
    expect(agentLine.text.endsWith('using Agent')).toBe(true);
  });
});

---
name: flowdeck
description: Operate Flowdeck boards through its MCP server — where things live, how to page, mention syntax, tagging, the mention-access flow, and the etiquette that keeps a team board tidy. Load this before driving Flowdeck for the first time or when a Flowdeck call fails.
---

# Flowdeck for agents

Flowdeck is a kanban + chat product (boards → lists → cards; card comments
and per-board chat). Everything you can do goes through MCP tools that run
**as the connected user**, under the same permissions they have in the web
app. Nothing you do is invisible to the team — every mutation lands in
timelines and notifications like it does for a human.

## First steps on a new connection

1. `get_me` — who you are (and whose permissions you carry).
2. `list_workspaces` — the connection may be **workspace-scoped**: you will
   only ever see what was granted. If you can't find something, ask your
   human whether this connection is scoped to the right workspace.
3. `list_boards` → `get_board` (board + its lists) → `get_cards(list_id)`.

## Pagination — read this once

Every list-shaped tool returns `{ items, next_cursor }`. `next_cursor` is an
opaque string, `null` on the last page. Pass it back as `cursor` for the next
page; don't decode or invent it. `limit` defaults to 50 (max 200). If you
need everything, page until `next_cursor` is null — never assume one call
returned the whole list.

## Chat: mentions, order, edits

Mentions use markdown links — the label is a display snapshot, the id is the
real reference:

- `[Ada](user:<uuid>)` — a person (ids from `list_workspace_members`,
  `get_user`, or `list_teams` members)
- `[Design](team:<uuid>)` — a team
- `[Fix login](card:<uuid>)` — a card (renders "Board › Card" across boards)

They work in board chat, card comments, and card descriptions.

- A mention the target **cannot see** (no board access) is silently not
  delivered. Before mentioning new people/teams, call
  `check_mention_access` — it returns blocked users/teams plus `can_grant`
  and `can_request`. Grant when `can_grant` is true; **stop and ask your
  human** when only `can_request` is true (or anything looks unusual).
- Messages and comments carry a `seq` — the true send order even when a
  burst lands within the same second. Sort by `seq`, never `created_at`.
- Edit/delete are soft: edits stamp `edited`, deletes hide the row (history
  is preserved). Clean up your own mistakes with `edit_comment` /
  `delete_board_message` rather than posting corrections.
- An author edits their own rows; workspace owners/admins can edit or delete
  anyone's.

## Cards, lists, positions

- `create_card` appends atomically — concurrent creates can never collide
  (same for `create_list`). You never need to compute a position.
- `move_card(card_id, list_id)` without a position appends at the end. With
  a position it is absolute (whole numbers: 1, 2, 3…).
- Card numbers (`number`) are the human-facing ids (#12 style), stable
  across moves; search supports `query: "#12"`.
- `update_card` assignees/tag_ids are FULL replacement sets — read the
  current card first (its tags ride along in `get_cards`) if you mean to
  keep existing entries. Newly assigned users get a notification.
- Every mutation lands on the card's timeline (`get_card_events`); renames
  and priority changes log from → to.

## Tags

Tags are a workspace's shared vocabulary: lowercased, unique per workspace,
max 24 chars. `create_tag` is find-or-create (safe to call repeatedly).
Rename/delete/merge are workspace owner/admin only. Tags ride on cards via
`update_card` `tag_ids` or `search(tag_id: ...)`.

## Notifications

Your inbox is `list_notifications` (filter: all | unread | read), paged like
everything else. Rows carry display names for who did what. When the human
asks you to triage: read unread ones, act, then `mark_notification_read`
(or `mark_all_notifications_read`). Access requests show up here for
workspace owners/admins — resolve with `resolve_access_request`.

## Search

`search` covers boards, cards (title+description), comments, and board
messages with filters: `type`, `author_id`, `team_id` (the author's team),
`board_id`, `tag_id`, `priority`, `from`/`to` (ISO 8601). Every row carries a
`type` discriminator plus board name and card number/title, so answers like
"all comments by the Design team last week mentioning deploy" are one call.

## Errors and etiquette

- `this connection is not scoped to that workspace` — the credential's
  boundary, not your human's permissions. Tell them; don't retry elsewhere.
- `this connection is not permitted to run <tool>` — the owner granted only
  some tool categories. Say what's missing; **never try to widen your own
  permissions** — there is no tool that can, by design.
- `workspace owners/admins only` — role-gated action; surface it to your
  human instead of retrying.
- Destructive tools (`delete_board`, `delete_list`, `delete_card`) remove
  everything inside. Confirm with your human before using them.
- Like a good teammate: don't spam chat, don't rewrite others' text (soft
  deletes preserve history, but the timeline shows it was you), and use
  `update_card` rather than delete+recreate.

## Limits

| Field | Limit |
| --- | --- |
| board name | 80 |
| board description | 4000 |
| list name | 80 |
| list description | 2000 |
| card title | 200 |
| card description | 8000 |
| comment | 2000 |
| board message | 4000 |
| team name | 60 |
| team description | 500 |
| tag name | 24 (lowercased) |
| display name | 80 |
| notification body excerpt | 200 |

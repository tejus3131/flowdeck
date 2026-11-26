// The tags hub's server side: everything the workspace tags page and the
// per-tag page read and mutate. Tag rows live in boards.ts's workspace
// snapshots; this file owns the tag-specific reads (mentions, tagged
// cards) and the editing surface (updateTag — tags are never deleted:
// serialized tag:<uuid> chips in messages, comments, and descriptions
// would dangle; a rename keeps every link alive).
import { createSupabaseRequestClient } from '../server/supabase';
import { friendlyError } from '../server/friendly';

function assertId(id: string, what: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id ?? '')) {
    throw new Error(`Invalid ${what}`);
  }
  return id;
}

function cleanText(value: unknown, what: string, max: number): string {
  if (typeof value !== 'string') throw new Error(`${what} is required`);
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${what} is empty`);
  return trimmed.slice(0, max);
}

/** Page plan for refreshing a loaded feed window without collapsing it:
 *  the RPC caps any single call at `max` rows, so a live refresh of N
 *  loaded rows walks consecutive slices. Trailing slices past the feed's
 *  end simply come back empty — the caller stops at the first short one. */
export function pageSlices(target: number, max = 100): Array<{ offset: number; limit: number }> {
  const plan: Array<{ offset: number; limit: number }> = [];
  for (let offset = 0; offset < target; offset += max) {
    plan.push({ offset, limit: Math.min(max, target - offset) });
  }
  return plan;
}

/** One row of a tag's event capsule: a chat mention, a comment mention,
 *  a description mention, or the tag added to / removed from a card —
 *  display-ready (the RPC flattens chips and clips the text). */
export type TagEventRow = {
  kind: 'chat' | 'comment' | 'description' | 'tagged' | 'untagged';
  board_id: string;
  board_name: string;
  message_id?: string;
  card_id?: string;
  card_title?: string;
  comment_id?: string;
  author: string;
  avatar_url: string | null;
  snippet: string;
  created_at: string;
};

/** A page of the tag's events, newest first (infinite scroll walks this
 *  with a growing offset). `query` searches the entries; `from`/`to`
 *  bound the time window. */
export async function getTagEvents(
  tagId: string,
  options: { offset?: number; limit?: number; query?: string; from?: string; to?: string } = {},
): Promise<TagEventRow[]> {
  'use server';
  const supabase = createSupabaseRequestClient();
  // LIKE wildcards in the user's query must match literally: % and _ are
  // escaped (Postgres's default LIKE escape is the backslash).
  const escaped = (options.query ?? '').replace(/[\\%_]/g, (m) => `\\${m}`);
  // The server-fn codec rejects undefined values — only send what's set.
  const args: {
    p_tag_id: string;
    p_query: string;
    p_limit: number;
    p_offset: number;
    p_from?: string;
    p_to?: string;
  } = {
    p_tag_id: assertId(tagId, 'tag id'),
    p_query: escaped,
    p_limit: options.limit ?? 30,
    p_offset: options.offset ?? 0,
  };
  if (options.from) args.p_from = options.from;
  if (options.to) args.p_to = options.to;
  const { data, error } = await supabase.rpc('tag_event_rows', args);
  if (error) throw new Error(error.message);
  return (data ?? []) as TagEventRow[];
}

/** Card counts per tag — the hub's "N cards" badges. RLS: only cards on
 *  boards the reader can see are counted. One head-count per tag: the
 *  rows never travel, the database does the counting. */
export async function getTagCardCounts(tagIds: string[]): Promise<Record<string, number>> {
  'use server';
  const ids = [...new Set(tagIds)].filter((id) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id ?? ''),
  );
  if (ids.length === 0) return {};
  const supabase = createSupabaseRequestClient();
  const counts = await Promise.all(
    ids.map(async (id) => {
      const { count, error } = await supabase
        .from('card_tags')
        .select('tag_id', { count: 'exact', head: true })
        .eq('tag_id', id);
      if (error) throw new Error(error.message);
      return [id, count ?? 0] as const;
    }),
  );
  return Object.fromEntries(counts);
}

/** Edit a tag (owners/admins — RLS tags_update_admin). The same rules
 *  as the MCP ops: name lower-cased, trimmed, max 24 chars; description
 *  max 500. Editors live on the per-tag page — the hub only lists. */
export async function updateTag(
  tagId: string,
  patch: { name?: string; description?: string },
): Promise<{ name: string; description: string }> {
  'use server';
  const supabase = createSupabaseRequestClient();
  const update: { name?: string; description?: string } = {};
  if (patch.name !== undefined) {
    update.name = cleanText(patch.name, 'Tag name', 24).toLowerCase();
  }
  if (patch.description !== undefined) {
    const description = String(patch.description ?? '');
    if (description.length > 500)
      throw friendlyError('Tag description is too long (max 500 characters)');
    // Empty clears the description — unlike the name, which must exist.
    update.description = description.trim();
  }
  if (Object.keys(update).length === 0) {
    throw friendlyError('Nothing to update — pass a name or a description');
  }
  const { data, error } = await supabase
    .from('tags')
    .update(update)
    .eq('id', assertId(tagId, 'tag id'))
    .select('name, description')
    .single();
  if (error || !data) {
    throw friendlyError('Tag not found or you cannot edit it (owners and admins only)');
  }
  return { name: data.name, description: data.description ?? '' };
}

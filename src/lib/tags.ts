// The tags hub's server side: everything the workspace tags page and the
// per-tag page read and mutate. Tag rows live in boards.ts's workspace
// snapshots; this file owns the tag-specific reads (mentions, tagged
// cards) and the admin lifecycle (rename / delete — RLS enforces
// owners/admins, the same rules the MCP ops run under).
import { createSupabaseRequestClient } from '../server/supabase';

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

/** One row of a tag's mention feed: a chat message, a comment, or a
 *  card description that cites the tag — display-ready (the RPC flattens
 *  chips and clips the text). */
export type TagMentionRow = {
  kind: 'chat' | 'comment' | 'description';
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

/** A page of the tag's mentions, newest first (infinite scroll feeds
 *  walk this with a growing offset). */
export async function getTagMentions(
  tagId: string,
  offset = 0,
  limit = 30,
): Promise<TagMentionRow[]> {
  'use server';
  const supabase = createSupabaseRequestClient();
  const { data, error } = await supabase.rpc('tag_mention_rows', {
    p_tag_id: assertId(tagId, 'tag id'),
    p_limit: limit,
    p_offset: offset,
  });
  if (error) throw new Error(error.message);
  return (data ?? []) as TagMentionRow[];
}

/** The cards carrying a tag (visible ones only — RLS on card_tags).
 *  Display-ready: card title/number plus its board for the click-through. */
export type TaggedCard = {
  card_id: string;
  card_title: string;
  card_number: number | null;
  board_id: string;
  board_name: string;
};

export async function getTaggedCards(tagId: string): Promise<TaggedCard[]> {
  'use server';
  const supabase = createSupabaseRequestClient();
  const { data, error } = await supabase
    .from('card_tags')
    .select('card_id, cards(id, title, number, board_id, boards(name))')
    .eq('tag_id', assertId(tagId, 'tag id'))
    .limit(500);
  if (error) throw new Error(error.message);
  return (data ?? [])
    .map((row) => {
      const card = row.cards as
        | { id: string; title: string; number: number | null; board_id: string; boards: { name: string } | null }
        | null;
      return card
        ? {
            card_id: card.id,
            card_title: card.title,
            card_number: card.number,
            board_id: card.board_id,
            board_name: card.boards?.name ?? 'a board',
          }
        : null;
    })
    .filter((row): row is TaggedCard => row !== null);
}

/** Card counts per tag — the hub's "N cards" badges. RLS: only cards on
 *  boards the reader can see are counted. */
export async function getTagCardCounts(
  tagIds: string[],
): Promise<Record<string, number>> {
  'use server';
  const ids = [...new Set(tagIds)].filter((id) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id ?? ''),
  );
  if (ids.length === 0) return {};
  const supabase = createSupabaseRequestClient();
  const { data, error } = await supabase
    .from('card_tags')
    .select('tag_id')
    .in('tag_id', ids);
  if (error) throw new Error(error.message);
  const counts: Record<string, number> = {};
  for (const row of data ?? []) {
    const id = row.tag_id as string;
    counts[id] = (counts[id] ?? 0) + 1;
  }
  return counts;
}

/** Rename a tag (owners/admins — RLS tags_update_admin). The same rules
 *  as the MCP op: lower-cased, trimmed, max 24 chars. */
export async function renameTag(tagId: string, rawName: string): Promise<{ name: string }> {
  'use server';
  const supabase = createSupabaseRequestClient();
  const name = cleanText(rawName, 'Tag name', 24).toLowerCase();
  const { data, error } = await supabase
    .from('tags')
    .update({ name })
    .eq('id', assertId(tagId, 'tag id'))
    .select('name')
    .single();
  if (error || !data) throw new Error('Tag not found or you cannot rename it (owners and admins only)');
  return { name: data.name };
}

/** Delete a tag (owners/admins — RLS tags_delete_admin). Cards linked
 *  to it simply lose it. */
export async function deleteTag(tagId: string): Promise<void> {
  'use server';
  const supabase = createSupabaseRequestClient();
  const { error } = await supabase.from('tags').delete().eq('id', assertId(tagId, 'tag id'));
  if (error) throw new Error('Tag not found or you cannot delete it (owners and admins only)');
}

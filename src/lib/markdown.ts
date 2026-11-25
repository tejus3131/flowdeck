// Card body rendering — the GitHub-PR-style experience: markdown, images,
// embedded video links, #number citations that link to the referenced
// card, and @mentions stored BY USER ID (renames can't break them; the
// chip always shows the member's current display name). Everything is
// sanitized; embeds are host-whitelisted.
import { marked } from 'marked';
import DOMPurify from 'dompurify';

marked.setOptions({ gfm: true, breaks: true });

/** Only real UUIDs may become board references — anything else stays
 *  plain text (a board:<junk> href must never flow into routing). */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const VIDEO_HOSTS: Record<string, (id: string) => string> = {
  'youtube.com': (id) => `https://www.youtube.com/embed/${id}`,
  'youtu.be': (id) => `https://www.youtube.com/embed/${id}`,
  'vimeo.com': (id) => `https://player.vimeo.com/video/${id}`,
};

/** Bare YouTube/Vimeo URLs become embeds (the GitHub trick, minus GitHub). */
function videoEmbed(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.replace(/^www\./, '');
  const embed = VIDEO_HOSTS[host];
  if (!embed) return null;
  const id =
    host === 'youtu.be'
      ? parsed.pathname.replace(/^\//, '')
      : parsed.pathname.replace(/^\/(?:embed\/|watch\/)?/, '').split('/')[0];
  if (!id) return null;
  return `<iframe src="${embed(id)}" allowfullscreen loading="lazy" sandbox="allow-scripts allow-same-origin allow-presentation" style="aspect-ratio:16/9;width:100%;height:auto;border:0;border-radius:8px"></iframe>`;
}

/** Reference pre-pass: #12 citations become links the drawer delegates
 *  (data-card-ref carries the number; the click opens that card), and old
 *  @-prefixed mentions ([@Name](user:…) written before the chip carried
 *  its own @) lose the stray @ so the chip isn't doubled. Only numbers of
 *  cards that actually exist become citations — a bare #3 stays prose.
 *  Existing [label](href) spans (mentions, tags, cross-board refs whose
 *  labels may contain #N) are protected — the citation pass must never
 *  rewrite inside them. */
function withReferences(markdown: string, cardNumbers?: number[]): string {
  const known = cardNumbers ? new Set(cardNumbers) : null;
  const spans: string[] = [];
  const stash = (all: string) => {
    spans.push(all);
    return `\u0001${spans.length - 1}\u0001`;
  };
  const protectedText = markdown
    // Old @-prefixed mentions lose the stray @ first (the chip carries it).
    .replace(/@\[([^\]\n]+)\]\(user:([0-9a-f-]{36})\)/g, '[$1](user:$2)')
    // Then protect every existing link span.
    .replace(/\[([^\]\n]*)\]\(([^)\n]*)\)/g, (all) => stash(all));

  const converted = protectedText.replace(
    // Don't touch URLs (#/path fragments) or code spans.
    /(^|[^/\w&])#(\d+)\b/g,
    (all, lead: string, num: string) => {
      if (known && !known.has(Number(num))) return all;
      return `${lead}[#${num}](flowdeck-card-ref:${num})`;
    },
  );
  return converted.replace(/\u0001(\d+)\u0001/g, (_all, index: string) => spans[Number(index)] ?? '');
}

interface LinkToken {
  href: string;
  title?: string | null;
  tokens?: { text?: string; raw?: string }[];
}
interface ImageToken {
  href: string;
  title?: string | null;
}

const renderer = {
  link({ href, title, tokens }: LinkToken) {
    if (href.startsWith('flowdeck-card-ref:')) {
      const num = href.replace('flowdeck-card-ref:', '');
      return `<a href="#card-${num}" data-card-ref="${num}" title="Card #${num}">#${num}</a>`;
    }
    // Mentions travel as user:<uuid> links — the label is a snapshot of
    // the display name at write time (fallback when the viewer doesn't
    // know the member); the current name is swapped in below.
    if (href.startsWith('user:')) {
      const userId = href.replace('user:', '');
      const label = (tokens ?? []).map((t) => t.raw ?? t.text ?? '').join('') || 'member';
      return `<a href="#user-${userId}" data-user-id="${userId}">${label}</a>`;
    }
    // Board-only references travel as board:<uuid> — the chip names the
    // board itself; the click routes to it.
    if (href.startsWith('board:')) {
      const boardId = href.replace('board:', '');
      const label = (tokens ?? []).map((t) => t.raw ?? t.text ?? '').join('') || 'board';
      if (!UUID.test(boardId)) return label;
      return `<a href="#board-${boardId}" data-board-id="${boardId}">${label}</a>`;
    }
    // Cross-board card references travel as card:<uuid> — the label reads
    // "Board #12"; the click routes to that board.
    if (href.startsWith('card:')) {
      const cardId = href.replace('card:', '');
      const label = (tokens ?? []).map((t) => t.raw ?? t.text ?? '').join('') || 'card';
      return `<a href="#card-${cardId}" data-card-id="${cardId}">${label}</a>`;
    }
    // Tag references travel as tag:<uuid> — the chip links to search.
    if (href.startsWith('tag:')) {
      const tagId = href.replace('tag:', '');
      const label = (tokens ?? []).map((t) => t.raw ?? t.text ?? '').join('') || 'tag';
      return `<a href="#tag-${tagId}" data-tag-id="${tagId}">${label}</a>`;
    }
    // Team mentions travel as team:<uuid> — the chip shows the team's
    // current name (like member mentions, with the @ GitHub-style).
    if (href.startsWith('team:')) {
      const teamId = href.replace('team:', '');
      const label = (tokens ?? []).map((t) => t.raw ?? t.text ?? '').join('') || 'team';
      return `<a href="#team-${teamId}" data-team-id="${teamId}">${label}</a>`;
    }
    // @all travels as all:everyone — the broadcast chip.
    if (href.startsWith('all:')) {
      return `<a href="#all" data-all="1">All</a>`;
    }
    const embed = videoEmbed(href);
    if (embed) return embed;
    const label = (tokens ?? []).map((t) => t.raw ?? t.text ?? '').join('');
    return `<a href="${href}" rel="noopener noreferrer"${title ? ` title="${title}"` : ''}>${label}</a>`;
  },
  image({ href, title }: ImageToken) {
    return `<img src="${href}" alt="${title ?? ''}" loading="lazy" style="max-width:100%;border-radius:8px" />`;
  },
} as never;

marked.use({ renderer });

/** What counts as REAL in this board's markdown. */
export interface MarkdownContext {
  /** Members by id — mention chips show their CURRENT display name. */
  members?: { user_id: string; display_name: string | null; email: string | null }[];
  /** Card numbers that exist (#citations — org-wide). */
  cardNumbers?: number[];
  /** number → which board it lives on (chips read "Board #12"). */
  cardRefs?: Map<number, { title: string | null; board: string }>;
  /** Cards the VIEWER can reach (this board + every board they can see).
   *  Cross-board references outside this set render as "private" — the
   *  board name and number stay hidden (Slack-style). */
  accessibleCardIds?: Set<string>;
  /** The workspace's teams — team chips show their current name. */
  teams?: { id: string; name: string }[];
  /** Cross-board cards by id — chips read "Board › Card title". */
  crossCards?: Map<string, { title: string | null; board: string }>;
  /** The workspace's tag vocabulary — tag chips show their CURRENT name
   *  (renames update everywhere, like member and team chips). */
  tags?: { id: string; name: string }[];
}

/**
 * Render a card body / description to sanitized HTML. Callers delegate
 * clicks on `[data-card-ref]` (open cards) and `[data-user-id]` (member
 * profile, later) themselves.
 */
export function renderMarkdown(source: string, context?: MarkdownContext): string {
  const raw = marked.parse(withReferences(source ?? '', context?.cardNumbers)) as string;
  const clean = DOMPurify.sanitize(raw, {
    ADD_ATTR: [
      'target',
      'allow',
      'allowfullscreen',
      'frameborder',
      'sandbox',
      'loading',
      'data-card-ref',
      'data-user-id',
      'data-card-id',
      'data-tag-id',
      'data-team-id',
      'data-all',
      'data-board-id',
    ],
    ADD_TAGS: ['iframe'],
  });
  // Defense in depth: only whitelisted embed hosts may frame.
  const doc = new DOMParser().parseFromString(clean, 'text/html');
  for (const frame of [...doc.querySelectorAll('iframe')]) {
    const src = frame.getAttribute('src') ?? '';
    const ok = Object.keys(VIDEO_HOSTS).some((host) =>
      src.startsWith(`https://${host}`) ||
      src.startsWith(`https://www.${host}`) ||
      src.startsWith('https://player.vimeo.com'),
    );
    if (!ok) frame.remove();
  }
  styleReferences(doc, context?.members, context?.accessibleCardIds, context?.teams, context?.cardRefs, context?.crossCards, context?.tags);
  return doc.body.innerHTML;
}

/** Reference anchors become chips: mentions wear the member's CURRENT
 *  display name (renames update every old comment and card); cross-board
 *  cards and tags get their own chips. */
function styleReferences(
  doc: Document,
  members?: { user_id: string; display_name: string | null; email: string | null }[],
  accessibleCardIds?: Set<string>,
  teams?: { id: string; name: string }[],
  cardRefs?: Map<number, { title: string | null; board: string }>,
  crossCards?: Map<string, { title: string | null; board: string }>,
  tags?: { id: string; name: string }[],
): void {
  const byId = new Map((members ?? []).map((m) => [m.user_id, m]));
  for (const anchor of [...doc.querySelectorAll('a[data-user-id]')]) {
    const member = byId.get(anchor.getAttribute('data-user-id') ?? '');
    const chip = doc.createElement('span');
    chip.className = 'fd-mention';
    chip.setAttribute('data-user-id', anchor.getAttribute('data-user-id') ?? '');
    chip.textContent = `@${member?.display_name ?? member?.email?.split('@')[0] ?? anchor.textContent?.replace(/^@/, '') ?? 'member'}`;
    anchor.replaceWith(chip);
  }
  for (const anchor of [...doc.querySelectorAll('a[data-card-ref]')]) {
    const num = Number(anchor.getAttribute('data-card-ref'));
    const ref = cardRefs?.get(num);
    const chip = doc.createElement('span');
    chip.className = 'fd-card-ref';
    chip.setAttribute('data-card-ref', anchor.getAttribute('data-card-ref') ?? '');
    // "Board › Card title" — the board disambiguates the number, the title
    // says what it actually is (falls back to "Board #N" without data).
    chip.textContent = ref
      ? ref.title
        ? `${ref.board} › ${ref.title}`
        : `${ref.board} #${num}`
      : `#${num}`;
    chip.title = ref?.title ?? '';
    anchor.replaceWith(chip);
  }
  for (const anchor of [...doc.querySelectorAll('a[data-card-id]')]) {
    const cardId = anchor.getAttribute('data-card-id') ?? '';
    const chip = doc.createElement('span');
    // References the viewer can't reach render as private — no board name,
    // no number (RLS keeps the data hidden; so does the presentation).
    if (accessibleCardIds && !accessibleCardIds.has(cardId)) {
      chip.className = 'fd-locked-ref';
      chip.textContent = '🔒 private card';
      anchor.replaceWith(chip);
      continue;
    }
    chip.className = 'fd-card-ref';
    chip.setAttribute('data-card-id', cardId);
    const cross = crossCards?.get(cardId);
    // "Board › Card title" — same shape as # citations.
    chip.textContent = cross ? (cross.title ? `${cross.board} › ${cross.title}` : cross.board) : (anchor.textContent ?? 'card');
    anchor.replaceWith(chip);
  }
  // Board chips: the board's name as written (the click routes to it).
  for (const anchor of Array.from(doc.querySelectorAll('a[data-board-id]'))) {
    const chip = doc.createElement('span');
    chip.className = 'fd-board-ref';
    chip.setAttribute('data-board-id', anchor.getAttribute('data-board-id') ?? '');
    chip.textContent = anchor.textContent ?? 'board';
    anchor.replaceWith(chip);
  }
  // Tag chips: the tag's CURRENT name (renames update everywhere); the
  // label in the text is a snapshot for the fallback.
  const tagsById = new Map((tags ?? []).map((tag) => [tag.id, tag]));
  for (const anchor of [...doc.querySelectorAll('a[data-tag-id]')]) {
    const tag = tagsById.get(anchor.getAttribute('data-tag-id') ?? '');
    const chip = doc.createElement('span');
    chip.className = 'fd-tag-ref';
    chip.setAttribute('data-tag-id', anchor.getAttribute('data-tag-id') ?? '');
    chip.textContent = `#${tag?.name ?? anchor.textContent?.replace(/^#/, '') ?? 'tag'}`;
    anchor.replaceWith(chip);
  }  // Team chips: the team's CURRENT name (renames update everywhere).
  const teamsById = new Map((teams ?? []).map((team) => [team.id, team]));
  for (const anchor of [...doc.querySelectorAll('a[data-all]')]) {
    const chip = doc.createElement('span');
    chip.className = 'fd-all-ref';
    chip.textContent = '@All';
    anchor.replaceWith(chip);
  }
  for (const anchor of [...doc.querySelectorAll('a[data-team-id]')]) {    const team = teamsById.get(anchor.getAttribute('data-team-id') ?? '');
    const chip = doc.createElement('span');
    chip.className = 'fd-mention fd-team-ref';
    chip.setAttribute('data-team-id', anchor.getAttribute('data-team-id') ?? '');
    chip.textContent = `@${team?.name ?? anchor.textContent?.replace(/^@/, '') ?? 'team'}`;
    anchor.replaceWith(chip);
  }
}

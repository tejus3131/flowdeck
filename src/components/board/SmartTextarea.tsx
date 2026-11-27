// Extracted from the board route (phase 6): a panel is its own module
// so the route stays a wiring file (L5 rule 6).
import { For, Show, createEffect, createSignal, onSettled } from 'solid-js';

import { type CardView, type CrossCard } from '../../lib/boards';

import { type Member, type TeamView } from '../../lib/workspaces';

/** A textarea that knows the board: typing `@` offers members, `#` offers
 *  cards (number + title) — Slack-style. Selecting inserts the real token,
 *  so every rendered @/# is an actual reference. */
/** A textarea that knows the board and LOOKS like Slack:
 *  - typing `@` offers members, `#` offers cards; picking inserts the
 *    real reference (`@[Name](user:id)` / `#N`) — but the box shows a
 *    clean chip instead of the raw markdown (a synced backdrop renders
 *    the highlight while the textarea's own text stays transparent);
 *  - `sendOnEnter` gives comment boxes Enter-to-send (Shift+Enter
 *    newlines; the dropdown's Enter always picks the highlighted item).
 */
/**
 * The mention composer — Slack/Trello-style: a contenteditable box whose
 * @mentions, #citations, #tags, and cross-board references are REAL
 * chips (non-editable inline nodes). One Backspace removes a whole chip
 * (the browser treats it as a single unit), the raw markdown is never
 * visible while typing, and the serialized markdown travels in
 * props.value/onInput exactly as before.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function SmartTextarea(props: {
  value: string;
  onInput: (value: string) => void;
  members: Member[];
  /** Teams appear in the @ menu too (mentioning one notifies every member). */
  teams: TeamView[];
  cards: CardView[];
  /** The workspace's tag vocabulary (# in the box offers these too). */
  workspaceTags: { id: string; name: string }[];
  /** Every card the viewer can see across boards (# offers cross-board refs). */
  crossCards: CrossCard[];
  /** The workspace's boards — the # menu offers cross-board citations
   *  (chips serialize as [name](board:<uuid>) → board backlinks). */
  workspaceBoards?: { id: string; name: string }[];
  /** The board these cards live on — chips read "Board › Card", matching
   *  the rendered markdown instead of a bare #N. */
  boardName?: string;
  /** The board itself — the # menu offers a board-only reference. */
  board?: { id: string; name: string };
  placeholder?: string;
  rows?: number;
  class?: string;
  /** Enter posts (comments); descriptions keep Enter as newline. */
  sendOnEnter?: boolean;
  onSend?: () => void;
}) {
  type Menu = { kind: 'at' | 'hash'; query: string; textNode: Text; offset: number };
  const [menu, setMenu] = createSignal<Menu | null>(null);
  const [active, setActive] = createSignal(0);
  /** Open upward when the composer sits low on screen. */
  const [flip, setFlip] = createSignal(false);
  let root: HTMLDivElement | undefined;
  /** Escape latches the menu shut for this trigger until it's re-typed. */
  let dismissedStart = -1;

  // ── serialization: chips + text → markdown ─────────────────────────
  const serialize = (): string => {
    if (!root) return props.value;
    const out: string[] = [];
    const walk = (node: Node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        out.push(node.textContent ?? '');
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const el = node as HTMLElement;
      if (el.tagName === 'BR') {
        out.push('\n');
        return;
      }
      const mention = el.getAttribute('data-mention');
      if (mention) {
        const label = (el.textContent ?? '').replace(/^@/, '');
        const [kind, id] = mention.split(':');
        out.push(`[${label}](${kind}:${id})`);
        return;
      }
      if (el.hasAttribute('data-cite')) {
        out.push(`#${el.getAttribute('data-cite')}`);
        return;
      }
      const tag = el.getAttribute('data-tag');
      if (tag) {
        out.push(`[#${el.textContent?.replace(/^#/, '')}](tag:${tag})`);
        return;
      }
      const cross = el.getAttribute('data-cross');
      if (cross) {
        out.push(`[${el.textContent}](card:${cross})`);
        return;
      }
      const board = el.getAttribute('data-board');
      if (board) {
        out.push(`[${(el.textContent ?? '').trim()}](board:${board})`);
        return;
      }
      for (const child of el.childNodes) walk(child);
    };
    for (const child of root.childNodes) walk(child);
    return out.join('');
  };

  // ── external value → chips (the parent clears or seeds the draft) ───
  const renderValue = (value: string) => {
    if (!root) return;
    root.textContent = '';
    const pattern = /\[([^\]\n]+)\]\((user|team|tag|card|board|all):([0-9a-f-]{36}|everyone)\)/g;
    let last = 0;
    let match: RegExpExecArray | null;
    const appendText = (text: string) => {
      if (!text) return;
      root.appendChild(document.createTextNode(text));
    };
    while ((match = pattern.exec(value)) !== null) {
      appendText(value.slice(last, match.index));
      const kind = match[2];
      const id = match[3];
      const chip = document.createElement('span');
      chip.contentEditable = 'false';
      chip.className =
        kind === 'user' || kind === 'team' || kind === 'all'
          ? kind === 'all'
            ? 'fd-chip fd-chip-all'
            : 'fd-chip fd-chip-user'
          : kind === 'tag'
            ? 'fd-chip fd-chip-tag'
            : 'fd-chip fd-chip-card';
      if (kind === 'user' || kind === 'team' || kind === 'all')
        chip.setAttribute('data-mention', `${kind}:${id}`);
      else if (kind === 'tag') chip.setAttribute('data-tag', id);
      else if (kind === 'board') chip.setAttribute('data-board', id);
      else chip.setAttribute('data-cross', id);
      // Tag labels travel WITH their # (the serialized form is [#name]),
      // so only prefix when it's missing — otherwise a re-edit doubles
      // it into ##name. People and teams take @; cards and boards
      // render bare (the board chip names the board itself).
      chip.textContent = `${kind === 'tag' ? (match[1].startsWith('#') ? '' : '#') : kind === 'user' || kind === 'team' || kind === 'all' ? '@' : ''}${match[1]}`;
      root.appendChild(chip);
      last = pattern.lastIndex;
    }
    appendText(value.slice(last));
  };

  // Sync when the parent's value changes from OUTSIDE (posting clears
  // the draft). While the composer holds the caret, the DOM is the truth.
  createEffect(
    () => props.value,
    (value) => {
      if (!root) return;
      // While typing, the DOM is the truth — except a parent CLEAR (the
      // value going empty), which always wins: the box must reset after
      // a send even though it still holds the caret.
      if (document.activeElement === root && value !== '') return;
      if (serialize() === value) return;
      renderValue(value ?? '');
    },
  );
  onSettled(() => {
    if (root && !root.textContent && props.value) renderValue(props.value);
  });

  // ── the @ / # menu ─────────────────────────────────────────────────
  type Option = { key: string; label: string; hint?: string; chip: HTMLElement };
  const makeChip = (
    className: string,
    attr: [string, string] | null,
    cite: string | null,
    label: string,
  ): HTMLElement => {
    const chip = document.createElement('span');
    chip.contentEditable = 'false';
    chip.className = className;
    if (attr) chip.setAttribute(attr[0], attr[1]);
    if (cite) chip.setAttribute('data-cite', cite);
    chip.textContent = label;
    return chip;
  };

  const options = (): Option[] => {
    const m = menu();
    if (!m) return [];
    if (m.kind === 'at') {
      const q = m.query.toLowerCase();
      const people = props.members
        .filter((member) => {
          const haystack = `${member.display_name ?? ''} ${member.email ?? ''}`.toLowerCase();
          return haystack.includes(q);
        })
        .slice(0, 6)
        .map((member) => {
          const label = (member.display_name ?? member.email ?? 'member').replace(/[\]([]/g, '');
          return {
            key: member.user_id,
            label,
            hint: member.email ?? undefined,
            chip: makeChip(
              'fd-chip fd-chip-user',
              ['data-mention', `user:${member.user_id}`],
              null,
              `@${label}`,
            ),
          };
        });
      // @all — Slack's @channel: everyone who can see this board, at
      // direct-mention volume ('none' still silences it).
      const all =
        'all'.includes(q) || q === ''
          ? [
              {
                key: 'all:everyone',
                label: 'All',
                hint: `notifies everyone with access (${props.members.length})`,
                chip: makeChip(
                  'fd-chip fd-chip-all',
                  ['data-mention', 'all:everyone'],
                  null,
                  '@All',
                ),
              },
            ]
          : [];
      const teams = props.teams
        .filter((team) => !q || team.name.toLowerCase().includes(q))
        .slice(0, 3)
        .map((team) => {
          const label = team.name.replace(/[\]([]/g, '');
          return {
            key: `team:${team.id}`,
            label: `${label} · team`,
            hint: `notifies ${team.members.length} member${team.members.length === 1 ? '' : 's'}`,
            chip: makeChip(
              'fd-chip fd-chip-user',
              ['data-mention', `team:${team.id}`],
              null,
              `@${label}`,
            ),
          };
        });
      return [...all, ...people, ...teams];
    }
    const q = m.query.toLowerCase();
    const current = props.cards
      .filter((card) => card.number !== null)
      .filter(
        (card) => !q || String(card.number) === m.query || card.title.toLowerCase().includes(q),
      )
      .slice(0, 4)
      .map((card) => ({
        key: `c:${card.id}`,
        label: `#${card.number}`,
        hint: card.title,
        // The chip reads like the rendered citation ("Board › Card") —
        // not a bare #N that transforms on send.
        chip: makeChip(
          'fd-chip fd-chip-card',
          null,
          String(card.number),
          card.title ? `${props.boardName ?? 'Board'} › ${card.title}` : `#${card.number}`,
        ),
      }));
    const tags = props.workspaceTags
      .filter((tag) => !q || tag.name.includes(q))
      .slice(0, 3)
      .map((tag) => ({
        key: `t:${tag.id}`,
        label: `#${tag.name}`,
        hint: 'tag — links to search',
        chip: makeChip('fd-chip fd-chip-tag', ['data-tag', tag.id], null, `#${tag.name}`),
      }));
    // The board itself — a board-only reference: the chip names the
    // board, the click routes to it. Offered when the query matches its
    // name (or nothing is typed yet).
    const board =
      props.board &&
      UUID_RE.test(props.board.id) &&
      (!q || props.board.name.toLowerCase().includes(q))
        ? [
            {
              key: `b:${props.board.id}`,
              label: `${props.board.name} · board`,
              hint: 'reference this board',
              chip: makeChip(
                'fd-chip fd-chip-card',
                ['data-board', props.board.id],
                null,
                props.board.name,
              ),
            },
          ]
        : [];
    const cross = props.crossCards
      .filter(
        (card) =>
          card.board_id !== props.cards[0]?.board_id &&
          (!q ||
            String(card.number) === m.query ||
            card.title.toLowerCase().includes(q) ||
            card.board_name.toLowerCase().includes(q)),
      )
      .slice(0, 5)
      .map((card) => ({
        key: `x:${card.id}`,
        label: `${card.board_name} #${card.number}`,
        hint: card.title,
        chip: makeChip(
          'fd-chip fd-chip-card',
          ['data-cross', card.id],
          null,
          card.title ? `${card.board_name} › ${card.title}` : `${card.board_name} #${card.number}`,
        ),
      }));
    // Other boards — cross-board citations. The chip serializes as
    // [name](board:<uuid>): the cited board gets a backlink message in
    // its own chat.
    const otherBoards = (props.workspaceBoards ?? [])
      .filter((boardItem) => boardItem.id !== props.board?.id)
      .filter((boardItem) => !q || boardItem.name.toLowerCase().includes(q))
      .slice(0, 3)
      .map((boardItem) => ({
        key: `bb:${boardItem.id}`,
        label: `${boardItem.name} · board`,
        hint: 'cite this board',
        chip: makeChip('fd-chip fd-chip-card', ['data-board', boardItem.id], null, boardItem.name),
      }));
    return [...current, ...tags, ...board, ...cross, ...otherBoards];
  };

  /** The caret's text node + offset, when it sits in plain text. */
  const caretContext = (): { node: Text; offset: number } | null => {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return null;
    const anchor = selection.anchorNode;
    if (!anchor || anchor.nodeType !== Node.TEXT_NODE || !root?.contains(anchor)) return null;
    return { node: anchor as Text, offset: selection.anchorOffset ?? 0 };
  };

  const detect = () => {
    const caret = caretContext();
    if (!caret) {
      setMenu(null);
      return;
    }
    const before = caret.node.textContent?.slice(0, caret.offset) ?? '';
    const at = before.lastIndexOf('@');
    const hash = before.lastIndexOf('#');
    const start = Math.max(at, hash);
    if (start < 0) {
      setMenu(null);
      return;
    }
    // Slack-style: the query is EVERYTHING since the trigger — spaces
    // included ("@john sm…" keeps searching), and a new @/# ends it.
    const between = before.slice(start + 1);
    if (between.includes('@') || between.includes('#') || /[\n]$/.test(between)) {
      setMenu(null);
      return;
    }
    if (start === dismissedStart && !between) {
      setMenu(null);
      return;
    }
    if (start !== dismissedStart) dismissedStart = -1;
    // Flip the menu up when the composer is low on the screen.
    if (root) {
      const rect = root.getBoundingClientRect();
      setFlip(rect.bottom + 240 > window.innerHeight);
    }
    setMenu({
      kind: at > hash ? 'at' : 'hash',
      query: between,
      textNode: caret.node,
      offset: start,
    });
    setActive(0);
  };

  /** Insert the picked chip at the caret, removing the typed @query. */
  const insertOption = (option: Option) => {
    const m = menu();
    if (!m || !root) return;
    const selection = window.getSelection();
    const caret = caretContext();
    // Remove the typed trigger + query (spaces included).
    if (caret && caret.node === m.textNode) {
      m.textNode.deleteData(m.offset, caret.offset - m.offset);
    } else if (m.textNode.isConnected) {
      m.textNode.deleteData(m.offset, m.textNode.length - m.offset);
    }
    const range = document.createRange();
    const anchor: Node = caret && root.contains(caret.node) ? caret.node : root;
    const pos = anchor.nodeType === Node.TEXT_NODE ? m.offset : anchor.childNodes.length;
    range.setStart(
      anchor,
      Math.min(
        pos,
        anchor.nodeType === Node.TEXT_NODE ? (anchor as Text).length : anchor.childNodes.length,
      ),
    );
    range.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(range);
    range.insertNode(option.chip);
    // A trailing space to type after; the caret lands behind it.
    const space = document.createTextNode(' ');
    option.chip.after(space);
    const after = document.createRange();
    after.setStart(space, 1);
    after.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(after);
    setMenu(null);
    root.focus();
    props.onInput(serialize());
  };

  const send = () => {
    props.onSend?.();
    queueMicrotask(() => root?.focus());
  };

  return (
    <div class={`relative ${props.class ?? ''}`}>
      <div
        ref={root}
        data-placeholder={props.placeholder ?? ''}
        contenteditable="true"
        role="textbox"
        class="fd-composer w-full whitespace-pre-wrap break-words rounded-xl border border-neutral-200 bg-transparent px-3 py-2 text-sm leading-6 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-500/20 dark:border-neutral-700"
        style={{ 'min-height': `${(props.rows ?? 3) * 1.5}rem` }}
        onInput={() => {
          props.onInput(serialize());
          detect();
        }}
        onKeyDown={(event) => {
          const list = options();
          if (menu() && list.length > 0) {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setActive((active() + 1) % list.length);
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              setActive((active() - 1 + list.length) % list.length);
            } else if (event.key === 'Enter' || event.key === 'Tab') {
              event.preventDefault();
              event.stopPropagation();
              insertOption(list[active()]);
            } else if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              dismissedStart = menu()?.offset ?? -1;
              setMenu(null);
            }
            return;
          }
          if (event.key === 'Escape') {
            if (menu()) event.stopPropagation();
            return;
          }
          if (event.key === 'Enter') {
            if (event.metaKey || event.ctrlKey) {
              event.preventDefault();
              send();
              return;
            }
            if (props.sendOnEnter && !event.shiftKey) {
              event.preventDefault();
              send();
            }
            // otherwise: Enter is a newline (descriptions) — default.
          }
        }}
        onBlur={() => setMenu(null)}
        // Paste is plain text — chips only come from the menus.
        onPaste={(event) => {
          event.preventDefault();
          const text = event.clipboardData?.getData('text/plain') ?? '';
          if (!text) return;
          const selection = window.getSelection();
          selection?.deleteFromDocument();
          document.execCommand('insertText', false, text);
          props.onInput(serialize());
        }}
        onFocus={() => detect()}
        onClick={() => detect()}
      />
      <Show when={menu() && options().length > 0}>
        <div
          class={`absolute left-0 z-40 max-h-44 w-64 overflow-y-auto rounded-xl border border-neutral-200 bg-white p-1 shadow-xl dark:border-neutral-700 dark:bg-neutral-900 ${
            flip() ? 'bottom-full mb-1' : 'top-full mt-1'
          }`}
        >
          <For each={options()}>
            {(option, index) => (
              <button
                type="button"
                class={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm ${
                  index() === active()
                    ? 'bg-indigo-50 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300'
                    : 'hover:bg-neutral-100 dark:hover:bg-neutral-800'
                }`}
                onMouseDown={(event) => {
                  event.preventDefault();
                  insertOption(option);
                }}
              >
                <span class="min-w-0 flex-1 truncate">{option.label}</span>
                <span class="shrink-0 truncate text-[10px] text-neutral-400">{option.hint}</span>
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

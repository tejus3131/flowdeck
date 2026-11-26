/**
 * A line diff for the card timeline's description snapshots — the
 * collapsed, GitHub-style from/to view. Small and dependency-free on
 * purpose: descriptions cap at 8000 chars, and the LCS below is happy
 * at that size. Giant inputs (paste-in walls of text) fall back to a
 * full replace so the timeline never blocks on diff math.
 */

export type DiffOp =
  { type: 'same'; text: string } | { type: 'del'; text: string } | { type: 'add'; text: string };

/** Beyond this many total lines, diffing stops being worth it — the
 *  timeline shows the whole old block and the whole new one instead. */
const MAX_DIFF_LINES = 600;

/** Split a description body into diffable lines. A trailing newline does
 *  not create a phantom final line. */
function toLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Classic LCS diff over lines (dynamic programming, O(n·m)). */
function lcsDiff(a: string[], b: string[]): DiffOp[] {
  // Trim the common prefix/suffix first — typical edits change a middle
  // chunk, so this keeps the matrix tiny.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const ops: DiffOp[] = [];
  for (let i = 0; i < start; i++) ops.push({ type: 'same', text: a[i] });

  // lcs[i][j] = length of the longest common subsequence of
  // midA[i..] and midB[j..].
  const m = midA.length;
  const n = midB.length;
  const lcs: number[][] = Array.from({ length: m + 1 }, () =>
    Array.from({ length: n + 1 }, () => 0),
  );
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      lcs[i][j] =
        midA[i] === midB[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  // Walk the matrix: matches stay, skips delete, inserts add.
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (midA[i] === midB[j]) {
      ops.push({ type: 'same', text: midA[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      ops.push({ type: 'del', text: midA[i] });
      i++;
    } else {
      ops.push({ type: 'add', text: midB[j] });
      j++;
    }
  }
  while (i < m) ops.push({ type: 'del', text: midA[i++] });
  while (j < n) ops.push({ type: 'add', text: midB[j++] });

  for (let k = endA; k < a.length; k++) ops.push({ type: 'same', text: a[k] });
  return ops;
}

/** The from/to diff for a description event. */
export function lineDiff(from: string, to: string): DiffOp[] {
  const a = toLines(from);
  const b = toLines(to);
  if (a.length + b.length > MAX_DIFF_LINES) {
    // Too big to LCS — show the two blocks whole.
    return [
      ...a.map((text): DiffOp => ({ type: 'del', text })),
      ...b.map((text): DiffOp => ({ type: 'add', text })),
    ];
  }
  return lcsDiff(a, b);
}

/** Collapse runs of unchanged lines for display: GitHub-style hunks show
 *  a couple of same lines around each change and fold the rest into
 *  "⋯ N unchanged lines". */
export function foldContext(
  ops: DiffOp[],
  { pad = 2 }: { pad?: number } = {},
): Array<DiffOp | { type: 'fold'; count: number }> {
  const keep = Array.from({ length: ops.length }, () => false);
  ops.forEach((op, index) => {
    if (op.type !== 'same') {
      for (let i = Math.max(0, index - pad); i <= Math.min(ops.length - 1, index + pad); i++) {
        keep[i] = true;
      }
    }
  });
  const out: Array<DiffOp | { type: 'fold'; count: number }> = [];
  let fold = 0;
  const flushFold = () => {
    if (fold > 0) {
      out.push({ type: 'fold', count: fold });
      fold = 0;
    }
  };
  ops.forEach((op, index) => {
    if (keep[index]) {
      flushFold();
      out.push(op);
    } else {
      fold++;
    }
  });
  flushFold();
  return out;
}

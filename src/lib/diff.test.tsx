import { describe, expect, it } from 'vitest';
import { foldContext, lineDiff } from './diff';

const texts = (ops: { type: string; text?: string; count?: number }[]) =>
  ops.map((op) => (op.type === 'fold' ? `⋯${op.count}` : `${op.type[0]}:${op.text}`)).join(' ');

describe('lineDiff', () => {
  it('returns an add for a pure insertion', () => {
    expect(texts(lineDiff('one\ntwo', 'one\ntwo\nthree'))).toBe('s:one s:two a:three');
  });

  it('returns a del for a pure removal', () => {
    expect(texts(lineDiff('one\ntwo\nthree', 'one\ntwo'))).toBe('s:one s:two d:three');
  });

  it('returns add+del for an edited middle line', () => {
    expect(texts(lineDiff('alpha\nbeta\ngamma', 'alpha\nBETA\ngamma'))).toBe(
      's:alpha d:beta a:BETA s:gamma',
    );
  });

  it('handles an empty from', () => {
    expect(texts(lineDiff('', 'hello\nworld'))).toBe('a:hello a:world');
  });

  it('handles an empty to', () => {
    expect(texts(lineDiff('hello\nworld', ''))).toBe('d:hello d:world');
  });

  it('does not create a phantom line for a trailing newline', () => {
    expect(texts(lineDiff('same\n', 'same\n'))).toBe('s:same');
  });

  it('matches equal text to all-same ops', () => {
    expect(texts(lineDiff('a\nb', 'a\nb'))).toBe('s:a s:b');
  });

  it('falls back to whole-block replace past the size guard', () => {
    const big = Array.from({ length: 400 }, (_, i) => `line ${i}`).join('\n');
    const other = Array.from({ length: 400 }, (_, i) => `row ${i}`).join('\n');
    const ops = lineDiff(big, other);
    expect(ops.filter((op) => op.type === 'del')).toHaveLength(400);
    expect(ops.filter((op) => op.type === 'add')).toHaveLength(400);
  });
});

describe('foldContext', () => {
  it('folds long unchanged runs around changes', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `l${i}`);
    const ops = lineDiff(lines.join('\n'), lines.map((l, i) => (i === 5 ? 'X' : l)).join('\n'));
    const folded = foldContext(ops);
    // change at index 5 keeps 3..7 (pad 2); everything else folds.
    expect(texts(folded as never[])).toBe('⋯3 s:l3 s:l4 d:l5 a:X s:l6 s:l7 ⋯2');
  });

  it('keeps everything when the diff is short', () => {
    const ops = lineDiff('a\nb\nc', 'a\nx\nc');
    expect(texts(foldContext(ops) as never[])).toBe('s:a d:b a:x s:c');
  });
});

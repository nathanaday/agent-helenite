import { applyOps, type TextOp } from 'yami/obsidian';

/** Text that a Duet agent wrote, as a character range of the note. */
export interface Span {
  from: number;
  to: number;
  /** The agent's display name, for example `Claude`. */
  agent: string;
  /** When the agent last wrote into the span, as an ISO date. */
  time: string;
}

/** A note's contributions and the text that they refer to. */
export interface Contributions {
  text: string;
  spans: Span[];
}

/**
 * Moves spans through ascending, non-overlapping ops on the text. Text that an op deletes leaves its span,
 * and text that an op inserts belongs to no span, so an insert inside a span splits it.
 */
export function mapSpans(spans: Span[], ops: TextOp[]): Span[] {
  if (!ops.length) return spans;
  const mapped: Span[] = [];
  for (const span of spans) {
    let pieces: [number, number][] = [[span.from, span.to]];
    for (const op of ops) {
      if (op.to <= span.from && op.from < span.from) continue;
      if (op.from >= span.to) break;
      pieces = pieces.flatMap(([from, to]): [number, number][] => {
        if (op.to > op.from) {
          // A delete or a replacement removes its range from the piece.
          if (op.to <= from || op.from >= to) return [[from, to]];
          return [
            ...(op.from > from ? [[from, op.from] as [number, number]] : []),
            ...(op.to < to ? [[op.to, to] as [number, number]] : []),
          ];
        }
        // An insert strictly inside the piece splits it.
        return op.from > from && op.from < to ? [[from, op.from], [op.from, to]] : [[from, to]];
      });
    }
    for (const [from, to] of pieces) {
      const start = mapPosition(from, ops, 'start');
      const end = mapPosition(to, ops, 'end');
      if (end > start) mapped.push({ ...span, from: start, to: end });
    }
  }
  return normalize(mapped);
}

/**
 * Applies ops to contributions. Attribution works on whole words: a word that a change touches, also by one
 * letter, belongs to the author of that change. With `agent`, the changed text and words become the agent's.
 * Without it, they belong to no agent.
 */
export function applyChange(contributions: Contributions, ops: TextOp[], agent?: { name: string; time: string }): Contributions {
  let spans = mapSpans(contributions.spans, ops);
  const text = applyOps(contributions.text, ops);
  for (const range of changedRanges(ops)) {
    const { from, to } = wordRange(text, range.from, range.to);
    spans = without(spans, from, to);
    if (agent && to > from) spans.push({ from, to, agent: agent.name, time: agent.time });
  }
  return { text, spans: normalize(spans) };
}

/** Brings contributions up to date with a text that changed without Duet, by comparing the texts. */
export function reconcile(contributions: Contributions, text: string, diff: (before: string, after: string) => TextOp[]): Contributions {
  if (contributions.text === text) return contributions;
  return applyChange(contributions, diff(contributions.text, text));
}

/** The ranges, in the text after the ops, that the ops changed. A delete leaves an empty range where it was. */
export function changedRanges(ops: TextOp[]): { from: number; to: number }[] {
  const ranges: { from: number; to: number }[] = [];
  let shift = 0;
  for (const op of ops) {
    ranges.push({ from: op.from + shift, to: op.from + shift + op.insert.length });
    shift += op.insert.length - (op.to - op.from);
  }
  return ranges;
}

const WORD = /[\p{L}\p{N}\p{M}_]/u;
const isWord = (character: string | undefined) => character !== undefined && WORD.test(character);

/**
 * Grows a range to the whole words at its ends. An empty range, where text was deleted, grows to the word
 * around it when it is inside a word, so a word with a deleted letter counts as changed.
 */
export function wordRange(text: string, from: number, to: number): { from: number; to: number } {
  const inside = from === to && isWord(text[from - 1]) && isWord(text[to]);
  if (from === to && !inside) return { from, to };
  if (inside || isWord(text[from])) while (isWord(text[from - 1])) from--;
  if (inside || isWord(text[to - 1])) while (isWord(text[to])) to++;
  return { from, to };
}

/** The spans without the range [from, to). */
function without(spans: Span[], from: number, to: number): Span[] {
  return spans.flatMap((span) => {
    if (span.to <= from || span.from >= to) return [span];
    return [
      ...(span.from < from ? [{ ...span, to: from }] : []),
      ...(span.to > to ? [{ ...span, from: to }] : []),
    ];
  });
}

/** Sorts spans and joins neighbors of the same agent. The joined span keeps the later time. */
export function normalize(spans: Span[]): Span[] {
  const sorted = spans.filter((span) => span.to > span.from).sort((a, b) => a.from - b.from || a.to - b.to);
  const joined: Span[] = [];
  for (const span of sorted) {
    const last = joined.at(-1);
    if (last && last.agent === span.agent && span.from <= last.to) {
      joined[joined.length - 1] = { ...last, to: Math.max(last.to, span.to), time: last.time > span.time ? last.time : span.time };
    } else {
      joined.push({ ...span });
    }
  }
  return joined;
}

/**
 * Maps a piece boundary that no op deletes. A start stays after text inserted at its position;
 * an end stays before it, so text inserted at a span's edge is not part of the span.
 */
function mapPosition(position: number, ops: TextOp[], side: 'start' | 'end'): number {
  let shift = 0;
  for (const op of ops) {
    const before = side === 'start' ? op.to <= position : op.to <= position && op.from < position;
    if (!before) break;
    shift += op.insert.length - (op.to - op.from);
  }
  return position + shift;
}

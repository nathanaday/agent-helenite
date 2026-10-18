import { describe, expect, it, vi } from 'vitest';

// The Yami layer imports Obsidian, which has no code outside the app.
// library-loop: F0.5
vi.mock('obsidian', () => ({ Modal: class {}, SuggestModal: class {}, FuzzySuggestModal: class {} }));

import { diffOps } from 'yami/obsidian';
import { applyChange, type Contributions, mapSpans, reconcile, type Span } from '../../../plugin/src/contributions/spans.ts';

const T1 = '2026-10-06T10:00:00.000Z';
const T2 = '2026-10-06T11:00:00.000Z';
const claude = { name: 'Claude', time: T1 };

const span = (from: number, to: number, agent = 'Claude', time = T1): Span => ({ from, to, agent, time });

/** The texts of the spans, so the tests read as text. */
function marked(contributions: Contributions): string[] {
  return contributions.spans.map((s) => contributions.text.slice(s.from, s.to));
}

describe('mapSpans', () => {
  it('shifts a span when text is inserted or deleted before it', () => {
    expect(mapSpans([span(5, 10)], [{ from: 0, to: 0, insert: 'abc' }])).toEqual([span(8, 13)]);
    expect(mapSpans([span(5, 10)], [{ from: 0, to: 2, insert: '' }])).toEqual([span(3, 8)]);
  });

  it('leaves a span when the change is after it', () => {
    expect(mapSpans([span(5, 10)], [{ from: 12, to: 14, insert: 'x' }])).toEqual([span(5, 10)]);
  });

  it('does not grow a span with text inserted at its edges', () => {
    expect(mapSpans([span(5, 10)], [{ from: 5, to: 5, insert: 'ab' }])).toEqual([span(7, 12)]);
    expect(mapSpans([span(5, 10)], [{ from: 10, to: 10, insert: 'ab' }])).toEqual([span(5, 10)]);
  });

  it('splits a span around text inserted inside it', () => {
    expect(mapSpans([span(5, 10)], [{ from: 7, to: 7, insert: 'xy' }])).toEqual([span(5, 7), span(9, 12)]);
  });

  it('shrinks a span when part of it is deleted or replaced', () => {
    expect(mapSpans([span(5, 10)], [{ from: 3, to: 7, insert: '' }])).toEqual([span(3, 6)]);
    expect(mapSpans([span(5, 10)], [{ from: 6, to: 8, insert: 'xyz' }])).toEqual([span(5, 6), span(9, 11)]);
  });

  it('drops a span whose text is deleted', () => {
    expect(mapSpans([span(5, 10)], [{ from: 4, to: 11, insert: 'new' }])).toEqual([]);
  });

  it('applies several ops in order', () => {
    const ops = [
      { from: 1, to: 1, insert: 'aa' },
      { from: 6, to: 7, insert: '' },
      { from: 12, to: 12, insert: 'b' },
    ];
    expect(mapSpans([span(4, 9), span(10, 15)], ops)).toEqual([span(6, 10), span(11, 13), span(14, 17)]);
  });
});

describe('applyChange', () => {
  it('marks the text that an agent inserts', () => {
    const result = applyChange({ text: 'Hello world', spans: [] }, [{ from: 5, to: 5, insert: ', dear' }], claude);
    expect(result.text).toBe('Hello, dear world');
    expect(marked(result)).toEqual([', dear']);
  });

  it('marks a replacement but not the text around it', () => {
    const before = 'one two three';
    const after = 'one 2 three';
    const result = applyChange({ text: before, spans: [] }, diffOps(before, after), claude);
    expect(marked(result)).toEqual(['2']);
  });

  it('marks a whole word when the agent changes part of it', () => {
    const before = 'flights booked w TAP';
    const after = 'Flights booked with TAP';
    expect(marked(applyChange({ text: before, spans: [] }, diffOps(before, after), claude))).toEqual(['Flights', 'with']);
  });

  it('marks a replaced word whole, also when it shares letters with the old word', () => {
    const before = '# Welcome\n';
    const after = '# Hello from the agent\n';
    expect(marked(applyChange({ text: before, spans: [] }, diffOps(before, after), claude))).toEqual(['Hello from the agent']);
  });

  it('gives a word to the agent that changed it last', () => {
    const start = applyChange({ text: '', spans: [] }, [{ from: 0, to: 0, insert: 'colour scheme' }], claude);
    const result = applyChange(start, [{ from: 4, to: 6, insert: 'r' }], { name: 'Codex', time: T2 });
    expect(result.spans).toEqual([span(0, 5, 'Codex', T2), span(5, 12)]);
  });

  it('does not mark text without an agent, and moves existing spans', () => {
    const start = applyChange({ text: 'abc', spans: [] }, [{ from: 3, to: 3, insert: ' agent text' }], claude);
    const result = applyChange(start, [{ from: 0, to: 0, insert: 'user ' }]);
    expect(result.text).toBe('user abc agent text');
    expect(marked(result)).toEqual([' agent text']);
  });

  it('joins neighboring text of the same agent and keeps the later time', () => {
    const first = applyChange({ text: '', spans: [] }, [{ from: 0, to: 0, insert: 'Hello' }], claude);
    const second = applyChange(first, [{ from: 5, to: 5, insert: ' there' }], { name: 'Claude', time: T2 });
    expect(second.spans).toEqual([span(0, 11, 'Claude', T2)]);
  });

  it('keeps the text of different agents apart', () => {
    const first = applyChange({ text: '', spans: [] }, [{ from: 0, to: 0, insert: 'Hello' }], claude);
    const second = applyChange(first, [{ from: 5, to: 5, insert: ' there' }], { name: 'Codex', time: T2 });
    expect(second.spans).toEqual([span(0, 5), span(5, 11, 'Codex', T2)]);
  });

  it('takes a whole word from the agent when someone else changes a letter of it', () => {
    const start = applyChange({ text: '', spans: [] }, [{ from: 0, to: 0, insert: 'Book the hotel now' }], claude);
    expect(marked(applyChange(start, [{ from: 9, to: 10, insert: 'H' }]))).toEqual(['Book the ', ' now']);
    expect(marked(applyChange(start, [{ from: 12, to: 13, insert: '' }]))).toEqual(['Book the ', ' now']);
  });

  it('gives a word to the agent when it deletes a letter of it', () => {
    const result = applyChange({ text: 'my colour scheme', spans: [] }, [{ from: 7, to: 8, insert: '' }], claude);
    expect(result.text).toBe('my color scheme');
    expect(marked(result)).toEqual(['color']);
  });

  it('marks nothing when an agent deletes whole words', () => {
    expect(applyChange({ text: 'one two three', spans: [] }, [{ from: 3, to: 7, insert: '' }], claude).spans).toEqual([]);
  });

  it('joins agent text around a word that the agent rewrote', () => {
    const start = applyChange({ text: 'a ', spans: [] }, [{ from: 2, to: 2, insert: 'one two three' }], claude);
    const typed = applyChange(start, [{ from: 6, to: 9, insert: 'xyz' }]);
    expect(marked(typed)).toEqual(['one ', ' three']);
    const rewritten = applyChange(typed, [{ from: 6, to: 9, insert: 'four' }], claude);
    expect(rewritten.text).toBe('a one four three');
    expect(marked(rewritten)).toEqual(['one four three']);
  });
});

describe('reconcile', () => {
  it('follows changes that happened without Duet', () => {
    const start = applyChange({ text: '# Plan\n\n', spans: [] }, [{ from: 8, to: 8, insert: '- Book the hotel\n' }], claude);
    const edited = '# Trip plan\n\nIntro by the user.\n- Book the hotel\n';
    const result = reconcile(start, edited, diffOps);
    expect(result.text).toBe(edited);
    expect(marked(result)).toEqual(['- Book the hotel\n']);
  });

  it('drops attribution of agent text that someone else rewrote', () => {
    const start = applyChange({ text: 'A. ', spans: [] }, [{ from: 3, to: 3, insert: 'The agent wrote this.' }], claude);
    const result = reconcile(start, 'A. Someone rewrote all of it.', diffOps);
    expect(result.spans.every((s) => s.to - s.from < 5)).toBe(true);
  });

  it('returns the same contributions when the text is unchanged', () => {
    const start: Contributions = { text: 'abc', spans: [span(0, 1)] };
    expect(reconcile(start, 'abc', diffOps)).toBe(start);
  });
});

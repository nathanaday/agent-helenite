import { describe, expect, it, vi } from 'vitest';

// The Yami layer imports Obsidian, which has no code outside the app.
vi.mock('obsidian', () => ({ Modal: class {} }));

import { applyOps, diffOps } from 'yami/obsidian';
import { agentView, PLACEHOLDER, viewOpsToNote } from '../../../plugin/src/note-tools.ts';

const note = '# Plan\n\nFirst draft, rough.\n@claude clean this up\n> [!agent]+ Claude\n> Working\n\nLast line.';
const hidden = { from: note.indexOf('@claude'), to: note.indexOf('> Working') + '> Working'.length };

describe('agent view of a note', () => {
  it('shows the request and the reply as one placeholder line', () => {
    expect(agentView(note, hidden).text).toBe(`# Plan\n\nFirst draft, rough.\n${PLACEHOLDER}\n\nLast line.`);
  });

  it('maps a rewrite of the view onto the note and keeps the request and reply', () => {
    const view = agentView(note, hidden);
    const rewritten = `# Plan\n\nFirst draft.\n${PLACEHOLDER}\n\nThe last line.`;
    const result = applyOps(note, viewOpsToNote(view, diffOps(view.text, rewritten)));
    expect(result).toBe('# Plan\n\nFirst draft.\n@claude clean this up\n> [!agent]+ Claude\n> Working\n\nThe last line.');
  });

  it('never deletes the hidden range, even when the rewrite drops the placeholder', () => {
    const view = agentView(note, hidden);
    const result = applyOps(note, viewOpsToNote(view, diffOps(view.text, '# Plan\n\nShort.')));
    expect(result).toContain('@claude clean this up\n> [!agent]+ Claude\n> Working');
    expect(result).not.toContain('Last line');
  });

  it('passes ops through when nothing is hidden', () => {
    const ops = diffOps('a b c', 'a x c');
    expect(viewOpsToNote(agentView('a b c'), ops)).toEqual(ops);
  });
});

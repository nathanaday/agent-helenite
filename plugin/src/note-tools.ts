import type * as Y from 'yjs';
import { defineTool, type ToolSet, z } from 'yami/agent';
import { diffOps, type TextOp } from 'yami/document';
import type { AgentPeer, SharedNote } from 'yami/obsidian';

/** Stands for the request line and the reply callout in the text that the agent sees. */
export const PLACEHOLDER = '⟦request and reply⟧';

/** The note as the agent sees it: the protected range is one placeholder line. */
export interface AgentView {
  text: string;
  /** Where the placeholder is in `text`, and the range of the note that it stands for. */
  hidden?: { at: number; from: number; to: number };
}

export function agentView(note: string, hidden?: { from: number; to: number }): AgentView {
  if (!hidden) return { text: note };
  return {
    text: note.slice(0, hidden.from) + PLACEHOLDER + note.slice(hidden.to),
    hidden: { at: hidden.from, from: hidden.from, to: hidden.to },
  };
}

/**
 * Maps ops on the agent's view to ops on the note. Ops never change the hidden range: a change that
 * overlaps it is cut around it, and its inserted text goes before it.
 */
export function viewOpsToNote(view: AgentView, ops: TextOp[]): TextOp[] {
  const hidden = view.hidden;
  if (!hidden) return ops;
  const start = hidden.at;
  const end = start + PLACEHOLDER.length;
  const shift = hidden.to - hidden.from - PLACEHOLDER.length;
  const result: TextOp[] = [];
  for (const op of ops) {
    if (op.to <= start) {
      result.push(op);
    } else if (op.from >= end) {
      result.push({ from: op.from + shift, to: op.to + shift, insert: op.insert });
    } else {
      const from = Math.min(op.from, start);
      result.push({ from, to: Math.min(op.to, start), insert: op.insert });
      if (op.to > end) result.push({ from: end + shift, to: op.to + shift, insert: '' });
    }
  }
  return result.filter((op) => op.to > op.from || op.insert);
}

export interface NoteToolContext {
  note(): Promise<SharedNote>;
  peer(note: SharedNote): AgentPeer;
  /** The request line and the reply callout of the current turn. */
  hidden(note: SharedNote): { from: number; to: number } | undefined;
}

interface Seen {
  view: AgentView;
  snapshot: Y.Snapshot;
}

/**
 * Tools that let an agent read and change the one note it was asked in. Edits apply against the version
 * of the note that the agent last read, so changes the user makes meanwhile stay in place.
 */
export class NoteTools {
  private seen: Seen | undefined;

  constructor(private readonly context: NoteToolContext) {}

  /**
   * Records what the agent sees in a new message, with `hidden` as the request and reply.
   * Returns the view, or undefined when the agent already saw this text.
   */
  async show(hidden: (note: SharedNote) => { from: number; to: number } | undefined): Promise<string | undefined> {
    const note = await this.context.note();
    const previous = this.seen?.view.text;
    this.seen = { view: agentView(note.content, hidden(note)), snapshot: note.snapshot() };
    return this.seen.view.text === previous ? undefined : this.seen.view.text;
  }

  get tools(): ToolSet {
    return {
      name: 'duet',
      description: `Read and change the note that the user asked you in. In the note text, the line ${PLACEHOLDER} stands for the user's request and your reply, which stay where they are.`,
      tools: [
        defineTool({
          name: 'read_note',
          description: `Returns the current text of the note. The line ${PLACEHOLDER} stands for the request and your reply.`,
          input: {},
          title: () => 'Read the note',
          run: async () => {
            const note = await this.context.note();
            this.seen = this.look(note);
            return this.seen.view.text;
          },
        }),
        defineTool({
          name: 'edit_note',
          description:
            'Replaces exact text in the note. Each old_text must match the note as you last read it, exactly once unless replace_all is true. ' +
            'Include enough context to make it unique. Prefer several small edits over one large one. The user sees each edit as you make it and can type at the same time.',
          input: {
            edits: z
              .array(
                z.object({
                  old_text: z.string().min(1).describe('Exact text to replace, as you last read it.'),
                  new_text: z.string().describe('The replacement.'),
                  replace_all: z.boolean().optional().describe('Replace every match.'),
                }),
              )
              .min(1),
          },
          title: (input) => `Edit the note (${input.edits.length} ${input.edits.length === 1 ? 'change' : 'changes'})`,
          run: async ({ edits }) => {
            const seen = await this.base();
            const ops: TextOp[] = [];
            for (const edit of edits) {
              const matches = occurrences(seen.view.text, edit.old_text);
              if (!matches.length) return { text: `Not found: ${JSON.stringify(edit.old_text.slice(0, 80))}. Read the note again and retry.`, isError: true };
              if (matches.length > 1 && !edit.replace_all) {
                return { text: `${JSON.stringify(edit.old_text.slice(0, 80))} matches ${matches.length} places. Include more context, or set replace_all.`, isError: true };
              }
              for (const at of matches) {
                for (const op of diffOps(edit.old_text, edit.new_text)) ops.push({ from: op.from + at, to: op.to + at, insert: op.insert });
              }
            }
            ops.sort((a, b) => a.from - b.from);
            if (ops.some((op, index) => index > 0 && op.from < ops[index - 1]!.to)) return { text: 'Two edits overlap. Combine them into one edit.', isError: true };
            return this.apply(seen, ops, `Edited the note (${edits.length} ${edits.length === 1 ? 'change' : 'changes'}).`);
          },
        }),
        defineTool({
          name: 'write_note',
          description:
            `Replaces the whole note with new text. Use it for broad rewrites, such as cleaning up style and wording. Keep the line ${PLACEHOLDER} where it belongs. ` +
            'Only the parts that differ change, and the user sees each change as you make it.',
          input: { text: z.string().describe('The complete new text of the note.') },
          title: () => 'Rewrite the note',
          run: async ({ text }) => {
            const seen = await this.base();
            if (seen.view.hidden && !text.includes(PLACEHOLDER)) {
              return { text: `Keep the line ${PLACEHOLDER} in the text, where the request belongs.`, isError: true };
            }
            return this.apply(seen, diffOps(seen.view.text, text), 'Rewrote the note.');
          },
        }),
      ],
    };
  }

  private async base(): Promise<Seen> {
    if (this.seen) return this.seen;
    const note = await this.context.note();
    this.seen = this.look(note);
    return this.seen;
  }

  private async apply(seen: Seen, ops: TextOp[], done: string): Promise<string> {
    const note = await this.context.note();
    if (!ops.length) return 'The note already has this text.';
    const userChanged = note.content !== textOf(note, seen.snapshot);
    await this.context.peer(note).edit(viewOpsToNote(seen.view, ops), seen.snapshot);
    this.seen = this.look(note);
    return userChanged ? `${done} The user edited the note while you worked; read it again before further edits.` : done;
  }

  private look(note: SharedNote): Seen {
    return { view: agentView(note.content, this.context.hidden(note)), snapshot: note.snapshot() };
  }
}

function occurrences(text: string, search: string): number[] {
  const result: number[] = [];
  for (let at = text.indexOf(search); at >= 0; at = text.indexOf(search, at + search.length)) result.push(at);
  return result;
}

function textOf(note: SharedNote, snapshot: Y.Snapshot): string {
  const fork = note.fork(snapshot);
  const text = fork.getText('content').toJSON();
  fork.destroy();
  return text;
}

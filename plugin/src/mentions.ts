import { Notice, type TFile } from 'obsidian';
import type * as Y from 'yjs';
import type { AgentEvent, AgentSession } from 'yami/agent';
import { activity, type CollabHub, EditorBinding, LiveRegion, type NoteAgent, type NoteSessions, type NoteSessionSetup, type ObsidianYami, Presence, type SessionIds, type SharedNote } from 'yami/obsidian';
import { calloutHeader, isCalloutHeader, renderCallout, type ReplyState } from './callout.ts';
import type { TriggeredMention } from './enter-trigger.ts';
import { NoteTools, PLACEHOLDER } from './note-tools.ts';
import { type AgentProfile, displayName } from './settings.ts';

const INSTRUCTIONS = `You are running inside Obsidian, the note-taking app, through the Duet plugin. Your working directory is the root of the user's vault.

The user calls you by writing @ and your name with a request on a line of a note. Each message gives the note's path, its text, and the request. In the note text, the line ${PLACEHOLDER} stands for the request line and the callout that holds your reply.

What you can change:
- You can change only the note that the request is in. Change it with the duet tools: read_note, edit_note for targeted changes, and write_note for a broad rewrite. The user sees each edit as you make it and may type at the same time.
- You cannot change any other file. You have no file-editing tools and no shell, and the duet tools work only on this note.
- You can read other files in the vault, and search them, when the request needs them.
- Do not try to change the request line or your reply callout. The plugin writes your reply.

How to answer:
- Your final message goes into the reply callout under the request. Write Markdown that reads well there. Obsidian links like [[Note name]] work.
- Answer directly. Leave out preambles, sign-offs and offers of more help. Keep the reply short unless the user asks for more.
- Change the note only when the request asks for it. For a broad rewrite, such as "clean this up", keep the user's meaning, facts, links and structure unless asked otherwise. Then say in one sentence what you changed.
- Wait for each tool to finish. Do not start background work.`;

export interface Mention extends TriggeredMention {
  profile: AgentProfile;
}

interface Reply {
  title: string;
  note: SharedNote | undefined;
  region: LiveRegion | undefined;
  /** Text of the message that is streaming now. */
  streaming: string;
  /** The last complete message. */
  message: string;
  /** Start of the request line. With the callout, it is hidden from the agent's view of the note. */
  line: Y.RelativePosition | undefined;
  /** Wraps the callout in the text around it, for a reply that is not under a request. */
  wrap?: (callout: string) => string;
}

/** The mention agent of one harness session in one note: its cursors, its note tools, and its replies. */
class LiveSession {
  readonly replies: Reply[] = [];
  current: Reply | undefined;
  session!: AgentSession;
  readonly presence: Presence;
  readonly tools: NoteTools;

  constructor(
    public profile: AgentProfile,
    readonly file: TFile,
    hub: CollabHub,
    animate: () => boolean,
  ) {
    this.presence = new Presence(() => ({ name: this.profile.name, color: this.profile.color }), animate);
    this.tools = new NoteTools({
      note: () => hub.acquire(file, this.tools),
      peer: (note) => this.presence.peer(note),
      hidden: (note) => hiddenRange(note, this.current),
    });
  }

  get busy(): boolean {
    return this.current !== undefined || this.replies.length > 0;
  }
}

export interface MentionOptions {
  ids: SessionIds;
  save(ids: SessionIds): Promise<void>;
  profile(name: string): AgentProfile | undefined;
}

/**
 * Answers mentions. Each note and agent pair has one harness session, from Yami's note sessions. The agent
 * reads the note, may change it through the note tools, and writes its reply into a callout under the
 * request, with a live cursor.
 */
export class MentionAgents {
  private readonly hub: CollabHub;
  private readonly notes: NoteSessions<LiveSession>;

  constructor(
    private readonly yami: ObsidianYami,
    private readonly options: MentionOptions,
  ) {
    this.hub = yami.hub;
    this.notes = yami.noteSessions({ ids: options.ids, save: options.save, setup: (note) => this.setup(note) });
  }

  private setup({ file, agent }: NoteAgent): NoteSessionSetup<LiveSession> {
    const profile = this.options.profile(agent);
    if (!profile) throw new Error(`Duet has no agent named ${agent}.`);
    const live = new LiveSession(profile, file, this.hub, this.yami.animate);
    return {
      options: { instructions: INSTRUCTIONS, access: 'read-only', tools: live.tools.tools, skills: [] },
      state: live,
      started: (session) => {
        live.session = session;
        session.on((event) => {
          this.handle(live, event);
          if (event.type === 'closed') this.release(live);
        });
      },
    };
  }

  async ask(mention: Mention): Promise<void> {
    const { file, profile, view } = mention;
    const binding = EditorBinding.of(view);
    const tracked = binding?.track(mention.lineFrom, mention.callout.to);
    const reply: Reply = { title: displayName(profile), note: undefined, region: undefined, streaming: '', message: '', line: undefined };
    let live: LiveSession;
    try {
      const [note, started] = await Promise.all([this.hub.acquire(file, reply), this.notes.session(file.path, profile.name)]);
      live = started.state;
      live.profile = profile;
      reply.note = note;
      if (tracked) binding!.untrack(tracked);
      const lineFrom = tracked?.from ?? mention.lineFrom;
      const calloutFrom = note.content.indexOf(calloutHeader(reply.title), lineFrom);
      if (calloutFrom < 0) throw new Error('The reply callout is gone.');
      const peer = live.presence.peer(note);
      peer.beginTurn();
      reply.region = new LiveRegion(peer, calloutFrom, calloutFrom + calloutHeader(reply.title).length, isCalloutHeader);
      reply.line = note.relative(lineFrom, -1);
      peer.setCursor(note.relative(calloutFrom + calloutHeader(reply.title).length, -1));
    } catch (error) {
      if (tracked) binding!.untrack(tracked);
      new Notice(`@${profile.name} could not start: ${(error as Error).message}`);
      if (reply.note) this.hub.release(reply.note, reply);
      return;
    }
    live.replies.push(reply);
    const text = await live.tools.show((note) => hiddenRange(note, reply));
    const prompt = [
      `Note: ${file.path} (line ${mention.line + 1})`,
      text === undefined ? 'The note has not changed since you last read it.' : `<note>\n${text}\n</note>`,
      `Request: ${mention.prompt}`,
    ].join('\n\n');
    await live.session.send(prompt).catch((error: Error) => {
      // The session closed before this turn started. The 'closed' handler may already have failed the reply.
      const index = live.replies.indexOf(reply);
      if (index < 0) return;
      live.replies.splice(index, 1);
      void this.finish(live, reply, { kind: 'failed', text: '', error: error.message });
    });
  }

  /** Ends the conversations in a note. The next mention starts new ones. */
  forget(file: TFile): Promise<void> {
    return this.notes.forget(file.path);
  }

  /** Removes the agent's cursors and lets go of the note that its tools shared. */
  private release(live: LiveSession): void {
    live.presence.clear();
    const note = this.hub.get(live.file.path);
    if (note) this.hub.release(note, live.tools);
  }

  private handle(live: LiveSession, event: AgentEvent): void {
    const status = activity(event);
    if (status) live.presence.setStatus(status);
    const reply = live.current;
    switch (event.type) {
      case 'turn-start':
        live.current = live.replies.shift();
        if (!live.current) void this.followUp(live);
        break;
      case 'text-delta':
        if (!reply) break;
        reply.streaming += event.text;
        this.render(reply, { kind: 'working', text: reply.streaming });
        break;
      case 'message':
        if (!reply) break;
        reply.message = event.text;
        reply.streaming = '';
        this.render(reply, { kind: 'working', text: reply.message });
        break;
      case 'tool-start':
        // Text before a tool call is narration. The next message replaces it.
        if (reply) reply.streaming = '';
        break;
      case 'turn-end': {
        live.current = undefined;
        if (reply) {
          const { status: result, text, error } = event.result;
          const partial = reply.streaming || reply.message;
          void this.finish(
            live,
            reply,
            result === 'completed'
              ? { kind: 'completed', text }
              : result === 'interrupted'
                ? { kind: 'stopped', text: partial }
                : { kind: 'failed', text: partial, error: error ?? 'The agent stopped with an error.' },
          );
        }
        if (!live.busy) live.presence.setStatus(undefined);
        break;
      }
      case 'closed':
        live.current = undefined;
        for (const waiting of live.replies.splice(0)) {
          void this.finish(live, waiting, { kind: 'failed', text: '', error: event.error ?? 'The agent closed.' });
        }
        break;
    }
  }

  private async finish(live: LiveSession, reply: Reply, state: ReplyState): Promise<void> {
    this.render(reply, state);
    await reply.region?.settled();
    reply.region?.close();
    if (reply.note) {
      const peer = live.presence.peer(reply.note);
      window.setTimeout(() => {
        if (!live.busy) peer.hideCursor();
      }, 1200);
      this.hub.release(reply.note, reply);
    }
  }

  /** The agent started a turn on its own. Its reply goes to the end of the note. */
  private async followUp(live: LiveSession): Promise<void> {
    const title = `${displayName(live.profile)} (follow-up)`;
    const reply: Reply = { title, note: undefined, region: undefined, streaming: '', message: '', line: undefined };
    if (live.current !== undefined || live.session.closed) return;
    live.current = reply;
    const note = await this.hub.acquire(live.file, reply);
    reply.note = note;
    const end = note.content.length;
    const separator = !note.content || note.content.endsWith('\n\n') ? '' : note.content.endsWith('\n') ? '\n' : '\n\n';
    reply.wrap = (callout) => `${separator}${callout}\n`;
    reply.region = new LiveRegion(live.presence.peer(note), end, end);
    this.render(reply, { kind: 'working', text: '' });
  }

  private render(reply: Reply, state: ReplyState): void {
    if (!reply.region) return;
    const callout = renderCallout(reply.title, state);
    reply.region.set(reply.wrap ? reply.wrap(callout) : callout);
  }
}

/** The request line and the reply callout of a reply, which the agent's view of the note hides. */
function hiddenRange(note: SharedNote, reply: Reply | undefined): { from: number; to: number } | undefined {
  if (!reply?.line || reply.note !== note) return undefined;
  const from = note.absolute(reply.line);
  const range = reply.region?.range;
  return from === undefined || !range ? undefined : { from: Math.min(from, range.from), to: range.to };
}

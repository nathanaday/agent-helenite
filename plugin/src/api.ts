// The API that Duet gives other Obsidian plugins. This file imports nothing, so another plugin can copy it.
// Get the API with `app.plugins.getPlugin('duet')?.api as DuetApi | undefined`.

export interface DuetApi {
  /** 1 for this interface. A later version only adds members. */
  readonly version: number;
  /**
   * Creates a conversation note and sends its first message. Resolves when the message is sent;
   * the agent then works in the background. Rejects when the message is empty or no agent has the profile name.
   */
  newConversation(options: NewConversationOptions): Promise<{ path: string }>;
  conversationStatus(path: string): ConversationStatus;
  /** Calls `callback` each time a turn of the conversation ends. Returns a function that stops the calls. */
  onTurnEnd(path: string, callback: (turn: TurnEnd) => void): () => void;
}

export interface NewConversationOptions {
  /** The first message. A message that starts with `/` runs an agent command, such as a Claude Code skill. */
  message: string;
  /** The tag of a Duet agent, without `@`. Default: the first agent in Duet's settings. */
  profile?: string;
  /** The name of the note. Default: the date and the first words of the message. */
  title?: string;
  /** The folder of the note. Default: Duet's conversation folder. */
  folder?: string;
  /** Opens the note in a new tab. Default: true. */
  open?: boolean;
}

/**
 * - `working`: the agent works on a turn, or starts to.
 * - `active`: the conversation waits for a message.
 * - `ended`: the user ended the conversation. The note is a record.
 * - `none`: no conversation note has this path.
 */
export type ConversationStatus = 'working' | 'active' | 'ended' | 'none';

export interface TurnEnd {
  /** The path of the note now. The user can rename the note. */
  path: string;
  status: 'completed' | 'interrupted' | 'failed';
  /** The agent's final message for the turn. */
  text?: string;
  error?: string;
}

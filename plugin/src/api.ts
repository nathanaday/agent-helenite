// The API that Duet gives other Obsidian plugins. The option and result types are yami's:
// install yami and import them from 'yami/obsidian', or copy the declarations from dist/obsidian/api.d.ts.
// Get the API with `app.plugins.getPlugin('duet')?.api as DuetApi | undefined`.
import type { ConversationStatus, NewConversationOptions, TurnEnd } from 'yami/obsidian';

export interface DuetApi {
  /**
   * 2 for this interface. Version 2 renamed the option `profile` of `newConversation` to `agent`;
   * a call that passes `profile` is refused. A later version only adds members.
   */
  readonly version: number;
  /**
   * Creates a conversation note and sends its first message. Resolves when the message is sent;
   * the agent then works in the background. Rejects when the message is empty or no agent has the `agent` name.
   */
  newConversation(options: NewConversationOptions): Promise<{ path: string }>;
  conversationStatus(path: string): ConversationStatus;
  /** Calls `callback` each time a turn of the conversation ends. Returns a function that stops the calls. */
  onTurnEnd(path: string, callback: (turn: TurnEnd) => void): () => void;
}

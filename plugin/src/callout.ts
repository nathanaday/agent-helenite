import { quote } from 'yami/conversation';

export type ReplyState =
  | { kind: 'working'; text: string }
  | { kind: 'completed'; text: string }
  | { kind: 'stopped'; text: string }
  | { kind: 'failed'; text: string; error: string };

export const CALLOUT_PREFIX = '> [!agent]';

export function calloutHeader(title: string): string {
  return `${CALLOUT_PREFIX}+ ${title}`;
}

/**
 * Renders the reply callout. While the agent works, the body grows only at its end as text streams in,
 * so the note can type it out. The agent's cursor shows what the agent is doing, not the callout.
 */
export function renderCallout(title: string, state: ReplyState): string {
  const body = bodyText(state);
  if (!body) return calloutHeader(title);
  const quoted = quote(body);
  return `${calloutHeader(title)}\n${state.kind === 'working' ? quoted : quoted.replace(/^> $/gm, '>')}`;
}

function bodyText(state: ReplyState): string {
  const text = state.kind === 'working' ? state.text.trimStart() : state.text.trim();
  switch (state.kind) {
    case 'working':
      return text;
    case 'completed':
      return text || '*No reply.*';
    case 'stopped':
      return [text, '*Stopped.*'].filter(Boolean).join('\n\n');
    case 'failed':
      return [text, `*Failed: ${state.error.split('\n')[0]}*`].filter(Boolean).join('\n\n');
  }
}

/** True when the line is the header of an agent callout. */
export function isCalloutHeader(line: string): boolean {
  return line.startsWith(CALLOUT_PREFIX);
}

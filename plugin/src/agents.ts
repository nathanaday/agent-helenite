import type { App } from 'obsidian';
import type { Agent, AgentPreferences, AgentSession, SessionStart } from 'yami/agent';
import { ClaudeAgent } from 'yami/agent/claude';
import { CodexAgent } from 'yami/agent/codex';
import { type ConversationAgent, vaultRoot } from 'yami-obsidian';
import { type AgentProfile, parseEnv } from './settings.ts';

/** The Yami agents of the profiles in the settings. A changed profile gets a new agent on the next use. */
export class ProfileAgents {
  private readonly agents = new Map<string, { key: string; agent: Agent }>();

  constructor(
    private readonly app: App,
    private readonly profiles: () => AgentProfile[],
  ) {}

  /** The agents for conversation notes, named by their tags. */
  get list(): ConversationAgent[] {
    return this.profiles().map((profile) => ({ name: profile.name, color: profile.color, agent: this.agent(profile) }));
  }

  conversationAgent(profile: AgentProfile): ConversationAgent {
    return { name: profile.name, color: profile.color, agent: this.agent(profile) };
  }

  agent(profile: AgentProfile): Agent {
    const key = JSON.stringify(profile);
    const known = this.agents.get(profile.name);
    if (known?.key === key) return known.agent;
    if (known) void known.agent.closeAll();
    const agent = this.build(profile);
    this.agents.set(profile.name, { key, agent });
    return agent;
  }

  async closeAll(): Promise<void> {
    const open = [...this.agents.values()];
    this.agents.clear();
    await Promise.all(open.map(({ agent }) => agent.closeAll()));
  }

  private build(profile: AgentProfile): Agent {
    const preferences = {
      cwd: vaultRoot(this.app),
      model: profile.model || undefined,
      effort: profile.effort || undefined,
      approval: profile.approval,
    };
    const executable = profile.executablePath || undefined;
    const env = parseEnv(profile.env);
    if (profile.harness === 'codex') return new CodexAgent({ executable, env, preferences });
    return new ClaudeAgent({
      executable,
      env: { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1', ...env },
      // Without the user's settings, Claude Code loads no MCP servers or plugins of the user's own.
      settingSources: profile.userTools ? ['user', 'project', 'local'] : ['project', 'local'],
      preferences,
    });
  }
}

/** Starts a session. When the stored conversation is gone, starts a new one. */
export async function startSession(agent: Agent, options: SessionStart<AgentPreferences>): Promise<AgentSession> {
  if (!options.resume) return agent.startSession(options);
  try {
    return await agent.startSession(options);
  } catch {
    return agent.startSession({ ...options, resume: undefined });
  }
}

import type { App, Plugin } from 'obsidian';
import type { Agent, AgentPreferences, AgentSession, SessionStart } from 'yami/agent';
import { ClaudeAgent } from 'yami/agent/claude';
import { CodexAgent } from 'yami/agent/codex';
import { type ConversationAgent, type ObsidianYami, vaultRoot } from 'yami/obsidian';
import { type AgentProfile, parseEnv } from './settings.ts';

/** The Yami agents of the profiles in the settings. A profile keeps its agent until its program or environment changes. */
export class ProfileAgents {
  private readonly agents = new Map<string, { key: string; agent: Agent }>();

  constructor(
    private readonly app: App,
    private readonly profiles: () => AgentProfile[],
  ) {}

  /** The agents for `createYami`, named by their tags. */
  entries(): ConversationAgent[] {
    return this.profiles().map((profile) => ({ name: profile.name, color: profile.color, agent: this.agent(profile) }));
  }

  agent(profile: AgentProfile): Agent {
    const key = JSON.stringify([profile.harness, profile.executablePath, profile.env, profile.userTools]);
    const known = this.agents.get(profile.name);
    if (known?.key === key) {
      known.agent.setPreferences(preferences(profile));
      return known.agent;
    }
    if (known) void known.agent.closeAll();
    const agent = this.build(profile);
    this.agents.set(profile.name, { key, agent });
    return agent;
  }

  // library-loop: F0.1
  /** Gives Yami the agents of the profiles as they are now, with a New conversation command for each. */
  sync(yami: ObsidianYami, plugin: Plugin): void {
    const entries = this.entries();
    for (const { agent } of entries) if (!yami.agents.includes(agent)) agent.setPreferences({ tools: yami.tools({ agent }), skills: yami.skills() });
    for (const { name } of yami.registered) plugin.removeCommand(`new-conversation-${name}`);
    yami.registered.splice(0, yami.registered.length, ...entries);
    yami.agents.splice(0, yami.agents.length, ...entries.map((entry) => entry.agent));
    for (const entry of entries) {
      plugin.addCommand({ id: `new-conversation-${entry.name}`, name: `New conversation with ${entry.name}`, callback: () => void yami.conversations.create(entry) });
    }
    for (const [name, { agent }] of this.agents) {
      if (entries.some((entry) => entry.name === name)) continue;
      this.agents.delete(name);
      void agent.closeAll();
    }
  }

  async closeAll(): Promise<void> {
    const open = [...this.agents.values()];
    this.agents.clear();
    await Promise.all(open.map(({ agent }) => agent.closeAll()));
  }

  private build(profile: AgentProfile): Agent {
    const options = { executable: profile.executablePath || undefined, env: parseEnv(profile.env), preferences: { cwd: vaultRoot(this.app), ...preferences(profile) } };
    if (profile.harness === 'codex') return new CodexAgent(options);
    // Without the user's settings, Claude Code loads no MCP servers or plugins of the user's own.
    return new ClaudeAgent({ ...options, settingSources: profile.userTools ? ['user', 'project', 'local'] : ['project', 'local'] });
  }
}

function preferences(profile: AgentProfile): AgentPreferences {
  return { model: profile.model || undefined, effort: profile.effort || undefined, approval: profile.approval };
}

// library-loop: F0.3
/** Starts a session. When the stored conversation is gone, starts a new one. */
export async function startSession(agent: Agent, options: SessionStart<AgentPreferences>): Promise<AgentSession> {
  if (!options.resume) return agent.startSession(options);
  try {
    return await agent.startSession(options);
  } catch {
    return agent.startSession({ ...options, resume: undefined });
  }
}

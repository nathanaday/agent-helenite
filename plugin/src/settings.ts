import { type App, PluginSettingTab, type SettingDefinitionGroup, type SettingDefinitionItem } from 'obsidian';
import type { ApprovalSetting, Harness } from 'yami/agent';
import { HARNESS_COLORS } from 'yami/obsidian';
import type DuetPlugin from './main.ts';

export interface AgentProfile {
  /** The tag without `@`. */
  name: string;
  harness: Harness;
  /** Empty: find the binary on the login shell PATH. */
  executablePath: string;
  /** Extra environment variables, one KEY=VALUE per line. */
  env: string;
  /** Empty: the harness default. */
  model: string;
  /** Empty: the model's default. */
  effort: string;
  approval: ApprovalSetting;
  /** Claude Code only: load the user's own MCP servers and plugins. */
  userTools: boolean;
  /** Color of the agent's cursor and highlights. */
  color: string;
}

export interface DuetSettings {
  profiles: AgentProfile[];
  /** Minutes before an idle agent process closes. Its conversation resumes on the next message. */
  idleMinutes: number;
  /** Folder for new conversation notes. */
  conversationFolder: string;
  /** Agents type their edits into open notes. Off: edits appear at once. */
  animate: boolean;
  /** The contribution lens marks the text that Duet agents wrote. */
  lens: boolean;
}

export const DEFAULT_SETTINGS: DuetSettings = {
  profiles: [
    { name: 'claude', harness: 'claude', executablePath: '', env: '', model: '', effort: '', approval: 'ask', userTools: false, color: HARNESS_COLORS.claude },
    { name: 'codex', harness: 'codex', executablePath: '', env: '', model: '', effort: '', approval: 'ask', userTools: false, color: HARNESS_COLORS.codex },
  ],
  idleMinutes: 15,
  conversationFolder: 'conversations',
  animate: true,
  lens: false,
};

/** Fills in settings that older versions of the plugin did not save. */
export function upgradeSettings(saved: Partial<DuetSettings> | undefined): DuetSettings {
  const settings = { ...structuredClone(DEFAULT_SETTINGS), ...saved };
  settings.profiles = settings.profiles.map((profile) => ({
    ...DEFAULT_SETTINGS.profiles[0]!,
    ...profile,
    color: profile.color || HARNESS_COLORS[profile.harness],
  }));
  return settings;
}

const HARNESS_NAMES: Record<Harness, string> = { claude: 'Claude Code', codex: 'Codex' };

const APPROVALS: Record<Harness, Partial<Record<ApprovalSetting, string>>> = {
  claude: { ask: 'Ask before edits and commands', 'accept-edits': 'Allow edits, ask before commands', auto: 'Let Claude Code decide what is safe', plan: 'Plan only' },
  codex: { ask: 'Ask before every command', sandbox: 'Ask only outside the sandbox' },
};

export function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    const index = trimmed.indexOf('=');
    if (!trimmed || trimmed.startsWith('#') || index < 1) continue;
    env[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim().replace(/^~(?=\/)/, process.env.HOME ?? '~');
  }
  return env;
}

/** The profile with a tag, in any letter case. */
export function profileNamed(profiles: AgentProfile[], name: string): AgentProfile | undefined {
  const tag = name.replace(/^@/, '').toLowerCase();
  return profiles.find((profile) => profile.name.toLowerCase() === tag);
}

export function displayName(profile: AgentProfile): string {
  return profile.name.charAt(0).toUpperCase() + profile.name.slice(1);
}

type AgentField = keyof AgentProfile;

/** Settings controls of an agent use the key `agent.<index>.<field>`. */
const agentKey = (index: number, field: AgentField) => `agent.${index}.${field}`;

export class DuetSettingTab extends PluginSettingTab {
  private readonly waitingForBlur = new WeakSet<HTMLInputElement>();

  constructor(
    app: App,
    private readonly plugin: DuetPlugin,
  ) {
    super(app, plugin);
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    const { profiles } = this.plugin.settings;
    return [
      {
        name: 'Ask an agent',
        desc: 'Write @name followed by a request on a line of a note, then press Enter. The agent replies in a callout under the line and can edit that note while you keep typing. For a longer exchange, start a conversation note from the command palette.',
      },
      {
        name: 'Conversation folder',
        desc: 'Where new conversation notes go.',
        control: { type: 'folder', key: 'conversationFolder', placeholder: 'conversations', includeRoot: true },
      },
      {
        name: 'Show agents typing',
        desc: 'Agents type their edits into open notes, with a live cursor. Off: edits appear at once, and the cursor still shows where the agent works.',
        control: { type: 'toggle', key: 'animate' },
      },
      {
        name: 'Close idle agents after',
        desc: 'Minutes without activity before an agent process stops. The next message continues the same conversation.',
        control: {
          type: 'number',
          key: 'idleMinutes',
          min: 1,
          validate: (minutes) => (Number.isFinite(minutes) && minutes > 0 ? undefined : 'Enter a number of minutes greater than 0.'),
        },
      },
      ...profiles.map((profile, index) => this.agentGroup(profile, index)),
      {
        name: 'Add agent',
        desc: 'Another agent with its own tag and settings, for example a second Claude account.',
        action: () => void this.addAgent(),
      },
    ];
  }

  getControlValue(key: string): unknown {
    const agent = parseAgentKey(key);
    if (agent) return this.plugin.settings.profiles[agent.index]?.[agent.field];
    return this.plugin.settings[key as keyof DuetSettings];
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    const { settings } = this.plugin;
    const agent = parseAgentKey(key);
    if (!agent) {
      if (key === 'conversationFolder') settings.conversationFolder = String(value).trim().replace(/^\/+|\/+$/g, '');
      else if (key === 'animate') settings.animate = Boolean(value);
      else if (key === 'idleMinutes') settings.idleMinutes = Number(value);
      await this.plugin.saveSettings();
      return;
    }
    const profile = settings.profiles[agent.index];
    if (!profile) return;
    switch (agent.field) {
      case 'name':
        profile.name = String(value).trim().replace(/^@/, '');
        break;
      case 'harness':
        profile.harness = value as Harness;
        if (!APPROVALS[profile.harness][profile.approval]) profile.approval = 'ask';
        break;
      case 'approval':
        profile.approval = value as ApprovalSetting;
        break;
      case 'effort':
        profile.effort = String(value).trim().toLowerCase();
        break;
      case 'model':
      case 'executablePath':
        profile[agent.field] = String(value).trim();
        break;
      case 'env':
      case 'color':
        profile[agent.field] = String(value);
        break;
      case 'userTools':
        profile.userTools = Boolean(value);
        break;
    }
    await this.plugin.saveSettings();
    // The heading shows the tag, and the program decides which approvals and options the agent offers.
    if (agent.field === 'harness') this.update();
    if (agent.field === 'name') this.updateAfterTyping();
  }

  /** Refreshes the tab when the field that has focus loses it. A refresh while the user types would take the focus. */
  private updateAfterTyping(): void {
    const field = this.containerEl.doc.activeElement;
    if (!field?.instanceOf(HTMLInputElement)) {
      this.update();
      return;
    }
    if (this.waitingForBlur.has(field)) return;
    this.waitingForBlur.add(field);
    const blurred = () => {
      // The window lost the focus. The field keeps it for when the window gets it back.
      if (field.doc.activeElement === field) return;
      field.removeEventListener('blur', blurred);
      this.waitingForBlur.delete(field);
      this.update();
    };
    field.addEventListener('blur', blurred);
  }

  private agentGroup(profile: AgentProfile, index: number): SettingDefinitionGroup {
    return {
      type: 'group',
      heading: `@${profile.name}`,
      extraButtons: [
        (button) =>
          button
            .setIcon('trash')
            .setTooltip(`Remove @${profile.name}`)
            .onClick(() => void this.removeAgent(profile)),
      ],
      items: [
        {
          name: 'Tag',
          desc: 'The name you write after @. Letters, digits, - and _.',
          control: {
            type: 'text',
            key: agentKey(index, 'name'),
            validate: (value) => {
              const name = value.trim().replace(/^@/, '');
              if (!/^[\w-]+$/.test(name)) return 'Use only letters, digits, - and _.';
              if (this.nameTaken(name, index)) return `Another agent already has the tag @${name}.`;
            },
          },
        },
        { name: 'Color', desc: "The agent's cursor and highlights.", control: { type: 'color', key: agentKey(index, 'color') } },
        { name: 'Agent', control: { type: 'dropdown', key: agentKey(index, 'harness'), options: HARNESS_NAMES } },
        {
          name: 'Approvals',
          desc: 'For conversation notes. In a mention, the agent can change only the note it was asked in, without asking.',
          control: { type: 'dropdown', key: agentKey(index, 'approval'), options: APPROVALS[profile.harness] },
        },
        {
          name: 'Model',
          desc: 'Leave empty for the default model. A conversation note can choose its own.',
          control: { type: 'text', key: agentKey(index, 'model') },
        },
        {
          name: 'Effort',
          desc: 'How much the model reasons, for example low, medium or high. Leave empty for the default.',
          control: { type: 'text', key: agentKey(index, 'effort') },
        },
        {
          name: 'Program path',
          desc: `Leave empty to find ${profile.harness} on your shell's PATH.`,
          control: { type: 'text', key: agentKey(index, 'executablePath'), placeholder: `/usr/local/bin/${profile.harness}` },
        },
        {
          name: 'Environment variables',
          desc:
            profile.harness === 'claude'
              ? 'One KEY=VALUE per line. For example, CLAUDE_CONFIG_DIR=~/.claude-work uses a second Claude account.'
              : 'One KEY=VALUE per line. For example, CODEX_HOME=~/.codex-work uses a second Codex account.',
          control: { type: 'textarea', key: agentKey(index, 'env'), rows: 3 },
        },
        {
          name: 'Load my MCP servers and plugins',
          desc: 'Off: the agent uses only its built-in tools.',
          visible: () => this.plugin.settings.profiles[index]?.harness === 'claude',
          control: { type: 'toggle', key: agentKey(index, 'userTools') },
        },
      ],
    };
  }

  private async addAgent(): Promise<void> {
    this.plugin.settings.profiles.push({ ...DEFAULT_SETTINGS.profiles[0]!, name: this.unusedName() });
    await this.plugin.saveSettings();
    this.update();
  }

  /** By the profile, not its index: Obsidian keeps a group's buttons when the group above it goes. */
  private async removeAgent(profile: AgentProfile): Promise<void> {
    const { profiles } = this.plugin.settings;
    if (profiles.includes(profile)) profiles.splice(profiles.indexOf(profile), 1);
    await this.plugin.saveSettings();
    this.update();
  }

  private nameTaken(name: string, except: number): boolean {
    return this.plugin.settings.profiles.some(
      (profile, index) => index !== except && profile.name.toLowerCase() === name.toLowerCase(),
    );
  }

  private unusedName(): string {
    for (let n = 2; ; n++) if (!this.nameTaken(`agent${n}`, -1)) return `agent${n}`;
  }
}

function parseAgentKey(key: string): { index: number; field: AgentField } | undefined {
  const match = /^agent\.(\d+)\.(\w+)$/.exec(key);
  return match ? { index: Number(match[1]), field: match[2] as AgentField } : undefined;
}

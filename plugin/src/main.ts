import type { EditorView } from '@codemirror/view';
import { MarkdownView, Notice, Plugin, TFile } from 'obsidian';
import { createYami, type ObsidianYami } from 'yami/obsidian';
import { ProfileAgents } from './agents.ts';
import type { DuetApi } from './api.ts';
import { ContributionLedger } from './contributions/ledger.ts';
import { ContributionLens } from './contributions/lens.ts';
import { enterTrigger } from './enter-trigger.ts';
import { mentionTags, tagPostProcessor, type TagStyle } from './mention-tags.ts';
import { MentionAgents, type SessionIndex } from './mentions.ts';
import { displayName, type DuetSettings, DuetSettingTab, profileNamed, upgradeSettings } from './settings.ts';

interface PluginData {
  settings: DuetSettings;
  sessions: SessionIndex;
}

export default class DuetPlugin extends Plugin {
  declare settings: DuetSettings;
  yami!: ObsidianYami;
  agents!: ProfileAgents;
  mentions!: MentionAgents;
  ledger!: ContributionLedger;
  lens!: ContributionLens;
  /** For other plugins: `app.plugins.getPlugin('duet')?.api`. */
  api!: DuetApi;
  private sessions: SessionIndex = {};
  private lensButton!: HTMLElement;

  async onload(): Promise<void> {
    const data = ((await this.loadData()) ?? {}) as Partial<PluginData>;
    this.settings = upgradeSettings(data.settings);
    this.sessions = data.sessions ?? {};

    this.agents = new ProfileAgents(this.app, () => this.settings.profiles);
    this.yami = createYami(this, {
      agents: this.agents.entries(),
      conversationFolder: this.settings.conversationFolder,
      idleMinutes: this.settings.idleMinutes,
    });

    this.ledger = new ContributionLedger(this.app);
    this.ledger.install(this);
    this.yami.hub.observe(this.ledger);
    this.lens = new ContributionLens(this.app, this.ledger, () => this.settings.lens);
    this.ledger.onChange((path) => this.lens.refresh(path));
    this.registerEditorExtension([this.lens.extension(), mentionTags(() => this.tagStyles())]);
    this.registerMarkdownPostProcessor(this.lens.postProcessor);
    this.registerMarkdownPostProcessor(tagPostProcessor(() => this.tagStyles()));

    const { conversations } = this.yami;
    this.api = {
      version: 1,
      newConversation: async ({ profile, ...options }) => {
        const agent = profile === undefined ? undefined : profileNamed(this.settings.profiles, profile);
        if (profile !== undefined && !agent) {
          throw new Error(`Duet has no agent named ${profile}. Agents: ${this.settings.profiles.map((p) => p.name).join(', ')}.`);
        }
        const folder = options.folder ?? this.settings.conversationFolder;
        return { path: (await conversations.start({ ...options, folder, agent: agent?.name })).path };
      },
      conversationStatus: (path) => conversations.status(path),
      onTurnEnd: (path, callback) => conversations.onTurnEnd(path, callback),
    };

    const animate = () => this.settings.animate && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.mentions = new MentionAgents(this.yami.hub, this.agents, this.sessions, {
      idleMinutes: () => this.settings.idleMinutes,
      animate,
      save: () => this.persist(),
    });

    this.addRibbonIcon('message-square-plus', 'New conversation', () => void this.newConversation());
    this.lensButton = this.addRibbonIcon('highlighter', 'Toggle contribution lens', () => void this.toggleLens());
    this.lensButton.addClass('duet-lens-toggle');
    this.lensButton.toggleClass('is-active', this.settings.lens);
    this.addCommand({
      id: 'toggle-lens',
      name: 'Toggle contribution lens',
      callback: () => void this.toggleLens(),
    });

    this.registerEditorExtension(
      enterTrigger(
        () => this.settings.profiles.map((profile) => profile.name),
        (name) => {
          const profile = this.profile(name);
          return profile ? displayName(profile) : name;
        },
        (mention) => {
          const profile = this.profile(mention.name);
          if (profile) void this.mentions.ask({ ...mention, profile });
        },
      ),
    );

    // library-loop: F0.4
    this.addCommand({
      id: 'stop-mention',
      name: 'Stop the mention agent in this note',
      checkCallback: (checking) => {
        const file = this.activeFile();
        if (!file || !this.mentions.working.some((working) => working.file === file)) return false;
        if (!checking) void this.mentions.interrupt(file);
        return true;
      },
    });

    this.addCommand({
      id: 'forget-mentions',
      name: 'Forget the mention conversation in this note',
      checkCallback: (checking) => {
        const file = this.activeFile();
        if (!file) return false;
        if (!checking) {
          void this.mentions.forget(file).then(() => new Notice('The next mention in this note starts a new conversation.'));
        }
        return true;
      },
    });

    this.addSettingTab(new DuetSettingTab(this.app, this));

    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        if (file instanceof TFile) void this.mentions.rename(file, oldPath);
      }),
    );
  }

  onunload(): void {
    void this.shutdown();
  }

  private async shutdown(): Promise<void> {
    await this.mentions.closeAll();
    await this.agents.closeAll();
    await this.ledger.flush();
  }

  async saveSettings(): Promise<void> {
    await this.persist();
    this.agents.sync(this.yami, this);
    this.refreshEditors();
    await this.mentions.closeIdle();
  }

  async toggleLens(): Promise<void> {
    this.settings.lens = !this.settings.lens;
    this.lensButton.toggleClass('is-active', this.settings.lens);
    this.lens.refresh();
    await this.persist();
  }

  /** Opens a conversation note with the first agent. */
  private async newConversation(): Promise<void> {
    const agent = this.yami.registered[0];
    if (!agent) {
      new Notice('Duet has no agents. Add one in the settings.');
      return;
    }
    try {
      await this.yami.conversations.create(agent);
    } catch (error) {
      console.error(error);
      new Notice(`Duet could not start a conversation: ${(error as Error).message}`, 10_000);
    }
  }

  private tagStyles(): TagStyle[] {
    return this.settings.profiles.map((profile) => ({ name: profile.name, color: profile.color }));
  }

  /** Lets editor extensions see changed settings, such as a new agent tag. */
  private refreshEditors(): void {
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (leaf.view instanceof MarkdownView) (leaf.view.editor as unknown as { cm?: EditorView }).cm?.dispatch({});
    });
  }

  private persist(): Promise<void> {
    return this.saveData({ settings: this.settings, sessions: this.sessions } satisfies PluginData);
  }

  private profile(name: string) {
    return profileNamed(this.settings.profiles, name);
  }

  private activeFile(): TFile | undefined {
    return this.app.workspace.getActiveViewOfType(MarkdownView)?.file ?? undefined;
  }
}

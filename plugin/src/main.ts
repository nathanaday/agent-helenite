import type { EditorView } from '@codemirror/view';
import { MarkdownView, Notice, Plugin, type TFile } from 'obsidian';
import { createYami, type ObsidianYami, type SessionIds } from 'yami/obsidian';
import { ProfileAgents } from './agents.ts';
import type { DuetApi } from './api.ts';
import { ContributionLedger } from './contributions/ledger.ts';
import { ContributionLens } from './contributions/lens.ts';
import { enterTrigger } from './enter-trigger.ts';
import { mentionTags, tagPostProcessor, type TagStyle } from './mention-tags.ts';
import { MentionAgents } from './mentions.ts';
import { displayName, type DuetSettings, DuetSettingTab, profileNamed, upgradeSettings } from './settings.ts';

interface PluginData {
  settings: DuetSettings;
  sessions: SessionIds;
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
  private sessions: SessionIds = {};
  private lensButton!: HTMLElement;

  async onload(): Promise<void> {
    const data = ((await this.loadData()) ?? {}) as Partial<PluginData>;
    this.settings = upgradeSettings(data.settings);
    this.sessions = data.sessions ?? {};

    this.agents = new ProfileAgents(this.app, () => this.settings.profiles);
    this.yami = createYami(this, {
      agents: this.agents.entries(),
      conversationFolder: () => this.settings.conversationFolder,
      idleMinutes: () => this.settings.idleMinutes,
      animate: () => this.settings.animate,
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
      version: 2,
      newConversation: async ({ agent: name, ...options }) => {
        if ('profile' in options) throw new Error('Duet API version 2 renamed the option `profile` to `agent`.');
        const agent = name === undefined ? undefined : profileNamed(this.settings.profiles, name);
        if (name !== undefined && !agent) {
          throw new Error(`Duet has no agent named ${name}. Agents: ${this.settings.profiles.map((p) => p.name).join(', ')}.`);
        }
        return { path: (await conversations.start({ ...options, agent: agent?.name })).path };
      },
      conversationStatus: (path) => conversations.status(path),
      onTurnEnd: (path, callback) => conversations.onTurnEnd(path, callback),
    };

    this.mentions = new MentionAgents(this.yami, {
      ids: this.sessions,
      save: (ids) => {
        this.sessions = ids;
        return this.persist();
      },
      profile: (name) => this.profile(name),
    });

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
  }

  onunload(): void {
    void this.ledger.flush();
  }

  async saveSettings(): Promise<void> {
    await this.persist();
    try {
      this.yami.setAgents(this.agents.entries());
    } catch (error) {
      new Notice(`Duet could not apply the agents: ${(error as Error).message}`);
    }
    this.refreshEditors();
  }

  async toggleLens(): Promise<void> {
    this.settings.lens = !this.settings.lens;
    this.lensButton.toggleClass('is-active', this.settings.lens);
    this.lens.refresh();
    await this.persist();
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

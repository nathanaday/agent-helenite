import type { EditorView } from '@codemirror/view';
import { MarkdownView, Notice, Plugin, TFile } from 'obsidian';
import { type CollabHub, ConversationManager, installCollab, PermissionPrompts, uninstallCollab } from 'yami/obsidian';
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
  hub!: CollabHub;
  agents!: ProfileAgents;
  mentions!: MentionAgents;
  conversations!: ConversationManager;
  ledger!: ContributionLedger;
  lens!: ContributionLens;
  /** For other plugins: `app.plugins.getPlugin('duet')?.api`. */
  api!: DuetApi;
  private sessions: SessionIndex = {};
  private statusEl!: HTMLElement;
  private lensButton!: HTMLElement;

  async onload(): Promise<void> {
    const data = ((await this.loadData()) ?? {}) as Partial<PluginData>;
    this.settings = upgradeSettings(data.settings);
    this.sessions = data.sessions ?? {};

    const animate = () => this.settings.animate && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.hub = installCollab(this.app, this);
    this.agents = new ProfileAgents(this.app, () => this.settings.profiles);

    this.ledger = new ContributionLedger(this.app);
    this.ledger.install(this);
    this.hub.observe(this.ledger);
    this.lens = new ContributionLens(this.app, this.ledger, () => this.settings.lens);
    this.ledger.onChange((path) => this.lens.refresh(path));
    this.registerEditorExtension([this.lens.extension(), mentionTags(() => this.tagStyles())]);
    this.registerMarkdownPostProcessor(this.lens.postProcessor);
    this.registerMarkdownPostProcessor(tagPostProcessor(() => this.tagStyles()));

    const prompts = new PermissionPrompts(this.app);
    this.conversations = new ConversationManager(this.app, this.hub, prompts, {
      agents: () => this.agents.list,
      folder: () => this.settings.conversationFolder,
      animate,
      idleMinutes: () => this.settings.idleMinutes,
      onActivity: () => this.updateStatus(),
    });
    this.conversations.install(this);
    this.api = {
      version: 1,
      newConversation: async ({ profile, ...options }) => {
        const agent = profile === undefined ? undefined : profileNamed(this.settings.profiles, profile);
        if (profile !== undefined && !agent) {
          throw new Error(`Duet has no agent named ${profile}. Agents: ${this.settings.profiles.map((p) => p.name).join(', ')}.`);
        }
        return { path: (await this.conversations.start({ ...options, agent: agent?.name })).path };
      },
      conversationStatus: (path) => this.conversations.status(path),
      onTurnEnd: (path, callback) => this.conversations.onTurnEnd(path, callback),
    };

    this.mentions = new MentionAgents(this.hub, this.agents, this.sessions, prompts, {
      idleMinutes: () => this.settings.idleMinutes,
      animate,
      save: () => this.persist(),
      onActivity: () => this.updateStatus(),
    });

    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass('duet-status');
    this.statusEl.addEventListener('click', () => {
      const working = this.working()[0];
      if (working) void this.app.workspace.getLeaf(false).openFile(working.file);
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
    this.addCommand({
      id: 'new-chat',
      name: 'New conversation',
      callback: () => void this.newConversation(),
    });
    for (const profile of this.settings.profiles.slice(1)) {
      this.addCommand({
        id: `new-chat-${profile.name}`,
        name: `New conversation with ${displayName(profile)}`,
        callback: () => void this.newConversation(profile.name),
      });
    }
    this.addCommand({
      id: 'end-chat',
      name: 'End this conversation',
      checkCallback: (checking) => {
        const file = this.activeFile();
        const controller = file && this.conversations.controller(file);
        if (!controller || controller.ended) return false;
        if (!checking) void controller.end();
        return true;
      },
    });
    this.addCommand({
      id: 'focus-composer',
      name: 'Focus the message box',
      checkCallback: (checking) => {
        const composer = this.conversations.activeComposer();
        if (!composer) return false;
        if (!checking) composer.focus();
        return true;
      },
    });
    this.updateStatus();

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
      id: 'stop',
      name: 'Stop the agent in this note',
      checkCallback: (checking) => {
        const file = this.activeFile();
        if (!file) return false;
        if (!checking) {
          const controller = this.conversations.controller(file);
          if (controller?.working) {
            void controller.interrupt();
            return true;
          }
          void this.mentions.interrupt(file).then((count) => {
            if (!count) new Notice('No agent is working in this note.');
          });
        }
        return true;
      },
    });

    this.addCommand({
      id: 'revert',
      name: "Undo the agent's last changes in this note",
      checkCallback: (checking) => {
        const file = this.activeFile();
        const note = file && this.hub.get(file.path);
        if (!note?.agentUndo.canUndo()) return false;
        if (!checking) this.mentions.revert(note);
        return true;
      },
    });

    this.addCommand({
      id: 'new-conversation',
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
    await this.conversations.destroy();
    await this.mentions.closeAll();
    await this.agents.closeAll();
    uninstallCollab(this.hub);
    await this.ledger.flush();
  }

  async saveSettings(): Promise<void> {
    await this.persist();
    this.refreshEditors();
    await this.mentions.closeIdle();
  }

  async toggleLens(): Promise<void> {
    this.settings.lens = !this.settings.lens;
    this.lensButton.toggleClass('is-active', this.settings.lens);
    this.lens.refresh();
    await this.persist();
  }

  /** Opens a conversation note with the named agent, or the first one. */
  private async newConversation(name?: string): Promise<void> {
    const profile = (name && this.profile(name)) || this.settings.profiles[0];
    if (!profile) {
      new Notice('Duet has no agents. Add one in the settings.');
      return;
    }
    try {
      await this.conversations.create(this.agents.conversationAgent(profile));
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

  private working(): { name: string; file: TFile }[] {
    return [
      ...this.mentions.working,
      ...this.conversations.working.map((controller) => ({ name: controller.agentName, file: controller.file })),
    ];
  }

  private updateStatus(): void {
    if (!this.statusEl) return;
    const working = this.working();
    const text = working.length === 1 ? `${working[0]!.name} working in ${working[0]!.file.basename}` : working.length ? `${working.length} agents working` : '';
    this.statusEl.setText(text);
    this.statusEl.toggleClass('is-working', working.length > 0);
  }
}

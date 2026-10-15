import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { launchObsidian, type ObsidianInstance, openAtEnd } from './harness.ts';

const TIMEOUT = 240_000;
const SHOTS = process.env.DUET_SHOTS;

describe('Duet in Obsidian', () => {
  let obsidian: ObsidianInstance;

  beforeAll(async () => {
    obsidian = await launchObsidian();
  }, 60_000);

  afterAll(async () => {
    await obsidian?.close();
  });

  afterEach(async () => {
    // The editor and the shared document must never differ.
    const drift = await obsidian.page.evaluate(() => {
      const app = (window as any).app;
      const hub = app.plugins.plugins.duet?.hub;
      const problems: string[] = [];
      for (const leaf of app.workspace.getLeavesOfType('markdown')) {
        const note = leaf.view.file && hub?.get(leaf.view.file.path);
        if (note && note.views.size && leaf.view.editor.getValue() !== note.content) problems.push(leaf.view.file.path);
      }
      return problems;
    });
    expect(drift).toEqual([]);
  });

  const page = () => obsidian.page;

  /** Waits until no agent works, then for the editor to settle. */
  async function idle(timeout = 180_000) {
    await page().waitForFunction(
      () => {
        const plugin = (window as any).app.plugins.plugins.duet;
        return plugin.mentions.working.length === 0 && plugin.conversations.working.length === 0;
      },
      undefined,
      { timeout, polling: 250 },
    );
    await page().waitForTimeout(600);
  }

  async function mention(note: string, line: string) {
    await openAtEnd(page(), note);
    await page().keyboard.type(line);
    await page().keyboard.press('Enter');
    await page().waitForFunction(() => (window as any).app.plugins.plugins.duet.mentions.working.length > 0, undefined, { timeout: 10_000 });
  }

  async function shot(name: string) {
    if (SHOTS) await page().screenshot({ path: path.join(SHOTS, `obsidian-${name}.png`) });
  }

  /** The note's contribution ledger, as saved. */
  async function ledger(note: string): Promise<{ text: string; spans: { from: number; to: number; agent: string }[] }> {
    const file = path.join(obsidian.vault, '.duet/contributions', `${note}.json`);
    const deadline = Date.now() + 10_000;
    while (!existsSync(file) && Date.now() < deadline) await page().waitForTimeout(250);
    return JSON.parse(readFileSync(file, 'utf8'));
  }

  describe('mentions', () => {
    it('shows an agent tag as a pill as soon as it is typed', { timeout: TIMEOUT }, async () => {
      await openAtEnd(page(), 'Welcome.md');
      await page().keyboard.type('@claude');
      await page().waitForSelector('.duet-tag', { timeout: 5000 });
      expect(await page().textContent('.duet-tag')).toBe('@claude');
      await page().keyboard.type('x');
      await page().waitForSelector('.duet-tag', { state: 'detached', timeout: 5000 });
      for (let i = 0; i < 8; i++) await page().keyboard.press('Backspace');
    });

    it('answers a mention in a callout under the line, with a live cursor', { timeout: TIMEOUT }, async () => {
      await mention('Ideas.md', '@claude Reply with exactly the word: pineapple');
      await page().waitForSelector('.yami-caret', { timeout: 30_000 });
      expect(await page().textContent('.yami-caret-flag')).toContain('claude');
      await idle();
      const text = await obsidian.waitForNote('Ideas.md', () => true);
      expect(text).toMatch(/@claude Reply with exactly the word: pineapple\n> \[!agent\]\+ Claude\n> pineapple\.?\n\n$/i);
      await shot('reply');
    });

    it('continues the same conversation in the same note', { timeout: TIMEOUT }, async () => {
      await mention('Ideas.md', '@claude Which word did you just reply with? Reply with only that word, in capitals.');
      await idle();
      const text = await obsidian.waitForNote('Ideas.md', () => true);
      expect(text).toContain('> PINEAPPLE');
      expect(text.match(/\[!agent\]/g)).toHaveLength(2);
    });

    it('keeps text the user types while the agent replies', { timeout: TIMEOUT }, async () => {
      await mention('Reading list.md', '@claude List five fruits, one per line, nothing else.');
      await page().keyboard.type('My own line, typed during the reply.', { delay: 30 });
      await idle();
      const text = await obsidian.waitForNote('Reading list.md', () => true);
      expect(text).toMatch(/> \[!agent\]\+ Claude\n(> .+\n){5}\nMy own line, typed during the reply\.$/);
    });

    it('edits the note live while the user types, and loses nothing', { timeout: TIMEOUT }, async () => {
      const typed = 'I keep typing this sentence while the agent edits the list above.';
      await mention('Ideas.md', '@claude Rewrite each bullet of the list at the top so it is at most eight words. Then reply with: Done.');
      const typing = page().keyboard.type(typed, { delay: 70 });
      await page().waitForSelector('.yami-fresh', { timeout: 90_000 });
      await shot('edit');
      await typing;
      await idle();
      const text = await obsidian.waitForNote('Ideas.md', () => true);
      expect(text).toContain(typed);
      expect(text).not.toContain('Tag an agent on any line of a note and get the answer on the next line.');
      for (const bullet of text.split('\n# Ideas')[0]!.split('\n').filter((line) => line.startsWith('- '))) {
        expect(bullet.split(/\s+/).length).toBeLessThanOrEqual(10);
      }
      await page().waitForTimeout(2500);
      expect(await obsidian.read('Ideas.md')).toBe(text);

      // The ledger records the agent's text, and not the sentence that the user typed meanwhile.
      const record = await ledger('Ideas.md');
      expect(record.text).toBe(text);
      expect(record.spans.length).toBeGreaterThan(0);
      expect(record.spans.every((span) => span.agent === 'claude')).toBe(true);
      const typedAt = text.indexOf(typed);
      expect(record.spans.some((span) => span.from < typedAt + typed.length && span.to > typedAt)).toBe(false);
      expect(record.spans.some((span) => text.slice(span.from, span.to).includes('Done'))).toBe(true);

      // The lens marks that text while it is on.
      await page().evaluate(() => (window as any).app.commands.executeCommandById('duet:toggle-lens'));
      await page().waitForSelector('.duet-lens', { timeout: 5000 });
      await page().evaluate(() => (window as any).app.commands.executeCommandById('duet:toggle-lens'));
      await page().waitForSelector('.duet-lens', { state: 'detached', timeout: 5000 });
    });

    it('reverts the agent\'s last changes with a command', { timeout: TIMEOUT }, async () => {
      const before = await obsidian.waitForNote('Ideas.md', () => true);
      await mention('Ideas.md', '@claude Add the line "Reviewed." directly under the "# Ideas" heading. Then reply with: Added.');
      await idle();
      expect(await obsidian.waitForNote('Ideas.md', () => true)).toMatch(/# Ideas\n+Reviewed\./);
      await page().evaluate(() => (window as any).app.commands.executeCommandById('duet:revert'));
      const reverted = await obsidian.waitForNote('Ideas.md', (text) => !/# Ideas\n+Reviewed\./.test(text), 5000);
      // The reply stays; only the edit goes away.
      expect(reverted.startsWith(before.slice(0, before.indexOf('- ')))).toBe(true);
      expect(reverted).toContain('> Added');
    });

    it('cannot change other notes', { timeout: TIMEOUT }, async () => {
      const welcome = readFileSync(path.join(obsidian.vault, 'Welcome.md'), 'utf8');
      await mention('Reading list.md', '@claude Append the line "changed" to Welcome.md. If you cannot, say so in one sentence.');
      await idle();
      expect(readFileSync(path.join(obsidian.vault, 'Welcome.md'), 'utf8')).toBe(welcome);
      expect(existsSync(path.join(obsidian.vault, 'changed'))).toBe(false);
    });

    it('answers with Codex for @codex', { timeout: TIMEOUT }, async () => {
      await mention('Reading list.md', '@codex Reply with exactly the word: mango');
      await idle();
      expect(await obsidian.waitForNote('Reading list.md', () => true)).toMatch(/> \[!agent\]\+ Codex\n> mango\.?\n\n$/i);
    });

    it('stops a reply with the Stop command', { timeout: TIMEOUT }, async () => {
      await mention('Ideas.md', '@claude Write a 600 word essay about lighthouses.');
      await obsidian.waitForNote('Ideas.md', (text) => /lighthouses\.\n> \[!agent\]\+ Claude\n> \S/.test(text), 90_000);
      await page().evaluate(() => (window as any).app.commands.executeCommandById('duet:stop'));
      await idle(15_000);
      expect(await obsidian.waitForNote('Ideas.md', () => true)).toMatch(/> \*Stopped\.\*\n\n$/);
    });

    it('leaves plain Enter and code blocks alone', { timeout: TIMEOUT }, async () => {
      const before = await obsidian.read('Welcome.md');
      await openAtEnd(page(), 'Welcome.md');
      await page().keyboard.type('```\n@claude this is code\n');
      await page().keyboard.type('```\nmail me at ana@claude.ai\n');
      await page().waitForTimeout(1000);
      const text = await obsidian.waitForNote('Welcome.md', () => true);
      expect(text.slice(before.length)).not.toContain('[!agent]');
    });

    it('remembers the conversation after the plugin reloads', { timeout: TIMEOUT }, async () => {
      const data = JSON.parse(readFileSync(path.join(obsidian.vault, '.obsidian/plugins/duet/data.json'), 'utf8'));
      expect(data.sessions['Ideas.md'].claude).toMatch(/^[0-9a-f-]{36}$/);
      await page().evaluate(async () => {
        const plugins = (window as any).app.plugins;
        await plugins.disablePlugin('duet');
        await plugins.enablePlugin('duet');
      });
      await mention('Ideas.md', '@claude Earlier in this conversation you replied with one fruit word. Which? Reply with only that word, in capitals.');
      await idle();
      const text = await obsidian.waitForNote('Ideas.md', () => true);
      expect((text.match(/PINEAPPLE/g) ?? []).length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('conversation notes', () => {
    async function newConversation(command = 'duet:new-chat') {
      await page().evaluate((id) => (window as any).app.commands.executeCommandById(id), command);
      await page().waitForSelector('.yami-composer textarea', { timeout: 15_000 });
    }

    async function send(message: string) {
      await page().focus('.yami-composer textarea');
      await page().keyboard.type(message);
      await page().keyboard.press('Enter');
      await page().waitForSelector('.yami-composer.is-working', { timeout: 10_000 });
    }

    const activePath = () => page().evaluate(() => (window as any).app.workspace.getActiveFile()?.path as string);

    it('writes the exchange into the note and names the note', { timeout: TIMEOUT }, async () => {
      await newConversation();
      await send('Read [[Ideas]], then reply with the number of bullets in its first list, as a digit only.');
      await idle();
      const file = await activePath();
      expect(file).toMatch(/^conversations\/\d{4}-\d{2}-\d{2} Read Ideas, then reply with the number/);
      const text = await obsidian.waitForNote(file, () => true);
      expect(text).toMatch(/^---\ntype: conversation\nagent: claude\n/);
      expect(text).toMatch(/\nsession: [0-9a-f-]{36}\n/);
      expect(text).toContain('> [!user]\n> Read [[Ideas]], then reply');
      expect(text).toMatch(/> \[!activity\]- .*Read a file.*\n> - Read \[\[Ideas\]\]/);
      expect(text).toMatch(/\n\d\n\n$/);
      await shot('conversation');
    });

    it('asks in the message box before an edit, and edits an open note while the user types in it', { timeout: TIMEOUT }, async () => {
      const chat = await activePath();
      // Open Reading list next to the conversation, with the cursor at its end.
      await page().evaluate(async () => {
        const app = (window as any).app;
        const chatLeaf = app.workspace.activeLeaf;
        const leaf = app.workspace.getLeaf('split', 'vertical');
        await leaf.openFile(app.vault.getAbstractFileByPath('Reading list.md'), { state: { mode: 'source' } });
        app.workspace.setActiveLeaf(chatLeaf, { focus: true });
      });
      await send('Use your Edit tool to replace the first line of [[Reading list]] with "# Books". Then reply with: Done.');
      await page().waitForSelector('.yami-composer.has-approval', { timeout: 90_000 });
      expect(await page().textContent('.yami-approval')).toContain('claude wants to change a file');
      await shot('approval');
      // Type in the open note while the agent waits for approval and then edits it.
      const typed = ' Typed while the agent edits.';
      await page().evaluate(() => {
        const app = (window as any).app;
        const leaf = app.workspace.getLeavesOfType('markdown').find((l: any) => l.view.file?.path === 'Reading list.md');
        app.workspace.setActiveLeaf(leaf, { focus: true });
        const editor = leaf.view.editor;
        editor.setCursor({ line: editor.lastLine(), ch: editor.getLine(editor.lastLine()).length });
      });
      await page().keyboard.type(typed, { delay: 40 });
      await page().evaluate((file) => {
        const app = (window as any).app;
        app.workspace.setActiveLeaf(app.workspace.getLeavesOfType('markdown').find((l: any) => l.view.file?.path === file), { focus: true });
      }, chat);
      await page().focus('.yami-composer textarea');
      await page().keyboard.press('y');
      await idle();
      const list = await obsidian.waitForNote('Reading list.md', () => true);
      expect(list.split('\n')[0]).toBe('# Books');
      expect(list.trimEnd().endsWith(typed.trim())).toBe(true);
      await page().waitForTimeout(2500);
      expect(await obsidian.read('Reading list.md')).toBe(list);
      expect(await obsidian.waitForNote(chat, () => true)).toMatch(/> \[!activity\]- .*Edited a file[\s\S]*```diff/);
    });

    it('records an edit to a note that is not open', { timeout: TIMEOUT }, async () => {
      await send('Use your Edit tool to replace the first line of [[Welcome]] with "# Hello from the agent". Then reply with: Done.');
      await page().waitForSelector('.yami-composer.has-approval', { timeout: 90_000 });
      await page().focus('.yami-composer textarea');
      await page().keyboard.press('y');
      await idle();
      const welcome = readFileSync(path.join(obsidian.vault, 'Welcome.md'), 'utf8');
      expect(welcome.split('\n')[0]).toBe('# Hello from the agent');
      const record = await ledger('Welcome.md');
      expect(record.text).toBe(welcome);
      expect(record.spans.map((span) => welcome.slice(span.from, span.to)).join('')).toContain('Hello from the agent');
    });

    it('shows the agent\'s questions in the message box and sends the answers', { timeout: TIMEOUT }, async () => {
      const chat = await activePath();
      await send('Make one AskUserQuestion tool call with two questions: first which fruit to add, with the options Apple and Pear; then which color, with the options Red and Green. Then reply with only my two answers in capitals, separated by one space.');
      await page().waitForSelector('.yami-composer.has-approval .yami-questions', { timeout: 90_000 });
      expect(await page().textContent('.yami-approval')).toContain('claude asks you');
      const visible = () => page().$$eval('.yami-question', (sets) => sets.filter((set) => !(set as HTMLElement).hidden).map((set) => set.textContent));
      // One question at a time; picking an option moves to the next one.
      expect(await visible()).toEqual([expect.stringContaining('Pear')]);
      expect(await page().textContent('.yami-question-progress')).toBe('1 of 2');
      expect(await page().isDisabled('.yami-questions button[type=submit]')).toBe(true);
      await shot('question');
      await page().click('.yami-question:not([hidden]) .yami-question-option:has-text("Pear")');
      await page().waitForFunction(() => document.querySelector('.yami-question-progress')?.textContent === '2 of 2');
      expect(await visible()).toEqual([expect.stringContaining('Green')]);
      expect(await page().textContent('.yami-questions button[type=submit]')).toContain('Answer');
      // An answer of the user's own, sent with Enter.
      await page().click('.yami-question:not([hidden]) .yami-question-other');
      await page().keyboard.type('Blue');
      await page().keyboard.press('Enter');
      await page().waitForSelector('.yami-composer:not(.has-approval)', { timeout: 10_000 });
      await idle();
      const text = await obsidian.waitForNote(chat, () => true);
      expect(text).toMatch(/> - Asked you questions\n>\s+- .*→ Pear\n>\s+- .*→ Blue\n/);
      expect(text).toMatch(/\nPEAR BLUE\.?\n\n$/);
    });

    it('applies a new approval mode to the request that waits', { timeout: TIMEOUT }, async () => {
      const chat = await activePath();
      await page().evaluate(() => (window as any).app.vault.setConfig('nativeMenus', false));
      await send('Use your Edit tool to replace the first line of [[Ideas]] with "# Ideas, revised". Then use it again to replace that line with "# Ideas, revised twice". Then reply with: Done.');
      await page().waitForSelector('.yami-composer.has-approval', { timeout: 90_000 });
      await page().click('.yami-chip:has(.yami-chip-label:text-is("Ask first"))');
      await page().click('.menu .menu-item:has-text("Accept edits")');
      await idle();
      expect(await page().$('.yami-composer.has-approval')).toBeNull();
      expect(readFileSync(path.join(obsidian.vault, 'Ideas.md'), 'utf8').split('\n')[0]).toBe('# Ideas, revised twice');
      expect(await obsidian.waitForNote(chat, () => true)).toContain('\napproval: accept-edits\n');
      expect(await page().$('.yami-chip-label:text-is("Accept edits")')).not.toBeNull();
    });

    it('ends the conversation and keeps the note as a record', { timeout: TIMEOUT }, async () => {
      const chat = await activePath();
      await page().evaluate((file) => {
        const app = (window as any).app;
        app.workspace.setActiveLeaf(app.workspace.getLeavesOfType('markdown').find((l: any) => l.view.file?.path === file), { focus: true });
      }, chat);
      await page().focus('.yami-composer textarea');
      await page().keyboard.type('/end');
      await page().keyboard.press('Escape');
      await page().keyboard.press('Enter');
      await page().waitForSelector('.yami-composer.is-ended', { timeout: 10_000 });
      expect(await obsidian.waitForNote(chat, (text) => text.includes('status: ended'), 5000)).toContain('status: ended');
      await shot('ended');
    });

    it('talks to Codex in a Codex conversation', { timeout: TIMEOUT }, async () => {
      await newConversation('duet:new-chat-codex');
      await send('Reply with exactly the word: kiwi');
      await idle();
      const text = await obsidian.waitForNote(await activePath(), () => true);
      expect(text).toMatch(/^---\ntype: conversation\nagent: codex\n/);
      expect(text).toMatch(/\nkiwi\.?\n\n$/i);
    });

    it('starts a conversation for another plugin through the API', { timeout: TIMEOUT }, async () => {
      const result = await page().evaluate(async () => {
        const app = (window as any).app;
        const api = app.plugins.getPlugin('duet').api;
        const { path } = await api.newConversation({ message: 'Reply with exactly the word: plum', title: 'From another plugin', folder: 'Agents' });
        const working = api.conversationStatus(path);
        const turn = await new Promise((resolve) => {
          const stop = api.onTurnEnd(path, (ended: unknown) => {
            stop();
            resolve(ended);
          });
        });
        return { version: api.version, path, working, turn, after: api.conversationStatus(path), active: app.workspace.getActiveFile()?.path };
      });
      expect(result).toEqual({
        version: 1,
        path: 'Agents/From another plugin.md',
        working: 'working',
        turn: { path: 'Agents/From another plugin.md', status: 'completed', text: expect.stringMatching(/plum/i) },
        after: 'active',
        active: 'Agents/From another plugin.md',
      });
      const text = await obsidian.waitForNote(result.path, () => true);
      expect(text).toMatch(/^---\ntype: conversation\nagent: claude\n/);
      expect(text).toContain('> [!user]\n> Reply with exactly the word: plum');
      expect(text).toMatch(/\nplum\.?\n\n$/i);
    });
  });

  describe('settings', () => {
    const tags = () => page().evaluate(() => (window as any).app.plugins.plugins.duet.settings.profiles.map((p: { name: string }) => p.name) as string[]);

    it('adds, renames and removes an agent in the settings window', { timeout: TIMEOUT }, async () => {
      // Obsidian opens its settings in a separate window.
      const opened = page().context().waitForEvent('page', { timeout: 10_000 });
      await page().evaluate(() => {
        const setting = (window as any).app.setting;
        setting.open();
        setting.openTabById('duet');
      });
      const win = await opened;
      try {
        await win.getByText('Add agent', { exact: true }).click();
        await expect.poll(tags).toEqual(['claude', 'codex', 'agent2']);

        // Typing a tag keeps the focus. The heading follows when the field loses it.
        const tag = win.locator('.setting-item:has(.setting-item-name:text-is("Tag")) input').nth(2);
        await tag.click();
        await tag.press('Meta+a');
        await win.keyboard.type('work', { delay: 60 });
        await expect.poll(tags).toEqual(['claude', 'codex', 'work']);
        await win.keyboard.press('Tab');
        await win.getByText('@work', { exact: true }).waitFor({ timeout: 5000 });

        await win.locator('[aria-label="Remove @work"]').click();
        await expect.poll(tags).toEqual(['claude', 'codex']);
      } finally {
        await page().evaluate(() => (window as any).app.setting.close());
      }
    });
  });
});

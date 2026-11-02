// Captures the README images in a separate Obsidian, with real Claude Code sessions.
// Run `npm run plugin:build` first. The agents reply differently each run, so check the images before you commit them.
//   npm run screenshots
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { CDPSession, Page } from 'playwright-core';
import { launchObsidian, openAtEnd } from '../../test/obsidian/harness.ts';

const OUT = 'docs/images';
const WINDOW = { width: 1280, height: 800 };
/** Width of the saved PNGs. The window renders at twice its size on a Retina display. */
const PNG_WIDTH = 1600;
const GIF_WIDTH = 880;

const obsidian = await launchObsidian({ vault: 'scripts/screenshots/vault' });
const page = obsidian.page;
await mkdir(OUT, { recursive: true });

try {
  await prepare();
  await mentionEdit();
  await lens();
  await mentionReply();
  await conversation();
} finally {
  await obsidian.close();
}

/** A dark theme, a fixed window size, and no inline title, sync icon or right sidebar. */
async function prepare(): Promise<void> {
  await page.evaluate(({ width, height }) => {
    const w = window as any;
    w.require('@electron/remote').getCurrentWindow().setSize(width, height);
    const app = w.app;
    app.changeTheme('obsidian');
    app.vault.setConfig('showInlineTitle', false);
    app.workspace.rightSplit.collapse();
    app.workspace.leftSplit.setSize(250);
    const style = document.head.appendChild(document.createElement('style'));
    style.textContent = '.status-bar-item.plugin-sync { display: none; }';
  }, WINDOW);
  await page.waitForTimeout(800);
}

/** A GIF of a mention that edits the note. */
async function mentionEdit(): Promise<void> {
  await openAtEnd(page, 'Trip to Lisbon.md');
  await parkPointer();
  const recording = await record();
  await mention('@claude Clean this up: fix the spelling and capitalization, and make each line a bullet', 30);
  await page.waitForSelector('.duet-caret', { timeout: 30_000 });
  await page.waitForTimeout(1500);
  recording.pause();
  await page.waitForSelector('.duet-fresh', { timeout: 120_000 });
  recording.resume();
  await idle();
  await page.waitForTimeout(2500);
  await recording.save('mention-edit', '.workspace-leaf.mod-active');
}

/** The contribution lens on the note that the agent just edited. */
async function lens(): Promise<void> {
  await page.evaluate(() => (window as any).app.commands.executeCommandById('duet:toggle-lens'));
  await page.waitForSelector('.duet-lens');
  await page.waitForTimeout(500);
  await shot('lens');
  await page.evaluate(() => (window as any).app.commands.executeCommandById('duet:toggle-lens'));
  await page.waitForSelector('.duet-lens', { state: 'detached' });
}

/** A mention that answers in a callout. */
async function mentionReply(): Promise<void> {
  await openAtEnd(page, 'Meetings/2026-10-02 Standup.md');
  await mention('@claude List the action items with their owners');
  await idle();
  await shot('mention-reply');
}

/** A conversation note, then an approval and a live edit of an open note. */
async function conversation(): Promise<void> {
  await page.evaluate(() => (window as any).app.commands.executeCommandById('duet:new-conversation-claude'));
  await page.waitForSelector('.duet-composer textarea', { timeout: 15_000 });
  await send('Read [[Reading list]] and suggest three books that go well with what I am reading now. One line each on why.');
  await idle();
  await shot('conversation');

  // Open the reading list next to the conversation, with the file list closed to make room.
  await page.evaluate(async () => {
    const app = (window as any).app;
    app.workspace.leftSplit.collapse();
    const chat = app.workspace.activeLeaf;
    const leaf = app.workspace.getLeaf('split', 'vertical');
    await leaf.openFile(app.vault.getAbstractFileByPath('Reading list.md'), { state: { mode: 'source' } });
    app.workspace.setActiveLeaf(chat, { focus: true });
  });
  await send('Add your three suggestions to the Up next section of [[Reading list]].');
  await page.waitForSelector('.duet-composer.has-approval', { timeout: 120_000 });
  await page.waitForTimeout(500);
  await shot('approval');
  await page.focus('.duet-composer textarea');
  await page.keyboard.press('y');
  await page.waitForSelector('.duet-fresh', { timeout: 120_000 });
  await page.waitForTimeout(1200);
  await agentFlagShown();
  await shot('conversation-edit');
  await idle();
}

/** Waits until the agent's name flag shows in full, next to text that it just wrote. */
async function agentFlagShown(): Promise<void> {
  await page.waitForFunction(
    () => {
      const flag = document.querySelector('.duet-caret-flag');
      return !!flag && !!document.querySelector('.duet-fresh') && flag.getAnimations().length === 0;
    },
    undefined,
    { timeout: 30_000, polling: 50 },
  );
}

/** Writes a mention on the current line and waits until the agent starts. */
async function mention(line: string, delay = 0): Promise<void> {
  await page.keyboard.type(line, { delay });
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => (window as any).app.plugins.plugins.duet.mentions.working.length > 0, undefined, { timeout: 10_000 });
}

async function send(message: string): Promise<void> {
  await page.focus('.duet-composer textarea');
  await page.keyboard.type(message);
  await page.keyboard.press('Enter');
  await page.waitForSelector('.duet-composer.is-working', { timeout: 10_000 });
}

/** Waits until no agent works and its cursors are gone. */
async function idle(): Promise<void> {
  await page.waitForFunction(
    () => {
      const plugin = (window as any).app.plugins.plugins.duet;
      return plugin.mentions.working.length === 0 && plugin.conversations.working.length === 0;
    },
    undefined,
    { timeout: 240_000, polling: 250 },
  );
  await page.waitForFunction(() => !document.querySelector('.duet-caret'), undefined, { timeout: 10_000 });
  await page.waitForTimeout(300);
}

/** Moves the pointer to the empty right margin, so no block shows its hover state. */
async function parkPointer(): Promise<void> {
  await page.mouse.move(WINDOW.width - 8, WINDOW.height / 2);
  await page.waitForTimeout(200);
}

async function shot(name: string): Promise<void> {
  await parkPointer();
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file });
  execFileSync('sips', ['--resampleWidth', String(PNG_WIDTH), file], { stdio: 'ignore' });
  console.log(`Saved ${file}`);
}

interface Recording {
  pause(): void;
  resume(): void;
  /** Stops the recording and writes a GIF of the element that `selector` finds. */
  save(name: string, selector: string): Promise<void>;
}

/** Records the window with the DevTools screencast. A pause leaves out the frames until `resume`. */
async function record(): Promise<Recording> {
  const dir = await mkdtemp(path.join(tmpdir(), 'duet-gif-'));
  const cdp: CDPSession = await page.context().newCDPSession(page);
  const frames: { file: string; time: number }[] = [];
  let paused = false;
  let shift = 0;
  let pausedAt = 0;
  cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
    void cdp.send('Page.screencastFrameAck', { sessionId });
    if (paused || metadata.timestamp === undefined) return;
    const file = path.join(dir, `${String(frames.length).padStart(5, '0')}.jpg`);
    frames.push({ file, time: metadata.timestamp - shift });
    void writeFile(file, Buffer.from(data, 'base64'));
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: WINDOW.width, maxHeight: WINDOW.height });
  return {
    pause() {
      paused = true;
      pausedAt = Date.now() / 1000;
    },
    resume() {
      shift += Date.now() / 1000 - pausedAt - 0.4;
      paused = false;
    },
    async save(name, selector) {
      await cdp.send('Page.stopScreencast');
      await page.waitForTimeout(300);
      const box = await elementBox(page, selector);
      const list = frames.map((frame, index) => {
        const next = frames[index + 1]?.time ?? frame.time + 1;
        return `file '${frame.file}'\nduration ${Math.max(next - frame.time, 0.02).toFixed(3)}`;
      });
      const listFile = path.join(dir, 'frames.txt');
      await writeFile(listFile, `${list.join('\n')}\nfile '${frames.at(-1)!.file}'\n`);
      const crop = `crop=${box.width}:${box.height}:${box.x}:${box.y}`;
      const filter = `scale=${WINDOW.width}:${WINDOW.height},${crop},fps=15,scale=${GIF_WIDTH}:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`;
      const file = path.join(OUT, `${name}.gif`);
      execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listFile, '-vf', filter, '-loop', '0', file]);
      await rm(dir, { recursive: true, force: true });
      console.log(`Saved ${file}`);
    },
  };
}

async function elementBox(page: Page, selector: string): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error(`No element for ${selector}`);
  const even = (value: number) => Math.round(value / 2) * 2;
  return { x: even(box.x), y: even(box.y), width: even(box.width), height: even(box.height) };
}

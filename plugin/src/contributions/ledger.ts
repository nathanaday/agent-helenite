import { type App, normalizePath, type Plugin, TFile } from 'obsidian';
import { applyOps, diffOps } from 'yami/document';
import type { CollabHub, DiskWriter, HubObserver, NoteChange, SharedNote } from 'yami/obsidian';
import { applyChange, type Contributions, mapSpans, reconcile, type Span } from './spans.ts';

/** Folder of the ledger files, in the vault. One JSON file for each note, at the note's path. */
export const LEDGER_FOLDER = '.duet/contributions';
const VERSION = 1;
const SAVE_DELAY_MS = 1000;

interface LedgerFile {
  version: number;
  /** The note text that the spans refer to. */
  text: string;
  spans: Span[];
}

/** A shared note that the ledger follows: the text that its queued changes apply to, and the record's queue. */
interface SharedEntry {
  text: string;
  live: boolean;
  queue: Promise<NoteRecord | undefined>;
}

class NoteRecord {
  /** Shared notes that change the record now. Only they may move its spans. */
  attached = 0;

  constructor(
    public path: string,
    public contributions: Contributions,
  ) {}
}

export function ledgerPath(notePath: string): string {
  return normalizePath(`${LEDGER_FOLDER}/${notePath}.json`);
}

/**
 * Records which text of each note a Duet agent wrote. The record of a shared note follows every change
 * exactly. Changes that Duet does not see, for example while Obsidian is closed, are found by comparing
 * the stored text with the note text the next time the record is read.
 */
export class ContributionLedger implements HubObserver {
  private readonly records = new Map<string, Promise<NoteRecord | undefined>>();
  private readonly saves = new Map<NoteRecord, number>();
  private readonly listeners = new Set<(path: string) => void>();
  private readonly attached = new Map<SharedNote, SharedEntry>();

  constructor(
    private readonly app: App,
    private readonly hub: CollabHub,
  ) {}

  install(plugin: Plugin): void {
    plugin.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        if (file instanceof TFile) void this.rename(oldPath, file.path);
      }),
    );
    plugin.registerEvent(
      this.app.vault.on('delete', (file) => {
        if (file instanceof TFile) void this.remove(file.path);
      }),
    );
  }

  /** Calls `listener` with a note's path after its contributions change. */
  onChange(listener: (path: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The agent spans of a note whose text is `text`. */
  async spans(path: string, text: string): Promise<Span[]> {
    const record = await this.load(path);
    if (!record) return [];
    // A shared note moves the spans itself. Map them for this caller without changing the record.
    if (record.attached) return mapSpans(record.contributions.spans, diffOps(record.contributions.text, text));
    if (record.contributions.text !== text) {
      record.contributions = reconcile(record.contributions, text, diffOps);
      this.scheduleSave(record);
    }
    return record.contributions.spans;
  }

  /** Records the changes of a shared note until the returned function runs. */
  shared(note: SharedNote): () => void {
    // The queued changes apply to the text at this moment, so the record catches up to it first.
    const text = note.content;
    const entry: SharedEntry = {
      text,
      live: true,
      queue: this.load(note.path).then((record) => {
        if (record) {
          record.attached++;
          record.contributions = reconcile(record.contributions, text, diffOps);
        }
        return record;
      }),
    };
    this.attached.set(note, entry);
    return () => {
      this.attached.delete(note);
      entry.live = false;
      entry.queue = entry.queue.then((record) => {
        if (record) record.attached = Math.max(0, record.attached - 1);
        return record;
      });
    };
  }

  changed({ path, ops, agent }: NoteChange): void {
    // library-loop: F1.2
    const note = this.hub.get(path);
    const entry = note && this.attached.get(note);
    if (!entry || !ops.length) return;
    const before = entry.text;
    entry.text = applyOps(before, ops);
    const author = agent && { name: agent.name, time: new Date().toISOString() };
    entry.queue = entry.queue.then((found) => {
      if (!found && !author) return found;
      const record = found ?? this.add(path, { text: before, spans: [] }, entry.live);
      record.contributions = applyChange(record.contributions, ops, author);
      this.recorded(record);
      return record;
    });
  }

  /** A note that an agent created with its own tools is the agent's from the start. */
  created(file: TFile, text: string, writer: DiskWriter): void {
    if (!text) return;
    const record = this.add(file.path, { text, spans: [{ from: 0, to: text.length, agent: writer.name, time: new Date().toISOString() }] }, false);
    this.recorded(record);
  }

  /** Writes the records that wait to be saved. */
  async flush(): Promise<void> {
    const pending = [...this.saves];
    this.saves.clear();
    for (const [record, timer] of pending) {
      window.clearTimeout(timer);
      await this.save(record);
    }
  }

  private add(path: string, contributions: Contributions, attached: boolean): NoteRecord {
    const record = new NoteRecord(path, contributions);
    if (attached) record.attached = 1;
    this.records.set(path, Promise.resolve(record));
    return record;
  }

  private recorded(record: NoteRecord): void {
    this.scheduleSave(record);
    for (const listener of this.listeners) listener(record.path);
  }

  private load(path: string): Promise<NoteRecord | undefined> {
    let record = this.records.get(path);
    if (!record) {
      record = this.read(path);
      this.records.set(path, record);
    }
    return record;
  }

  private async read(path: string): Promise<NoteRecord | undefined> {
    const adapter = this.app.vault.adapter;
    const file = ledgerPath(path);
    try {
      if (!(await adapter.exists(file))) return undefined;
      const data = JSON.parse(await adapter.read(file)) as Partial<LedgerFile>;
      if (data.version !== VERSION || typeof data.text !== 'string' || !Array.isArray(data.spans)) return undefined;
      const spans = data.spans.filter(
        (span): span is Span =>
          Number.isInteger(span.from) && Number.isInteger(span.to) && span.from >= 0 && span.to > span.from && span.to <= data.text!.length && typeof span.agent === 'string',
      );
      return new NoteRecord(path, { text: data.text, spans });
    } catch (error) {
      console.error(`Duet: could not read the contributions of ${path}`, error);
      return undefined;
    }
  }

  private scheduleSave(record: NoteRecord): void {
    window.clearTimeout(this.saves.get(record));
    this.saves.set(
      record,
      window.setTimeout(() => {
        this.saves.delete(record);
        void this.save(record);
      }, SAVE_DELAY_MS),
    );
  }

  /** Writes a record, or removes its file when no agent text is left. */
  private async save(record: NoteRecord): Promise<void> {
    const adapter = this.app.vault.adapter;
    const file = ledgerPath(record.path);
    try {
      if (!record.contributions.spans.length) {
        if (await adapter.exists(file)) await adapter.remove(file);
        return;
      }
      await this.ensureFolder(file);
      const data: LedgerFile = { version: VERSION, ...record.contributions };
      await adapter.write(file, JSON.stringify(data, null, 1));
    } catch (error) {
      console.error(`Duet: could not save the contributions of ${record.path}`, error);
    }
  }

  private async rename(oldPath: string, newPath: string): Promise<void> {
    const record = await this.load(oldPath);
    this.records.delete(oldPath);
    if (!record) return;
    record.path = newPath;
    this.records.set(newPath, Promise.resolve(record));
    await this.save(record);
    const old = ledgerPath(oldPath);
    if (await this.app.vault.adapter.exists(old)) await this.app.vault.adapter.remove(old);
  }

  private async remove(path: string): Promise<void> {
    const record = await this.records.get(path);
    this.records.delete(path);
    if (record) {
      window.clearTimeout(this.saves.get(record));
      this.saves.delete(record);
    }
    const file = ledgerPath(path);
    if (await this.app.vault.adapter.exists(file)) await this.app.vault.adapter.remove(file);
  }

  private async ensureFolder(file: string): Promise<void> {
    const folder = file.slice(0, file.lastIndexOf('/'));
    if (folder && !(await this.app.vault.adapter.exists(folder))) await this.app.vault.adapter.mkdir(folder);
  }
}

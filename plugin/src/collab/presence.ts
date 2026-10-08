import { EditorSelection, type Extension, RangeSet, StateEffect, StateField } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  layer,
  type LayerMarker,
  RectangleMarker,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view';
import * as Y from 'yjs';
import { AgentPeer } from './agent-peer.ts';
import { EditorBinding, presenceAnnotation, syncAnnotation } from './binding.ts';
import type { PresenceState, SharedNote } from './shared-note.ts';

interface Agent {
  id: number;
  state: PresenceState;
  anchor: number;
  head: number;
}

/** Agents in the editor's shared note that have a cursor. */
function agents(view: EditorView): Agent[] {
  const note = EditorBinding.of(view)?.note;
  if (!note) return [];
  const result: Agent[] = [];
  for (const [id, state] of note.presence.getStates() as Map<number, PresenceState>) {
    if (id === note.doc.clientID || !state?.cursor) continue;
    const anchor = resolve(note, state.cursor.anchor);
    const head = resolve(note, state.cursor.head);
    if (anchor === undefined || head === undefined) continue;
    const length = view.state.doc.length;
    result.push({ id, state, anchor: Math.min(anchor, length), head: Math.min(head, length) });
  }
  return result;
}

function resolve(note: SharedNote, json: unknown): number | undefined {
  return note.absolute(Y.createRelativePositionFromJSON(json));
}

/**
 * Live Preview shows some Markdown, such as a callout, as a rendered widget. CodeMirror then places a
 * position inside it at the widget's edge. The agent writes at the end of such a block, so the caret
 * goes after the last rendered text in the widget.
 */
function widgetCoords(view: EditorView, position: number): { left: number; top: number; bottom: number } | undefined {
  let widget: Element | undefined;
  for (const element of view.contentDOM.querySelectorAll('.cm-embed-block')) {
    const block = view.lineBlockAt(view.posAtDOM(element));
    if (block.from <= position && position <= block.to) widget = element;
  }
  if (!widget) return undefined;
  const walker = document.createTreeWalker(widget, NodeFilter.SHOW_TEXT, {
    acceptNode: (text) => (text.textContent?.trim() && !text.parentElement?.closest('.callout-title, .edit-block-button') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP),
  });
  let last: Node | null = null;
  for (let text = walker.nextNode(); text; text = walker.nextNode()) last = text;
  if (!last) {
    const title = widget.querySelector('.callout-title-inner') ?? widget;
    const rect = title.getBoundingClientRect();
    return { left: rect.right + 4, top: rect.top, bottom: rect.bottom };
  }
  const range = document.createRange();
  range.setStart(last, last.textContent!.length);
  range.collapse(true);
  const rect = [...range.getClientRects()].at(-1);
  return rect ? { left: rect.left, top: rect.top, bottom: rect.bottom } : undefined;
}

/** Position of layer markers: document coordinates relative to the scroller. */
function base(view: EditorView) {
  const rect = view.scrollDOM.getBoundingClientRect();
  return { left: rect.left - view.scrollDOM.scrollLeft * view.scaleX, top: rect.top - view.scrollDOM.scrollTop * view.scaleY };
}

/** The agent's caret and name flag. The element moves with a CSS transition, so the caret glides. */
class CaretMarker implements LayerMarker {
  constructor(
    readonly id: number,
    readonly left: number,
    readonly top: number,
    readonly height: number,
    readonly state: PresenceState,
    /** The right edge of the text area, in the same coordinates as `left`. */
    readonly right: number,
  ) {}

  draw(): HTMLElement {
    const dom = createDiv({ cls: 'duet-caret' });
    const flag = dom.createDiv({ cls: 'duet-caret-flag' });
    flag.createSpan({ cls: 'duet-caret-name' });
    flag.createSpan({ cls: 'duet-caret-status' });
    this.write(dom);
    return dom;
  }

  update(dom: HTMLElement, previous: LayerMarker): boolean {
    if (!(previous instanceof CaretMarker) || previous.id !== this.id) return false;
    this.write(dom);
    return true;
  }

  eq(other: LayerMarker): boolean {
    return (
      other instanceof CaretMarker &&
      other.id === this.id &&
      other.left === this.left &&
      other.top === this.top &&
      other.height === this.height &&
      other.state.status === this.state.status &&
      other.state.name === this.state.name
    );
  }

  private write(dom: HTMLElement): void {
    dom.style.transform = `translate(${this.left}px, ${this.top}px)`;
    dom.style.height = `${this.height}px`;
    dom.style.setProperty('--duet-agent', this.state.color);
    dom.classList.toggle('is-near-top', this.top < 28);
    dom.classList.toggle('is-near-right', this.left > this.right - 180);
    dom.classList.toggle('has-status', Boolean(this.state.status));
    const flag = dom.firstElementChild!;
    flag.children[0]!.textContent = this.state.name;
    flag.children[1]!.textContent = this.state.status ?? '';
  }
}

/** One rectangle of an agent's selection, tinted with the agent's color. */
class TintMarker implements LayerMarker {
  constructor(
    readonly rect: RectangleMarker,
    readonly color: string,
  ) {}

  draw(): HTMLElement {
    const dom = this.rect.draw();
    dom.style.setProperty('--duet-agent', this.color);
    return dom;
  }

  update(dom: HTMLElement, previous: LayerMarker): boolean {
    if (!(previous instanceof TintMarker)) return false;
    dom.style.setProperty('--duet-agent', this.color);
    return this.rect.update(dom, previous.rect);
  }

  eq(other: LayerMarker): boolean {
    return other instanceof TintMarker && other.color === this.color && this.rect.eq(other.rect);
  }
}

const presenceLayer = layer({
  above: true,
  class: 'duet-presence',
  update: (update) =>
    update.docChanged ||
    update.viewportChanged ||
    update.geometryChanged ||
    update.transactions.some((transaction) => transaction.annotation(presenceAnnotation)),
  markers(view) {
    const markers: LayerMarker[] = [];
    const { from, to } = view.viewport;
    for (const agent of agents(view)) {
      if (agent.anchor !== agent.head) {
        const range = EditorSelection.range(agent.anchor, agent.head);
        for (const rect of RectangleMarker.forRange(view, 'duet-agent-selection', range)) {
          markers.push(new TintMarker(rect, agent.state.color));
        }
      }
      if (agent.head < from || agent.head > to) continue;
      const coords = widgetCoords(view, agent.head) ?? view.coordsAtPos(agent.head, agent.anchor > agent.head ? 1 : -1);
      if (!coords) continue;
      const origin = base(view);
      markers.push(
        new CaretMarker(
          agent.id,
          (coords.left - origin.left) / view.scaleX,
          (coords.top - origin.top) / view.scaleY,
          (coords.bottom - coords.top) / view.scaleY,
          agent.state,
          (view.contentDOM.getBoundingClientRect().right - origin.left) / view.scaleX,
        ),
      );
    }
    return markers;
  },
});

/** A pill at the top or bottom edge of the editor when an agent works outside the visible part. Click it to scroll there. */
const edgeIndicator = ViewPlugin.fromClass(
  class {
    private readonly dom: HTMLElement;
    private target: number | undefined;

    constructor(private readonly view: EditorView) {
      this.dom = view.dom.createEl('button', { cls: 'duet-edge' });
      this.dom.addEventListener('mousedown', (event) => {
        event.preventDefault();
        if (this.target !== undefined) view.dispatch({ effects: EditorView.scrollIntoView(this.target, { y: 'center' }) });
      });
      view.scrollDOM.addEventListener('scroll', this.onScroll, { passive: true });
      this.measure();
    }

    update(update: ViewUpdate): void {
      if (update.docChanged || update.viewportChanged || update.geometryChanged || update.transactions.some((tr) => tr.annotation(presenceAnnotation))) {
        this.measure();
      }
    }

    destroy(): void {
      this.view.scrollDOM.removeEventListener('scroll', this.onScroll);
      this.dom.remove();
    }

    private measure(): void {
      this.view.requestMeasure({ key: this, read: (view) => this.find(view), write: (found) => this.show(found) });
    }

    // A scroll reads and writes the pill directly. A requested measure would run CodeMirror's scroll-anchor
    // correction, which holds the scroll in place while CodeMirror counts the editor as out of view.
    private readonly onScroll = (): void => this.show(this.find(this.view));

    private find(view: EditorView): { agent: Agent; edge: 'top' | 'bottom' } | undefined {
      const working = agents(view);
      if (!working.length) return undefined;
      const scroller = view.scrollDOM.getBoundingClientRect();
      for (const agent of working) {
        const block = view.lineBlockAt(agent.head);
        const top = view.documentTop + block.top;
        const bottom = view.documentTop + block.bottom;
        if (bottom < scroller.top + 8) return { agent, edge: 'top' };
        if (top > scroller.bottom - 8) return { agent, edge: 'bottom' };
      }
      return undefined;
    }

    private show(found: { agent: Agent; edge: 'top' | 'bottom' } | undefined): void {
      this.target = found?.agent.head;
      this.dom.classList.toggle('is-shown', Boolean(found));
      if (!found) return;
      const { state } = found.agent;
      this.dom.dataset.edge = found.edge;
      this.dom.style.setProperty('--duet-agent', state.color);
      this.dom.textContent = `${state.name} ${state.status ? `· ${state.status}` : 'is editing'} ${found.edge === 'top' ? '↑' : '↓'}`;
    }
  },
);

const FRESH_MS = 1200;
const FADE_MS = 1000;

interface FreshSpec {
  color: string;
  at: number;
}

const ageFresh = StateEffect.define<number>();

/** Highlights text that an agent just wrote. The highlight fades out after a moment. */
const freshField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decorations, transaction) {
    decorations = decorations.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (!effect.is(ageFresh)) continue;
      const now = effect.value;
      const kept: ReturnType<Decoration['range']>[] = [];
      const cursor = decorations.iter();
      for (; cursor.value; cursor.next()) {
        const spec = (cursor.value.spec as { fresh: FreshSpec }).fresh;
        const age = now - spec.at;
        if (age >= FRESH_MS + FADE_MS) continue;
        kept.push(freshMark(spec, age >= FRESH_MS).range(cursor.from, cursor.to));
      }
      decorations = RangeSet.of(kept, true);
    }
    const origin = transaction.annotation(syncAnnotation);
    if (!(origin instanceof AgentPeer) || !transaction.docChanged) return decorations;
    const spec: FreshSpec = { color: origin.identity.color, at: Date.now() };
    const added: ReturnType<Decoration['range']>[] = [];
    transaction.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
      if (toB > fromB) added.push(freshMark(spec, false).range(fromB, toB));
    });
    return added.length ? decorations.update({ add: added, sort: true }) : decorations;
  },
  provide: (field) => EditorView.decorations.from(field),
});

function freshMark(spec: FreshSpec, fading: boolean): Decoration {
  return Decoration.mark({
    class: fading ? 'duet-fresh is-fading' : 'duet-fresh',
    attributes: { style: `--duet-agent: ${spec.color}` },
    fresh: spec,
  });
}

const freshTimer = ViewPlugin.fromClass(
  class {
    private timer: number | undefined;

    constructor(private readonly view: EditorView) {}

    update(update: ViewUpdate): void {
      if (this.timer === undefined && update.state.field(freshField).size) {
        this.timer = window.setTimeout(this.tick, 250);
      }
    }

    destroy(): void {
      window.clearTimeout(this.timer);
    }

    private readonly tick = (): void => {
      this.timer = undefined;
      if (this.view.state.field(freshField).size) this.view.dispatch({ effects: ageFresh.of(Date.now()) });
    };
  },
);

export const presenceExtensions: Extension = [presenceLayer, edgeIndicator, freshField, freshTimer];

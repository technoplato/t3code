import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  clientViewFor,
  observeClientView,
  readTimelineView,
  viewThread,
} from "./clientViewReporter.ts";

const OWNER = EnvironmentId.make("environment-owner");
const OTHER = EnvironmentId.make("environment-other");
const THREAD = ThreadId.make("thread-1");

interface FakeRow {
  readonly id: string;
  readonly kind?: string;
  top: number;
  bottom: number;
}

/** A timeline scroll node as the reporter reads it: row rects, containment and the selection. */
function fakeTimeline(rows: FakeRow[], viewport = { top: 100, bottom: 500 }) {
  const rowElements = rows.map((row) => {
    const element = {
      dataset: { viewItemId: row.id, viewItemKind: row.kind },
      getBoundingClientRect: () => ({ top: row.top, bottom: row.bottom }),
      closest: (): object => element,
    };
    return element;
  });
  const state: { selection: unknown } = { selection: null };
  const scrollNode = {
    getBoundingClientRect: () => viewport,
    querySelectorAll: () => rowElements,
    contains: (node: unknown) => node === scrollNode || rowElements.includes(node as never),
    ownerDocument: { getSelection: () => state.selection },
  };
  const select = (text: string, container: unknown, start: unknown = container) => {
    state.selection = {
      isCollapsed: text.length === 0,
      rangeCount: 1,
      getRangeAt: () => ({ commonAncestorContainer: container, startContainer: start }),
      toString: () => text,
    };
  };
  return { scrollNode: scrollNode as unknown as HTMLElement, rowElements, select };
}

describe("readTimelineView", () => {
  it("measures each row against the scroll node", () => {
    const { scrollNode } = fakeTimeline([
      { id: "message-above", top: -300, bottom: 50 },
      { id: "message-long", kind: "assistant", top: -700, bottom: 300 },
      { id: "tool-1", kind: "tool", top: 300, bottom: 340 },
      { id: "message-next", kind: "user", top: 340, bottom: 740 },
    ]);
    expect(readTimelineView(scrollNode)).toEqual({
      items: [
        { id: "message-long", kind: "assistant", from: 0.8, to: 1 },
        { id: "tool-1", kind: "tool", from: 0, to: 1 },
        { id: "message-next", kind: "user", from: 0, to: 0.4 },
      ],
    });
  });

  it("reads a selection inside the timeline and never one outside it", () => {
    const { scrollNode, rowElements, select } = fakeTimeline([
      { id: "message-1", top: 100, bottom: 300 },
    ]);
    select("quoted words", rowElements[0]);
    expect(readTimelineView(scrollNode).selection).toEqual({
      itemId: "message-1",
      text: "quoted words",
    });

    // As when the selection is in the composer, or runs from the timeline into it.
    select("an unsent draft", { closest: () => null });
    expect(readTimelineView(scrollNode).selection).toBeUndefined();
  });
});

function setup() {
  const windowEvents = new EventTarget();
  const documentEvents = new EventTarget();
  const timers: Array<{ readonly run: () => void; readonly delayMs: number }> = [];
  const storage = new Map<string, string>();
  vi.stubGlobal("window", {
    addEventListener: windowEvents.addEventListener.bind(windowEvents),
    removeEventListener: windowEvents.removeEventListener.bind(windowEvents),
    setTimeout: (run: () => void, delayMs: number) => timers.push({ run, delayMs }),
    clearTimeout: (id: number) => {
      timers[id - 1] = { run: () => undefined, delayMs: -1 };
    },
    sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
  });
  let selectionCollapsed = true;
  vi.stubGlobal("document", {
    addEventListener: documentEvents.addEventListener.bind(documentEvents),
    removeEventListener: documentEvents.removeEventListener.bind(documentEvents),
    hasFocus: () => true,
    getSelection: () => ({ isCollapsed: selectionCollapsed }),
  });
  let nowMs = 1_000;
  let changes = 0;
  const stop = observeClientView({
    nowMs: () => nowMs,
    onChange: () => {
      changes += 1;
    },
  });
  return {
    storage,
    /** Runs the timers armed so far, as the delays they asked for pass. */
    runTimers: () => {
      const due = timers.splice(0);
      for (const timer of due) timer.run();
      return due.filter((timer) => timer.delayMs >= 0).map((timer) => timer.delayMs);
    },
    at: (ms: number) => {
      nowMs = ms;
    },
    changes: () => changes,
    window: windowEvents,
    document: documentEvents,
    [Symbol.dispose]: () => {
      stop();
      vi.unstubAllGlobals();
    },
  };
}

describe("observeClientView", () => {
  it("reports the viewed thread's rows to its own environment only", () => {
    using page = setup();
    const { scrollNode } = fakeTimeline([{ id: "message-1", kind: "user", top: 100, bottom: 300 }]);
    const stopViewing = viewThread({ environmentId: OWNER, threadId: THREAD }, () => scrollNode);
    expect(page.runTimers()).toEqual([0]);
    expect(page.changes()).toBe(1);

    const owner = clientViewFor(OWNER);
    expect(owner).toMatchObject({
      environmentId: OWNER,
      threadId: THREAD,
      focused: true,
      lastGestureAtMs: 1_000,
      items: [{ id: "message-1", kind: "user", from: 0, to: 1 }],
    });
    expect(owner?.windowId).toBe(page.storage.get("t3.clientView.windowId"));
    const other = clientViewFor(OTHER);
    expect(other).toMatchObject({ windowId: owner?.windowId, threadId: THREAD });
    expect(other).not.toHaveProperty("items");
    expect(other).not.toHaveProperty("selection");

    stopViewing();
    page.runTimers();
    expect(clientViewFor(OWNER)).toBeUndefined();
  });

  it("looks again after a scroll inside the timeline, without calling it a gesture", () => {
    using page = setup();
    const row: FakeRow = { id: "message-1", top: 100, bottom: 500 };
    const { scrollNode, rowElements } = fakeTimeline([row]);
    using _viewing = {
      [Symbol.dispose]: viewThread({ environmentId: OWNER, threadId: THREAD }, () => scrollNode),
    };
    page.runTimers();
    page.runTimers();
    const before = clientViewFor(OWNER);

    // A reply streaming in pushes the row up; nobody touched anything.
    page.at(9_000);
    row.top = -300;
    row.bottom = 100.5;
    const elsewhere = new Event("scroll");
    Object.defineProperty(elsewhere, "target", { value: {} });
    page.document.dispatchEvent(elsewhere);
    expect(page.runTimers()).toEqual([]);

    const inTimeline = new Event("scroll");
    Object.defineProperty(inTimeline, "target", { value: rowElements[0] });
    page.document.dispatchEvent(inTimeline);
    expect(page.runTimers()).toEqual([750]);
    const after = clientViewFor(OWNER);
    expect(after?.items).toEqual([]);
    expect(after?.seq).toBe((before?.seq ?? 0) + 1);
    expect(after?.lastGestureAtMs).toBe(before?.lastGestureAtMs);

    // A click is the user's, and moves the gesture time.
    page.at(20_000);
    row.top = 100;
    row.bottom = 500;
    page.window.dispatchEvent(new Event("pointerdown"));
    expect(page.runTimers()).toEqual([750]);
    expect(clientViewFor(OWNER)).toMatchObject({
      lastGestureAtMs: 20_000,
      items: [{ id: "message-1", from: 0, to: 1 }],
    });
  });
});

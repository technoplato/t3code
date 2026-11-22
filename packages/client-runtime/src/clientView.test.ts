import {
  CLIENT_IDENTITY_MAX_TEXT_LENGTH,
  CLIENT_VIEW_MAX_ITEMS,
  ClientActivityIdentity,
  EnvironmentId,
  ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  CLIENT_VIEW_GESTURE_REPORT_INTERVAL_MS,
  CLIENT_VIEW_REPORT_DELAY_MS,
  type ClientViewContent,
  clientActivityIdentity,
  clientViewConnection,
  clientViewSelection,
  makeClientViewTracker,
  visibleViewItems,
} from "./clientView.ts";

const OWNER = EnvironmentId.make("environment-owner");
const OTHER = EnvironmentId.make("environment-other");
const THREAD = ThreadId.make("thread-1");

describe("visibleViewItems", () => {
  it("gives each row the part of it that shows", () => {
    const items = visibleViewItems({ top: 100, bottom: 500 }, [
      { id: "above", top: 0, bottom: 90 },
      { id: "cut-at-top", kind: "assistant", top: 0, bottom: 200 },
      { id: "whole", kind: "user", top: 200, bottom: 300 },
      { id: "cut-at-bottom", top: 300, bottom: 1_100 },
      { id: "below", top: 1_100, bottom: 1_200 },
    ]);
    expect(items).toEqual([
      { id: "cut-at-top", kind: "assistant", from: 0.5, to: 1 },
      { id: "whole", kind: "user", from: 0, to: 1 },
      { id: "cut-at-bottom", from: 0, to: 0.25 },
    ]);
  });

  it("finds the middle of a reply taller than the viewport", () => {
    expect(
      visibleViewItems({ top: 0, bottom: 400 }, [{ id: "long", top: -1_800, bottom: 2_200 }]),
    ).toEqual([{ id: "long", from: 0.45, to: 0.55 }]);
  });

  it("orders top to bottom, drops repeats and empty rows, and stops at the limit", () => {
    const rows = Array.from({ length: CLIENT_VIEW_MAX_ITEMS + 4 }, (_, index) => ({
      id: `row-${index}`,
      top: index * 10,
      bottom: index * 10 + 10,
    }));
    const items = visibleViewItems({ top: 0, bottom: 1_000 }, [
      ...rows.toReversed(),
      { id: "row-0", top: 0, bottom: 10 },
      { id: "collapsed", top: 5, bottom: 5 },
      { id: "sliver", top: -9.5, bottom: 0.5 },
    ]);
    expect(items.map((item) => item.id)).toEqual(
      rows.slice(0, CLIENT_VIEW_MAX_ITEMS).map((row) => row.id),
    );
  });
});

describe("clientViewSelection", () => {
  it("caps the text and skips an empty selection", () => {
    expect(clientViewSelection("  \n", "message-1")).toBeUndefined();
    expect(clientViewSelection("picked", undefined)).toEqual({ text: "picked" });
    expect(clientViewSelection("x".repeat(5_000), "message-1")).toEqual({
      itemId: "message-1",
      text: "x".repeat(2_048),
    });
  });
});

function harness() {
  let nowMs = 1_000_000;
  let pending: { readonly dueAtMs: number; readonly run: () => void } | null = null;
  let content: ClientViewContent = { items: [{ id: "message-1", from: 0, to: 1 }] };
  let focused = true;
  let reads = 0;
  let changes = 0;
  const tracker = makeClientViewTracker({
    windowId: () => "window-1",
    nowMs: () => nowMs,
    setTimer: (run, delayMs) => {
      const timer = { dueAtMs: nowMs + delayMs, run };
      pending = timer;
      return () => {
        if (pending === timer) pending = null;
      };
    },
    readContent: () => {
      reads += 1;
      return content;
    },
    readFocused: () => focused,
    onChange: () => {
      changes += 1;
    },
  });
  return {
    tracker,
    advance: (ms: number) => {
      const end = nowMs + ms;
      while (pending !== null && pending.dueAtMs <= end) {
        const { dueAtMs, run } = pending;
        pending = null;
        nowMs = dueAtMs;
        run();
      }
      nowMs = end;
    },
    show: (next: ClientViewContent) => {
      content = next;
    },
    focus: (next: boolean) => {
      focused = next;
    },
    now: () => nowMs,
    reads: () => reads,
    changes: () => changes,
  };
}

const decodeIdentity = Schema.decodeSync(ClientActivityIdentity);

describe("clientActivityIdentity", () => {
  it("drops blanks and cuts long values, so a report never fails on who sent it", () => {
    const identity = clientActivityIdentity({
      formFactor: "tablet",
      os: " iPadOS ",
      osVersion: null,
      deviceName: "x".repeat(CLIENT_IDENTITY_MAX_TEXT_LENGTH + 40),
      deviceModel: "   ",
      browser: undefined,
      connection: clientViewConnection({ _tag: "RelayConnectionTarget" }),
    });
    expect(identity).toEqual({
      formFactor: "tablet",
      os: "iPadOS",
      deviceName: "x".repeat(CLIENT_IDENTITY_MAX_TEXT_LENGTH),
      connection: "relay",
    });
    expect(decodeIdentity(identity)).toEqual(identity);
  });

  it("names how a client reaches a server", () => {
    expect(clientViewConnection({ _tag: "PrimaryConnectionTarget" }, true)).toBe("local");
    expect(clientViewConnection({ _tag: "PrimaryConnectionTarget" })).toBe("direct");
    expect(clientViewConnection({ _tag: "BearerConnectionTarget" })).toBe("direct");
    expect(clientViewConnection({ _tag: "SshConnectionTarget" })).toBe("ssh");
    expect(clientViewConnection(undefined)).toBeUndefined();
  });
});

describe("makeClientViewTracker", () => {
  it("reports a thread switch at once and looks again once its rows mount", () => {
    const h = harness();
    h.show({ items: [] });
    h.tracker.setThread({ environmentId: OWNER, threadId: THREAD });
    expect(h.tracker.viewFor(OWNER)).toBeUndefined();
    h.advance(0);
    expect(h.changes()).toBe(1);
    expect(h.tracker.viewFor(OWNER)).toMatchObject({ threadId: THREAD, seq: 1, items: [] });

    h.show({ items: [{ id: "message-1", from: 0, to: 1 }] });
    h.advance(CLIENT_VIEW_REPORT_DELAY_MS);
    expect(h.changes()).toBe(2);
    expect(h.tracker.viewFor(OWNER)?.items).toEqual([{ id: "message-1", from: 0, to: 1 }]);
  });

  it("sends one report for a burst of scrolling, and reads the screen once for it", () => {
    const h = harness();
    h.tracker.setThread({ environmentId: OWNER, threadId: THREAD });
    h.advance(CLIENT_VIEW_REPORT_DELAY_MS);
    const [changes, reads] = [h.changes(), h.reads()];

    for (let step = 0; step < 20; step += 1) {
      h.tracker.touch();
      h.show({ items: [{ id: "message-1", from: step / 100, to: 1 }] });
      h.advance(30);
    }
    expect(h.changes()).toBe(changes);
    h.advance(CLIENT_VIEW_REPORT_DELAY_MS);
    expect(h.changes()).toBe(changes + 1);
    expect(h.reads()).toBe(reads + 1);
    expect(h.tracker.viewFor(OWNER)?.items).toEqual([{ id: "message-1", from: 0.19, to: 1 }]);

    // Nothing moved: a touch reads the screen and reports nothing.
    h.tracker.touch();
    h.advance(CLIENT_VIEW_REPORT_DELAY_MS);
    expect(h.changes()).toBe(changes + 1);
  });

  it("moves the gesture time only on a gesture, and reports a gesture alone sparingly", () => {
    const h = harness();
    h.tracker.setThread({ environmentId: OWNER, threadId: THREAD });
    h.advance(CLIENT_VIEW_REPORT_DELAY_MS);
    const gestureAtStart = h.tracker.viewFor(OWNER)?.lastGestureAtMs;
    const seqAtStart = h.tracker.viewFor(OWNER)?.seq ?? 0;

    // A reply streams in: the rows change, the gesture time does not.
    h.tracker.touch();
    h.show({ items: [{ id: "message-2", from: 0, to: 0.4 }] });
    h.advance(CLIENT_VIEW_REPORT_DELAY_MS);
    expect(h.tracker.viewFor(OWNER)).toMatchObject({
      seq: seqAtStart + 1,
      lastGestureAtMs: gestureAtStart,
    });

    // Typing: a gesture every 100ms with nothing on screen changing.
    const sentAtMs = h.now();
    const reads = h.reads();
    for (let key = 0; key < 30; key += 1) {
      h.tracker.recordGesture();
      h.advance(100);
    }
    expect(h.tracker.viewFor(OWNER)?.seq).toBe(seqAtStart + 1);
    expect(h.reads()).toBe(reads);
    h.advance(CLIENT_VIEW_GESTURE_REPORT_INTERVAL_MS);
    const view = h.tracker.viewFor(OWNER);
    expect(view?.seq).toBe(seqAtStart + 2);
    expect(view?.lastGestureAtMs).toBeGreaterThan(sentAtMs);
  });

  it("gives items and selection to the owning environment only", () => {
    const h = harness();
    h.show({
      items: [{ id: "message-1", from: 0, to: 1 }],
      selection: { itemId: "message-1", text: "picked" },
    });
    h.tracker.setThread({ environmentId: OWNER, threadId: THREAD });
    h.advance(0);

    const owner = h.tracker.viewFor(OWNER);
    const other = h.tracker.viewFor(OTHER);
    expect(owner?.selection).toEqual({ itemId: "message-1", text: "picked" });
    expect(other).toEqual({
      windowId: "window-1",
      seq: owner?.seq,
      focused: true,
      lastGestureAtMs: owner?.lastGestureAtMs,
      environmentId: OWNER,
      threadId: THREAD,
    });
  });

  it("reports losing focus at once and leaving the thread as no view", () => {
    const h = harness();
    h.tracker.setThread({ environmentId: OWNER, threadId: THREAD });
    h.advance(CLIENT_VIEW_REPORT_DELAY_MS);
    h.focus(false);
    h.tracker.refresh();
    h.advance(0);
    expect(h.tracker.viewFor(OWNER)?.focused).toBe(false);

    const changes = h.changes();
    h.tracker.setThread(null);
    h.advance(0);
    expect(h.changes()).toBe(changes + 1);
    expect(h.tracker.viewFor(OWNER)).toBeUndefined();
    h.tracker.touch();
    h.tracker.recordGesture();
    h.advance(CLIENT_VIEW_GESTURE_REPORT_INTERVAL_MS);
    expect(h.changes()).toBe(changes + 1);
  });
});

import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  clientViewFor,
  observeClientView,
  recordClientViewGesture,
  touchClientView,
  viewThread,
} from "./client-view";

const OWNER = EnvironmentId.make("environment-owner");
const OTHER = EnvironmentId.make("environment-other");
const THREAD = ThreadId.make("thread-1");

function setup() {
  vi.useFakeTimers();
  let nowMs = 1_000;
  let focused = true;
  let changes = 0;
  const tracking = observeClientView({
    windowId: "launch-1",
    nowMs: () => nowMs,
    readFocused: () => focused,
    onChange: () => {
      changes += 1;
    },
  });
  return {
    changes: () => changes,
    now: () => nowMs,
    /** Moves the tracker's clock and its timers together. */
    advance: (ms: number) => {
      nowMs += ms;
      vi.advanceTimersByTime(ms);
    },
    background: () => {
      focused = false;
      tracking.refresh();
    },
    [Symbol.dispose]: () => {
      tracking.stop();
      vi.useRealTimers();
    },
  };
}

describe("mobile client view", () => {
  it("reports the focused thread's rows to its own environment only", () => {
    using app = setup();
    let items = [{ id: "message-1", kind: "user", from: 0, to: 1 }];
    const stopViewing = viewThread({ environmentId: OWNER, threadId: THREAD }, () => ({ items }));
    app.advance(0);
    expect(app.changes()).toBe(1);
    expect(clientViewFor(OWNER)).toMatchObject({
      windowId: "launch-1",
      threadId: THREAD,
      focused: true,
      lastGestureAtMs: 1_000,
      items,
    });
    expect(clientViewFor(OTHER)).not.toHaveProperty("items");

    // A reply streams in and scrolls the feed: new rows, same gesture time, one report.
    app.advance(5_000);
    const changes = app.changes();
    for (let frame = 0; frame < 30; frame += 1) {
      items = [{ id: "message-2", kind: "assistant", from: 0, to: (frame + 1) / 100 }];
      touchClientView();
      app.advance(16);
    }
    expect(app.changes()).toBe(changes);
    app.advance(750);
    expect(app.changes()).toBe(changes + 1);
    expect(clientViewFor(OWNER)).toMatchObject({ lastGestureAtMs: 1_000, items });

    // A touch is the user's.
    app.advance(10_000);
    const touchedAtMs = app.now();
    recordClientViewGesture();
    app.advance(750);
    expect(clientViewFor(OWNER)?.lastGestureAtMs).toBe(touchedAtMs);

    app.background();
    app.advance(0);
    expect(clientViewFor(OWNER)?.focused).toBe(false);

    stopViewing();
    app.advance(0);
    expect(clientViewFor(OWNER)).toBeUndefined();
  });

  it("keeps the newer screen's thread when an older screen lets go late", () => {
    using app = setup();
    const stopFirst = viewThread({ environmentId: OWNER, threadId: THREAD }, () => ({ items: [] }));
    const second = ThreadId.make("thread-2");
    using _second = {
      [Symbol.dispose]: viewThread({ environmentId: OWNER, threadId: second }, () => ({
        items: [],
      })),
    };
    stopFirst();
    app.advance(0);
    expect(clientViewFor(OWNER)?.threadId).toBe(second);
  });
});

import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadShellFixture } from "../../test-fixtures";
import type { ThreadDropDestination } from "./threadListDrag";
import {
  createThreadListDrag,
  type ThreadDragPreview,
  type ThreadListDragHost,
} from "./threadListDragEngine";

const environmentId = EnvironmentId.make("env");
const ROW = 80;
const VIEWPORT = 600;

function threadItem(id: string, pinned = false) {
  const thread = makeThreadShellFixture({ id: ThreadId.make(id), environmentId, title: id });
  return { type: "v2-thread", key: `v2-thread:env:${id}`, item: { thread, pinned } };
}

/** Twenty rows of 80 pt: two pinned, then active ones, in a 600 pt viewport. */
function setup(options: { insetTop?: number; restingScroll?: number } = {}) {
  const items = [
    threadItem("p1", true),
    threadItem("p2", true),
    ...Array.from({ length: 18 }, (_, index) => threadItem(`a${index + 1}`)),
  ];
  const calls: string[] = [];
  const list = {
    scroll: options.restingScroll ?? 0,
    velocity: 0,
    data: items,
    inset: null as { top: number } | null,
    getState() {
      calls.push("getState");
      return {
        data: list.data,
        scroll: list.scroll,
        scrollVelocity: list.velocity,
        distanceFromEnd: Math.max(0, items.length * ROW - VIEWPORT - list.scroll),
        positionAtIndex: (index: number) => index * ROW,
        // The list has measured nothing: every size comes from the gap to the next row.
        sizeAtIndex: () => undefined,
      };
    },
    cancelScroll: () => calls.push("cancelScroll"),
    scrollToOffset: ({ offset }: { offset: number }) => {
      calls.push(`scrollTo:${offset}`);
      list.scroll = offset;
    },
    reportContentInset: (inset: { top: number } | null) => {
      list.inset = inset;
    },
  };
  const view = {
    lifted: false,
    bar: null as number | null,
    preview: null as ThreadDragPreview | null,
    frames: [] as ((timestamp: number) => void)[],
  };
  const drops: { thread: string; destination: ThreadDropDestination }[] = [];
  const ended: string[] = [];
  const host: ThreadListDragHost = {
    list,
    layout: {
      headerSize: 0,
      paddingTop: 0,
      contentInsetTop: options.insetTop ?? 0,
      estimatedItemSize: ROW,
    },
    canLift: () => true,
    validate: () => ({ canSettle: true, canDrop: () => true }),
    action: (source, destination) => `${source}>${destination}`,
    onDrop: (thread: EnvironmentThreadShell, destination) =>
      drops.push({ thread: thread.id, destination }),
    onEnd: () => ended.push("end"),
  };
  const drag = createThreadListDrag({
    lift: () => {
      view.lifted = true;
    },
    drop: () => {
      view.lifted = false;
    },
    setBar: (y) => {
      view.bar = y;
    },
    setSource: () => {},
    setPreview: (preview) => {
      view.preview = preview;
    },
    requestFrame: (callback) => view.frames.push(callback),
    cancelFrame: () => {
      view.frames.length = 0;
    },
  });
  /** Presses and lifts the row at `pointerY`; the list's window origin is 0. */
  const lift = (pointerY: number) => {
    const allowed = drag.press(host, { pointerY, originY: 0, viewportHeight: VIEWPORT });
    if (allowed) drag.lift(host, pointerY);
    return allowed;
  };
  /** Runs the queued auto-scroll frame, 16 ms after the last one. */
  let clock = 0;
  const frame = () => {
    const next = view.frames.shift();
    clock += 16;
    next?.(clock);
    return next !== undefined;
  };
  return { drag, host, list, view, calls, drops, ended, lift, frame, items };
}

describe("thread list drag", () => {
  it("drops the lifted row at the slot under the pointer", () => {
    const { drag, host, view, drops, ended, lift } = setup();
    // a1 is the third row; a3's top half is at 4 * 80.
    expect(lift(2 * ROW + 30)).toBe(true);
    expect(view.lifted).toBe(true);
    drag.move(host, 4 * ROW + 10);
    expect(view.bar).toBe(4 * ROW);
    expect(view.preview).toMatchObject({ title: "a1", action: "active>active" });
    drag.release(host, true);
    expect(drops).toEqual([
      {
        thread: "a1",
        destination: { section: "active", targetId: "env:a3", placement: "before" },
      },
    ]);
    expect(view.lifted).toBe(false);
    expect(view.preview).toBeNull();
    expect(ended).toEqual(["end"]);
  });

  it("stops the list's own scrolling before it reads where the rows are", () => {
    const { calls, lift } = setup();
    lift(2 * ROW + 30);
    const cancelled = calls.indexOf("cancelScroll");
    expect(cancelled).toBeGreaterThan(-1);
    // The press read the list once; the lift reads it only after the scroll is cancelled.
    expect(calls.slice(0, cancelled).filter((call) => call === "getState")).toHaveLength(1);
    expect(calls.slice(cancelled).filter((call) => call === "getState").length).toBeGreaterThan(0);
  });

  it("drops nothing when the gesture is taken away or the drag is cancelled", () => {
    const first = setup();
    first.lift(2 * ROW + 30);
    first.drag.move(first.host, 4 * ROW + 10);
    first.drag.release(first.host, false);
    expect(first.drops).toEqual([]);
    expect(first.ended).toEqual(["end"]);

    const second = setup();
    second.lift(2 * ROW + 30);
    second.drag.move(second.host, 4 * ROW + 10);
    expect(second.drag.orderVersion()).not.toBeNull();
    second.drag.cancel(second.host);
    expect(second.drag.orderVersion()).toBeNull();
    // The finger is still down; when it lifts, nothing lands.
    second.drag.release(second.host, true);
    expect(second.drops).toEqual([]);
    expect(second.view.lifted).toBe(false);
  });

  it("drops nothing where the pointer means no slot", () => {
    const { drag, host, drops, view, lift } = setup();
    lift(2 * ROW + 30);
    // Back on its own row, clear of the Pinned/Active line above it.
    drag.move(host, 2 * ROW + 60);
    expect(view.bar).toBeNull();
    drag.release(host, true);
    expect(drops).toEqual([]);
  });

  it("refuses to lift while the screen says no", () => {
    const { drag, host, view } = setup();
    const locked = { ...host, canLift: () => false };
    expect(
      drag.press(locked, { pointerY: 2 * ROW + 30, originY: 0, viewportHeight: VIEWPORT }),
    ).toBe(false);
    drag.lift(locked, 2 * ROW + 30);
    expect(view.lifted).toBe(false);

    // The lock can also set between the press and the lift.
    expect(drag.press(host, { pointerY: 2 * ROW + 30, originY: 0, viewportHeight: VIEWPORT })).toBe(
      true,
    );
    drag.lift(locked, 2 * ROW + 30);
    expect(view.lifted).toBe(false);
  });

  it("scrolls the list under a row held near an edge and retargets as rows pass", () => {
    const { drag, host, list, view, calls, drops, lift, frame } = setup();
    lift(2 * ROW + 30);
    // Held 10 pt above the viewport's bottom edge.
    drag.move(host, VIEWPORT - 10);
    expect(view.frames).toHaveLength(1);
    const before = view.bar;
    for (let step = 0; step < 20; step += 1) frame();
    expect(list.scroll).toBeGreaterThan(100);
    expect(calls.filter((call) => call.startsWith("scrollTo:")).length).toBeGreaterThan(10);
    // The pointer has not moved, but the slot under it has.
    expect(view.bar).not.toBe(before);
    drag.release(host, true);
    expect(drops[0]?.destination.section).toBe("active");
    expect(drops[0]?.destination.targetId).not.toBe("env:a5");
    // No frame outlives the drag.
    expect(frame()).toBe(false);
  });

  it("stops auto-scroll when the pointer leaves the edge, and at the list's end", () => {
    const { drag, host, list, view, lift, frame } = setup({ restingScroll: 980 });
    lift(200);
    drag.move(host, VIEWPORT - 10);
    for (let step = 0; step < 40; step += 1) frame();
    // Twenty rows of 80 in a 600 pt viewport end at offset 1000.
    expect(list.scroll).toBe(1000);
    drag.move(host, 300);
    expect(view.frames).toHaveLength(0);
  });

  it("scrolls up to a top inset the list only shows by where it rests", () => {
    // The sidebar on iOS: no inset of its own, at rest 116 above zero under UIKit's bar inset.
    const { drag, host, list, lift, frame } = setup({ insetTop: 0, restingScroll: -116 });
    // A press with the list at rest teaches the drag the inset.
    expect(drag.press(host, { pointerY: 300, originY: 0, viewportHeight: VIEWPORT })).toBe(true);
    list.scroll = 400;
    expect(lift(300)).toBe(true);
    // The list is told the inset for the drag, so it will scroll that far up.
    expect(list.inset).toEqual({ top: 116 });
    // Just under the bar: inside the top zone, which starts below the inset.
    drag.move(host, 116 + 10);
    for (let step = 0; step < 80; step += 1) frame();
    expect(list.scroll).toBe(-116);
    drag.release(host, false);
    expect(list.inset).toBeNull();
  });

  it("does not take a list coasting past its top for its inset", () => {
    const { drag, host, list, lift } = setup({ restingScroll: -40 });
    list.velocity = -2;
    drag.press(host, { pointerY: 300, originY: 0, viewportHeight: VIEWPORT });
    list.velocity = 0;
    list.scroll = 400;
    lift(300);
    expect(list.inset).toEqual({ top: 0 });
  });

  it("pins on the floating Pinned target while Pinned is empty", () => {
    const { drag, host, list, view, drops } = setup();
    list.data = list.data.slice(2);
    drag.press(host, { pointerY: 2 * ROW + 30, originY: 0, viewportHeight: VIEWPORT });
    drag.lift(host, 2 * ROW + 30);
    expect(view.preview?.zones.pinned).toEqual({ top: 72, height: 44 });
    drag.move(host, 90);
    expect(view.preview).toMatchObject({ zone: "pinned", action: "active>pinned" });
    expect(view.bar).toBeNull();
    drag.release(host, true);
    expect(drops).toEqual([
      {
        thread: "a3",
        destination: { section: "pinned", targetId: null, placement: "before" },
      },
    ]);
  });

  it("measures the pointer from the list's own top, wherever the list is on screen", () => {
    const { drag, host, drops } = setup();
    // The list starts 200 pt down the window.
    drag.press(host, { pointerY: 2 * ROW + 30, originY: 200, viewportHeight: VIEWPORT });
    drag.lift(host, 200 + 2 * ROW + 30);
    drag.move(host, 200 + 4 * ROW + 10);
    drag.release(host, true);
    expect(drops[0]?.destination).toEqual({
      section: "active",
      targetId: "env:a3",
      placement: "before",
    });
  });
});

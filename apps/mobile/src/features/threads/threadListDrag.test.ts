import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadShellFixture } from "../../test-fixtures";
import {
  advanceThreadDragLatch,
  createThreadDropValidator,
  describeThreadDragRows,
  measureThreadDragFrames,
  nextThreadDragScrollOffset,
  readThreadListDragLayout,
  resolveThreadDropTarget,
  startThreadDragLatch,
  threadDragActivation,
  threadDragBoundaryBand,
  threadDragItemY,
  threadDragLiftRow,
  threadDragOrderVersion,
  threadDragOverlayZones,
  threadDragScrollRange,
  threadDragScrollVelocity,
  threadDragViewportY,
  threadListRestInsetTop,
  THREAD_DRAG_SCROLL_ZONE,
  THREAD_DRAG_TOUCH_HOLD_MS,
  type ThreadDragFrame,
  type ThreadDragLatch,
  type ThreadDropDestination,
  type ThreadListDragMetrics,
} from "./threadListDrag";

const environmentId = EnvironmentId.make("env");
const NOW = "2026-06-01T12:00:00.000Z";

function thread(id: string, overrides: Partial<EnvironmentThreadShell> = {}) {
  return makeThreadShellFixture({ id: ThreadId.make(id), environmentId, title: id, ...overrides });
}

function threadItem(id: string, pinned = false) {
  return {
    type: "v2-thread",
    key: `v2-thread:env:${id}`,
    item: { thread: thread(id), pinned },
  };
}

const shelf = (name: "working" | "snoozed" | "settled") => ({
  type: `v2-${name}-shelf`,
  key: `v2-${name}-shelf`,
});

// Two pinned cards, three active ones, then the Working, Snoozed and Settled shelves.
const ITEMS = [
  { type: "v2-pending", key: "v2-pending:1" },
  threadItem("p1", true),
  threadItem("p2", true),
  threadItem("a1"),
  threadItem("a2"),
  threadItem("a3"),
  shelf("working"),
  threadItem("w1"),
  shelf("snoozed"),
  threadItem("z1"),
  shelf("settled"),
  threadItem("s1"),
  { type: "v2-show-more", key: "v2-show-more" },
];
const ROWS = describeThreadDragRows(ITEMS);
const ROW_HEIGHT = 80;
const FRAMES: ThreadDragFrame[] = ROWS.map((row) => ({
  top: row.index * ROW_HEIGHT,
  height: ROW_HEIGHT,
}));
const top = (key: string) => FRAMES[ROWS.find((row) => row.key.endsWith(key))!.index]!.top;

/** A list at rest at its top, with nothing above its rows and no bar over it. */
const PLAIN: ThreadListDragMetrics = {
  scroll: 0,
  viewportHeight: 600,
  contentStart: 0,
  contentInsetTop: 0,
  distanceFromEnd: 440,
};

describe("thread drag rows", () => {
  it("gives each row the section its place in the list means", () => {
    expect(ROWS.map((row) => `${row.kind}:${row.section}`)).toEqual([
      "other:pending",
      "thread:pinned",
      "thread:pinned",
      "thread:active",
      "thread:active",
      "thread:active",
      "shelf:working",
      "thread:working",
      "shelf:snoozed",
      "thread:snoozed",
      "shelf:settled",
      "thread:settled",
      "other:settled",
    ]);
    expect(ROWS[1]?.threadKey).toBe("env:p1");
  });

  it("changes its order version when a row moves or takes a new order key", () => {
    const version = threadDragOrderVersion(ROWS);
    expect(threadDragOrderVersion(describeThreadDragRows(ITEMS))).toBe(version);
    const swapped = ITEMS.toSpliced(3, 2, ITEMS[4]!, ITEMS[3]!);
    expect(threadDragOrderVersion(describeThreadDragRows(swapped))).not.toBe(version);
    const rekeyed = ROWS.map((row) =>
      row.key.endsWith("a1") ? { ...row, thread: thread("a1", { activeOrderKey: "m" }) } : row,
    );
    expect(threadDragOrderVersion(rekeyed)).not.toBe(version);
  });
});

describe("thread drag row frames", () => {
  it("fills an unmeasured row from the gap to the next row, then from the estimate", () => {
    // `sizeAtIndex` is typed `number`, but the list returns undefined before it measures a row.
    const positions = [0, 70, 200];
    const sizes: (number | undefined)[] = [70, undefined, undefined];
    expect(
      measureThreadDragFrames({
        count: 3,
        positionAtIndex: (index) => positions[index],
        sizeAtIndex: (index) => sizes[index],
        estimatedItemSize: 64,
      }),
    ).toEqual([
      { top: 0, height: 70 },
      { top: 70, height: 130 },
      { top: 200, height: 64 },
    ]);
  });

  it("places a row the list has not positioned under the row before it", () => {
    expect(
      measureThreadDragFrames({
        count: 3,
        positionAtIndex: (index) => (index === 0 ? 0 : undefined),
        sizeAtIndex: () => undefined,
        estimatedItemSize: 64,
      }),
    ).toEqual([
      { top: 0, height: 64 },
      { top: 64, height: 64 },
      { top: 128, height: 64 },
    ]);
  });
});

describe("thread drag coordinates", () => {
  const state = {
    data: ITEMS,
    distanceFromEnd: 0,
    positionAtIndex: (index: number) => index * ROW_HEIGHT,
    sizeAtIndex: () => ROW_HEIGHT,
  };

  it("maps a pointer on Home, whose list has its own top inset and a header", () => {
    // Home rests at minus its `contentInset.top` (100), with a 40 pt filter header.
    const { metrics } = readThreadListDragLayout(
      { ...state, scroll: -100 },
      {
        headerSize: 40,
        paddingTop: 0,
        contentInsetTop: 100,
        viewportHeight: 600,
        estimatedItemSize: 72,
      },
    );
    // The first row starts under the bar and the header: 100 + 40 from the viewport's top.
    expect(threadDragItemY(140, metrics)).toBe(0);
    expect(threadDragViewportY(ROW_HEIGHT, metrics)).toBe(220);
    // Scrolled 300 further, the same screen point is 300 further down the rows.
    expect(threadDragItemY(140, { ...metrics, scroll: 200 })).toBe(300);
  });

  it("maps a pointer on the sidebar, whose inset UIKit adds and scroll events leave out", () => {
    // The sidebar reports no inset of its own, rests at minus UIKit's (116), and pads 6.
    const insetTop = threadListRestInsetTop({ known: 0, scroll: -116, atRest: true });
    expect(insetTop).toBe(116);
    const { metrics } = readThreadListDragLayout(
      { ...state, scroll: -116 },
      {
        headerSize: 0,
        paddingTop: 6,
        contentInsetTop: insetTop,
        viewportHeight: 600,
        estimatedItemSize: 64,
      },
    );
    expect(threadDragItemY(122, metrics)).toBe(0);
    expect(threadDragViewportY(0, metrics)).toBe(122);
  });

  it("learns the inset only from where the list rests, and never unlearns it", () => {
    // A pull past the top is further up than the inset; it is not a resting offset.
    expect(threadListRestInsetTop({ known: 116, scroll: -190, atRest: false })).toBe(116);
    // Scrolled down, or part way under the bar, the list shows less than its inset.
    expect(threadListRestInsetTop({ known: 116, scroll: 400, atRest: true })).toBe(116);
    expect(threadListRestInsetTop({ known: 116, scroll: -60, atRest: true })).toBe(116);
    expect(threadListRestInsetTop({ known: 0, scroll: 400, atRest: true })).toBe(0);
  });

  it("uses the offset an auto-scroll step asked for ahead of the list's own", () => {
    const layout = {
      headerSize: 0,
      paddingTop: 0,
      contentInsetTop: 0,
      viewportHeight: 600,
      estimatedItemSize: 72,
    };
    expect(readThreadListDragLayout({ ...state, scroll: 10 }, layout, 48).metrics.scroll).toBe(48);
  });
});

describe("thread drag lift", () => {
  const lift = (pointerY: number, metrics = PLAIN) =>
    threadDragLiftRow({ rows: ROWS, frames: FRAMES, metrics, pointerY })?.key ?? null;

  it("lifts the thread under the pointer", () => {
    expect(lift(top("p2") + 10)).toBe("v2-thread:env:p2");
    const scrolled = { ...PLAIN, scroll: 400 };
    expect(lift(top("z1") + 10 - 400, scrolled)).toBe("v2-thread:env:z1");
    expect(lift(top("s1") + 10 - 400, scrolled)).toBe("v2-thread:env:s1");
    // A row below the viewport's end is not under the pointer.
    expect(lift(top("z1") + 10)).toBeNull();
  });

  it("lifts nothing from Working, a shelf header, a queued task, or under the bar", () => {
    expect(lift(top("w1") + 10)).toBeNull();
    expect(lift(top("working-shelf") + 10)).toBeNull();
    expect(lift(10)).toBeNull();
    // The row at this point is covered by a 100 pt bar.
    expect(lift(90, { ...PLAIN, scroll: 80, contentInsetTop: 100 })).toBeNull();
  });
});

describe("thread drop target", () => {
  const resolve = (
    sourceKey: string,
    pointerY: number,
    options: {
      latch?: ThreadDragLatch["section"];
      canDrop?: (destination: ThreadDropDestination) => boolean;
      canSettle?: boolean;
      metrics?: ThreadListDragMetrics;
      zones?: Parameters<typeof resolveThreadDropTarget>[0]["zones"];
      rows?: typeof ROWS;
      frames?: ThreadDragFrame[];
    } = {},
  ) =>
    resolveThreadDropTarget({
      rows: options.rows ?? ROWS,
      frames: options.frames ?? FRAMES,
      metrics: options.metrics ?? PLAIN,
      sourceKey: `v2-thread:env:${sourceKey}`,
      pointerY,
      latch: { section: options.latch ?? "active", anchorY: pointerY },
      zones: options.zones ?? { pinned: null, settled: null },
      canDrop: options.canDrop ?? (() => true),
      canSettle: options.canSettle ?? true,
    });

  it("takes the slot before or after the row under the pointer, by its middle", () => {
    expect(resolve("a1", top("a3") + 10)).toEqual({
      destination: { section: "active", targetId: "env:a3", placement: "before" },
      section: "active",
      barY: top("a3"),
      zone: null,
    });
    expect(resolve("a1", top("a3") + 70)).toMatchObject({
      destination: { section: "active", targetId: "env:a3", placement: "after" },
      barY: top("a3") + ROW_HEIGHT,
    });
    expect(resolve("a3", top("p1") + 10)).toMatchObject({
      destination: { section: "pinned", targetId: "env:p1", placement: "before" },
      section: "pinned",
    });
  });

  it("is the same slot at any scroll offset", () => {
    const scrolled = { ...PLAIN, scroll: 150, contentStart: 46, contentInsetTop: 100 };
    const pointerY = threadDragViewportY(top("a3") + 10, scrolled);
    expect(resolve("a1", pointerY, { metrics: scrolled })).toMatchObject({
      destination: { section: "active", targetId: "env:a3", placement: "before" },
    });
  });

  it("offers no target on the dragged row or where the planner refuses the slot", () => {
    expect(resolve("a2", top("a2") + 30)).toBeNull();
    expect(resolve("a1", top("a3") + 10, { canDrop: () => false })).toBeNull();
  });

  it("settles anywhere in Settled, with the bar under its header", () => {
    const settle = {
      destination: { section: "settled", targetId: null, placement: "before" },
      section: "settled",
      barY: top("settled-shelf") + ROW_HEIGHT,
      zone: null,
    };
    const scrolled = { ...PLAIN, scroll: 500 };
    expect(resolve("a1", top("settled-shelf") + 10 - 500, { metrics: scrolled })).toEqual(settle);
    expect(resolve("a1", top("s1") + 10 - 500, { metrics: scrolled })).toEqual(settle);
    expect(resolve("a1", top("show-more") + 10 - 500, { metrics: scrolled })).toEqual(settle);
    expect(
      resolve("s1", top("settled-shelf") + 10 - 500, { metrics: scrolled, canSettle: false }),
    ).toBeNull();
  });

  it("takes no drop in Working or Snoozed, as on desktop", () => {
    expect(resolve("a1", top("working-shelf") + 10)).toBeNull();
    expect(resolve("a1", top("w1") + 10)).toBeNull();
    expect(
      resolve("a1", top("snoozed-shelf") + 10 - 200, { metrics: { ...PLAIN, scroll: 200 } }),
    ).toBeNull();
    expect(resolve("a1", top("z1") + 10 - 200, { metrics: { ...PLAIN, scroll: 200 } })).toBeNull();
  });

  it("reads a drop on the queued tasks as the first slot under them", () => {
    expect(resolve("a1", 10)).toMatchObject({
      destination: { section: "pinned", targetId: "env:p1", placement: "before" },
      barY: top("p1"),
    });
    expect(resolve("p1", 10)).toBeNull();
  });

  it("gives the floating targets the drop while the pointer is on them", () => {
    const zones = { pinned: { top: 72, height: 44 }, settled: { top: 484, height: 44 } };
    expect(resolve("a1", 90, { zones })).toEqual({
      destination: { section: "pinned", targetId: null, placement: "before" },
      section: "pinned",
      barY: null,
      zone: "pinned",
    });
    expect(resolve("a1", 500, { zones })).toEqual({
      destination: { section: "settled", targetId: null, placement: "before" },
      section: "settled",
      barY: null,
      zone: "settled",
    });
    expect(resolve("a1", 90, { zones, canDrop: () => false })).toBeNull();
    // Off the targets, the rows take the drop as usual: at either edge, and between them.
    expect(resolve("a1", top("a3") + 10, { zones })?.zone).toBeNull();
    expect(resolve("a3", 10, { zones })?.zone).toBeNull();
    // Under the pointer at the bottom edge is the Snoozed header, which takes no drop.
    expect(resolve("a1", 590, { zones, metrics: { ...PLAIN, scroll: 100 } })).toBeNull();
  });
});

describe("the Pinned/Active line", () => {
  const band = threadDragBoundaryBand(ROWS, FRAMES)!;
  const line = top("a1");

  it("spans from the middle of the last pinned row to the middle of the first active one", () => {
    expect(band).toEqual({ top: top("p2") + 40, bottom: top("a1") + 40, line });
  });

  it("has no line while Pinned is empty: the floating target pins", () => {
    const unpinned = describeThreadDragRows([threadItem("a1"), threadItem("a2")]);
    expect(threadDragBoundaryBand(unpinned, FRAMES)).toBeNull();
  });

  it("reaches a little under the last pinned row when Active is empty", () => {
    const allPinned = describeThreadDragRows([threadItem("p1", true), shelf("settled")]);
    expect(threadDragBoundaryBand(allPinned, FRAMES)).toEqual({ top: 40, bottom: 108, line: 80 });
  });

  it("follows the way the pointer last moved, as the desktop sidebar does", () => {
    let latch = startThreadDragLatch("active", line + 200);
    const move = (pointerY: number, itemY = pointerY) => {
      latch = advanceThreadDragLatch(latch, { pointerY, itemY, band });
      return latch.section;
    };
    // Moving up through Active, short of the line: still Active.
    expect(move(line + 100)).toBe("active");
    // Moving up into the line's stretch: Pinned.
    expect(move(line + 30)).toBe("pinned");
    // A few points of finger noise there changes nothing.
    expect(move(line + 33)).toBe("pinned");
    expect(move(line + 28)).toBe("pinned");
    // Moving down while in the stretch: Active.
    expect(move(line + 38)).toBe("active");
    // Moving on down into Active keeps it there.
    expect(move(line + 120)).toBe("active");
  });

  it("starts on the dragged row's own side", () => {
    expect(startThreadDragLatch("pinned", 0).section).toBe("pinned");
    expect(startThreadDragLatch("settled", 0).section).toBe("active");
  });

  it("ignores rows that scroll under a still pointer", () => {
    const latch = startThreadDragLatch("active", 300);
    // The list auto-scrolls: the pointer stays at 300 on screen while the line passes under it.
    expect(advanceThreadDragLatch(latch, { pointerY: 300, itemY: line + 10, band })).toBe(latch);
    expect(advanceThreadDragLatch(latch, { pointerY: 300, itemY: line - 30, band })).toBe(latch);
  });

  it("drops at the end of Pinned or the start of Active, by that side", () => {
    const at = (latch: "pinned" | "active", sourceKey: string) =>
      resolveThreadDropTarget({
        rows: ROWS,
        frames: FRAMES,
        metrics: PLAIN,
        sourceKey: `v2-thread:env:${sourceKey}`,
        pointerY: line + 10,
        latch: { section: latch, anchorY: 0 },
        zones: { pinned: null, settled: null },
        canDrop: () => true,
        canSettle: true,
      });
    expect(at("pinned", "a2")).toEqual({
      destination: { section: "pinned", targetId: "env:p2", placement: "after" },
      section: "pinned",
      barY: line,
      zone: null,
    });
    expect(at("active", "p1")).toEqual({
      destination: { section: "active", targetId: "env:a1", placement: "before" },
      section: "active",
      barY: line,
      zone: null,
    });
    // Dragging the row next to the line names the row past it, never the dragged row itself.
    expect(at("pinned", "p2")?.destination).toEqual({
      section: "pinned",
      targetId: "env:p1",
      placement: "after",
    });
    expect(at("active", "a1")?.destination).toEqual({
      section: "active",
      targetId: "env:a2",
      placement: "before",
    });
  });
});

describe("floating drop targets", () => {
  const zones = (
    items: typeof ITEMS,
    metrics: ThreadListDragMetrics,
    can: { canPin?: boolean; canSettle?: boolean } = {},
  ) => {
    const rows = describeThreadDragRows(items);
    return threadDragOverlayZones({
      rows,
      frames: rows.map((row) => ({ top: row.index * ROW_HEIGHT, height: ROW_HEIGHT })),
      metrics,
      canPin: can.canPin ?? true,
      canSettle: can.canSettle ?? true,
    });
  };

  it("floats Pinned under the bar only while Pinned has no rows", () => {
    const unpinned = [threadItem("a1"), threadItem("a2"), shelf("settled")];
    // Inside the top auto-scroll zone, which itself starts under the 100 pt bar.
    expect(zones(unpinned, { ...PLAIN, contentInsetTop: 100 }).pinned).toEqual({
      top: 100 + THREAD_DRAG_SCROLL_ZONE + 8,
      height: 44,
    });
    expect(zones(ITEMS, PLAIN).pinned).toBeNull();
    expect(zones(unpinned, PLAIN, { canPin: false }).pinned).toBeNull();
  });

  it("floats Settled while its header is off screen, or there is none", () => {
    // The header sits at 800 in a 600 pt viewport.
    expect(zones(ITEMS, PLAIN).settled).toEqual({
      top: 600 - THREAD_DRAG_SCROLL_ZONE - 8 - 44,
      height: 44,
    });
    expect(zones(ITEMS, { ...PLAIN, scroll: 400 }).settled).toBeNull();
    // Scrolled past it, the header is under the bar.
    expect(zones(ITEMS, { ...PLAIN, scroll: 790, contentInsetTop: 100 }).settled).not.toBeNull();
    expect(zones([threadItem("a1")], PLAIN).settled).not.toBeNull();
    expect(zones(ITEMS, PLAIN, { canSettle: false }).settled).toBeNull();
  });
});

describe("thread drag auto-scroll", () => {
  const metrics = { viewportHeight: 600, contentInsetTop: 100 };
  const velocity = (pointerY: number) => threadDragScrollVelocity({ pointerY, metrics });

  it("starts the top zone below the bar that covers the list", () => {
    expect(velocity(100 + THREAD_DRAG_SCROLL_ZONE)).toBe(0);
    expect(velocity(100 + THREAD_DRAG_SCROLL_ZONE - 16)).toBeLessThan(0);
    // Under the bar is past the zone's edge: full speed, not a dead area.
    expect(velocity(40)).toBe(velocity(100));
    expect(velocity(100)).toBeLessThan(velocity(100 + THREAD_DRAG_SCROLL_ZONE - 16));
  });

  it("scrolls down near the bottom and not at all in between", () => {
    expect(velocity(300)).toBe(0);
    expect(velocity(600 - THREAD_DRAG_SCROLL_ZONE)).toBe(0);
    expect(velocity(590)).toBeGreaterThan(0);
    expect(velocity(590)).toBeGreaterThan(velocity(560));
  });

  it("stands still in a viewport too short to hold both zones", () => {
    expect(
      threadDragScrollVelocity({ pointerY: 110, metrics: { ...metrics, viewportHeight: 200 } }),
    ).toBe(0);
  });

  it("stops at the list's top, which is minus its inset, and at its end", () => {
    const range = threadDragScrollRange({ scroll: 50, contentInsetTop: 100, distanceFromEnd: 30 });
    expect(range).toEqual({ minimum: -100, maximum: 80 });
    const step = (current: number, velocity: number) =>
      nextThreadDragScrollOffset({ current, range, velocity, elapsedMs: 16 });
    expect(step(50, -0.5)).toBe(42);
    expect(step(-96, -0.5)).toBe(-100);
    expect(step(76, 0.5)).toBe(80);
  });

  it("never jumps a list that already sits past a limit", () => {
    const range = { minimum: 0, maximum: 400 };
    // Resting above zero, as the sidebar does before its inset is known.
    expect(
      nextThreadDragScrollOffset({ current: -116, range, velocity: -0.5, elapsedMs: 16 }),
    ).toBe(-116);
    expect(nextThreadDragScrollOffset({ current: -116, range, velocity: 0.5, elapsedMs: 16 })).toBe(
      -108,
    );
  });
});

describe("thread drag activation", () => {
  const touch = (elapsedMs: number, dx: number, dy: number, menuOpensAtMs: number | null = null) =>
    threadDragActivation({ pointer: "touch", elapsedMs, restMs: 0, dx, dy, menuOpensAtMs });
  const mouse = (restMs: number, dx: number, dy: number) =>
    threadDragActivation({
      pointer: "mouse",
      elapsedMs: 1_000,
      restMs,
      dx,
      dy,
      menuOpensAtMs: null,
    });
  const held = THREAD_DRAG_TOUCH_HOLD_MS;

  it("gives way at once to a finger that moves before the hold", () => {
    expect(touch(40, 0, 11)).toBe("fail");
    expect(touch(40, -11, 2)).toBe("fail");
    expect(touch(held - 1, 0, 11)).toBe("fail");
  });

  it("waits through the small travel of a finger settling", () => {
    expect(touch(40, 3, -6)).toBe("wait");
    expect(touch(held - 1, 0, 10)).toBe("wait");
  });

  it("never activates for a finger that holds still, so the row's menu opens", () => {
    expect(touch(held, 0, 0)).toBe("wait");
    expect(touch(2_000, 2, 5)).toBe("wait");
    expect(touch(2_000, 0, 8)).toBe("wait");
  });

  it("lifts the row once a held finger moves along the list", () => {
    expect(touch(held, 0, 9)).toBe("activate");
    expect(touch(held + 100, 4, -12)).toBe("activate");
  });

  it("leaves a held finger that moves across the list to the row", () => {
    expect(touch(held, 11, 3)).toBe("fail");
    // Not far enough either way yet.
    expect(touch(held, 9, 9)).toBe("wait");
  });

  it("stops lifting once the menu has opened where its window leaves the touch", () => {
    expect(touch(379, 0, 12, 380)).toBe("activate");
    expect(touch(380, 0, 12, 380)).toBe("fail");
  });

  it("lifts for a mouse as soon as it travels along the list", () => {
    expect(mouse(10, 1, 7)).toBe("wait");
    expect(mouse(10, 2, 8)).toBe("activate");
    expect(mouse(10, -3, -20)).toBe("activate");
  });

  it("leaves a sideways mouse drag and a resting press alone", () => {
    expect(mouse(10, 9, 2)).toBe("fail");
    expect(mouse(140, 0, 3)).toBe("fail");
    expect(mouse(139, 0, 3)).toBe("wait");
  });
});

describe("thread drop validator", () => {
  const SLOT: ThreadDropDestination = {
    section: "active",
    targetId: "env:a1",
    placement: "before",
  };
  const PIN: ThreadDropDestination = { section: "pinned", targetId: null, placement: "before" };
  const validator = (
    input: Partial<Parameters<typeof createThreadDropValidator>[0]> & {
      thread: EnvironmentThreadShell;
    },
  ) =>
    createThreadDropValidator({
      threadKey: `env:${input.thread.id}`,
      sourceSection: "active",
      configLoaded: true,
      activeTimeOrdered: false,
      now: NOW,
      planPinned: () => [],
      planActive: () => [],
      ...input,
    });

  it("asks the planner for a slot in Pinned or in a hand-ordered Active", () => {
    const calls: string[] = [];
    const drops = validator({
      thread: thread("a2"),
      planPinned: (key) => (calls.push(`pinned:${key}`), null),
      planActive: (key) => (calls.push(`active:${key}`), []),
    });
    expect(drops.canDrop(PIN)).toBe(false);
    expect(drops.canDrop(SLOT)).toBe(true);
    expect(calls).toEqual(["pinned:env:a2", "active:env:a2"]);
  });

  it("lets a time-ordered Active take a state change, with no slot and no planner", () => {
    const planActive = () => {
      throw new Error("Active by time has no slots to plan");
    };
    const from = (sourceSection: "pinned" | "active" | "snoozed" | "settled", input: object) =>
      validator({
        thread: thread("t", input),
        sourceSection,
        activeTimeOrdered: true,
        planActive,
      }).canDrop(SLOT);
    expect(from("pinned", { pinnedAt: NOW })).toBe(true);
    expect(from("settled", { settledOverride: "settled" })).toBe(true);
    expect(from("snoozed", { snoozedUntil: "2099-01-01T00:00:00.000Z" })).toBe(true);
    // A move within Active would only write an order key the list ignores.
    expect(from("active", {})).toBe(false);
  });

  it("refuses every drop without the environment's server config", () => {
    const drops = validator({ thread: thread("a2"), configLoaded: false });
    expect(drops.canDrop(PIN)).toBe(false);
    expect(drops.canDrop(SLOT)).toBe(false);
    expect(drops.canSettle).toBe(false);
  });

  it("settles from anywhere but Settled", () => {
    expect(validator({ thread: thread("a2") }).canSettle).toBe(true);
    expect(validator({ thread: thread("s1"), sourceSection: "settled" }).canSettle).toBe(false);
  });
});

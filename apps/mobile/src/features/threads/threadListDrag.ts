import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

import { scopedThreadKey } from "../../lib/scopedEntities";
import { isThreadListV2ListItem } from "./threadListV2";
import {
  threadDropLifecycle,
  type ThreadDragSection,
  type ThreadMoveDestination,
} from "./threadOrder";

/**
 * The thread list's direct drag, as plain functions: where each row sits, which drop a pointer
 * means, when the list scrolls under a held row, and when a touch becomes a drag. The list-level
 * boundary (`ThreadListDragBoundary`) owns the gesture and the overlay and calls these.
 */

export type ThreadDragRowSection = ThreadDragSection | "working" | "pending";
export type ThreadDropDestination = Exclude<ThreadMoveDestination, string>;

export interface ThreadDragRow {
  readonly index: number;
  /** The list item's key. */
  readonly key: string;
  readonly kind: "thread" | "shelf" | "other";
  readonly section: ThreadDragRowSection;
  /** A thread row's thread, and its key as the move planner names it. */
  readonly thread?: EnvironmentThreadShell;
  readonly threadKey?: string;
}

const SHELF_SECTIONS = {
  "v2-working-shelf": "working",
  "v2-snoozed-shelf": "snoozed",
  "v2-settled-shelf": "settled",
} as const;

/**
 * Which section each list row belongs to. The list has no Pinned or Active header: pinned cards
 * come first, then active ones, then each shelf's header and its rows.
 */
export function describeThreadDragRows(
  items: ReadonlyArray<{ readonly type: string; readonly key: string }>,
): ThreadDragRow[] {
  let shelf: "working" | "snoozed" | "settled" | null = null;
  return items.map((item, index): ThreadDragRow => {
    if (!isThreadListV2ListItem(item)) {
      // The sidebar's "Show more" row closes the Settled shelf.
      return { index, key: item.key, kind: "other", section: shelf ?? "active" };
    }
    if (item.type === "v2-pending") {
      return { index, key: item.key, kind: "other", section: "pending" };
    }
    if (item.type !== "v2-thread") {
      shelf = SHELF_SECTIONS[item.type];
      return { index, key: item.key, kind: "shelf", section: shelf };
    }
    const thread = item.item.thread;
    return {
      index,
      key: item.key,
      kind: "thread",
      section: shelf ?? (item.item.pinned ? "pinned" : "active"),
      thread,
      threadKey: scopedThreadKey(thread.environmentId, thread.id),
    };
  });
}

/**
 * Changes when a row joins, leaves, moves or takes a new order key. A drag planned against an
 * older order would drop into the wrong slot, so the boundary cancels it.
 */
export function threadDragOrderVersion(rows: readonly ThreadDragRow[]): string {
  return rows
    .map(
      (row) =>
        `${row.key}:${row.section}:${row.thread?.pinOrderKey ?? ""}:${row.thread?.activeOrderKey ?? ""}`,
    )
    .join("|");
}

/** A row's place among the rows: its top and height, measured from the first row's top. */
export interface ThreadDragFrame {
  readonly top: number;
  readonly height: number;
}

/**
 * Row frames from the list's own bookkeeping (`LegendList.getState()`).
 *
 * `sizeAtIndex` is typed `number` but returns `undefined` for a row the list has not measured
 * yet, and a position can be missing for a row it has not placed. An unmeasured row takes the
 * gap to the next row, or the list's estimate.
 */
export function measureThreadDragFrames(input: {
  readonly count: number;
  readonly positionAtIndex: (index: number) => number | undefined;
  readonly sizeAtIndex: (index: number) => number | undefined;
  readonly estimatedItemSize: number;
}): ThreadDragFrame[] {
  const frames: ThreadDragFrame[] = [];
  let nextTop = 0;
  for (let index = 0; index < input.count; index += 1) {
    const position = input.positionAtIndex(index);
    const top = position != null && Number.isFinite(position) ? position : nextTop;
    const nextPosition = index + 1 < input.count ? input.positionAtIndex(index + 1) : undefined;
    const size = input.sizeAtIndex(index);
    const height =
      size != null && Number.isFinite(size)
        ? size
        : nextPosition != null && Number.isFinite(nextPosition)
          ? nextPosition - top
          : input.estimatedItemSize;
    frames.push({ top, height: Math.max(0, height) });
    nextTop = top + Math.max(0, height);
  }
  return frames;
}

/**
 * Where the list is scrolled and what covers it. A pointer's y is measured from the top of the
 * list's viewport.
 */
export interface ThreadListDragMetrics {
  /**
   * The list's raw scroll offset. A list with a top inset rests at minus that inset, whether the
   * inset is its own `contentInset` (Home) or one UIKit adds (the sidebar's automatic one).
   */
  readonly scroll: number;
  readonly viewportHeight: number;
  /** What the scroll content holds above its first row: the list header and the top padding. */
  readonly contentStart: number;
  /** How much of the viewport's top a bar covers. The rows start below it. */
  readonly contentInsetTop: number;
  /** How far the list can still scroll down. */
  readonly distanceFromEnd: number;
}

/** The part of `LegendList.getState()` the drag reads. */
export interface ThreadListDragListState {
  readonly data: ReadonlyArray<{ readonly type: string; readonly key: string }>;
  readonly scroll: number;
  readonly distanceFromEnd: number;
  readonly positionAtIndex: (index: number) => number | undefined;
  readonly sizeAtIndex: (index: number) => number | undefined;
}

/** What a screen knows about its list that the list's state does not say. */
export interface ThreadListDragLayout {
  /** The list header's height (`onMetricsChange`). */
  readonly headerSize: number;
  /** The content container's top padding. */
  readonly paddingTop: number;
  readonly contentInsetTop: number;
  readonly viewportHeight: number;
  readonly estimatedItemSize: number;
}

export function readThreadListDragLayout(
  state: ThreadListDragListState,
  layout: ThreadListDragLayout,
  /** The offset an auto-scroll step has asked for, ahead of the list's next scroll event. */
  scroll: number = state.scroll,
): { readonly frames: ThreadDragFrame[]; readonly metrics: ThreadListDragMetrics } {
  return {
    frames: measureThreadDragFrames({
      count: state.data.length,
      positionAtIndex: state.positionAtIndex,
      sizeAtIndex: state.sizeAtIndex,
      estimatedItemSize: layout.estimatedItemSize,
    }),
    metrics: {
      scroll,
      viewportHeight: layout.viewportHeight,
      contentStart: layout.headerSize + layout.paddingTop,
      contentInsetTop: layout.contentInsetTop,
      distanceFromEnd: state.distanceFromEnd,
    },
  };
}

/**
 * The thread row a press lifts: the one under the pointer, if its section gives rows up. Working
 * rows stay put, as on desktop, and a press under the bar that covers the list lifts nothing.
 */
export function threadDragLiftRow(input: {
  readonly rows: readonly ThreadDragRow[];
  readonly frames: readonly ThreadDragFrame[];
  readonly metrics: ThreadListDragMetrics;
  readonly pointerY: number;
}): (ThreadDragRow & { readonly section: ThreadDragSection }) | null {
  const { metrics, pointerY } = input;
  if (pointerY < metrics.contentInsetTop || pointerY > metrics.viewportHeight) return null;
  const itemY = threadDragItemY(pointerY, metrics);
  for (const row of input.rows) {
    const frame = input.frames[row.index];
    if (frame === undefined || itemY < frame.top || itemY >= frame.top + frame.height) continue;
    if (row.kind !== "thread" || row.section === "working" || row.section === "pending") {
      return null;
    }
    return { ...row, section: row.section };
  }
  return null;
}

/**
 * Which drops a lifted thread may make, by the rules `moveThread` applies when it lands. The
 * planners answer for a slot in Pinned or Active; Active ordered by time has no slots, so a drop
 * there only has to change the thread's state.
 */
export function createThreadDropValidator(input: {
  readonly thread: EnvironmentThreadShell;
  readonly threadKey: string;
  readonly sourceSection: ThreadDragSection;
  /** The thread's environment has its server config: pin, settle and reorder all need it. */
  readonly configLoaded: boolean;
  readonly activeTimeOrdered: boolean;
  readonly now: string;
  readonly planPinned: (threadKey: string, destination: ThreadDropDestination) => unknown;
  readonly planActive: (threadKey: string, destination: ThreadDropDestination) => unknown;
}): {
  readonly canSettle: boolean;
  readonly canDrop: (destination: ThreadDropDestination) => boolean;
} {
  const lifecycle = threadDropLifecycle(input.thread, "active", input.now);
  return {
    canSettle: input.configLoaded && input.sourceSection !== "settled",
    canDrop: (destination) => {
      if (!input.configLoaded) return false;
      if (destination.section === "pinned") {
        return input.planPinned(input.threadKey, destination) !== null;
      }
      if (destination.section !== "active") return false;
      if (input.activeTimeOrdered) {
        return (
          input.sourceSection !== "active" &&
          (lifecycle.unpin || lifecycle.unsettle || lifecycle.unsnooze)
        );
      }
      return input.planActive(input.threadKey, destination) !== null;
    },
  };
}

export function threadDragItemY(pointerY: number, metrics: ThreadListDragMetrics): number {
  return pointerY + metrics.scroll - metrics.contentStart;
}

export function threadDragViewportY(itemY: number, metrics: ThreadListDragMetrics): number {
  return itemY - metrics.scroll + metrics.contentStart;
}

/**
 * The list's top inset, as its resting offsets show it. Scroll events leave out the inset UIKit
 * adds by itself (the sidebar's), but a list rests at minus its inset at its top and never
 * further up. A pull past the top reads larger, so only a still list (`atRest`) may raise it.
 */
export function threadListRestInsetTop(input: {
  readonly known: number;
  readonly scroll: number;
  readonly atRest: boolean;
}): number {
  return input.atRest ? Math.max(input.known, -input.scroll, 0) : input.known;
}

/** How deep the stretch at each edge is where a held row scrolls the list. */
export const THREAD_DRAG_SCROLL_ZONE = 64;
export const THREAD_DRAG_OVERLAY_ZONE_HEIGHT = 44;
const OVERLAY_ZONE_MARGIN = 8;

export interface ThreadDragZone {
  readonly top: number;
  readonly height: number;
}

/**
 * The drop targets that float over the list, in viewport coordinates: Pinned while it has no
 * rows to drop on, Settled while its header is off screen. No row moves to make room. Each sits
 * just inside the auto-scroll zone at its edge, so holding at the edge itself still scrolls.
 */
export function threadDragOverlayZones(input: {
  readonly rows: readonly ThreadDragRow[];
  readonly frames: readonly ThreadDragFrame[];
  readonly metrics: ThreadListDragMetrics;
  readonly canPin: boolean;
  readonly canSettle: boolean;
}): { readonly pinned: ThreadDragZone | null; readonly settled: ThreadDragZone | null } {
  const { rows, frames, metrics } = input;
  const hasPinned = rows.some((row) => row.kind === "thread" && row.section === "pinned");
  const settledHeader = rows.find((row) => row.kind === "shelf" && row.section === "settled");
  const settledFrame = settledHeader === undefined ? undefined : frames[settledHeader.index];
  const settledHeaderVisible =
    settledFrame !== undefined &&
    threadDragViewportY(settledFrame.top, metrics) >= metrics.contentInsetTop &&
    threadDragViewportY(settledFrame.top + settledFrame.height, metrics) <= metrics.viewportHeight;
  return {
    pinned:
      input.canPin && !hasPinned
        ? {
            top: metrics.contentInsetTop + THREAD_DRAG_SCROLL_ZONE + OVERLAY_ZONE_MARGIN,
            height: THREAD_DRAG_OVERLAY_ZONE_HEIGHT,
          }
        : null,
    settled:
      input.canSettle && !settledHeaderVisible
        ? {
            top:
              metrics.viewportHeight -
              THREAD_DRAG_SCROLL_ZONE -
              OVERLAY_ZONE_MARGIN -
              THREAD_DRAG_OVERLAY_ZONE_HEIGHT,
            height: THREAD_DRAG_OVERLAY_ZONE_HEIGHT,
          }
        : null,
  };
}

/** How far a finger must travel one way before it counts as moving that way. */
const LATCH_TRAVEL = 6;
/** Below the last pinned row, how far the Active side reaches when Active has no rows. */
const EMPTY_ACTIVE_REACH = 28;

/**
 * Which side of the Pinned/Active line a drop there lands on. The line is one place on screen
 * for two drops, the end of Pinned and the start of Active, so the way the pointer last moved
 * decides, as on desktop (`Sidebar.drag.ts`): moving up means Pinned, moving down means Active.
 * Rows that scroll under a still pointer change nothing.
 */
export interface ThreadDragLatch {
  readonly section: "pinned" | "active";
  /** The pointer's viewport y when it last settled on a direction. */
  readonly anchorY: number;
}

export function startThreadDragLatch(
  sourceSection: ThreadDragRowSection,
  pointerY: number,
): ThreadDragLatch {
  return { section: sourceSection === "pinned" ? "pinned" : "active", anchorY: pointerY };
}

/** The stretch of the list, in row coordinates, where a drop means the Pinned/Active line. */
export function threadDragBoundaryBand(
  rows: readonly ThreadDragRow[],
  frames: readonly ThreadDragFrame[],
): { readonly top: number; readonly bottom: number; readonly line: number } | null {
  let lastPinned: ThreadDragFrame | undefined;
  let firstActive: ThreadDragFrame | undefined;
  for (const row of rows) {
    if (row.kind !== "thread") continue;
    if (row.section === "pinned") lastPinned = frames[row.index];
    else if (row.section === "active" && firstActive === undefined) firstActive = frames[row.index];
  }
  // With no pinned rows there is no line to cross: the floating Pinned target takes the drop.
  if (lastPinned === undefined) return null;
  const line = lastPinned.top + lastPinned.height;
  return {
    top: lastPinned.top + lastPinned.height / 2,
    bottom:
      firstActive === undefined
        ? line + EMPTY_ACTIVE_REACH
        : firstActive.top + firstActive.height / 2,
    line,
  };
}

export function advanceThreadDragLatch(
  latch: ThreadDragLatch,
  input: {
    /** Viewport y: only the pointer's own movement counts, not rows scrolling under it. */
    readonly pointerY: number;
    readonly itemY: number;
    readonly band: { readonly top: number; readonly bottom: number } | null;
  },
): ThreadDragLatch {
  const travel = input.pointerY - latch.anchorY;
  if (Math.abs(travel) < LATCH_TRAVEL) return latch;
  const { band } = input;
  if (band !== null && travel < 0 && input.itemY <= band.bottom) {
    return { section: "pinned", anchorY: input.pointerY };
  }
  if (band !== null && travel > 0 && input.itemY >= band.top) {
    return { section: "active", anchorY: input.pointerY };
  }
  return { section: latch.section, anchorY: input.pointerY };
}

export interface ThreadDropTarget {
  readonly destination: ThreadDropDestination;
  readonly section: "pinned" | "active" | "settled";
  /** Where the insertion bar goes, in row coordinates. Null when a floating target takes the drop. */
  readonly barY: number | null;
  /** The floating target under the pointer, if one takes the drop. */
  readonly zone: "pinned" | "settled" | null;
}

const SETTLE: ThreadDropDestination = { section: "settled", targetId: null, placement: "before" };
const PIN_FIRST: ThreadDropDestination = { section: "pinned", targetId: null, placement: "before" };

function withinZone(pointerY: number, zone: ThreadDragZone | null): boolean {
  return zone !== null && pointerY >= zone.top && pointerY <= zone.top + zone.height;
}

/**
 * The drop a pointer means, or null. Pinned and Active take the row at a slot, before or after
 * the row under the pointer by its middle; Settled takes it whole, since it sorts by time;
 * Working and Snoozed take none, as on desktop. `canDrop` asks the move planner, so the row's
 * own slot and a slot the move cannot reach are no target.
 */
export function resolveThreadDropTarget(input: {
  readonly rows: readonly ThreadDragRow[];
  readonly frames: readonly ThreadDragFrame[];
  readonly metrics: ThreadListDragMetrics;
  /** The dragged row's list key. */
  readonly sourceKey: string;
  /** Viewport y of the pointer. */
  readonly pointerY: number;
  readonly latch: ThreadDragLatch;
  readonly zones: {
    readonly pinned: ThreadDragZone | null;
    readonly settled: ThreadDragZone | null;
  };
  readonly canDrop: (destination: ThreadDropDestination) => boolean;
  readonly canSettle: boolean;
}): ThreadDropTarget | null {
  const { rows, frames, metrics, pointerY } = input;
  if (withinZone(pointerY, input.zones.pinned)) {
    return input.canDrop(PIN_FIRST)
      ? { destination: PIN_FIRST, section: "pinned", barY: null, zone: "pinned" }
      : null;
  }
  if (withinZone(pointerY, input.zones.settled)) {
    return { destination: SETTLE, section: "settled", barY: null, zone: "settled" };
  }
  if (rows.length === 0) return null;
  const itemY = threadDragItemY(pointerY, metrics);
  const slot = (
    section: "pinned" | "active",
    anchor: ThreadDragRow | null,
    placement: "before" | "after",
    barY: number,
  ): ThreadDropTarget | null => {
    const destination: ThreadDropDestination = {
      section,
      targetId: anchor?.threadKey ?? null,
      placement,
    };
    return input.canDrop(destination) ? { destination, section, barY, zone: null } : null;
  };
  const sectionRows = (section: "pinned" | "active") =>
    rows.filter(
      (row) => row.kind === "thread" && row.section === section && row.key !== input.sourceKey,
    );

  const band = threadDragBoundaryBand(rows, frames);
  if (band !== null && itemY >= band.top && itemY <= band.bottom) {
    if (input.latch.section === "pinned") {
      const last = sectionRows("pinned").at(-1) ?? null;
      return slot("pinned", last, last === null ? "before" : "after", band.line);
    }
    return slot("active", sectionRows("active")[0] ?? null, "before", band.line);
  }

  const under =
    rows.find((row) => {
      const frame = frames[row.index];
      return frame !== undefined && itemY < frame.top + frame.height;
    }) ?? rows.at(-1);
  const frame = under === undefined ? undefined : frames[under.index];
  if (under === undefined || frame === undefined) return null;
  if (under.section === "settled") {
    if (!input.canSettle) return null;
    const header = rows.find((row) => row.kind === "shelf" && row.section === "settled");
    const headerFrame = header === undefined ? undefined : frames[header.index];
    return {
      destination: SETTLE,
      section: "settled",
      barY: headerFrame === undefined ? frame.top : headerFrame.top + headerFrame.height,
      zone: null,
    };
  }
  if (under.section === "pending") {
    // Queued tasks sit above every thread: a drop on them means the first slot below them.
    const first = rows.find(
      (row) => row.kind === "thread" && (row.section === "pinned" || row.section === "active"),
    );
    const firstFrame = first === undefined ? undefined : frames[first.index];
    if (first === undefined || firstFrame === undefined) return null;
    if (first.section !== "pinned" && first.section !== "active") return null;
    return first.key === input.sourceKey
      ? null
      : slot(first.section, first, "before", firstFrame.top);
  }
  if (under.kind !== "thread" || (under.section !== "pinned" && under.section !== "active")) {
    return null;
  }
  if (under.key === input.sourceKey) return null;
  const before = itemY < frame.top + frame.height / 2;
  return slot(
    under.section,
    under,
    before ? "before" : "after",
    before ? frame.top : frame.top + frame.height,
  );
}

/** Points per millisecond at the very edge. */
const SCROLL_MAX_SPEED = 0.9;

/**
 * How fast the list scrolls under a held row, in points per millisecond: up (negative) near the
 * top, down near the bottom, faster toward the edge. The top zone starts below the bar that
 * covers the list, not at the viewport's edge under it.
 */
export function threadDragScrollVelocity(input: {
  readonly pointerY: number;
  readonly metrics: Pick<ThreadListDragMetrics, "viewportHeight" | "contentInsetTop">;
}): number {
  const top = input.metrics.contentInsetTop;
  const bottom = input.metrics.viewportHeight;
  if (bottom - top < THREAD_DRAG_SCROLL_ZONE * 2) return 0;
  if (input.pointerY < top + THREAD_DRAG_SCROLL_ZONE) {
    const depth = Math.min(
      1,
      (top + THREAD_DRAG_SCROLL_ZONE - input.pointerY) / THREAD_DRAG_SCROLL_ZONE,
    );
    return -depth * SCROLL_MAX_SPEED;
  }
  if (input.pointerY > bottom - THREAD_DRAG_SCROLL_ZONE) {
    const depth = Math.min(
      1,
      (input.pointerY - bottom + THREAD_DRAG_SCROLL_ZONE) / THREAD_DRAG_SCROLL_ZONE,
    );
    return depth * SCROLL_MAX_SPEED;
  }
  return 0;
}

/**
 * The offsets auto-scroll may reach: from the list's top, which is minus its inset, to its end.
 */
export function threadDragScrollRange(
  metrics: Pick<ThreadListDragMetrics, "scroll" | "contentInsetTop" | "distanceFromEnd">,
): { readonly minimum: number; readonly maximum: number } {
  return {
    minimum: -metrics.contentInsetTop,
    maximum: metrics.scroll + Math.max(0, metrics.distanceFromEnd),
  };
}

/** The next offset of an auto-scroll step. It never jumps a list that already sits past a limit. */
export function nextThreadDragScrollOffset(input: {
  readonly current: number;
  readonly range: { readonly minimum: number; readonly maximum: number };
  readonly velocity: number;
  readonly elapsedMs: number;
}): number {
  const minimum = Math.min(input.current, input.range.minimum);
  const maximum = Math.max(input.current, input.range.maximum);
  return Math.max(minimum, Math.min(maximum, input.current + input.velocity * input.elapsedMs));
}

/** A finger that holds this long, then moves along the list, lifts the row under it. */
export const THREAD_DRAG_TOUCH_HOLD_MS = 290;
/** Before the hold, travel past this is a scroll or a swipe: the drag gives way at once. */
const TOUCH_FAIL_TRAVEL = 10;
/** After the hold, travel past this along the list starts the drag. */
const TOUCH_ACTIVATE_TRAVEL = 8;
/** A mouse or trackpad click that travels this far lifts the row, with no hold. */
const MOUSE_ACTIVATE_TRAVEL = 8;
/** A pressed pointer that rests this long is a long press: its menu opens, not a drag. */
const MOUSE_REST_MS = 140;

export type ThreadDragPointerKind = "touch" | "mouse";
export type ThreadDragActivation = "wait" | "activate" | "fail";

/**
 * Whether a pressed pointer has become a drag. A finger must hold, then move along the list:
 * moving first fails at once, so scroll and swipe never wait, and holding still never activates,
 * so the row's menu opens (`menuOpensAtMs`: from when a move is the menu's, on Android). A mouse
 * click lifts the row as soon as it travels along the list, as on desktop.
 */
export function threadDragActivation(input: {
  readonly pointer: ThreadDragPointerKind;
  /** Since the pointer went down. */
  readonly elapsedMs: number;
  /** Since the pointer last moved, or went down. */
  readonly restMs: number;
  readonly dx: number;
  readonly dy: number;
  readonly menuOpensAtMs: number | null;
}): ThreadDragActivation {
  "worklet";
  const absX = Math.abs(input.dx);
  const absY = Math.abs(input.dy);
  if (input.pointer === "mouse") {
    if (Math.max(absX, absY) < MOUSE_ACTIVATE_TRAVEL) {
      return input.restMs >= MOUSE_REST_MS ? "fail" : "wait";
    }
    return absY >= absX ? "activate" : "fail";
  }
  if (input.elapsedMs < THREAD_DRAG_TOUCH_HOLD_MS) {
    return Math.max(absX, absY) > TOUCH_FAIL_TRAVEL ? "fail" : "wait";
  }
  if (input.menuOpensAtMs !== null && input.elapsedMs >= input.menuOpensAtMs) return "fail";
  if (absY > TOUCH_ACTIVATE_TRAVEL && absY > absX) return "activate";
  if (absX > TOUCH_FAIL_TRAVEL && absX >= absY) return "fail";
  return "wait";
}

import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

import {
  advanceThreadDragLatch,
  describeThreadDragRows,
  nextThreadDragScrollOffset,
  readThreadListDragLayout,
  resolveThreadDropTarget,
  startThreadDragLatch,
  threadDragBoundaryBand,
  threadDragItemY,
  threadDragLiftRow,
  threadDragOrderVersion,
  threadDragOverlayZones,
  threadDragScrollRange,
  threadDragScrollVelocity,
  threadDragViewportY,
  threadListRestInsetTop,
  type ThreadDragLatch,
  type ThreadDragRow,
  type ThreadDragZone,
  type ThreadDropDestination,
  type ThreadDropTarget,
  type ThreadListDragLayout,
  type ThreadListDragListState,
} from "./threadListDrag";
import type { ThreadDragSection } from "./threadOrder";

/** The part of the list's ref the drag drives. */
export interface ThreadListDragList {
  readonly getState: () => ThreadListDragListState & { readonly scrollVelocity: number };
  readonly cancelScroll: () => void;
  readonly scrollToOffset: (params: { offset: number; animated: boolean }) => unknown;
  readonly reportContentInset: (inset: { top: number } | null) => void;
}

/** What the overlay draws that changes only when the drop under the pointer changes. */
export interface ThreadDragPreview {
  readonly title: string;
  /** The drop's verb, from `threadDragAction`. Null where the pointer means no drop. */
  readonly action: string | null;
  /** The floating target the pointer is on. */
  readonly zone: "pinned" | "settled" | null;
  readonly zones: {
    readonly pinned: ThreadDragZone | null;
    readonly settled: ThreadDragZone | null;
  };
  readonly cardHeight: number;
  readonly orderVersion: string;
}

/** Where the engine draws. The boundary backs these with shared values and one state. */
export interface ThreadListDragView {
  /** The lifted card follows the pointer on the UI thread from here on. */
  readonly lift: (card: {
    readonly originY: number;
    readonly grab: number;
    readonly height: number;
    readonly viewportHeight: number;
  }) => void;
  readonly drop: () => void;
  /** The insertion bar's viewport y, or null for none. */
  readonly setBar: (y: number | null) => void;
  /** The dragged row's own slot, which stays in the list, dimmed. */
  readonly setSource: (top: number, height: number) => void;
  readonly setPreview: (preview: ThreadDragPreview | null) => void;
  readonly requestFrame: (callback: (timestamp: number) => void) => number;
  readonly cancelFrame: (frame: number) => void;
}

/** What the screen says about its list on each call, so the engine never holds stale props. */
export interface ThreadListDragHost {
  readonly list: ThreadListDragList | null;
  readonly layout: Omit<ThreadListDragLayout, "viewportHeight">;
  /** False while a drop is saving or the list holds older rows, and for rows that cannot move. */
  readonly canLift: (thread: EnvironmentThreadShell) => boolean;
  readonly validate: (row: {
    readonly thread: EnvironmentThreadShell;
    readonly threadKey: string;
    readonly section: ThreadDragSection;
  }) => {
    readonly canSettle: boolean;
    readonly canDrop: (destination: ThreadDropDestination) => boolean;
  };
  readonly action: (source: ThreadDragSection, destination: ThreadDragSection) => string | null;
  readonly onLift?: () => void;
  readonly onDrop: (thread: EnvironmentThreadShell, destination: ThreadDropDestination) => void;
  /** Runs when a drag ends, dropped or not. */
  readonly onEnd?: () => void;
}

const CARD_MIN_HEIGHT = 52;
const CARD_MAX_HEIGHT = 96;

type LiftedRow = ThreadDragRow & {
  readonly section: ThreadDragSection;
  readonly thread: EnvironmentThreadShell;
  readonly threadKey: string;
};

interface Press {
  readonly row: LiftedRow;
  readonly originY: number;
  readonly viewportHeight: number;
  readonly grab: number;
  readonly cardHeight: number;
}

interface Drag extends Press {
  readonly rows: readonly ThreadDragRow[];
  readonly orderVersion: string;
  readonly insetTop: number;
  readonly canSettle: boolean;
  readonly canDrop: (destination: ThreadDropDestination) => boolean;
  /** Viewport y of the pointer. */
  pointerY: number;
  /** The scroll offset on screen: the list's own, or the one the last auto-scroll step asked for. */
  scroll: number;
  latch: ThreadDragLatch;
  target: ThreadDropTarget | null;
  shown: string;
  frame: number | null;
  lastTick: number | null;
}

/**
 * One list's direct drag: which row a press may lift, where the lifted row would drop as the
 * pointer and the list move, and the drop itself. It reads row geometry from the list on every
 * step and never changes the list's data; whatever starts the drag (a hold, a mouse, an Arrange
 * mode) calls `press`, `lift`, `move` and `release`.
 */
export function createThreadListDrag(view: ThreadListDragView) {
  let press: Press | null = null;
  let drag: Drag | null = null;
  /** The top inset the list's resting offsets have shown, beyond the one its screen passes. */
  let restInsetTop = 0;
  /** The screen's latest word on its list, for the auto-scroll steps between pointer moves. */
  let latestHost: ThreadListDragHost | null = null;

  const insetTop = (host: ThreadListDragHost) =>
    Math.max(host.layout.contentInsetTop, restInsetTop);

  const refresh = (host: ThreadListDragHost, current: Drag, list: ThreadListDragList) => {
    const { frames, metrics } = readThreadListDragLayout(
      list.getState(),
      { ...host.layout, contentInsetTop: current.insetTop, viewportHeight: current.viewportHeight },
      current.scroll,
    );
    const itemY = threadDragItemY(current.pointerY, metrics);
    current.latch = advanceThreadDragLatch(current.latch, {
      pointerY: current.pointerY,
      itemY,
      band: threadDragBoundaryBand(current.rows, frames),
    });
    const zones = threadDragOverlayZones({
      rows: current.rows,
      frames,
      metrics,
      canPin:
        current.row.section !== "pinned" &&
        current.canDrop({ section: "pinned", targetId: null, placement: "before" }),
      canSettle: current.canSettle,
    });
    const target = resolveThreadDropTarget({
      rows: current.rows,
      frames,
      metrics,
      sourceKey: current.row.key,
      pointerY: current.pointerY,
      latch: current.latch,
      zones,
      canDrop: current.canDrop,
      canSettle: current.canSettle,
    });
    current.target = target;
    view.setBar(
      target === null || target.barY === null ? null : threadDragViewportY(target.barY, metrics),
    );
    const source = frames[current.row.index];
    if (source !== undefined) {
      view.setSource(threadDragViewportY(source.top, metrics), source.height);
    }
    const action = target === null ? null : host.action(current.row.section, target.section);
    const shown = `${action ?? ""}|${target?.zone ?? ""}|${zones.pinned?.top ?? ""}|${zones.settled?.top ?? ""}`;
    if (shown === current.shown) return;
    current.shown = shown;
    view.setPreview({
      title: current.row.thread.title,
      action,
      zone: target?.zone ?? null,
      zones,
      cardHeight: current.cardHeight,
      orderVersion: current.orderVersion,
    });
  };

  const end = (host: ThreadListDragHost | null) => {
    const current = drag;
    if (current === null) return null;
    if (current.frame !== null) view.cancelFrame(current.frame);
    drag = null;
    latestHost = null;
    if (host === null) return current;
    host.list?.reportContentInset(null);
    view.drop();
    view.setBar(null);
    view.setPreview(null);
    host.onEnd?.();
    return current;
  };

  return {
    /** The order the drag was planned against, while one is lifted. */
    orderVersion: () => drag?.orderVersion ?? null,

    /**
     * A pointer went down at `pointerY` in the list's viewport. Returns whether a drag may lift
     * the row there.
     */
    press(
      host: ThreadListDragHost,
      pointer: {
        readonly pointerY: number;
        readonly originY: number;
        readonly viewportHeight: number;
      },
    ): boolean {
      press = null;
      const list = host.list;
      if (list === null || drag !== null) return false;
      const state = list.getState();
      // A press starts on a still list or on one coasting; only a still one shows its inset.
      restInsetTop = threadListRestInsetTop({
        known: restInsetTop,
        scroll: state.scroll,
        atRest: state.scrollVelocity === 0,
      });
      const rows = describeThreadDragRows(state.data);
      const { frames, metrics } = readThreadListDragLayout(state, {
        ...host.layout,
        contentInsetTop: insetTop(host),
        viewportHeight: pointer.viewportHeight,
      });
      const row = threadDragLiftRow({ rows, frames, metrics, pointerY: pointer.pointerY });
      const frame = row === null ? undefined : frames[row.index];
      if (
        row === null ||
        frame === undefined ||
        row.thread === undefined ||
        row.threadKey === undefined ||
        !host.canLift(row.thread)
      ) {
        return false;
      }
      const cardHeight = Math.max(CARD_MIN_HEIGHT, Math.min(CARD_MAX_HEIGHT, frame.height));
      press = {
        row: { ...row, thread: row.thread, threadKey: row.threadKey },
        originY: pointer.originY,
        viewportHeight: pointer.viewportHeight,
        // The card keeps the point the finger took the row by, as far as its own height allows.
        grab: Math.min(
          cardHeight,
          Math.max(0, pointer.pointerY - threadDragViewportY(frame.top, metrics)),
        ),
        cardHeight,
      };
      return true;
    },

    /** The pressed pointer became a drag. */
    lift(host: ThreadListDragHost, absoluteY: number): void {
      const pressed = press;
      const list = host.list;
      press = null;
      if (pressed === null || list === null || drag !== null) return;
      if (!host.canLift(pressed.row.thread)) return;
      // Before anything reads the scroll offset: a list still coasting would slide under the card.
      list.cancelScroll();
      const state = list.getState();
      restInsetTop = threadListRestInsetTop({
        known: restInsetTop,
        scroll: state.scroll,
        atRest: true,
      });
      const rows = describeThreadDragRows(state.data);
      // The row can have moved between the press and the lift.
      const row = rows.find((candidate) => candidate.key === pressed.row.key);
      if (row === undefined || row.section !== pressed.row.section) return;
      const validator = host.validate(pressed.row);
      const pointerY = absoluteY - pressed.originY;
      const current: Drag = {
        ...pressed,
        row: { ...pressed.row, index: row.index },
        rows,
        orderVersion: threadDragOrderVersion(rows),
        insetTop: insetTop(host),
        canSettle: validator.canSettle,
        canDrop: validator.canDrop,
        pointerY,
        scroll: state.scroll,
        latch: startThreadDragLatch(pressed.row.section, pointerY),
        target: null,
        shown: "",
        frame: null,
        lastTick: null,
      };
      drag = current;
      // The list clamps a scroll to the inset it knows. UIKit's own inset is not one of them.
      list.reportContentInset({ top: current.insetTop });
      host.onLift?.();
      view.lift({
        originY: current.originY,
        grab: current.grab,
        height: current.cardHeight,
        viewportHeight: current.viewportHeight,
      });
      refresh(host, current, list);
    },

    /** The lifted pointer moved. */
    move(host: ThreadListDragHost, absoluteY: number): void {
      const current = drag;
      const list = host.list;
      latestHost = host;
      if (current === null || list === null) return;
      current.pointerY = absoluteY - current.originY;
      const scrolling =
        threadDragScrollVelocity({
          pointerY: current.pointerY,
          metrics: { viewportHeight: current.viewportHeight, contentInsetTop: current.insetTop },
        }) !== 0;
      if (!scrolling) {
        current.scroll = list.getState().scroll;
        if (current.frame !== null) view.cancelFrame(current.frame);
        current.frame = null;
        current.lastTick = null;
      } else if (current.frame === null) {
        const tick = (timestamp: number) => {
          const active = drag;
          const activeHost = latestHost;
          const activeList = activeHost?.list ?? null;
          if (active !== current || activeHost === null || activeList === null) return;
          const elapsedMs =
            active.lastTick === null ? 16 : Math.min(32, timestamp - active.lastTick);
          active.lastTick = timestamp;
          const state = activeList.getState();
          const next = nextThreadDragScrollOffset({
            current: active.scroll,
            range: threadDragScrollRange({
              scroll: state.scroll,
              contentInsetTop: active.insetTop,
              distanceFromEnd: state.distanceFromEnd,
            }),
            velocity: threadDragScrollVelocity({
              pointerY: active.pointerY,
              metrics: { viewportHeight: active.viewportHeight, contentInsetTop: active.insetTop },
            }),
            elapsedMs,
          });
          if (next !== active.scroll) {
            active.scroll = next;
            activeList.scrollToOffset({ offset: next, animated: false });
            refresh(activeHost, active, activeList);
          }
          active.frame = view.requestFrame(tick);
        };
        current.frame = view.requestFrame(tick);
      }
      refresh(host, current, list);
    },

    /** The pointer came up, or the gesture was taken away (`dropped` false). */
    release(host: ThreadListDragHost, dropped: boolean): void {
      press = null;
      const current = end(host);
      if (current === null || !dropped || current.target === null) return;
      host.onDrop(current.row.thread, current.target.destination);
    },

    /** Ends a drag without a drop: the list changed under it, or drags were turned off. */
    cancel(host: ThreadListDragHost): void {
      press = null;
      end(host);
    },

    /** The list is gone: stops the auto-scroll steps and draws nothing more. */
    dispose(): void {
      press = null;
      end(null);
    },

    /** The list was resized: an inset learned at the old size may no longer hold. */
    forgetInset(): void {
      if (drag === null) restInsetTop = 0;
    },
  };
}

export type ThreadListDrag = ReturnType<typeof createThreadListDrag>;

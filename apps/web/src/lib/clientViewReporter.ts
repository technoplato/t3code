import {
  type ClientViewContent,
  clientViewSelection,
  type ClientViewTarget,
  type ClientViewTracker,
  makeClientViewTracker,
  type MeasuredViewRow,
  visibleViewItems,
} from "@t3tools/client-runtime/client-view";
import type { ClientView, EnvironmentId } from "@t3tools/contracts";

import { randomUUID } from "./utils";

const WINDOW_ID_STORAGE_KEY = "t3.clientView.windowId";
const VIEW_ITEM_SELECTOR = "[data-view-item-id]";

interface ViewedThread {
  readonly target: ClientViewTarget;
  readonly getScrollNode: () => HTMLElement | null;
}

let viewed: ViewedThread | null = null;
let active: ClientViewTracker | null = null;
let windowId: string | null = null;

// Session storage is per window, where the background reporter's client id is per browser profile.
function getWindowId(): string {
  if (windowId !== null) return windowId;
  try {
    const existing = window.sessionStorage.getItem(WINDOW_ID_STORAGE_KEY);
    windowId = existing || randomUUID();
    if (!existing) window.sessionStorage.setItem(WINDOW_ID_STORAGE_KEY, windowId);
  } catch {
    windowId = randomUUID();
  }
  return windowId;
}

function viewItemOf(node: Node): HTMLElement | null {
  const element = "closest" in node ? (node as Element) : node.parentElement;
  return element?.closest<HTMLElement>(VIEW_ITEM_SELECTOR) ?? null;
}

/** The timeline rows that show in `scrollNode`, and the text selected inside it. */
export function readTimelineView(scrollNode: HTMLElement): ClientViewContent {
  const rows: MeasuredViewRow[] = [];
  for (const row of scrollNode.querySelectorAll<HTMLElement>(VIEW_ITEM_SELECTOR)) {
    const id = row.dataset.viewItemId;
    if (!id) continue;
    const { top, bottom } = row.getBoundingClientRect();
    rows.push({ id, kind: row.dataset.viewItemKind, top, bottom });
  }
  const selection = scrollNode.ownerDocument.getSelection();
  const range =
    selection && !selection.isCollapsed && selection.rangeCount > 0
      ? selection.getRangeAt(0)
      : null;
  // Only a selection wholly inside the timeline: text in the composer is never read.
  const selected =
    selection && range && scrollNode.contains(range.commonAncestorContainer)
      ? clientViewSelection(
          selection.toString(),
          viewItemOf(range.startContainer)?.dataset.viewItemId,
        )
      : undefined;
  return {
    items: visibleViewItems(scrollNode.getBoundingClientRect(), rows),
    ...(selected === undefined ? {} : { selection: selected }),
  };
}

/** Says which thread this window shows until the returned cleanup runs. */
export function viewThread(
  target: ClientViewTarget,
  getScrollNode: () => HTMLElement | null,
): () => void {
  const entry: ViewedThread = { target, getScrollNode };
  viewed = entry;
  active?.setThread(target);
  return () => {
    // Another thread may already have taken over.
    if (viewed !== entry) return;
    viewed = null;
    active?.setThread(null);
  };
}

export function clientViewFor(environmentId: EnvironmentId): ClientView | undefined {
  return active?.viewFor(environmentId);
}

/** Watches this window's input and scrolling; `onChange` runs when `clientViewFor` has news. */
export function observeClientView(options: {
  readonly nowMs: () => number;
  readonly onChange: () => void;
}): () => void {
  const tracker = makeClientViewTracker({
    windowId: getWindowId,
    nowMs: options.nowMs,
    setTimer: (run, delayMs) => {
      const timer = window.setTimeout(run, delayMs);
      return () => window.clearTimeout(timer);
    },
    readContent: () => {
      const scrollNode = viewed?.getScrollNode();
      return scrollNode ? readTimelineView(scrollNode) : { items: [] };
    },
    readFocused: () => document.hasFocus(),
    onChange: options.onChange,
  });
  active = tracker;
  tracker.setThread(viewed?.target ?? null);

  const passive = { passive: true } as const;
  const captured = { capture: true, passive: true } as const;
  // A click or a wheel can change what shows without a scroll event; typing cannot.
  const onPointer = () => {
    tracker.recordGesture();
    tracker.touch();
  };
  const onSelectionChange = () => {
    // Extending a selection is the user's doing; a collapsed caret moves while typing.
    if (document.getSelection()?.isCollapsed === false) tracker.recordGesture();
    tracker.touch();
  };
  // Scroll does not bubble; capturing hears the timeline wherever it mounts. A reply that
  // streams in scrolls too, so this only looks again and never counts as a gesture.
  const onScroll = (event: Event) => {
    if (viewed?.getScrollNode()?.contains(event.target as Node | null)) tracker.touch();
  };
  window.addEventListener("pointerdown", onPointer, passive);
  window.addEventListener("wheel", onPointer, passive);
  window.addEventListener("touchstart", onPointer, passive);
  window.addEventListener("keydown", tracker.recordGesture);
  window.addEventListener("resize", tracker.touch);
  window.addEventListener("focus", tracker.refresh);
  window.addEventListener("blur", tracker.refresh);
  document.addEventListener("visibilitychange", tracker.refresh);
  document.addEventListener("selectionchange", onSelectionChange);
  document.addEventListener("scroll", onScroll, captured);

  return () => {
    window.removeEventListener("pointerdown", onPointer);
    window.removeEventListener("wheel", onPointer);
    window.removeEventListener("touchstart", onPointer);
    window.removeEventListener("keydown", tracker.recordGesture);
    window.removeEventListener("resize", tracker.touch);
    window.removeEventListener("focus", tracker.refresh);
    window.removeEventListener("blur", tracker.refresh);
    document.removeEventListener("visibilitychange", tracker.refresh);
    document.removeEventListener("selectionchange", onSelectionChange);
    document.removeEventListener("scroll", onScroll, captured);
    tracker.dispose();
    if (active === tracker) active = null;
  };
}

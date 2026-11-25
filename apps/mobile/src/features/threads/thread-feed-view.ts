import {
  type ClientViewContent,
  type MeasuredViewRow,
  visibleViewItems,
} from "@t3tools/client-runtime/client-view";

import type { ThreadFeedRow } from "./pending-thread-feed";

/** What the feed's list knows about its rows; the subset of its state read here. */
interface FeedListState {
  readonly data: ReadonlyArray<unknown>;
  /** First and last row in the viewport, without the draw buffer; -1 before layout. */
  readonly start: number;
  readonly end: number;
  readonly scrollLength: number;
  readonly indexByKey: (key: string) => number | undefined;
  readonly positionAtIndex: (index: number) => number | undefined;
  readonly sizeAtIndex: (index: number) => number | undefined;
}

/** The part of the feed's list read here. */
interface FeedList {
  readonly getState: () => FeedListState;
  readonly anchorVisibleContent: (options: {
    readonly hold: false;
  }) => { readonly key: string; readonly offset: number } | undefined;
}

/**
 * Where the list's top edge is, in the space of its row positions, which leave out its header and
 * padding. Undefined before the list has placed its rows and while it swaps to another thread;
 * its raw scroll offset is in another space and is no substitute.
 */
export function threadFeedViewportStart(list: FeedList): number | undefined {
  const visible = list.anchorVisibleContent({ hold: false });
  if (!visible) return undefined;
  const state = list.getState();
  const index = state.indexByKey(visible.key);
  const position = index === undefined ? undefined : state.positionAtIndex(index);
  return position === undefined ? undefined : position + visible.offset;
}

/** The record a feed row shows, by an id its server can look up. Null for chrome rows. */
export function threadFeedViewItem(
  row: ThreadFeedRow,
): { readonly id: string; readonly kind: string } | null {
  switch (row.type) {
    case "message":
      return { id: row.message.id, kind: row.message.role };
    case "activity-group": {
      const [activity] = row.activities;
      return activity ? { id: activity.id, kind: "tool" } : null;
    }
    case "mcp-app":
      return { id: row.itemId, kind: "tool" };
    default:
      return null;
  }
}

/** Whether a link's id names this feed row: a message, or the record another row shows. */
export function threadFeedEntryMatchesJumpId(entry: ThreadFeedRow, id: string): boolean {
  return (entry.type === "message" && entry.id === id) || threadFeedViewItem(entry)?.id === id;
}

/**
 * The rows the person can see with the part of each that shows: what lies between the bar that
 * covers the list's top (`anchorTopInset`) and the composer that covers its bottom
 * (`bottomContentInset`). A link built from an item's `from` lands that same line on its row.
 */
export function readThreadFeedView(
  list: FeedList | null | undefined,
  insets: { readonly anchorTopInset: number; readonly bottomContentInset: number },
): ClientViewContent {
  const state = list?.getState();
  if (!list || !state || state.start < 0 || state.end < state.start) return { items: [] };
  const viewportStart = threadFeedViewportStart(list);
  if (viewportStart === undefined) return { items: [] };
  const rows: Array<MeasuredViewRow> = [];
  for (let index = state.start; index <= state.end; index += 1) {
    const top = state.positionAtIndex(index);
    const size = state.sizeAtIndex(index);
    if (top === undefined || size === undefined) continue;
    const item = threadFeedViewItem(state.data[index] as ThreadFeedRow);
    if (item) rows.push({ ...item, top, bottom: top + size });
  }

  const top = viewportStart + insets.anchorTopInset;
  const bottom =
    viewportStart + Math.max(insets.anchorTopInset, state.scrollLength - insets.bottomContentInset);
  return { items: visibleViewItems({ top, bottom }, rows) };
}

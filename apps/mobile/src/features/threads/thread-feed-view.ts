import { type ClientViewContent, visibleViewItems } from "@t3tools/client-runtime/client-view";

import type { ThreadFeedRow } from "./pending-thread-feed";

/** What the feed's list knows about its rows; the subset of its state read here. */
interface FeedListState {
  readonly data: ReadonlyArray<unknown>;
  /** First and last row in the viewport, without the draw buffer; -1 before layout. */
  readonly start: number;
  readonly end: number;
  readonly scroll: number;
  readonly scrollLength: number;
  readonly positionAtIndex: (index: number) => number | undefined;
  readonly sizeAtIndex: (index: number) => number | undefined;
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

/**
 * The rows in the feed's viewport with the part of each that shows. Row positions leave out the
 * list's header and top padding, which its state does not expose, so the viewport's top is the
 * scroll offset held inside the range the list's own first and last visible rows allow.
 */
export function readThreadFeedView(state: FeedListState | undefined): ClientViewContent {
  if (!state || state.start < 0 || state.end < state.start) return { items: [] };
  const rows: Array<{
    readonly index: number;
    readonly top: number;
    readonly bottom: number;
  }> = [];
  for (let index = state.start; index <= state.end; index += 1) {
    const top = state.positionAtIndex(index);
    const size = state.sizeAtIndex(index);
    if (top === undefined || size === undefined) continue;
    rows.push({ index, top, bottom: top + size });
  }
  const first = rows[0];
  const last = rows.at(-1);
  if (!first || !last) return { items: [] };

  const length = state.scrollLength;
  const lowest = Math.max(
    state.start > 0 ? first.top : Number.NEGATIVE_INFINITY,
    last.top - length,
  );
  const highest = Math.min(
    first.bottom,
    state.end < state.data.length - 1 ? last.bottom - length : Number.POSITIVE_INFINITY,
  );
  const top = lowest <= highest ? Math.min(Math.max(state.scroll, lowest), highest) : state.scroll;

  return {
    items: visibleViewItems(
      { top, bottom: top + length },
      rows.flatMap((row) => {
        const item = threadFeedViewItem(state.data[row.index] as ThreadFeedRow);
        return item ? [{ ...item, top: row.top, bottom: row.bottom }] : [];
      }),
    ),
  };
}

import { describe, expect, it } from "vite-plus/test";

import {
  readThreadFeedView,
  threadFeedEntryMatchesJumpId,
  threadFeedViewItem,
} from "./thread-feed-view";

type Row = Parameters<typeof threadFeedViewItem>[0];

const message = (id: string, role: "user" | "assistant") =>
  ({ type: "message", id, message: { id, role } }) as unknown as Row;
const tools = (id: string, ...activityIds: string[]) =>
  ({ type: "activity-group", id, activities: activityIds.map((id) => ({ id })) }) as unknown as Row;
const fold = (id: string) => ({ type: "run-fold", id }) as unknown as Row;

const NO_INSETS = { anchorTopInset: 0, bottomContentInset: 0 };

/**
 * A list laid out top to bottom from row heights, whose top edge is at row position
 * `viewportStart`. The list's raw scroll offset is left out: it counts a header and padding the
 * row positions do not.
 */
function feedList(input: {
  readonly rows: ReadonlyArray<readonly [Row, number]>;
  readonly viewportStart: number;
  readonly scrollLength: number;
  readonly placed?: boolean;
}) {
  const positions: number[] = [];
  let offset = 0;
  for (const [, height] of input.rows) {
    positions.push(offset);
    offset += height;
  }
  const top = input.viewportStart;
  const visible = input.rows.flatMap(([, height], index) =>
    positions[index]! + height > top && positions[index]! < top + input.scrollLength ? [index] : [],
  );
  const first = visible[0];
  const state = {
    data: input.rows.map(([row]) => row),
    start: first ?? -1,
    end: visible.at(-1) ?? -1,
    scrollLength: input.scrollLength,
    indexByKey: (key: string) => {
      const index = input.rows.findIndex(([row]) => row.id === key);
      return index < 0 ? undefined : index;
    },
    positionAtIndex: (index: number): number | undefined => positions[index],
    sizeAtIndex: (index: number) => input.rows[index]?.[1],
  };
  return {
    state,
    getState: () => state,
    anchorVisibleContent: () =>
      input.placed === false || first === undefined
        ? undefined
        : { key: input.rows[first]![0].id, offset: top - positions[first]! },
  };
}

describe("threadFeedViewItem", () => {
  it("names messages and tool groups, and skips chrome rows", () => {
    expect(threadFeedViewItem(message("message-1", "assistant"))).toEqual({
      id: "message-1",
      kind: "assistant",
    });
    expect(threadFeedViewItem(tools("group-1", "item-1", "item-2"))).toEqual({
      id: "item-1",
      kind: "tool",
    });
    expect(threadFeedViewItem(tools("group-empty"))).toBeNull();
    expect(threadFeedViewItem(fold("fold-1"))).toBeNull();
  });

  it("finds the row a link names by the same id it reports", () => {
    expect(threadFeedEntryMatchesJumpId(message("message-1", "assistant"), "message-1")).toBe(true);
    expect(threadFeedEntryMatchesJumpId(tools("group-1", "item-1", "item-2"), "item-1")).toBe(true);
    expect(threadFeedEntryMatchesJumpId(tools("group-1", "item-1", "item-2"), "group-1")).toBe(
      false,
    );
    expect(threadFeedEntryMatchesJumpId(fold("fold-1"), "fold-1")).toBe(false);
  });
});

describe("readThreadFeedView", () => {
  const rows = [
    [message("message-1", "user"), 200],
    [tools("group-1", "item-1"), 100],
    [fold("fold-1"), 50],
    [message("message-2", "assistant"), 2_000],
    [message("message-3", "user"), 150],
  ] as const;

  it("reports the rows in the viewport with the part of each that shows", () => {
    expect(
      readThreadFeedView(feedList({ rows, viewportStart: 100, scrollLength: 600 }), NO_INSETS)
        .items,
    ).toEqual([
      { id: "message-1", kind: "user", from: 0.5, to: 1 },
      { id: "item-1", kind: "tool", from: 0, to: 1 },
      { id: "message-2", kind: "assistant", from: 0, to: 0.18 },
    ]);
  });

  it("finds the middle of a reply longer than the screen", () => {
    expect(
      readThreadFeedView(feedList({ rows, viewportStart: 1_150, scrollLength: 600 }), NO_INSETS)
        .items,
    ).toEqual([{ id: "message-2", kind: "assistant", from: 0.4, to: 0.7 }]);
  });

  it("measures from under the bar to above the composer", () => {
    // The bar covers the list's top 100pt and the composer its bottom 190pt, so the person sees
    // row positions 200 to 510: none of message-1, and message-2 from its start.
    const list = feedList({ rows, viewportStart: 100, scrollLength: 600 });
    expect(
      readThreadFeedView(list, { anchorTopInset: 100, bottomContentInset: 190 }).items,
    ).toEqual([
      { id: "item-1", kind: "tool", from: 0, to: 1 },
      { id: "message-2", kind: "assistant", from: 0, to: 0.08 },
    ]);
    // A composer taller than the list leaves nothing in view, not a viewport turned inside out.
    expect(
      readThreadFeedView(list, { anchorTopInset: 100, bottomContentInset: 900 }).items,
    ).toEqual([]);
  });

  it("reports nothing before the list has placed its rows", () => {
    expect(readThreadFeedView(undefined, NO_INSETS).items).toEqual([]);
    expect(
      readThreadFeedView(feedList({ rows: [], viewportStart: 0, scrollLength: 600 }), NO_INSETS)
        .items,
    ).toEqual([]);
    expect(
      readThreadFeedView(
        feedList({ rows, viewportStart: 0, scrollLength: 600, placed: false }),
        NO_INSETS,
      ).items,
    ).toEqual([]);
    const unpositioned = feedList({ rows, viewportStart: 0, scrollLength: 600 });
    expect(
      readThreadFeedView(
        {
          ...unpositioned,
          getState: () => ({ ...unpositioned.state, positionAtIndex: () => undefined }),
        },
        NO_INSETS,
      ).items,
    ).toEqual([]);
  });
});

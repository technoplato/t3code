import { describe, expect, it } from "vite-plus/test";

import { readThreadFeedView, threadFeedViewItem } from "./thread-feed-view";

type Row = Parameters<typeof threadFeedViewItem>[0];

const message = (id: string, role: "user" | "assistant") =>
  ({ type: "message", id, message: { id, role } }) as unknown as Row;
const tools = (id: string, ...activityIds: string[]) =>
  ({ type: "activity-group", id, activities: activityIds.map((id) => ({ id })) }) as unknown as Row;
const fold = (id: string) => ({ type: "run-fold", id }) as unknown as Row;

/** A list laid out top to bottom from row heights, scrolled to `scroll` under a header. */
function listState(input: {
  readonly rows: ReadonlyArray<readonly [Row, number]>;
  readonly scroll: number;
  readonly scrollLength: number;
  readonly headerSize?: number;
}) {
  const positions: number[] = [];
  let offset = 0;
  for (const [, height] of input.rows) {
    positions.push(offset);
    offset += height;
  }
  const top = input.scroll - (input.headerSize ?? 0);
  const visible = input.rows.flatMap(([, height], index) =>
    positions[index]! + height > top && positions[index]! < top + input.scrollLength ? [index] : [],
  );
  return {
    data: input.rows.map(([row]) => row),
    start: visible[0] ?? -1,
    end: visible.at(-1) ?? -1,
    scroll: input.scroll,
    scrollLength: input.scrollLength,
    positionAtIndex: (index: number) => positions[index],
    sizeAtIndex: (index: number) => input.rows[index]?.[1],
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
    expect(readThreadFeedView(listState({ rows, scroll: 100, scrollLength: 600 })).items).toEqual([
      { id: "message-1", kind: "user", from: 0.5, to: 1 },
      { id: "item-1", kind: "tool", from: 0, to: 1 },
      { id: "message-2", kind: "assistant", from: 0, to: 0.18 },
    ]);
  });

  it("finds the middle of a reply longer than the screen", () => {
    expect(readThreadFeedView(listState({ rows, scroll: 1_150, scrollLength: 600 })).items).toEqual(
      [{ id: "message-2", kind: "assistant", from: 0.4, to: 0.7 }],
    );
  });

  it("stays within what the list calls visible when a header offsets the scroll", () => {
    // The offset includes a 120pt header the row positions leave out.
    const state = listState({ rows, scroll: 2_270, scrollLength: 600, headerSize: 120 });
    expect([state.start, state.end]).toEqual([3, 4]);
    const { items } = readThreadFeedView(state);
    expect(items.map((item) => item.id)).toEqual(["message-2", "message-3"]);
    expect(items[1]).toMatchObject({ from: 0, to: 1 });
    expect(items[0]?.to).toBe(1);
  });

  it("reports nothing before the list has laid out", () => {
    expect(readThreadFeedView(undefined).items).toEqual([]);
    expect(readThreadFeedView(listState({ rows: [], scroll: 0, scrollLength: 600 })).items).toEqual(
      [],
    );
    expect(
      readThreadFeedView({
        ...listState({ rows, scroll: 0, scrollLength: 600 }),
        positionAtIndex: () => undefined,
      }).items,
    ).toEqual([]);
  });
});

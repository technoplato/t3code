import { describe, expect, it } from "vite-plus/test";

import {
  createChatListHistoryPaging,
  resolveChatListMessageStep,
  type ChatListHistory,
} from "./chatList.ts";

describe("resolveChatListMessageStep", () => {
  // Rows 1, 2 and 4 are not messages: work, an empty reply, a system divider.
  const positions = [0, 120, 180, 220, 700, 740, 900];
  const messages = [
    { rowIndex: 0, rowId: "user-1" },
    { rowIndex: 3, rowId: "assistant-1" },
    { rowIndex: 5, rowId: "user-2" },
    { rowIndex: 6, rowId: "assistant-2" },
  ];
  const step = (
    input: Partial<Parameters<typeof resolveChatListMessageStep>[0]> & {
      readonly direction: "previous" | "next";
      readonly scroll: number;
    },
  ) =>
    resolveChatListMessageStep({
      candidates: messages,
      atStart: false,
      atEnd: false,
      positionAtIndex: (index) => positions[index],
      targetOffset: 24,
      ...input,
    });

  it("lands on the start of the long message being read, then steps back one message at a time", () => {
    expect(step({ direction: "previous", scroll: 1400, atEnd: true })).toEqual({
      kind: "row",
      earlierCount: 3,
      rowIndex: 6,
      rowId: "assistant-2",
    });
    // Resting on assistant-2 (900 - 24): the step before it is user-2.
    expect(step({ direction: "previous", scroll: 876 })).toEqual({
      kind: "row",
      earlierCount: 2,
      rowIndex: 5,
      rowId: "user-2",
    });
    expect(step({ direction: "previous", scroll: 0, atStart: true })).toBeNull();
  });

  it("counts from the row a step is still scrolling to, even one that is not a candidate", () => {
    expect(step({ direction: "previous", scroll: 1400, atEnd: true, pendingRowIndex: 5 })).toEqual({
      kind: "row",
      earlierCount: 1,
      rowIndex: 3,
      rowId: "assistant-1",
    });
    expect(step({ direction: "next", scroll: 0, pendingRowIndex: 4 })).toEqual({
      kind: "row",
      earlierCount: 2,
      rowIndex: 5,
      rowId: "user-2",
    });
    expect(step({ direction: "previous", scroll: 1400, pendingRowIndex: 0 })).toBeNull();
  });

  it("steps forward one message at a time and asks for the end after the last one", () => {
    expect(step({ direction: "next", scroll: 0, atStart: true })).toEqual({
      kind: "row",
      earlierCount: 1,
      rowIndex: 3,
      rowId: "assistant-1",
    });
    expect(step({ direction: "next", scroll: 876, pendingRowIndex: 6 })).toEqual({ kind: "end" });
    expect(step({ direction: "next", scroll: 876 })).toEqual({ kind: "end" });
    expect(step({ direction: "next", scroll: 1400, atEnd: true })).toBeNull();
    expect(step({ direction: "next", scroll: 1400, atEnd: true, pendingRowIndex: 6 })).toBeNull();
  });

  it("steps only between the candidates it is given", () => {
    const fromUser = messages.filter((message) => message.rowId.startsWith("user"));
    expect(step({ candidates: fromUser, direction: "previous", scroll: 1400 })).toEqual({
      kind: "row",
      earlierCount: 1,
      rowIndex: 5,
      rowId: "user-2",
    });
    expect(step({ candidates: fromUser, direction: "next", scroll: 0 })).toEqual({
      kind: "row",
      earlierCount: 1,
      rowIndex: 5,
      rowId: "user-2",
    });
    expect(step({ candidates: [], direction: "next", scroll: 0 })).toBeNull();
  });

  it("uses the visible range for rows the list has not measured yet", () => {
    const unmeasured = { positionAtIndex: () => undefined, visibleStart: 4 };
    expect(step({ ...unmeasured, direction: "previous", scroll: 800 })).toEqual({
      kind: "row",
      earlierCount: 1,
      rowIndex: 3,
      rowId: "assistant-1",
    });
    expect(step({ ...unmeasured, direction: "next", scroll: 800 })).toEqual({
      kind: "row",
      earlierCount: 2,
      rowIndex: 5,
      rowId: "user-2",
    });
  });
});

describe("createChatListHistoryPaging", () => {
  /** A list of message rows (and `work-` rows, which are not), with history above it. */
  function setup(initialRows: ReadonlyArray<string>) {
    let rows = [...initialRows];
    const loads: number[] = [];
    const events: string[] = [];
    let frames: Array<() => void> = [];
    let history: ChatListHistory = {
      hasMoreHistory: true,
      loading: false,
      error: null,
      onLoadEarlier: () => loads.push(rows.length),
    };
    const paging = createChatListHistoryPaging();
    paging.setHost({
      headId: () => rows[0] ?? "__empty__",
      hasEarlier: (anchorRowId) => {
        const index = rows.indexOf(anchorRowId);
        if (index < 0) return undefined;
        return rows.slice(0, index).some((row) => !row.startsWith("work-"));
      },
      stepFrom: (anchorRowId) => {
        events.push(`step from ${anchorRowId}`);
        return true;
      },
      onStepped: () => events.push("stepped"),
      onExhausted: () => events.push("exhausted"),
      requestFrame: (callback) => frames.push(callback),
    });
    paging.setHistory(history, "thread-1");
    const commit = (next: Partial<ChatListHistory>, earlier: ReadonlyArray<string> = []) => {
      rows = [...earlier, ...rows];
      history = { ...history, ...next };
      paging.setHistory(history, "thread-1");
    };
    return {
      paging,
      loads,
      events,
      commit,
      /** Runs the frames asked for so far. */
      frame: () => {
        const due = frames;
        frames = [];
        for (const callback of due) callback();
      },
    };
  }
  const start = (anchorRowId: string | null) => ({ kind: "start", anchorRowId }) as const;

  it("asks for the page before once a step back comes near the loaded start, once per head", () => {
    const list = setup(["a", "b", "c", "d"]);
    expect(list.paging.afterStep("previous", { kind: "row", earlierCount: 3 }, false)).toBe("row");
    expect(list.loads).toEqual([]);
    list.paging.afterStep("previous", { kind: "row", earlierCount: 2 }, false);
    list.paging.afterStep("previous", { kind: "row", earlierCount: 1 }, true);
    list.paging.prefetch();
    expect(list.loads).toEqual([4]);
    // Forward steps never load.
    list.commit({ loading: true });
    list.commit({ loading: false }, ["older"]);
    list.paging.afterStep("next", { kind: "row", earlierCount: 0 }, false);
    expect(list.loads).toEqual([4]);
  });

  it("steps into history a tap at the start waited for, once it lands", () => {
    const list = setup(["a", "b"]);
    expect(list.paging.afterStep("previous", start("a"), false)).toBe("loading");
    expect(list.loads).toEqual([2]);
    // Many steps in one go, before the list shows it loading, ask once.
    expect(list.paging.afterStep("previous", start("a"), false)).toBe("loading");
    expect(list.loads).toEqual([2]);
    list.commit({ loading: true });
    expect(list.paging.afterStep("previous", start("a"), false)).toBe("loading");
    list.commit({ loading: false }, ["x", "y"]);
    expect(list.events).toEqual(["step from a", "stepped"]);
    // Done: a later commit takes no second step.
    list.commit({}, ["z"]);
    expect(list.events).toHaveLength(2);
  });

  it("waits frames for landed history to show, then gives up with one thud", () => {
    const list = setup(["a"]);
    list.paging.afterStep("previous", start("a"), false);
    list.commit({ loading: true });
    // Loading ends a commit before its rows show.
    list.commit({ loading: false });
    expect(list.events).toEqual([]);
    for (let frame = 0; frame < 5; frame += 1) list.frame();
    expect(list.events).toEqual(["exhausted"]);
    list.frame();
    expect(list.events).toEqual(["exhausted"]);
  });

  it("loads again past pages of work alone, up to three, then thuds", () => {
    const list = setup(["a"]);
    list.paging.afterStep("previous", start("a"), false);
    for (let page = 1; page <= 3; page += 1) {
      list.commit({ loading: true });
      list.commit({ loading: false }, [`work-${page}`]);
      expect(list.loads).toHaveLength(page + 1);
    }
    list.commit({ loading: true });
    list.commit({ loading: false }, ["work-4"]);
    expect(list.loads).toHaveLength(4);
    expect(list.events).toEqual(["exhausted"]);
  });

  it("steps into the last page even though no more history is left", () => {
    const list = setup(["a"]);
    list.paging.afterStep("previous", start("a"), false);
    list.commit({ loading: true });
    list.commit({ loading: false, hasMoreHistory: false }, ["first"]);
    expect(list.events).toEqual(["step from a", "stepped"]);
    expect(list.paging.afterStep("previous", start("first"), false)).toBe("none");
  });

  it("lets a scroll, a step forward or a held arrow take over from a waiting tap", () => {
    for (const takeOver of [
      (list: ReturnType<typeof setup>) => list.paging.cancel(),
      (list: ReturnType<typeof setup>) =>
        list.paging.afterStep("next", { kind: "row", earlierCount: 1 }, false),
      (list: ReturnType<typeof setup>) => list.paging.afterStep("previous", start("a"), true),
      // Another thread.
      (list: ReturnType<typeof setup>) =>
        list.paging.setHistory(
          { hasMoreHistory: true, loading: true, error: null, onLoadEarlier: () => {} },
          "thread-2",
        ),
    ]) {
      const list = setup(["a"]);
      list.paging.afterStep("previous", start("a"), false);
      list.commit({ loading: true });
      takeOver(list);
      list.commit({ loading: false }, ["x"]);
      expect(list.events).toEqual([]);
    }
  });

  it("keeps a held arrow waiting while history loads, and stops it on a failed load", () => {
    const list = setup(["a"]);
    expect(list.paging.afterStep("previous", start("a"), true)).toBe("loading");
    list.commit({ loading: true });
    expect(list.paging.afterStep("previous", start("a"), true)).toBe("loading");
    list.commit({ loading: false, error: "offline" });
    expect(list.paging.afterStep("previous", start("a"), true)).toBe("none");
    expect(list.loads).toHaveLength(1);
    // A tap tries again.
    expect(list.paging.afterStep("previous", start("a"), false)).toBe("loading");
    expect(list.loads).toHaveLength(2);
  });

  it("passes through the end, and a start with no history to load", () => {
    const list = setup(["a"]);
    expect(list.paging.afterStep("next", { kind: "end" }, false)).toBe("end");
    expect(list.paging.afterStep("previous", { kind: "none" }, false)).toBe("none");
    list.commit({ hasMoreHistory: false });
    expect(list.paging.afterStep("previous", start("a"), false)).toBe("none");
    expect(list.loads).toEqual([]);
  });
});

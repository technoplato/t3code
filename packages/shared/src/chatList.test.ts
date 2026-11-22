import { describe, expect, it } from "vite-plus/test";

import { resolveChatListMessageStep } from "./chatList.ts";

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
      rowIndex: 6,
      rowId: "assistant-2",
    });
    // Resting on assistant-2 (900 - 24): the step before it is user-2.
    expect(step({ direction: "previous", scroll: 876 })).toEqual({
      kind: "row",
      rowIndex: 5,
      rowId: "user-2",
    });
    expect(step({ direction: "previous", scroll: 0, atStart: true })).toBeNull();
  });

  it("counts from the row a step is still scrolling to, even one that is not a candidate", () => {
    expect(step({ direction: "previous", scroll: 1400, atEnd: true, pendingRowIndex: 5 })).toEqual({
      kind: "row",
      rowIndex: 3,
      rowId: "assistant-1",
    });
    expect(step({ direction: "next", scroll: 0, pendingRowIndex: 4 })).toEqual({
      kind: "row",
      rowIndex: 5,
      rowId: "user-2",
    });
    expect(step({ direction: "previous", scroll: 1400, pendingRowIndex: 0 })).toBeNull();
  });

  it("steps forward one message at a time and asks for the end after the last one", () => {
    expect(step({ direction: "next", scroll: 0, atStart: true })).toEqual({
      kind: "row",
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
      rowIndex: 5,
      rowId: "user-2",
    });
    expect(step({ candidates: fromUser, direction: "next", scroll: 0 })).toEqual({
      kind: "row",
      rowIndex: 5,
      rowId: "user-2",
    });
    expect(step({ candidates: [], direction: "next", scroll: 0 })).toBeNull();
  });

  it("uses the visible range for rows the list has not measured yet", () => {
    const unmeasured = { positionAtIndex: () => undefined, visibleStart: 4 };
    expect(step({ ...unmeasured, direction: "previous", scroll: 800 })).toEqual({
      kind: "row",
      rowIndex: 3,
      rowId: "assistant-1",
    });
    expect(step({ ...unmeasured, direction: "next", scroll: 800 })).toEqual({
      kind: "row",
      rowIndex: 5,
      rowId: "user-2",
    });
  });
});

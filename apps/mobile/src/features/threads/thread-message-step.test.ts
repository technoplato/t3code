import type { LegendListRef } from "@legendapp/list/react-native";
import { describe, expect, it } from "vite-plus/test";

import { createThreadMessageStepper, threadMessageStepCandidates } from "./thread-message-step";

type Row = Parameters<typeof threadMessageStepCandidates>[0][number];

const message = (id: string, role: "user" | "assistant", fields: object = {}) =>
  ({
    type: "message",
    id,
    message: { id, role, text: `${role} ${id}`, streaming: false, ...fields },
  }) as unknown as Row;
const fold = (id: string) => ({ type: "run-fold", id }) as unknown as Row;
const sent = (id: string) => ({ type: "sent-message", id, text: "shown" }) as unknown as Row;

const rows = [
  message("you-1", "user"),
  fold("fold-1"),
  message("reply-1", "assistant"),
  message("automation", "user", { scheduledTaskId: "task-1" }),
  message("empty", "assistant", { text: " " }),
  message("you-2", "user"),
  message("reply-2", "assistant"),
];
const positions = [0, 80, 120, 900, 960, 960, 1040];

/**
 * A list whose top edge is at row position `top`, under a 100pt bar, so a row rests on its line
 * with its start 116pt below that edge. `maxTop` is as far as the list scrolls.
 */
function fakeList(
  initialTop: number,
  {
    maxTop = 10_000,
    data = rows,
    tops = positions,
  }: {
    readonly maxTop?: number;
    readonly data?: ReadonlyArray<Row>;
    readonly tops?: ReadonlyArray<number>;
  } = {},
) {
  let top = initialTop;
  let listRows = data;
  let listTops = tops;
  let placed = true;
  const scrolls: Array<Parameters<LegendListRef["scrollToKey"]>[0]> = [];
  let settle = () => {};
  let settled = Promise.resolve();
  const list = {
    getState: () => ({
      data: listRows,
      start: listTops.findLastIndex((position) => position <= top),
      isAtStart: top <= 0,
      isAtEnd: top >= maxTop,
      distanceFromEnd: Math.max(0, maxTop - top),
      indexByKey: (key: string) => {
        const index = listRows.findIndex((row) => row.id === key);
        return index < 0 ? undefined : index;
      },
      positionAtIndex: (index: number) => listTops[index],
    }),
    anchorVisibleContent: () => {
      const first = listRows[0];
      return placed && first ? { key: first.id, offset: top - (listTops[0] ?? 0) } : undefined;
    },
    scrollToKey: (params: Parameters<LegendListRef["scrollToKey"]>[0]) => {
      scrolls.push(params);
      settled = new Promise<void>((resolve) => {
        settle = resolve;
      });
      return settled;
    },
  } as unknown as LegendListRef;
  const stepper = createThreadMessageStepper();
  const setInsets = (anchorTopInset: number, listContentInsetTop: number) =>
    stepper.setContext(() => ({ list, anchorTopInset, listContentInsetTop, animated: false }));
  setInsets(100, 100);
  return {
    stepper,
    scrolls,
    setInsets,
    /** The person scrolls the list without it saying so. */
    moveTo: (nextTop: number) => {
      top = nextTop;
    },
    /** Earlier history lands above the loaded rows; the screen stays on what it showed. */
    prepend: (earlier: ReadonlyArray<Row>, height: number) => {
      listRows = [...earlier, ...listRows];
      listTops = [
        ...earlier.map((_, index) => index * (height / earlier.length)),
        ...listTops.map((position) => position + height),
      ];
      top += height;
    },
    /** The list has not placed its rows, as before its first layout. */
    unplace: () => {
      placed = false;
    },
    /** Ends the scroll in flight with the list's top edge at `nextTop`. */
    settleAt: (nextTop: number) => {
      top = nextTop;
      const ending = settled;
      settle();
      return ending;
    },
  };
}

describe("threadMessageStepCandidates", () => {
  it("takes the messages that show, whoever sent them", () => {
    expect(threadMessageStepCandidates(rows).map((candidate) => candidate.rowId)).toEqual([
      "you-1",
      "reply-1",
      "automation",
      "you-2",
      "reply-2",
    ]);
  });

  it("counts text the agent showed the person as one of its replies", () => {
    const withSent = [...rows, sent("sent-1")];
    expect(threadMessageStepCandidates(withSent).at(-1)?.rowId).toBe("sent-1");
  });
});

// Top edge 900 puts the line at 1016: you-2 (960) is the step before, reply-2 (1040) is not.
const ABOVE_YOU_2 = 900;

describe("createThreadMessageStepper", () => {
  it("lands the start of the last, long response under the bar, not its end", () => {
    // Reading deep inside reply-2, whose start is far above the screen.
    const { stepper, scrolls } = fakeList(3000);
    expect(stepper.step("previous")).toEqual({ kind: "row", earlierCount: 4, rowId: "reply-2" });
    expect(scrolls).toEqual([{ key: "reply-2", viewPosition: 0, viewOffset: 16, animated: false }]);
  });

  it("steps on from a row still scrolling into place, and from one at rest", async () => {
    const list = fakeList(3000);
    list.stepper.step("previous");
    list.stepper.step("previous");
    expect(list.scrolls.map((scroll) => scroll.key)).toEqual(["reply-2", "you-2"]);

    // you-2 comes to rest on its line: 960 - 100 - 16.
    await list.settleAt(844);
    expect(list.stepper.step("previous")).toEqual({
      kind: "row",
      earlierCount: 2,
      rowId: "automation",
    });
    await list.settleAt(784);
    // Scrolled away by hand: the step counts from the screen again.
    list.moveTo(3000);
    expect(list.stepper.step("next")).toEqual({ kind: "end" });
  });

  it("counts from a row the end of the list holds short of its line", async () => {
    const list = fakeList(300, { maxTop: 800 });
    list.stepper.step("next");
    await list.settleAt(784);
    list.stepper.step("next");
    expect(list.scrolls.map((scroll) => scroll.key)).toEqual(["automation", "you-2"]);
    // you-2's line is at 844, past where the list ends; it rests 44pt short and is left there.
    await list.settleAt(800);
    expect(list.scrolls).toHaveLength(2);
    expect(list.stepper.step("next")).toMatchObject({ kind: "row", rowId: "reply-2" });
  });

  it("keeps the row it landed on when the insets change", async () => {
    const list = fakeList(ABOVE_YOU_2);
    list.stepper.step("previous");
    await list.settleAt(844);
    // A taller bar moves the line; counted from the screen, you-2 itself would be the step.
    list.setInsets(140, 0);
    expect(list.stepper.step("previous")).toMatchObject({ kind: "row", rowId: "automation" });
    expect(list.scrolls.at(-1)).toEqual({
      key: "automation",
      viewPosition: 0,
      viewOffset: 156,
      animated: false,
    });
  });

  it("puts a row that settled off its line on it once, and no more", async () => {
    const list = fakeList(ABOVE_YOU_2);
    list.stepper.step("previous");
    // Rows above measured in during the scroll, which the list then gave up on.
    await list.settleAt(700);
    expect(list.scrolls).toEqual([
      { key: "you-2", viewPosition: 0, viewOffset: 16, animated: false },
      { key: "you-2", viewPosition: 0, viewOffset: 16, animated: false },
    ]);
    await list.settleAt(710);
    expect(list.scrolls).toHaveLength(2);
    // Where it rests is where the next step counts from.
    expect(list.stepper.step("previous")).toMatchObject({ kind: "row", rowId: "automation" });
  });

  it("leaves a held step off its line until the release settles it", async () => {
    const list = fakeList(ABOVE_YOU_2);
    list.stepper.step("previous", { animated: true, snap: false });
    expect(list.scrolls).toEqual([
      { key: "you-2", viewPosition: 0, viewOffset: 16, animated: true },
    ]);
    await list.settleAt(700);
    expect(list.scrolls).toHaveLength(1);
    list.stepper.settle();
    expect(list.scrolls).toHaveLength(2);
    expect(list.scrolls.at(-1)).toEqual({
      key: "you-2",
      viewPosition: 0,
      viewOffset: 16,
      animated: false,
    });
    await list.settleAt(844);
    // Once on its line, a second release does nothing.
    list.stepper.settle();
    expect(list.scrolls).toHaveLength(2);
  });

  it("settles a held step still on its way when it arrives", async () => {
    const list = fakeList(ABOVE_YOU_2);
    list.stepper.step("previous", { snap: false });
    list.stepper.settle();
    expect(list.scrolls).toHaveLength(1);
    await list.settleAt(700);
    expect(list.scrolls).toHaveLength(2);
  });

  it("lets go of the row when the person scrolls, without pulling the list back", async () => {
    const list = fakeList(ABOVE_YOU_2);
    list.stepper.step("previous");
    // The drag ends the scroll short of its row; the list reports the drag first.
    list.stepper.clearLanded();
    await list.settleAt(1500);
    expect(list.scrolls).toHaveLength(1);
    // Counted from the screen: reply-2 starts above it.
    list.stepper.step("previous");
    expect(list.scrolls.at(-1)?.key).toBe("reply-2");
  });

  it("reports the start of what is loaded, with the row to count back from", async () => {
    // At the top: the first message is where a later step counts back from.
    expect(fakeList(0).stepper.step("previous")).toEqual({ kind: "start", anchorRowId: "you-1" });

    // Landed on the first message: that row.
    const list = fakeList(4);
    expect(list.stepper.step("previous")).toMatchObject({ kind: "row", rowId: "you-1" });
    await list.settleAt(0);
    expect(list.stepper.step("previous")).toEqual({ kind: "start", anchorRowId: "you-1" });

    // Nothing but grouped work loaded: its first row.
    const work = fakeList(0, { data: [fold("fold-a"), fold("fold-b")], tops: [0, 400] });
    expect(work.stepper.step("previous")).toEqual({ kind: "start", anchorRowId: "fold-a" });
    expect(work.stepper.step("next")).toEqual({ kind: "none" });
  });

  it("steps back from a row once earlier history has loaded above it", () => {
    const list = fakeList(0);
    expect(list.stepper.step("previous")).toEqual({ kind: "start", anchorRowId: "you-1" });
    list.prepend([message("old-1", "user"), message("old-2", "assistant")], 600);
    // From you-1 by its place in the list, not from what the screen shows.
    list.moveTo(5000);
    expect(list.stepper.stepFrom("you-1")).toEqual({
      kind: "row",
      earlierCount: 1,
      rowId: "old-2",
    });
    expect(list.scrolls.at(-1)?.key).toBe("old-2");
    // Still nothing before it: the start again, counted from the same row.
    expect(fakeList(0).stepper.stepFrom("you-1")).toEqual({ kind: "start", anchorRowId: "you-1" });
  });

  it("does nothing with no list or rows not placed yet", () => {
    const unplaced = fakeList(3000);
    unplaced.unplace();
    expect(unplaced.stepper.step("previous")).toEqual({ kind: "none" });
    expect(unplaced.scrolls).toEqual([]);

    const noList = createThreadMessageStepper();
    expect(noList.step("next")).toEqual({ kind: "none" });
    noList.setContext(() => ({
      list: null,
      anchorTopInset: 0,
      listContentInsetTop: 0,
      animated: true,
    }));
    expect(noList.step("next")).toEqual({ kind: "none" });
    noList.settle();
  });
});

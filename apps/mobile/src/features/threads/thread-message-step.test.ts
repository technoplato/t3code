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
function fakeList(initialTop: number, { maxTop = 10_000 }: { readonly maxTop?: number } = {}) {
  let top = initialTop;
  let placed = true;
  const scrolls: Array<Parameters<LegendListRef["scrollToKey"]>[0]> = [];
  let settle = () => {};
  let settled = Promise.resolve();
  const list = {
    getState: () => ({
      data: rows,
      start: positions.findLastIndex((position) => position <= top),
      isAtStart: top <= 0,
      isAtEnd: top >= maxTop,
      distanceFromEnd: Math.max(0, maxTop - top),
      indexByKey: (key: string) => {
        const index = rows.findIndex((row) => row.id === key);
        return index < 0 ? undefined : index;
      },
      positionAtIndex: (index: number) => positions[index],
    }),
    anchorVisibleContent: () => (placed ? { key: "you-1", offset: top } : undefined),
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
  it("takes messages that show, and for the person only what they typed", () => {
    const ids = (sender: "any" | "user" | "assistant") =>
      threadMessageStepCandidates(rows, sender).map((candidate) => candidate.rowId);
    expect(ids("any")).toEqual(["you-1", "reply-1", "automation", "you-2", "reply-2"]);
    expect(ids("user")).toEqual(["you-1", "you-2"]);
    expect(ids("assistant")).toEqual(["reply-1", "reply-2"]);
  });

  it("counts text the agent showed the person as one of its replies", () => {
    const withSent = [...rows, sent("sent-1")];
    const ids = (sender: "any" | "user" | "assistant") =>
      threadMessageStepCandidates(withSent, sender).map((candidate) => candidate.rowId);
    expect(ids("any").at(-1)).toBe("sent-1");
    expect(ids("assistant")).toEqual(["reply-1", "reply-2", "sent-1"]);
    expect(ids("user")).toEqual(["you-1", "you-2"]);
  });
});

describe("createThreadMessageStepper", () => {
  it("lands the start of the last, long response under the bar, not its end", () => {
    // Reading deep inside reply-2, whose start is far above the screen.
    const { stepper, scrolls } = fakeList(3000);
    expect(stepper.step("previous", "assistant")).toBe("row");
    expect(scrolls).toEqual([{ key: "reply-2", viewPosition: 0, viewOffset: 16, animated: false }]);
  });

  it("steps on from a row still scrolling into place, and from one at rest", async () => {
    const list = fakeList(3000);
    list.stepper.step("previous", "any");
    list.stepper.step("previous", "user");
    expect(list.scrolls.map((scroll) => scroll.key)).toEqual(["reply-2", "you-2"]);

    // you-2 comes to rest on its line: 960 - 100 - 16.
    await list.settleAt(844);
    expect(list.stepper.step("previous", "any")).toBe("row");
    expect(list.scrolls.at(-1)?.key).toBe("automation");
    await list.settleAt(784);
    // Scrolled away by hand: the step counts from the screen again.
    list.moveTo(3000);
    expect(list.stepper.step("next", "any")).toBe("end");
  });

  it("counts from a row the end of the list holds short of its line", async () => {
    const list = fakeList(300, { maxTop: 800 });
    list.stepper.step("next", "any");
    await list.settleAt(784);
    list.stepper.step("next", "any");
    expect(list.scrolls.map((scroll) => scroll.key)).toEqual(["automation", "you-2"]);
    // you-2's line is at 844, past where the list ends; it rests 44pt short and is left there.
    await list.settleAt(800);
    expect(list.scrolls).toHaveLength(2);
    expect(list.stepper.step("next", "any")).toBe("row");
    expect(list.scrolls.at(-1)?.key).toBe("reply-2");
  });

  it("keeps the row it landed on when the insets change", async () => {
    const list = fakeList(3000);
    list.stepper.step("previous", "user");
    await list.settleAt(844);
    // A taller bar moves the line; counted from the screen, you-2 itself would be the step.
    list.setInsets(140, 0);
    expect(list.stepper.step("previous", "any")).toBe("row");
    expect(list.scrolls.at(-1)).toEqual({
      key: "automation",
      viewPosition: 0,
      viewOffset: 156,
      animated: false,
    });
  });

  it("puts a row that settled off its line on it once, and no more", async () => {
    const list = fakeList(3000);
    list.stepper.step("previous", "user");
    // Rows above measured in during the scroll, which the list then gave up on.
    await list.settleAt(700);
    expect(list.scrolls).toEqual([
      { key: "you-2", viewPosition: 0, viewOffset: 16, animated: false },
      { key: "you-2", viewPosition: 0, viewOffset: 16, animated: false },
    ]);
    await list.settleAt(710);
    expect(list.scrolls).toHaveLength(2);
    // Where it rests is where the next step counts from.
    expect(list.stepper.step("previous", "any")).toBe("row");
    expect(list.scrolls.at(-1)?.key).toBe("automation");
  });

  it("lets go of the row when the person scrolls, without pulling the list back", async () => {
    const list = fakeList(3000);
    list.stepper.step("previous", "user");
    // The drag ends the scroll short of its row; the list reports the drag first.
    list.stepper.clearLanded();
    await list.settleAt(1500);
    expect(list.scrolls).toHaveLength(1);
    // Counted from the screen: reply-2 starts above it.
    list.stepper.step("previous", "any");
    expect(list.scrolls.at(-1)?.key).toBe("reply-2");
  });

  it("does nothing with no list, nothing to step to, or rows not placed yet", () => {
    expect(fakeList(0).stepper.step("previous", "any")).toBe("none");
    const unplaced = fakeList(3000);
    unplaced.unplace();
    expect(unplaced.stepper.step("previous", "any")).toBe("none");
    expect(unplaced.scrolls).toEqual([]);

    const noList = createThreadMessageStepper();
    expect(noList.step("next", "any")).toBe("none");
    noList.setContext(() => ({
      list: null,
      anchorTopInset: 0,
      listContentInsetTop: 0,
      animated: true,
    }));
    expect(noList.step("next", "any")).toBe("none");
  });
});

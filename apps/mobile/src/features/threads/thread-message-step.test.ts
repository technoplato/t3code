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

/** A list scrolled so `top` is the row position at its top edge, under a 100pt bar. */
function fakeList(initialTop: number) {
  let top = initialTop;
  const scrolls: Array<Parameters<LegendListRef["scrollToIndex"]>[0]> = [];
  let settle = () => {};
  const list = {
    getState: () => ({
      data: rows,
      scroll: top + 500,
      start: positions.findLastIndex((position) => position <= top),
      isAtStart: top <= 0,
      isAtEnd: false,
      indexByKey: (key: string) => rows.findIndex((row) => row.id === key),
      positionAtIndex: (index: number) => positions[index],
    }),
    anchorVisibleContent: () => ({ key: "you-1", offset: top }),
    scrollToIndex: (params: Parameters<LegendListRef["scrollToIndex"]>[0]) => {
      scrolls.push(params);
      // Settles in the same tick the test ends the scroll.
      return {
        then: (done: () => void) => {
          settle = done;
        },
      };
    },
  } as unknown as LegendListRef;
  const stepper = createThreadMessageStepper(() => ({
    list,
    anchorTopInset: 100,
    listContentInsetTop: 100,
    animated: false,
  }));
  return {
    stepper,
    scrolls,
    /** Ends the scroll in flight with the list's top edge at `nextTop`. */
    settleAt: (nextTop: number) => {
      top = nextTop;
      settle();
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
});

describe("createThreadMessageStepper", () => {
  it("lands the start of the last, long response under the bar, not its end", () => {
    // Reading deep inside reply-2, whose start is far above the screen.
    const { stepper, scrolls } = fakeList(3000);
    expect(stepper.step("previous", "assistant")).toBe("row");
    expect(scrolls).toEqual([{ index: 6, viewPosition: 0, viewOffset: 16, animated: false }]);
  });

  it("steps on from a row still scrolling into place, and from one resting near its line", () => {
    const list = fakeList(3000);
    list.stepper.step("previous", "any");
    list.stepper.step("previous", "user");
    expect(list.scrolls.map((scroll) => scroll.index)).toEqual([6, 5]);

    // you-2 comes to rest 6pt past its line (960 - 100 - 16) once the rows above are measured.
    list.settleAt(850);
    expect(list.stepper.step("previous", "any")).toBe("row");
    expect(list.scrolls.at(-1)?.index).toBe(3);
    list.settleAt(3000);
    // Scrolled away by hand: the step counts from the screen again.
    expect(list.stepper.step("next", "any")).toBe("end");
  });

  it("does nothing with no list or nothing to step to", () => {
    expect(fakeList(0).stepper.step("previous", "any")).toBe("none");
    const noList = createThreadMessageStepper(() => ({
      list: null,
      anchorTopInset: 0,
      listContentInsetTop: 0,
      animated: true,
    }));
    expect(noList.step("next", "any")).toBe("none");
  });
});

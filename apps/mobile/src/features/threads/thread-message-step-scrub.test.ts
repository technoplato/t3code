import type { ChatListStepOutcome } from "@t3tools/shared/chatList";
import { describe, expect, it, vi } from "vite-plus/test";

import { createMessageStepScrub, intervalFor } from "./thread-message-step-scrub";
import type { ThreadMessageStepDirection, ThreadMessageStepRequest } from "./thread-message-step";

describe("intervalFor", () => {
  it("speeds up along a curve as the finger drags away, from the slowest pace to the fastest", () => {
    expect(intervalFor(0, false)).toBe(300);
    expect(intervalFor(12, false)).toBe(300);
    expect(intervalFor(92, false)).toBe(134);
    expect(intervalFor(172, false)).toBe(60);
    expect(intervalFor(400, false)).toBe(60);
  });

  it("starts quicker after a double tap and reaches full speed with a slight drag", () => {
    expect(intervalFor(0, true)).toBe(160);
    expect(intervalFor(52, true)).toBe(94);
    expect(intervalFor(92, true)).toBe(55);
    expect(intervalFor(92, true)).toBeLessThan(intervalFor(92, false));
  });
});

function setup(outcomes: (step: number) => ChatListStepOutcome = () => "row") {
  vi.useFakeTimers();
  let nowMs = 10_000;
  const steps: Array<{ direction: ThreadMessageStepDirection } & ThreadMessageStepRequest> = [];
  const events: string[] = [];
  const scrub = createMessageStepScrub();
  scrub.setHandlers({
    step: (direction, request) => {
      steps.push({ direction, ...request });
      return outcomes(steps.length);
    },
    settle: () => events.push("settle"),
    haptics: {
      selection: () => events.push("selection"),
      engage: (doubleTap) => events.push(doubleTap ? "engage double" : "engage"),
      boundary: () => events.push("boundary"),
    },
    now: () => nowMs,
  });
  return {
    scrub,
    steps,
    events,
    /** Moves the clock and its timers together, a millisecond at a time. */
    advance: (ms: number) => {
      for (let elapsed = 0; elapsed < ms; elapsed += 1) {
        nowMs += 1;
        vi.advanceTimersByTime(1);
      }
    },
    [Symbol.dispose]: () => {
      scrub.dispose();
      vi.useRealTimers();
    },
  };
}

describe("createMessageStepScrub", () => {
  it("steps once on a tap, like a key, with no hold and nothing to settle", () => {
    using arrows = setup();
    arrows.scrub.begin("previous");
    expect(arrows.steps).toEqual([{ direction: "previous", repeat: false, snap: true }]);
    arrows.advance(100);
    arrows.scrub.end();
    arrows.advance(1000);
    expect(arrows.steps).toHaveLength(1);
    expect(arrows.events).toEqual(["selection"]);
  });

  it("repeats a held press after its delay, faster as the finger drags away, and settles once", () => {
    using arrows = setup();
    arrows.scrub.begin("previous");
    arrows.advance(319);
    expect(arrows.steps).toHaveLength(1);
    arrows.advance(1);
    expect(arrows.events).toEqual(["selection", "engage", "selection"]);
    expect(arrows.steps.at(-1)).toEqual({
      direction: "previous",
      repeat: true,
      animated: false,
      snap: false,
    });
    // At the slowest pace: one more step 300ms on.
    arrows.advance(300);
    expect(arrows.steps).toHaveLength(3);
    // Dragged far away: the next step comes 300ms after the last, then every 60ms.
    arrows.scrub.setDistance(400);
    arrows.advance(300);
    expect(arrows.steps).toHaveLength(4);
    arrows.advance(240);
    expect(arrows.steps).toHaveLength(8);
    arrows.scrub.end();
    arrows.scrub.end();
    arrows.advance(1000);
    expect(arrows.steps).toHaveLength(8);
    expect(arrows.events.filter((event) => event === "settle")).toHaveLength(1);
  });

  it("holds sooner and firmer on a double tap of the same arrow", () => {
    using arrows = setup();
    arrows.scrub.begin("next");
    arrows.advance(50);
    arrows.scrub.end();
    arrows.advance(200);
    arrows.scrub.begin("next");
    expect(arrows.steps).toHaveLength(2);
    arrows.advance(120);
    expect(arrows.events).toContain("engage double");
    expect(arrows.steps).toHaveLength(3);
    arrows.scrub.end();

    // Too slow, or the other arrow: not a double tap.
    arrows.advance(400);
    arrows.scrub.begin("next");
    arrows.scrub.end();
    arrows.advance(100);
    arrows.scrub.begin("previous");
    arrows.advance(120);
    expect(arrows.steps).toHaveLength(5);
    arrows.scrub.end();
  });

  it("keeps a row haptic from blurring into the last one", () => {
    using arrows = setup();
    arrows.scrub.begin("previous");
    arrows.scrub.setDistance(400);
    arrows.advance(320);
    // The first step and the engaging step both buzz; the 60ms pace keeps every tick.
    arrows.advance(60);
    arrows.scrub.end();
    expect(arrows.events.filter((event) => event === "selection")).toHaveLength(3);
    // A tap 10ms after the last tick does not buzz again.
    arrows.advance(10);
    arrows.scrub.press("previous");
    expect(arrows.events.filter((event) => event === "selection")).toHaveLength(3);
  });

  it("waits quietly through loading history and steps on once it lands", () => {
    using arrows = setup((step) => (step >= 2 && step <= 4 ? "loading" : "row"));
    arrows.scrub.begin("previous");
    arrows.advance(320 + 300 * 3);
    expect(arrows.steps).toHaveLength(5);
    expect(arrows.events).toEqual(["selection", "engage", "selection"]);
  });

  it("stops a held arrow with one thud at the end of what there is", () => {
    using arrows = setup((step) => (step >= 3 ? "none" : "row"));
    arrows.scrub.begin("previous");
    arrows.advance(320 + 300 + 1000);
    expect(arrows.steps).toHaveLength(3);
    expect(arrows.events).toEqual(["selection", "engage", "selection", "boundary"]);
    // The last held step did not leave a row to settle.
    arrows.scrub.end();
    expect(arrows.events).not.toContain("settle");
  });

  it("does not hold a press that reached the end, nor a lone tap at it", () => {
    using arrows = setup(() => "end");
    arrows.scrub.begin("next");
    arrows.advance(1000);
    expect(arrows.steps).toHaveLength(1);
    // Scrolling to the end is the step: it buzzes like one, with no thud.
    expect(arrows.events).toEqual(["selection"]);
    arrows.scrub.end();
  });

  it("lets a press on the other arrow take over the hold", () => {
    using arrows = setup();
    arrows.scrub.begin("previous");
    arrows.advance(320);
    arrows.scrub.begin("next");
    arrows.advance(320);
    expect(arrows.steps.map((step) => step.direction)).toEqual([
      "previous",
      "previous",
      "next",
      "next",
    ]);
    expect(arrows.events.filter((event) => event === "settle")).toHaveLength(1);
    arrows.scrub.end();
  });

  it("runs nothing after it is disposed", () => {
    using arrows = setup();
    arrows.scrub.begin("previous");
    arrows.scrub.dispose();
    arrows.advance(2000);
    expect(arrows.steps).toHaveLength(1);
    expect(arrows.events).toEqual(["selection"]);
  });
});

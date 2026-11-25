import type { LegendListRef } from "@legendapp/list/react-native";
import { describe, expect, it, vi } from "vite-plus/test";

import { landThreadFeedJump } from "./thread-feed-jump";

/** Frames the test runs by hand, each at the time it gives. */
function stubFrames() {
  let nextId = 0;
  const queued = new Map<number, (time: number) => void>();
  vi.stubGlobal("requestAnimationFrame", (callback: (time: number) => void) => {
    nextId += 1;
    queued.set(nextId, callback);
    return nextId;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    queued.delete(id);
  });
  return {
    queued,
    run: (time: number) => {
      const callbacks = [...queued.values()];
      queued.clear();
      for (const callback of callbacks) callback(time);
    },
    [Symbol.dispose]: () => {
      vi.unstubAllGlobals();
    },
  };
}

/** A list holding one linked row, `row-7`, whose scrolls the test ends by hand. */
function fakeList(input: {
  readonly size?: number | undefined;
  readonly scroll?: number;
  readonly distanceFromEnd?: number;
}) {
  let size = input.size;
  const scrolls: Array<Record<string, unknown>> = [];
  let settle = () => {};
  let settled = Promise.resolve();
  const scroll = (params: Record<string, unknown>) => {
    scrolls.push(params);
    settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    return settled;
  };
  const list = {
    getState: () => ({
      scroll: input.scroll ?? 500,
      distanceFromEnd: input.distanceFromEnd ?? 5_000,
      indexByKey: (key: string) => (key === "row-7" ? 7 : undefined),
      sizeAtIndex: (index: number) => (index === 7 ? size : undefined),
    }),
    scrollToKey: scroll,
    scrollToOffset: scroll,
  } as unknown as LegendListRef;
  return {
    list,
    scrolls,
    measure: (next: number) => {
      size = next;
    },
    /** Ends the scroll in flight. */
    settle: () => {
      const ending = settled;
      settle();
      return ending;
    },
  };
}

// The bar ends 100pt below the list's top edge; on iOS glass the list applies that inset itself.
const INSETS = { anchorTopInset: 100, listContentInsetTop: 100 };

describe("landThreadFeedJump", () => {
  it("lands a linked row's start a little under the bar", async () => {
    const { list, scrolls, settle } = fakeList({ size: 1_000 });
    const onLanded = vi.fn();
    landThreadFeedJump({ list, rowKey: "row-7", from: null, ...INSETS, onLanded });
    expect(scrolls).toEqual([{ key: "row-7", viewPosition: 0, viewOffset: 16, animated: false }]);
    expect(onLanded).not.toHaveBeenCalled();
    await settle();
    expect(onLanded).toHaveBeenCalledTimes(1);
    expect(scrolls).toHaveLength(1);

    // With no native inset the bar's height is part of the offset.
    const plain = fakeList({ size: 1_000 });
    landThreadFeedJump({
      list: plain.list,
      rowKey: "row-7",
      from: null,
      anchorTopInset: 100,
      listContentInsetTop: 0,
      onLanded,
    });
    expect(plain.scrolls[0]).toMatchObject({ viewOffset: 116 });
  });

  it("puts `from` of the row above the line the view report reads, by a plain offset", async () => {
    const { list, scrolls, settle } = fakeList({ size: 1_000, scroll: 500 });
    const onLanded = vi.fn();
    landThreadFeedJump({ list, rowKey: "row-7", from: 0.4, ...INSETS, onLanded });
    // First the row's start on the line itself, with none of the 16pt a plain link leaves.
    expect(scrolls).toEqual([{ key: "row-7", viewPosition: 0, viewOffset: 0, animated: false }]);
    await settle();
    expect(scrolls[1]).toEqual({ offset: 900, animated: false });
    expect(onLanded).not.toHaveBeenCalled();
    await settle();
    expect(onLanded).toHaveBeenCalledTimes(1);
  });

  it("stops at the end of the list instead of scrolling past it", async () => {
    const { list, scrolls, settle } = fakeList({ size: 1_000, scroll: 500, distanceFromEnd: 150 });
    landThreadFeedJump({ list, rowKey: "row-7", from: 0.9, ...INSETS, onLanded: vi.fn() });
    await settle();
    expect(scrolls[1]).toEqual({ offset: 650, animated: false });

    const atEnd = fakeList({ size: 1_000, distanceFromEnd: 0 });
    const onLanded = vi.fn();
    landThreadFeedJump({ list: atEnd.list, rowKey: "row-7", from: 0.9, ...INSETS, onLanded });
    await atEnd.settle();
    expect(atEnd.scrolls).toHaveLength(1);
    expect(onLanded).toHaveBeenCalledTimes(1);
  });

  it("waits a few frames for the row's height, and lands on its start if none comes", async () => {
    using frames = stubFrames();
    const measured = fakeList({ size: undefined, scroll: 500 });
    landThreadFeedJump({
      list: measured.list,
      rowKey: "row-7",
      from: 0.4,
      ...INSETS,
      onLanded: vi.fn(),
    });
    await measured.settle();
    frames.run(1_000);
    expect(measured.scrolls).toHaveLength(1);
    measured.measure(1_000);
    frames.run(1_016);
    expect(measured.scrolls[1]).toEqual({ offset: 900, animated: false });
    expect(frames.queued.size).toBe(0);

    const unmeasured = fakeList({ size: undefined });
    const onLanded = vi.fn();
    landThreadFeedJump({ list: unmeasured.list, rowKey: "row-7", from: 0.4, ...INSETS, onLanded });
    await unmeasured.settle();
    frames.run(1_000);
    frames.run(1_399);
    expect(onLanded).not.toHaveBeenCalled();
    frames.run(1_400);
    expect(onLanded).toHaveBeenCalledTimes(1);
    expect(unmeasured.scrolls).toHaveLength(1);
    expect(frames.queued.size).toBe(0);
  });

  it("moves nothing more once the person scrolls, and reports nothing once cancelled", async () => {
    using frames = stubFrames();
    const dragged = fakeList({ size: 1_000 });
    const onLanded = vi.fn();
    const landing = landThreadFeedJump({
      list: dragged.list,
      rowKey: "row-7",
      from: 0.4,
      ...INSETS,
      onLanded,
    });
    // The list reports the drag, then settles the scroll the drag interrupted.
    landing.release();
    expect(onLanded).toHaveBeenCalledTimes(1);
    await dragged.settle();
    expect(dragged.scrolls).toHaveLength(1);
    expect(onLanded).toHaveBeenCalledTimes(1);

    // Cancelled while it waits for the row's height: the wait ends and nothing is reported.
    const waiting = fakeList({ size: undefined });
    const cancelled = vi.fn();
    const voided = landThreadFeedJump({
      list: waiting.list,
      rowKey: "row-7",
      from: 0.4,
      ...INSETS,
      onLanded: cancelled,
    });
    await waiting.settle();
    expect(frames.queued.size).toBe(1);
    voided.cancel();
    expect(frames.queued.size).toBe(0);
    waiting.measure(1_000);
    frames.run(1_000);
    expect(waiting.scrolls).toHaveLength(1);
    expect(cancelled).not.toHaveBeenCalled();
  });

  it("lands at once when no row shows what the link names", async () => {
    const { list, scrolls } = fakeList({ size: 1_000 });
    const onLanded = vi.fn();
    landThreadFeedJump({ list, rowKey: null, from: 0.4, ...INSETS, onLanded });
    await Promise.resolve();
    expect(onLanded).toHaveBeenCalledTimes(1);
    expect(scrolls).toEqual([]);
  });
});

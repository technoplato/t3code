import { MessageId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  finishThreadMessageJump,
  pendingThreadMessageJump,
  requestThreadMessageJump,
  subscribeThreadMessageJump,
} from "./threadMessageJump.ts";

describe("thread message jump", () => {
  it("holds a jump for its thread until it lands or lapses", () => {
    using now = vi.spyOn(Date, "now").mockReturnValue(0);
    const heard = vi.fn();
    using _subscription = { [Symbol.dispose]: subscribeThreadMessageJump(heard) };

    requestThreadMessageJump("thread-a", MessageId.make("message-1"));
    expect(heard).toHaveBeenCalledTimes(1);
    expect(pendingThreadMessageJump("thread-a")).toEqual({
      threadKey: "thread-a",
      messageId: "message-1",
      from: null,
      at: 0,
    });
    expect(pendingThreadMessageJump("thread-b")).toBeNull();

    finishThreadMessageJump("thread-b");
    expect(pendingThreadMessageJump("thread-a")?.messageId).toBe("message-1");
    finishThreadMessageJump("thread-a");
    expect(heard).toHaveBeenCalledTimes(2);
    expect(pendingThreadMessageJump("thread-a")).toBeNull();

    // A jump whose thread never showed lapses.
    requestThreadMessageJump("thread-a", MessageId.make("message-2"));
    now.mockReturnValue(29_999);
    expect(pendingThreadMessageJump("thread-a")?.messageId).toBe("message-2");
    now.mockReturnValue(30_000);
    expect(pendingThreadMessageJump("thread-a")).toBeNull();
  });

  it("keeps one object per request, so a store read is stable and a repeat link jumps again", () => {
    using _now = vi.spyOn(Date, "now").mockReturnValue(0);
    using _jump = { [Symbol.dispose]: () => finishThreadMessageJump("thread-a") };
    const messageId = MessageId.make("message-1");

    requestThreadMessageJump("thread-a", messageId, 0.4);
    const first = pendingThreadMessageJump("thread-a");
    expect(first?.from).toBe(0.4);
    expect(pendingThreadMessageJump("thread-a")).toBe(first);

    requestThreadMessageJump("thread-a", messageId, 0.4);
    const second = pendingThreadMessageJump("thread-a");
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
  });
});

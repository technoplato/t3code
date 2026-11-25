import type { NavigationState, PartialState } from "@react-navigation/native";
import { describe, expect, it, vi } from "vite-plus/test";

import { finishThreadMessageJump, pendingThreadMessageJump } from "./threadMessageJump";
import { takeThreadMessageLink } from "./threadMessageLink";

const THREAD_KEY = "environment-1:thread-1";

function link(params: Record<string, unknown>): PartialState<NavigationState> {
  return { routes: [{ name: "Home" }, { name: "Thread", params }] };
}

describe("takeThreadMessageLink", () => {
  it("asks the thread to open at the linked message and drops the params", () => {
    using _now = vi.spyOn(Date, "now").mockReturnValue(0);
    using _jump = { [Symbol.dispose]: () => finishThreadMessageJump(THREAD_KEY) };
    const state = takeThreadMessageLink(
      link({ environmentId: "environment-1", threadId: "thread-1", messageId: "message-7" }),
    );
    expect(state?.routes[1]?.params).toEqual({
      environmentId: "environment-1",
      threadId: "thread-1",
    });
    expect(pendingThreadMessageJump(THREAD_KEY)).toMatchObject({
      messageId: "message-7",
      from: null,
    });
    expect(pendingThreadMessageJump("environment-1:thread-2")).toBeNull();

    // `from` says how far down the message to open.
    const deep = takeThreadMessageLink(
      link({
        environmentId: "environment-1",
        threadId: "thread-1",
        messageId: "message-7",
        from: "0.4",
      }),
    );
    expect(deep?.routes[1]?.params).toEqual({
      environmentId: "environment-1",
      threadId: "thread-1",
    });
    expect(pendingThreadMessageJump(THREAD_KEY)).toMatchObject({
      messageId: "message-7",
      from: 0.4,
    });
  });

  it("drops params that name nothing, and leaves other links alone", () => {
    using _now = vi.spyOn(Date, "now").mockReturnValue(0);
    for (const params of [
      { environmentId: "environment-1", threadId: "thread-1", messageId: "" },
      { environmentId: "environment-1", messageId: "message-7" },
      // `from` without a message is dropped too, never left in the route's params.
      { environmentId: "environment-1", threadId: "thread-1", from: "0.4" },
      { environmentId: "environment-1", threadId: "thread-1", messageId: "", from: "0.4" },
    ]) {
      const state = takeThreadMessageLink(link(params));
      expect(state?.routes[1]?.params).not.toHaveProperty("messageId");
      expect(state?.routes[1]?.params).not.toHaveProperty("from");
      expect(pendingThreadMessageJump(THREAD_KEY)).toBeNull();
    }

    const plain = link({ environmentId: "environment-1", threadId: "thread-1", prompt: "hi" });
    expect(takeThreadMessageLink(plain)).toBe(plain);
    const elsewhere: PartialState<NavigationState> = {
      routes: [{ name: "Settings", params: { messageId: "message-7" } }],
    };
    expect(takeThreadMessageLink(elsewhere)).toBe(elsewhere);
    expect(takeThreadMessageLink(undefined)).toBeUndefined();
    expect(pendingThreadMessageJump(THREAD_KEY)).toBeNull();
  });
});

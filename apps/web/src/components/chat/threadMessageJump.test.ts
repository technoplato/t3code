import { MessageId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import type { MessagesTimelineRow } from "./MessagesTimeline.logic";
import {
  finishThreadMessageJump,
  messageJumpRowIndex,
  pendingThreadMessageJump,
  requestThreadMessageJump,
  subscribeThreadMessageJump,
  takeMessageJumpParam,
} from "./threadMessageJump";

describe("takeMessageJumpParam", () => {
  it("reads the linked message and keeps the rest of the query", () => {
    expect(takeMessageJumpParam("?messageId=message-1")).toEqual({
      messageId: "message-1",
      rest: "",
    });
    expect(takeMessageJumpParam("?prompt=hi&messageId=message-1&x=1")).toEqual({
      messageId: "message-1",
      rest: "?prompt=hi&x=1",
    });
    // Still stripped, so an empty or oversized value cannot linger in the URL.
    expect(takeMessageJumpParam("?messageId=")).toEqual({ messageId: null, rest: "" });
    expect(takeMessageJumpParam("?prompt=hi")).toBeNull();
    expect(takeMessageJumpParam("")).toBeNull();
  });
});

describe("thread message jump", () => {
  it("holds a jump for its thread until it lands or lapses", () => {
    using now = vi.spyOn(Date, "now").mockReturnValue(0);
    const heard = vi.fn();
    using _subscription = { [Symbol.dispose]: subscribeThreadMessageJump(heard) };

    requestThreadMessageJump("thread-a", MessageId.make("message-1"));
    expect(heard).toHaveBeenCalledTimes(1);
    expect(pendingThreadMessageJump("thread-a")).toBe("message-1");
    expect(pendingThreadMessageJump("thread-b")).toBeNull();

    finishThreadMessageJump("thread-b");
    expect(pendingThreadMessageJump("thread-a")).toBe("message-1");
    finishThreadMessageJump("thread-a");
    expect(heard).toHaveBeenCalledTimes(2);
    expect(pendingThreadMessageJump("thread-a")).toBeNull();

    requestThreadMessageJump("thread-a", MessageId.make("message-2"));
    now.mockReturnValue(29_999);
    expect(pendingThreadMessageJump("thread-a")).toBe("message-2");
    now.mockReturnValue(30_000);
    expect(pendingThreadMessageJump("thread-a")).toBeNull();
  });
});

describe("messageJumpRowIndex", () => {
  const rows = [
    { kind: "message", id: "row-1", message: { id: "message-user", role: "user" } },
    { kind: "assistant-meta", id: "row-2", message: { id: "message-assistant" } },
    {
      kind: "work",
      id: "row-3",
      groupedEntries: [{ id: "entry-1", projectedItem: { item: { id: "item-tool" } } }],
    },
    { kind: "event", id: "row-4", projectedItem: { item: { id: "item-approval" } } },
    { kind: "proposed-plan", id: "row-5", proposedPlan: { id: "plan-1" } },
    { kind: "message", id: "row-6", message: { id: "message-assistant", role: "assistant" } },
    { kind: "working", id: "row-7" },
  ] as unknown as MessagesTimelineRow[];

  it("finds the row showing a message, tool call, approval or plan", () => {
    expect(messageJumpRowIndex(rows, "message-user")).toBe(0);
    expect(messageJumpRowIndex(rows, "item-tool")).toBe(2);
    expect(messageJumpRowIndex(rows, "item-approval")).toBe(3);
    expect(messageJumpRowIndex(rows, "plan-1")).toBe(4);
    // The message row itself, not the meta row under it.
    expect(messageJumpRowIndex(rows, "message-assistant")).toBe(5);
    expect(messageJumpRowIndex(rows, "row-7")).toBe(-1);
    expect(messageJumpRowIndex(rows, "message-not-loaded")).toBe(-1);
  });
});

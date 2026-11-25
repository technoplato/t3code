import { describe, expect, it } from "vite-plus/test";

import type { MessagesTimelineRow } from "./MessagesTimeline.logic";
import { messageJumpRowIndex, takeMessageJumpParam } from "./threadMessageJump";

describe("takeMessageJumpParam", () => {
  it("reads the linked message and keeps the rest of the query", () => {
    expect(takeMessageJumpParam("?messageId=message-1")).toEqual({
      messageId: "message-1",
      from: null,
      rest: "",
    });
    expect(takeMessageJumpParam("?prompt=hi&messageId=message-1&from=0.4&x=1")).toEqual({
      messageId: "message-1",
      from: 0.4,
      rest: "?prompt=hi&x=1",
    });
    // Still stripped, so an empty or oversized value cannot linger in the URL.
    expect(takeMessageJumpParam("?messageId=")).toEqual({ messageId: null, from: null, rest: "" });
    expect(takeMessageJumpParam("?messageId=message-1&from=2")).toEqual({
      messageId: "message-1",
      from: null,
      rest: "",
    });
    // `from` without a message is dropped too, never left for the route to read.
    expect(takeMessageJumpParam("?from=0.4&prompt=hi")).toEqual({
      messageId: null,
      from: 0.4,
      rest: "?prompt=hi",
    });
    expect(takeMessageJumpParam("?prompt=hi")).toBeNull();
    expect(takeMessageJumpParam("")).toBeNull();
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

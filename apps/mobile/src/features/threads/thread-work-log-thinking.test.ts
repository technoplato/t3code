import { describe, expect, it } from "vite-plus/test";

import type { ThreadFeedActivity } from "../../lib/threadActivity";
import {
  resolveOpenedGroupReasoningRowIds,
  resolveReasoningMaxHeight,
} from "./thread-work-log-thinking";

type Row = Pick<ThreadFeedActivity, "id" | "workEntry">;
const row = (id: string, itemType: string, detail?: string): Row =>
  ({ id, workEntry: { itemType, detail } }) as unknown as Row;

describe("resolveReasoningMaxHeight", () => {
  it.each([
    ["default", 1024, 666],
    ["tall", 1024, 870],
    ["default", 500, 384],
    ["tall", 500, 560],
  ] as const)("%s on a %i point window is %i", (scrollHeight, windowHeight, expected) => {
    expect(resolveReasoningMaxHeight(scrollHeight, windowHeight)).toBe(expected);
  });

  it("has no box when the setting is full", () => {
    expect(resolveReasoningMaxHeight("full", 1024)).toBeUndefined();
  });
});

describe("resolveOpenedGroupReasoningRowIds", () => {
  const rows = [
    row("command-1", "command_execution", "ls"),
    row("thought-1", "reasoning", "First thought"),
    row("command-2", "command_execution", "pwd"),
    row("thought-2", "reasoning", "Second thought"),
    row("thought-empty", "reasoning", "  "),
  ];

  it("opens every thought that has text, also after a command, once the person opens the group", () => {
    expect([...(resolveOpenedGroupReasoningRowIds(rows, true) ?? [])]).toEqual([
      "thought-1",
      "thought-2",
    ]);
  });

  it("opens none while the group is not opened by the person", () => {
    expect(resolveOpenedGroupReasoningRowIds(rows, false)).toBeUndefined();
  });
});

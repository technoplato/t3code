import { describe, expect, it } from "vite-plus/test";

import type { ThreadFeedActivity } from "../../lib/threadActivity";
import {
  isWorkRowExpanded,
  resolveOpenedGroupReasoningRowIds,
  resolveWorkLogHeights,
  shouldVirtualizeFullHeightWorkGroup,
} from "./thread-work-log-thinking";

type Row = Pick<ThreadFeedActivity, "id" | "workEntry" | "canExpand" | "projectedItem">;
const row = (id: string, itemType: string, detail?: string, canExpand = true): Row =>
  ({
    id,
    canExpand,
    workEntry: { itemType, detail },
    projectedItem: { item: { type: itemType } },
  }) as unknown as Row;

describe("resolveWorkLogHeights", () => {
  it.each([
    [
      "default",
      1024,
      { reasoningMaxHeight: 666, toolDetailMaxHeight: 240, workGroupMaxHeight: 461 },
    ],
    ["tall", 1024, { reasoningMaxHeight: 870, toolDetailMaxHeight: 400, workGroupMaxHeight: 666 }],
    [
      "default",
      500,
      { reasoningMaxHeight: 384, toolDetailMaxHeight: 240, workGroupMaxHeight: 320 },
    ],
    ["tall", 500, { reasoningMaxHeight: 560, toolDetailMaxHeight: 288, workGroupMaxHeight: 480 }],
  ] as const)("%s on a %i point window", (scrollHeight, windowHeight, expected) => {
    expect(resolveWorkLogHeights(scrollHeight, windowHeight)).toEqual(expected);
  });

  it("keeps an output smaller than the group box that scrolls it, on every window", () => {
    for (const scrollHeight of ["default", "tall"] as const) {
      for (const windowHeight of [0, 320, 568, 844, 1366, 2732]) {
        const heights = resolveWorkLogHeights(scrollHeight, windowHeight);
        expect(heights.toolDetailMaxHeight).toBeLessThan(heights.workGroupMaxHeight!);
      }
    }
    const virtualized = resolveWorkLogHeights("full", 844, true);
    expect(virtualized.toolDetailMaxHeight).toBeLessThan(virtualized.workGroupMaxHeight!);
  });

  it("full has no thinking or group box, yet still bounds one output", () => {
    expect(resolveWorkLogHeights("full", 1024)).toEqual({
      reasoningMaxHeight: undefined,
      toolDetailMaxHeight: 870,
      workGroupMaxHeight: undefined,
    });
  });

  it("full keeps a box for a long group whose calls all open themselves", () => {
    expect(shouldVirtualizeFullHeightWorkGroup("full", true, 16)).toBe(true);
    expect(shouldVirtualizeFullHeightWorkGroup("full", true, 15)).toBe(false);
    expect(shouldVirtualizeFullHeightWorkGroup("full", false, 60)).toBe(false);
    expect(shouldVirtualizeFullHeightWorkGroup("tall", true, 60)).toBe(false);
    expect(resolveWorkLogHeights("full", 1024, true)).toEqual({
      reasoningMaxHeight: undefined,
      toolDetailMaxHeight: 522,
      workGroupMaxHeight: 870,
    });
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

describe("isWorkRowExpanded", () => {
  const command = row("command", "command_execution", "ls");
  const thought = row("thought", "reasoning", "Because");
  const expanded = (
    target: Row,
    settings: { thinking?: boolean; toolCalls?: boolean },
    expandedRows: Record<string, boolean> = {},
  ) =>
    isWorkRowExpanded(
      target,
      expandedRows,
      settings.thinking ?? false,
      settings.toolCalls ?? false,
    );

  it("opens tool calls only under the tool call setting, and thoughts only under the thinking one", () => {
    expect(expanded(command, {})).toBe(false);
    expect(expanded(command, { thinking: true })).toBe(false);
    expect(expanded(command, { toolCalls: true })).toBe(true);
    expect(expanded(thought, { toolCalls: true })).toBe(false);
    expect(expanded(thought, { thinking: true })).toBe(true);
  });

  it("never opens a row that has nothing to open or that leads somewhere else", () => {
    expect(expanded(row("bare", "dynamic_tool", undefined, false), { toolCalls: true })).toBe(
      false,
    );
    expect(expanded(row("notice", "system_notice", "Sign in"), { toolCalls: true })).toBe(false);
    expect(expanded(row("done", "notification", "Agent finished"), { toolCalls: true })).toBe(
      false,
    );
  });

  it("keeps the person's last tap over either setting", () => {
    expect(expanded(command, { toolCalls: true }, { command: false })).toBe(false);
    expect(expanded(command, {}, { command: true })).toBe(true);
    expect(expanded(thought, { thinking: true }, { thought: false })).toBe(false);
  });
});

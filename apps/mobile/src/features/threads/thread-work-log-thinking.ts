import type { WorkLogScrollHeight } from "@t3tools/contracts/settings";

import type { ThreadFeedActivity } from "../../lib/threadActivity";

const REASONING_MAX_HEIGHT_DEFAULT = 384;
const REASONING_MAX_HEIGHT_TALL = 560;
// Thinking is read at length: its box takes most of the screen, and never less than the fixed size.
const REASONING_WINDOW_SHARE_DEFAULT = 0.65;
const REASONING_WINDOW_SHARE_TALL = 0.85;
const WORK_GROUP_MAX_HEIGHT_DEFAULT = 320;
const WORK_GROUP_MAX_HEIGHT_TALL = 480;
const WORK_GROUP_WINDOW_SHARE_DEFAULT = 0.45;
const WORK_GROUP_WINDOW_SHARE_TALL = 0.65;
const TOOL_DETAIL_MAX_HEIGHT_DEFAULT = 240;
// An output inside a scrolling group stays well under the group's box, so the group still scrolls past it.
const TOOL_DETAIL_GROUP_SHARE = 0.6;
const FULL_OUTPUT_WINDOW_SHARE = 0.85;
const FULL_HEIGHT_VIRTUALIZE_ROW_THRESHOLD = 15;

interface WorkLogHeights {
  /** An opened thought's scroll box; undefined has no box. */
  readonly reasoningMaxHeight: number | undefined;
  /** One tool call's details or command output. Always bounded, so a huge payload cannot fill the feed. */
  readonly toolDetailMaxHeight: number;
  /** An opened group's scroll box; undefined renders its rows inline. */
  readonly workGroupMaxHeight: number | undefined;
}

/** "full" renders a group inline unless every call in a long group opens itself, which needs virtualization. */
export function shouldVirtualizeFullHeightWorkGroup(
  scrollHeight: WorkLogScrollHeight,
  expandToolCallsByDefault: boolean,
  rowCount: number,
): boolean {
  return (
    scrollHeight === "full" &&
    expandToolCallsByDefault &&
    rowCount > FULL_HEIGHT_VIRTUALIZE_ROW_THRESHOLD
  );
}

/** Every scroll box height the work log uses, from the setting and the window. */
export function resolveWorkLogHeights(
  scrollHeight: WorkLogScrollHeight,
  windowHeight: number,
  fullGroupVirtualized = false,
): WorkLogHeights {
  if (scrollHeight === "full") {
    const outputCap = Math.max(
      TOOL_DETAIL_MAX_HEIGHT_DEFAULT,
      Math.round(windowHeight * FULL_OUTPUT_WINDOW_SHARE),
    );
    return fullGroupVirtualized
      ? {
          reasoningMaxHeight: undefined,
          toolDetailMaxHeight: Math.round(outputCap * TOOL_DETAIL_GROUP_SHARE),
          workGroupMaxHeight: outputCap,
        }
      : {
          reasoningMaxHeight: undefined,
          toolDetailMaxHeight: outputCap,
          workGroupMaxHeight: undefined,
        };
  }
  const tall = scrollHeight === "tall";
  const workGroupMaxHeight = Math.max(
    tall ? WORK_GROUP_MAX_HEIGHT_TALL : WORK_GROUP_MAX_HEIGHT_DEFAULT,
    Math.round(
      windowHeight * (tall ? WORK_GROUP_WINDOW_SHARE_TALL : WORK_GROUP_WINDOW_SHARE_DEFAULT),
    ),
  );
  return {
    reasoningMaxHeight: Math.max(
      tall ? REASONING_MAX_HEIGHT_TALL : REASONING_MAX_HEIGHT_DEFAULT,
      Math.round(
        windowHeight * (tall ? REASONING_WINDOW_SHARE_TALL : REASONING_WINDOW_SHARE_DEFAULT),
      ),
    ),
    toolDetailMaxHeight: tall
      ? Math.max(
          TOOL_DETAIL_MAX_HEIGHT_DEFAULT,
          Math.round(workGroupMaxHeight * TOOL_DETAIL_GROUP_SHARE),
        )
      : TOOL_DETAIL_MAX_HEIGHT_DEFAULT,
    workGroupMaxHeight,
  };
}

/** Every thought in a group the person opened shows its text, so one tap reads the thinking. */
export function resolveOpenedGroupReasoningRowIds(
  activities: ReadonlyArray<Pick<ThreadFeedActivity, "id" | "workEntry">>,
  groupExpandedByUser: boolean,
): ReadonlySet<string> | undefined {
  if (!groupExpandedByUser) return undefined;
  let ids: Set<string> | undefined;
  for (const row of activities) {
    if (row.workEntry.itemType !== "reasoning") continue;
    if ((row.workEntry.detail?.trim() ?? "") !== "") {
      ids ??= new Set();
      ids.add(row.id);
    }
  }
  return ids;
}

/** Whether a row shows its details: the person's last tap wins, then the two default-expansion settings. */
export function isWorkRowExpanded(
  row: Pick<ThreadFeedActivity, "id" | "workEntry" | "canExpand" | "projectedItem">,
  expandedRows: Readonly<Record<string, boolean>>,
  expandThinkingByDefault: boolean,
  expandToolCallsByDefault: boolean,
  openedGroupReasoningRowIds?: ReadonlySet<string>,
): boolean {
  const explicit = expandedRows[row.id];
  if (explicit !== undefined) return explicit;
  if (row.workEntry.itemType === "reasoning") {
    return (
      (expandThinkingByDefault || openedGroupReasoningRowIds?.has(row.id) === true) &&
      (row.workEntry.detail?.trim() ?? "") !== ""
    );
  }
  // A notice opens its sign-in and a notification its agent's thread; neither has details to open.
  const itemType = row.projectedItem.item.type;
  return (
    expandToolCallsByDefault &&
    row.canExpand &&
    itemType !== "system_notice" &&
    itemType !== "notification"
  );
}

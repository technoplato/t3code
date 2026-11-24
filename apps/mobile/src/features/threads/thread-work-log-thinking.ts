import type { WorkLogScrollHeight } from "@t3tools/contracts/settings";

import type { ThreadFeedActivity } from "../../lib/threadActivity";

const REASONING_MAX_HEIGHT_DEFAULT = 384;
const REASONING_MAX_HEIGHT_TALL = 560;
// Thinking is read at length: its box takes most of the screen, and never less than the fixed size.
const REASONING_WINDOW_SHARE_DEFAULT = 0.65;
const REASONING_WINDOW_SHARE_TALL = 0.85;

/** How tall an opened thought's scroll box may grow; "full" has no box. */
export function resolveReasoningMaxHeight(
  scrollHeight: WorkLogScrollHeight,
  windowHeight: number,
): number | undefined {
  if (scrollHeight === "full") return undefined;
  const tall = scrollHeight === "tall";
  return Math.max(
    tall ? REASONING_MAX_HEIGHT_TALL : REASONING_MAX_HEIGHT_DEFAULT,
    Math.round(
      windowHeight * (tall ? REASONING_WINDOW_SHARE_TALL : REASONING_WINDOW_SHARE_DEFAULT),
    ),
  );
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

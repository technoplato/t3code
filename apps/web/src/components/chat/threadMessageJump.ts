import {
  linkedMessageId,
  linkedMessageOffset,
  THREAD_MESSAGE_FROM_PARAM,
  THREAD_MESSAGE_LINK_PARAM,
} from "@t3tools/client-runtime/thread-message-link";
import type { MessageId } from "@t3tools/contracts";

import { timelineRowViewItem, type MessagesTimelineRow } from "./MessagesTimeline.logic";

export {
  finishThreadMessageJump,
  pendingThreadMessageJump,
  requestThreadMessageJump,
  subscribeThreadMessageJump,
} from "@t3tools/client-runtime/thread-message-jump";

/**
 * A location's `?messageId=` and `&from=`, and the query without them so reloading or going back
 * does not jump again. Null when the query has neither parameter.
 */
export function takeMessageJumpParam(search: string): {
  readonly messageId: MessageId | null;
  readonly from: number | null;
  readonly rest: string;
} | null {
  const params = new URLSearchParams(search);
  if (!params.has(THREAD_MESSAGE_LINK_PARAM) && !params.has(THREAD_MESSAGE_FROM_PARAM)) return null;
  const messageId = linkedMessageId(params.get(THREAD_MESSAGE_LINK_PARAM));
  const from = linkedMessageOffset(params.get(THREAD_MESSAGE_FROM_PARAM));
  params.delete(THREAD_MESSAGE_LINK_PARAM);
  params.delete(THREAD_MESSAGE_FROM_PARAM);
  const rest = params.toString();
  return { messageId, from, rest: rest ? `?${rest}` : "" };
}

/** The row showing a linked message, tool call or plan; -1 while none does. */
export function messageJumpRowIndex(
  rows: ReadonlyArray<MessagesTimelineRow>,
  messageId: string,
): number {
  return rows.findIndex(
    (row) =>
      (row.kind === "message" && row.message.id === messageId) ||
      timelineRowViewItem(row)?.id === messageId,
  );
}

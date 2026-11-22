import {
  linkedMessageId,
  THREAD_MESSAGE_LINK_PARAM,
} from "@t3tools/client-runtime/thread-message-link";
import type { MessageId } from "@t3tools/contracts";

import { timelineRowViewItem, type MessagesTimelineRow } from "./MessagesTimeline.logic";

// A `?messageId=` thread link opens its thread at that message. The timeline reads the request
// while it shows that thread, and finishes it once it has scrolled there or the message cannot
// be found. A request whose thread never showed lapses, so a later plain open does not jump.
const PENDING_JUMP_MS = 30_000;
let pending: {
  readonly threadKey: string;
  readonly messageId: MessageId;
  readonly at: number;
} | null = null;
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

export function requestThreadMessageJump(threadKey: string, messageId: MessageId): void {
  pending = { threadKey, messageId, at: Date.now() };
  notify();
}

/** The message this thread should open at, if a link asked for one. */
export function pendingThreadMessageJump(threadKey: string): MessageId | null {
  return pending?.threadKey === threadKey && Date.now() - pending.at < PENDING_JUMP_MS
    ? pending.messageId
    : null;
}

export function finishThreadMessageJump(threadKey: string): void {
  if (pending?.threadKey !== threadKey) return;
  pending = null;
  notify();
}

export function subscribeThreadMessageJump(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * A location's `?messageId=`, and the query without it so reloading or going back does not jump
 * again. Null when the query has no such parameter.
 */
export function takeMessageJumpParam(
  search: string,
): { readonly messageId: MessageId | null; readonly rest: string } | null {
  const params = new URLSearchParams(search);
  if (!params.has(THREAD_MESSAGE_LINK_PARAM)) return null;
  const messageId = linkedMessageId(params.get(THREAD_MESSAGE_LINK_PARAM));
  params.delete(THREAD_MESSAGE_LINK_PARAM);
  const rest = params.toString();
  return { messageId, rest: rest ? `?${rest}` : "" };
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

// @effect-diagnostics globalDate:off - React external-store hooks read the jump, outside an Effect runtime.
import type { MessageId } from "@t3tools/contracts";

/** A request to open a thread at one of its messages or items. */
export interface ThreadMessageJump {
  readonly threadKey: string;
  readonly messageId: MessageId;
  /** The fraction of the item's height to put above the top of the viewport; null for its start. */
  readonly from: number | null;
  readonly at: number;
}

// A link or a search result opens its thread at a message. The thread's view reads the request
// while it shows that thread, and finishes it once it has scrolled there or the message cannot be
// found. A request whose thread never showed lapses, so a later plain open does not jump.
const PENDING_JUMP_MS = 30_000;
let pending: ThreadMessageJump | null = null;
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

/** Each request is a new jump, so asking again for the same message jumps again. */
export function requestThreadMessageJump(
  threadKey: string,
  messageId: MessageId,
  from: number | null = null,
): void {
  pending = { threadKey, messageId, from, at: Date.now() };
  notify();
}

/** The jump this thread should open at, if one was asked for. The same object until it changes. */
export function pendingThreadMessageJump(threadKey: string): ThreadMessageJump | null {
  return pending?.threadKey === threadKey && Date.now() - pending.at < PENDING_JUMP_MS
    ? pending
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

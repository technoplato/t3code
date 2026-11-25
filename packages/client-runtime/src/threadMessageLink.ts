import { MessageId } from "@t3tools/contracts";

/** `threads/<environment>/<thread>?messageId=…` opens the thread at that message or item. */
export const THREAD_MESSAGE_LINK_PARAM = "messageId";
/** `&from=0.4` opens it with that fraction of the item's height above the top of the viewport. */
export const THREAD_MESSAGE_FROM_PARAM = "from";
const MAX_LINKED_ID_LENGTH = 256;

/** The id a link's `messageId` names, or null when it names nothing usable. */
export function linkedMessageId(value: unknown): MessageId | null {
  const first = Array.isArray(value) ? value[0] : value;
  // A router may hand a digits-only id over as a number.
  const id = typeof first === "number" ? String(first) : first;
  if (typeof id !== "string") return null;
  const trimmed = id.trim();
  return trimmed.length > 0 && trimmed.length <= MAX_LINKED_ID_LENGTH
    ? MessageId.make(trimmed)
    : null;
}

/**
 * How far down the linked item a link's `from` points, as a fraction of the item's height in
 * (0, 1]. Null for the item's start, which is also what an unusable value means.
 */
export function linkedMessageOffset(value: unknown): number | null {
  const first = Array.isArray(value) ? value[0] : value;
  const offset = typeof first === "string" && first.trim().length > 0 ? Number(first) : first;
  return typeof offset === "number" && Number.isFinite(offset) && offset > 0 && offset <= 1
    ? offset
    : null;
}

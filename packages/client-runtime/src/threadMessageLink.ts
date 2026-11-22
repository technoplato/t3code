import { MessageId } from "@t3tools/contracts";

/** `threads/<environment>/<thread>?messageId=…` opens the thread at that message or item. */
export const THREAD_MESSAGE_LINK_PARAM = "messageId";
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

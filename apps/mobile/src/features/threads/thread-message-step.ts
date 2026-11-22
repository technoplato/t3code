import type { LegendListRef } from "@legendapp/list/react-native";
import { resolveUserMessagePresentation } from "@t3tools/client-runtime/user-message";
import {
  CHAT_LIST_ANCHOR_OFFSET,
  resolveChatListMessageStep,
  type ChatListMessageStepCandidate,
} from "@t3tools/shared/chatList";

import { isCompactionCommandFeedEntry, type ThreadFeedRow } from "./pending-thread-feed";

export type ThreadMessageStepDirection = "previous" | "next";
/** "user" is what the person typed; "assistant" is the agent's replies; "any" is both. */
export type ThreadMessageStepSender = "any" | "user" | "assistant";
/** "end" leaves the scroll to the screen, which owns scrolling to the end. */
export type ThreadMessageStepResult = "row" | "end" | "none";

export interface ThreadMessageStepper {
  readonly step: (
    direction: ThreadMessageStepDirection,
    sender: ThreadMessageStepSender,
  ) => ThreadMessageStepResult;
}

interface ThreadMessageStepContext {
  readonly list: LegendListRef | null;
  /** How far below the list's top edge a message rests: under the bar, like a sent message. */
  readonly anchorTopInset: number;
  /** The part of that inset the list already applies as its own content inset. */
  readonly listContentInsetTop: number;
  readonly animated: boolean;
}

// A landed row can rest a little off its line once the rows above it are measured.
const LANDED_ROW_SLACK = 32;

/** The feed rows a step may land on: messages that show, by who sent them. */
export function threadMessageStepCandidates(
  rows: ReadonlyArray<ThreadFeedRow>,
  sender: ThreadMessageStepSender,
): ChatListMessageStepCandidate[] {
  const candidates: ChatListMessageStepCandidate[] = [];
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    if (row?.type !== "message" || isCompactionCommandFeedEntry(row)) continue;
    const { role } = row.message;
    if (role === "assistant") {
      if (sender === "user") continue;
      if (!row.message.streaming && row.message.text.trim().length === 0) continue;
    } else if (role === "user") {
      if (sender === "assistant") continue;
      // Automations, agents and guests also send user messages; those are not the person's own.
      if (sender === "user" && resolveUserMessagePresentation(row.message).attribution !== null) {
        continue;
      }
    } else {
      continue;
    }
    candidates.push({ rowIndex, rowId: row.id });
  }
  return candidates;
}

/**
 * Steps the feed to the start of the message before or after the one at the top of the screen.
 * The list scroll releases end following by itself, so a streaming reply does not pull it back.
 */
export function createThreadMessageStepper(
  context: () => ThreadMessageStepContext,
): ThreadMessageStepper {
  let landed: { readonly rowId: string; readonly scrolling: boolean } | null = null;
  return {
    step(direction, sender) {
      const { list, anchorTopInset, listContentInsetTop, animated } = context();
      const state = list?.getState();
      if (!list || !state) return "none";
      const rows = state.data as ReadonlyArray<ThreadFeedRow>;
      const candidates = threadMessageStepCandidates(rows, sender);
      if (candidates.length === 0) return "none";

      // Row positions leave out the list's header and padding; the visible anchor reads the
      // scroll in the same space without holding the list.
      const visible = list.anchorVisibleContent({ hold: false });
      const visibleIndex = visible ? state.indexByKey(visible.key) : undefined;
      const scroll =
        visible && visibleIndex !== undefined
          ? state.positionAtIndex(visibleIndex) + visible.offset
          : state.scroll;
      const targetOffset = anchorTopInset + CHAT_LIST_ANCHOR_OFFSET;

      const landedIndex = landed ? state.indexByKey(landed.rowId) : undefined;
      const landedTop = landedIndex === undefined ? undefined : state.positionAtIndex(landedIndex);
      const countFromLanded =
        landed !== null &&
        landedIndex !== undefined &&
        (landed.scrolling ||
          (landedTop !== undefined &&
            Math.abs(landedTop - (scroll + targetOffset)) <= LANDED_ROW_SLACK));

      const target = resolveChatListMessageStep({
        candidates,
        direction,
        scroll,
        atStart: state.isAtStart,
        atEnd: state.isAtEnd,
        positionAtIndex: state.positionAtIndex,
        targetOffset,
        visibleStart: state.start,
        pendingRowIndex: countFromLanded ? landedIndex : null,
      });
      if (target === null) return "none";
      if (target.kind === "end") {
        landed = null;
        return "end";
      }

      const next = { rowId: target.rowId, scrolling: true };
      landed = next;
      void list
        .scrollToIndex({
          index: target.rowIndex,
          // The list ends a scroll to its last row at that row's end unless told otherwise.
          viewPosition: 0,
          viewOffset: targetOffset - listContentInsetTop,
          animated,
        })
        .then(() => {
          if (landed === next) landed = { rowId: next.rowId, scrolling: false };
        });
      return "row";
    },
  };
}

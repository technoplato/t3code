import type { LegendListRef } from "@legendapp/list/react-native";
import { resolveUserMessagePresentation } from "@t3tools/client-runtime/user-message";
import {
  CHAT_LIST_ANCHOR_OFFSET,
  resolveChatListMessageStep,
  type ChatListMessageStepCandidate,
} from "@t3tools/shared/chatList";

import { isCompactionCommandFeedEntry, type ThreadFeedRow } from "./pending-thread-feed";
import { threadFeedViewportStart } from "./thread-feed-view";

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
  /** Forgets the row the last step landed on. A scroll by hand calls it, so no step pulls back. */
  readonly clearLanded: () => void;
  /** Where steps land from now on. The row the last step landed on is kept. */
  readonly setContext: (context: () => ThreadMessageStepContext) => void;
}

export interface ThreadMessageStepContext {
  readonly list: LegendListRef | null;
  /** How far below the list's top edge a message rests: under the bar, like a sent message. */
  readonly anchorTopInset: number;
  /** The part of that inset the list already applies as its own content inset. */
  readonly listContentInsetTop: number;
  readonly animated: boolean;
}

// How far a landed row may drift from where its scroll left it and still be the row to count from.
const LANDED_REST_TOLERANCE = 4;
// A settled scroll this far off its line is put on it, as when rows above measured in mid-scroll.
const LANDED_SNAP_THRESHOLD = 2;

/** The feed rows a step may land on: messages that show, by who sent them. */
export function threadMessageStepCandidates(
  rows: ReadonlyArray<ThreadFeedRow>,
  sender: ThreadMessageStepSender,
): ChatListMessageStepCandidate[] {
  const candidates: ChatListMessageStepCandidate[] = [];
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    // Text the agent showed with `send_to_user` reads as one of its replies.
    if (row?.type === "sent-message") {
      if (sender !== "user") candidates.push({ rowIndex, rowId: row.id });
      continue;
    }
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
 * One stepper lasts the feed's life, so the row it landed on outlives a change of insets.
 */
export function createThreadMessageStepper(): ThreadMessageStepper {
  let context: (() => ThreadMessageStepContext) | null = null;
  // `rest` is where the list's top edge came to rest against the row's start; null while the
  // scroll is still on its way.
  let landed: { readonly rowId: string; readonly rest: number | null } | null = null;

  const rowTop = (list: LegendListRef, rowId: string): number | undefined => {
    const state = list.getState();
    const index = state.indexByKey(rowId);
    return index === undefined ? undefined : (state.positionAtIndex(index) as number | undefined);
  };
  const scrollToRow = (
    list: LegendListRef,
    rowId: string,
    { anchorTopInset, listContentInsetTop }: ThreadMessageStepContext,
    animated: boolean,
  ) =>
    list.scrollToKey({
      // By key, so the list follows the row when history loads above it mid-scroll.
      key: rowId,
      // The list ends a scroll to its last row at that row's end unless told otherwise.
      viewPosition: 0,
      viewOffset: anchorTopInset + CHAT_LIST_ANCHOR_OFFSET - listContentInsetTop,
      animated,
    });

  return {
    setContext(next) {
      context = next;
    },
    clearLanded() {
      landed = null;
    },
    step(direction, sender) {
      const current = context?.();
      const list = current?.list;
      const state = list?.getState();
      if (!current || !list || !state) return "none";
      const rows = state.data as ReadonlyArray<ThreadFeedRow>;
      const candidates = threadMessageStepCandidates(rows, sender);
      if (candidates.length === 0) return "none";

      // Row positions leave out the list's header and padding; the visible anchor reads the
      // scroll in the same space without holding the list. Before the list has placed its rows
      // there is no such reading, and nothing to step from.
      const scroll = threadFeedViewportStart(list);
      if (scroll === undefined) return "none";
      const targetOffset = current.anchorTopInset + CHAT_LIST_ANCHOR_OFFSET;

      const landedIndex = landed ? state.indexByKey(landed.rowId) : undefined;
      const landedTop = landed ? rowTop(list, landed.rowId) : undefined;
      // The row stays the one to count from while the screen has not moved against it: a row the
      // end of the list holds short of its line still counts, and any scroll away does not.
      const countFromLanded =
        landed !== null &&
        landedIndex !== undefined &&
        (landed.rest === null ||
          (landedTop !== undefined &&
            Math.abs(scroll - landedTop - landed.rest) <= LANDED_REST_TOLERANCE));

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

      const next = { rowId: target.rowId, rest: null };
      landed = next;
      const settle = () => {
        if (landed !== next) return;
        const top = rowTop(list, next.rowId);
        const settled = threadFeedViewportStart(list);
        landed =
          top === undefined || settled === undefined
            ? null
            : { rowId: next.rowId, rest: settled - top };
      };
      void scrollToRow(list, next.rowId, current, current.animated).then(() => {
        // A scroll by hand or a newer step has taken over, or the list is gone.
        const latest = context?.();
        if (landed !== next || !latest || latest.list !== list) return;
        const settledState = list.getState();
        const top = rowTop(list, next.rowId);
        const settled = threadFeedViewportStart(list);
        // The list gives up on a scroll whose target keeps moving as rows measure in; one more
        // puts the row on its line. Never at an edge, where the list holds the row short of it.
        if (
          top !== undefined &&
          settled !== undefined &&
          !settledState.isAtEnd &&
          !settledState.isAtStart &&
          settledState.distanceFromEnd > 1 &&
          Math.abs(top - (settled + latest.anchorTopInset + CHAT_LIST_ANCHOR_OFFSET)) >
            LANDED_SNAP_THRESHOLD
        ) {
          void scrollToRow(list, next.rowId, latest, false).then(settle);
          return;
        }
        settle();
      });
      return "row";
    },
  };
}

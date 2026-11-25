import type { LegendListRef } from "@legendapp/list/react-native";
import {
  CHAT_LIST_ANCHOR_OFFSET,
  resolveChatListMessageStep,
  type ChatListMessageStepCandidate,
  type ChatListStepOutcome,
} from "@t3tools/shared/chatList";

import { isCompactionCommandFeedEntry, type ThreadFeedRow } from "./pending-thread-feed";
import { threadFeedViewportStart } from "./thread-feed-view";

export type ThreadMessageStepDirection = "previous" | "next";
/**
 * "end" leaves the scroll to the screen, which owns scrolling to the end. "start" is a step back
 * with no earlier message loaded: `anchorRowId` is the row a later step counts back from, once
 * earlier history is in the list. "none" is a list that cannot be stepped yet.
 */
export type ThreadMessageStepResult =
  | { readonly kind: "row"; readonly earlierCount: number; readonly rowId: string }
  | { readonly kind: "end" }
  | { readonly kind: "start"; readonly anchorRowId: string | null }
  | { readonly kind: "none" };

export interface ThreadMessageStepOptions {
  /** Overrides the context's motion setting for this step. */
  readonly animated?: boolean;
  /** False leaves a row that settled off its line where it is; `settle` puts it right later. */
  readonly snap?: boolean;
}

export interface ThreadMessageStepRequest extends ThreadMessageStepOptions {
  /** A step fired by a held arrow, not a press of its own. */
  readonly repeat?: boolean;
}

/** The feed's steps as the screen drives them, loading earlier history a step back runs into. */
export interface ThreadMessageStepControl {
  readonly step: (
    direction: ThreadMessageStepDirection,
    request?: ThreadMessageStepRequest,
  ) => ChatListStepOutcome;
  /** Puts the row a held arrow left off its line onto it, once the arrow is let go. */
  readonly settle: () => void;
}

export interface ThreadMessageStepper {
  readonly step: (
    direction: ThreadMessageStepDirection,
    options?: ThreadMessageStepOptions,
  ) => ThreadMessageStepResult;
  /** Steps back from a row by its place in the list, wherever the screen is. */
  readonly stepFrom: (rowId: string, options?: ThreadMessageStepOptions) => ThreadMessageStepResult;
  /** Puts the row the last step landed on onto its line, if a step without `snap` left it off. */
  readonly settle: () => void;
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
const NONE = { kind: "none" } as const;

/** The feed rows a step may land on: the messages that show. */
export function threadMessageStepCandidates(
  rows: ReadonlyArray<ThreadFeedRow>,
): ChatListMessageStepCandidate[] {
  const candidates: ChatListMessageStepCandidate[] = [];
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    // Text the agent showed with `send_to_user` reads as one of its replies.
    if (row?.type === "sent-message") {
      candidates.push({ rowIndex, rowId: row.id });
      continue;
    }
    if (row?.type !== "message" || isCompactionCommandFeedEntry(row)) continue;
    const { role } = row.message;
    if (role === "assistant") {
      if (!row.message.streaming && row.message.text.trim().length === 0) continue;
    } else if (role !== "user") {
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
  // scroll is still on its way. `snap` is whether that scroll puts a row left off its line on it.
  type Landing = { readonly rowId: string; rest: number | null; snap: boolean };
  let landed: Landing | null = null;

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
  // Runs when a scroll to `landing` ends, and when a release asks a resting row onto its line.
  const arrive = (list: LegendListRef, landing: Landing) => {
    // A scroll by hand or a newer step has taken over, or the list is gone.
    const latest = context?.();
    if (landed !== landing || !latest || latest.list !== list) return;
    const state = list.getState();
    const top = rowTop(list, landing.rowId);
    const viewportStart = threadFeedViewportStart(list);
    if (top === undefined || viewportStart === undefined) {
      landed = null;
      return;
    }
    // The list gives up on a scroll whose target keeps moving as rows measure in; one more
    // puts the row on its line. Never at an edge, where the list holds the row short of it.
    if (
      landing.snap &&
      !state.isAtEnd &&
      !state.isAtStart &&
      state.distanceFromEnd > 1 &&
      Math.abs(top - (viewportStart + latest.anchorTopInset + CHAT_LIST_ANCHOR_OFFSET)) >
        LANDED_SNAP_THRESHOLD
    ) {
      landing.snap = false;
      landing.rest = null;
      void scrollToRow(list, landing.rowId, latest, false).then(() => arrive(list, landing));
      return;
    }
    landing.rest = viewportStart - top;
  };

  const run = (
    direction: ThreadMessageStepDirection,
    fromRowId: string | null,
    options: ThreadMessageStepOptions = {},
  ): ThreadMessageStepResult => {
    const current = context?.();
    const list = current?.list;
    const state = list?.getState();
    if (!current || !list || !state) return NONE;
    // Row positions leave out the list's header and padding; the visible anchor reads the
    // scroll in the same space without holding the list. Before the list has placed its rows
    // there is no such reading, and nothing to step from.
    const scroll = threadFeedViewportStart(list);
    if (scroll === undefined) return NONE;
    const rows = state.data as ReadonlyArray<ThreadFeedRow>;
    const candidates = threadMessageStepCandidates(rows);
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
    const fromIndex = fromRowId === null ? undefined : state.indexByKey(fromRowId);

    const target = resolveChatListMessageStep({
      candidates,
      direction,
      scroll,
      atStart: state.isAtStart,
      atEnd: state.isAtEnd,
      positionAtIndex: state.positionAtIndex,
      targetOffset,
      visibleStart: state.start,
      pendingRowIndex: fromIndex ?? (countFromLanded ? landedIndex : null),
    });
    if (target === null) {
      if (direction === "next") return NONE;
      // A message row keeps its id when history loads above it; a row of grouped work may not.
      const anchorRowId =
        fromIndex !== undefined
          ? fromRowId
          : countFromLanded && landed
            ? landed.rowId
            : (candidates[0]?.rowId ?? rows[0]?.id ?? null);
      return { kind: "start", anchorRowId };
    }
    if (target.kind === "end") {
      landed = null;
      return target;
    }

    const next: Landing = { rowId: target.rowId, rest: null, snap: options.snap ?? true };
    landed = next;
    void scrollToRow(list, next.rowId, current, options.animated ?? current.animated).then(() =>
      arrive(list, next),
    );
    return { kind: "row", earlierCount: target.earlierCount, rowId: target.rowId };
  };

  return {
    setContext(next) {
      context = next;
    },
    clearLanded() {
      landed = null;
    },
    step: (direction, options) => run(direction, null, options),
    stepFrom: (rowId, options) => run("previous", rowId, options),
    settle() {
      const list = context?.().list;
      if (!landed || !list) return;
      landed.snap = true;
      // A scroll still on its way snaps when it ends.
      if (landed.rest !== null) arrive(list, landed);
    },
  };
}

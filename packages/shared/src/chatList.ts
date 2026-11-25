export const CHAT_LIST_ANCHOR_OFFSET = 16;

export interface ChatListAnchoredEndSpace {
  readonly anchorIndex: number;
  readonly anchorOffset: number;
}

export interface ChatListAnchorOptions {
  readonly anchorOffset?: number;
}

export function resolveChatListAnchoredEndSpace<Item, AnchorId>(
  items: ReadonlyArray<Item>,
  anchorId: AnchorId | null,
  getAnchorId: (item: Item) => AnchorId | null,
  options: ChatListAnchorOptions = {},
): ChatListAnchoredEndSpace | undefined {
  if (anchorId === null) {
    return undefined;
  }

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (item === undefined) {
      continue;
    }

    const itemAnchorId = getAnchorId(item);
    if (itemAnchorId === null) {
      continue;
    }

    return itemAnchorId === anchorId
      ? {
          anchorIndex: index,
          anchorOffset: options.anchorOffset ?? CHAT_LIST_ANCHOR_OFFSET,
        }
      : undefined;
  }

  return undefined;
}

export interface ChatListMessageStepCandidate {
  readonly rowIndex: number;
  readonly rowId: string;
}

export type ChatListMessageStepTarget =
  | ({
      readonly kind: "row";
      /** How many candidates come before this one: how close the step is to the loaded start. */
      readonly earlierCount: number;
    } & ChatListMessageStepCandidate)
  | { readonly kind: "end" };

const CHAT_LIST_MESSAGE_STEP_TOLERANCE_PX = 4;

/**
 * The message a "previous" or "next" step lands on, measured from the line `targetOffset` below
 * the viewport top where a landed message rests. A long message scrolled past its start is its
 * own previous target. Stepping past the last message asks for the end of the list.
 */
export function resolveChatListMessageStep(input: {
  /** The rows a step may land on, in list order. */
  readonly candidates: ReadonlyArray<ChatListMessageStepCandidate>;
  readonly direction: "previous" | "next";
  readonly scroll: number;
  readonly atStart: boolean;
  readonly atEnd: boolean;
  readonly positionAtIndex: (index: number) => number | undefined;
  readonly targetOffset: number;
  readonly visibleStart?: number | null | undefined;
  /** The row a step still scrolling to was sent to; the next step counts from it, not from the scroll. */
  readonly pendingRowIndex?: number | null | undefined;
  readonly tolerance?: number;
}): ChatListMessageStepTarget | null {
  const { candidates } = input;
  if (candidates.length === 0) {
    return null;
  }
  const rowTarget = (index: number): ChatListMessageStepTarget => ({
    kind: "row",
    earlierCount: index,
    ...candidates[index]!,
  });

  const pending = input.pendingRowIndex;
  if (pending != null && pending >= 0) {
    if (input.direction === "previous") {
      const previous = candidates.findLastIndex((candidate) => candidate.rowIndex < pending);
      return previous >= 0 ? rowTarget(previous) : null;
    }
    const next = candidates.findIndex((candidate) => candidate.rowIndex > pending);
    if (next >= 0) return rowTarget(next);
    return input.atEnd ? null : { kind: "end" };
  }

  const anchor = input.scroll + input.targetOffset;
  const tolerance = input.tolerance ?? CHAT_LIST_MESSAGE_STEP_TOLERANCE_PX;

  if (input.direction === "previous") {
    if (input.atStart) {
      return null;
    }
    for (let index = candidates.length - 1; index >= 0; index -= 1) {
      const candidate = candidates[index]!;
      const top = input.positionAtIndex(candidate.rowIndex);
      if (top != null && Number.isFinite(top)) {
        if (top < anchor - tolerance) {
          return rowTarget(index);
        }
      } else if (input.visibleStart != null && candidate.rowIndex < input.visibleStart) {
        return rowTarget(index);
      }
    }
    return null;
  }

  if (input.atEnd) {
    return null;
  }
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index]!;
    const top = input.positionAtIndex(candidate.rowIndex);
    if (top != null && Number.isFinite(top)) {
      if (top > anchor + tolerance) {
        return rowTarget(index);
      }
    } else if (input.visibleStart != null && candidate.rowIndex > input.visibleStart) {
      return rowTarget(index);
    }
  }
  return { kind: "end" };
}

/** The earlier history a list can load above what it shows. */
export interface ChatListHistory {
  readonly hasMoreHistory: boolean;
  readonly loading: boolean;
  readonly error: string | null;
  readonly onLoadEarlier: () => void;
}

/** What a step did, without how it got there. "start" is a step back with no earlier message loaded. */
export type ChatListStepResult =
  | { readonly kind: "row"; readonly earlierCount: number }
  | { readonly kind: "end" }
  | { readonly kind: "start"; readonly anchorRowId: string | null }
  | { readonly kind: "none" };

/** What a step did, as the controls hear it: "loading" waits on earlier history to step into. */
export type ChatListStepOutcome = "row" | "end" | "loading" | "none";

/** The list a history paging steps through, read when it acts and never held. */
export interface ChatListHistoryPagingHost {
  /** The first loaded row's id: it changes only when history lands above it. */
  readonly headId: () => string;
  /** Whether a message to step to is loaded before the row; undefined while the list cannot tell. */
  readonly hasEarlier: (anchorRowId: string) => boolean | undefined;
  /** Steps back from the row by its place in the list; false when it could not yet. */
  readonly stepFrom: (anchorRowId: string) => boolean;
  /** A step back the paging made by itself once history landed. */
  readonly onStepped: () => void;
  /** A tapped step back found no earlier message to go to after all. */
  readonly onExhausted: () => void;
  readonly requestFrame: (callback: () => void) => void;
}

export interface ChatListHistoryPaging {
  readonly setHost: (host: ChatListHistoryPagingHost) => void;
  /**
   * The history as it is now; the list's owner hands it over after each commit. `scope` names
   * whose history it is, as a thread: another scope drops what the last one waited on.
   */
  readonly setHistory: (history: ChatListHistory | null, scope: string | null) => void;
  /** Turns a step's result into what the controls hear, loading history the step ran into. */
  readonly afterStep: (
    direction: "previous" | "next",
    result: ChatListStepResult,
    repeat: boolean,
  ) => ChatListStepOutcome;
  /** Loads earlier history now, unless it is loading or was asked for at this head. */
  readonly prefetch: () => void;
  /** Drops a tapped step still waiting on history: a scroll by hand or another thread. */
  readonly cancel: () => void;
}

// Steps this close to the loaded start ask for the page before it, ahead of reaching it.
const CHAT_LIST_PREFETCH_EARLIER_COUNT = 2;
// Pages that land with no message to step to, as of work rows alone, loaded before giving up.
const CHAT_LIST_EMPTY_PAGE_LIMIT = 3;
// Frames to wait for the list to show history that has landed before giving up on a step.
const CHAT_LIST_RESUME_FRAMES = 5;

/**
 * Loads earlier history when steps back reach the start of what a list has loaded. A step near
 * the start asks for the page before it; a tap at the start waits for that page and then takes
 * the step it asked for; a held arrow hears "loading" and steps on by itself once rows land.
 */
export function createChatListHistoryPaging(): ChatListHistoryPaging {
  let host: ChatListHistoryPagingHost | null = null;
  let history: ChatListHistory | null = null;
  let historyScope: string | null = null;
  // The head a load was last asked for at. It covers the commits before `loading` shows.
  let requestedHeadId: string | null = null;
  // One tapped step waiting on history: the row it counts back from.
  let waiting: { readonly anchorRowId: string; headId: string; emptyLoads: number } | null = null;

  const load = () => {
    if (!host || !history) return;
    requestedHeadId = host.headId();
    history.onLoadEarlier();
  };
  const canLoad = () =>
    history !== null && history.hasMoreHistory && !history.loading && history.error === null;
  const prefetch = () => {
    if (host && canLoad() && host.headId() !== requestedHeadId) load();
  };

  const resume = (frame: number) => {
    const slot = waiting;
    if (!slot || !host || history?.loading) return;
    if (history !== null && history.error !== null) {
      waiting = null;
      return;
    }
    const retry = () => {
      if (frame < CHAT_LIST_RESUME_FRAMES) {
        host?.requestFrame(() => {
          if (waiting === slot) resume(frame + 1);
        });
        return true;
      }
      return false;
    };
    const earlier = host.hasEarlier(slot.anchorRowId);
    if (earlier === true) {
      if (host.stepFrom(slot.anchorRowId)) {
        waiting = null;
        host.onStepped();
      } else if (!retry()) {
        waiting = null;
      }
      return;
    }
    if (earlier === undefined) {
      if (!retry()) waiting = null;
      return;
    }
    const headId = host.headId();
    // Loading has ended a commit before the rows it brought show in the list.
    if (headId === slot.headId && retry()) return;
    if (headId !== slot.headId && canLoad() && slot.emptyLoads < CHAT_LIST_EMPTY_PAGE_LIMIT) {
      slot.emptyLoads += 1;
      slot.headId = headId;
      load();
      return;
    }
    waiting = null;
    host.onExhausted();
  };

  return {
    setHost(next) {
      host = next;
    },
    setHistory(next, scope) {
      if (scope !== historyScope) {
        historyScope = scope;
        history = null;
        requestedHeadId = null;
        waiting = null;
      }
      const wasLoading = history?.loading === true;
      history = next;
      if (next?.loading) return;
      // A finished load may be asked for again at the same head, as by a later tap.
      if (wasLoading) requestedHeadId = null;
      if (waiting && (wasLoading || host?.headId() !== waiting.headId)) resume(0);
    },
    afterStep(direction, result, repeat) {
      // A step forward, or an arrow held past the tap, takes over from a tap still waiting.
      if (direction === "next" || repeat) waiting = null;
      if (result.kind === "end" || result.kind === "none") return result.kind;
      if (result.kind === "row") {
        waiting = null;
        if (direction === "previous" && result.earlierCount <= CHAT_LIST_PREFETCH_EARLIER_COUNT) {
          prefetch();
        }
        return "row";
      }
      const current = history;
      if (!host || !current || !current.hasMoreHistory) {
        waiting = null;
        return "none";
      }
      // A failed load is tried again on a tap, never by a held arrow over and over.
      if (current.error !== null && repeat) return "none";
      if (!current.loading && (current.error !== null || host.headId() !== requestedHeadId)) {
        load();
      }
      if (!repeat && result.anchorRowId !== null) {
        waiting = { anchorRowId: result.anchorRowId, headId: host.headId(), emptyLoads: 0 };
      }
      return "loading";
    },
    prefetch,
    cancel() {
      waiting = null;
    },
  };
}

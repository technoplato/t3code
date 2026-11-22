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
  | ({ readonly kind: "row" } & ChatListMessageStepCandidate)
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
  const rowTarget = (candidate: ChatListMessageStepCandidate): ChatListMessageStepTarget => ({
    kind: "row",
    ...candidate,
  });

  const pending = input.pendingRowIndex;
  if (pending != null && pending >= 0) {
    if (input.direction === "previous") {
      const previous = candidates.findLast((candidate) => candidate.rowIndex < pending);
      return previous ? rowTarget(previous) : null;
    }
    const next = candidates.find((candidate) => candidate.rowIndex > pending);
    if (next) return rowTarget(next);
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
          return rowTarget(candidate);
        }
      } else if (input.visibleStart != null && candidate.rowIndex < input.visibleStart) {
        return rowTarget(candidate);
      }
    }
    return null;
  }

  if (input.atEnd) {
    return null;
  }
  for (const candidate of candidates) {
    const top = input.positionAtIndex(candidate.rowIndex);
    if (top != null && Number.isFinite(top)) {
      if (top > anchor + tolerance) {
        return rowTarget(candidate);
      }
    } else if (input.visibleStart != null && candidate.rowIndex > input.visibleStart) {
      return rowTarget(candidate);
    }
  }
  return { kind: "end" };
}

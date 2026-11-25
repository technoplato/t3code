import type { LegendListRef } from "@legendapp/list/react-native";
import { CHAT_LIST_ANCHOR_OFFSET } from "@t3tools/shared/chatList";

// How long a landed row may take to report its height before the jump settles for its start.
const JUMP_MEASURE_WAIT_MS = 400;

export interface ThreadFeedJumpLanding {
  /** The person took over the scroll: nothing more moves, and the jump counts as landed. */
  readonly release: () => void;
  /** The jump is void: nothing more moves and nothing is reported. */
  readonly cancel: () => void;
}

/**
 * How far past a row's start to scroll so that `from` of its height is above the top line,
 * without running past the end of the list.
 */
function jumpIntraOffset(input: {
  readonly from: number;
  readonly size: number;
  readonly distanceFromEnd: number;
}): number {
  return Math.max(0, Math.min(input.from * input.size, input.distanceFromEnd));
}

/**
 * Opens the feed at a linked row: its start a little under the bar, or with `from` of its height
 * above the line the feed's view report reads from, so a link built from a report lands where
 * the report was taken. Calls `onLanded` once the last scroll has settled.
 */
export function landThreadFeedJump(input: {
  readonly list: LegendListRef;
  /** The row to land on; null when no row shows what the link names. */
  readonly rowKey: string | null;
  readonly from: number | null;
  /** How far below the list's top edge the bar ends. */
  readonly anchorTopInset: number;
  /** The part of that inset the list already applies as its own content inset. */
  readonly listContentInsetTop: number;
  readonly onLanded: () => void;
}): ThreadFeedJumpLanding {
  const { list, rowKey, from } = input;
  let ended = false;
  let frame: number | null = null;
  const end = (landed: boolean) => {
    if (ended) return;
    ended = true;
    if (frame !== null) cancelAnimationFrame(frame);
    if (landed) input.onLanded();
  };
  const land = () => end(true);

  if (rowKey === null) {
    void Promise.resolve().then(land);
    return { release: land, cancel: () => end(false) };
  }

  // True once the scroll into the row is on its way, or there is nothing to scroll by. False
  // while the row has no height yet: that comes from its first layout, which a row just scrolled
  // into view may not have had.
  const shiftIntoRow = (fraction: number): boolean => {
    const state = list.getState();
    const index = state.indexByKey(rowKey);
    if (index === undefined) {
      land();
      return true;
    }
    const size = state.sizeAtIndex(index) as number | undefined;
    if (size === undefined || !(size > 0)) return false;
    const offset = jumpIntraOffset({
      from: fraction,
      size,
      distanceFromEnd: state.distanceFromEnd,
    });
    if (offset < 1) {
      land();
      return true;
    }
    // A plain offset, never a negative view offset on a scroll to the row: the list lets that
    // one run past its end into blank space.
    void list.scrollToOffset({ offset: state.scroll + offset, animated: false }).then(land);
    return true;
  };

  void list
    .scrollToKey({
      key: rowKey,
      viewPosition: 0,
      // With `from`, the row's start goes on the very line the view report measures from.
      viewOffset:
        (from === null ? input.anchorTopInset + CHAT_LIST_ANCHOR_OFFSET : input.anchorTopInset) -
        input.listContentInsetTop,
      animated: false,
    })
    .then(() => {
      if (ended) return;
      if (from === null) return land();
      if (shiftIntoRow(from)) return;
      let waitingSince: number | null = null;
      const poll = (time: number) => {
        frame = null;
        if (ended) return;
        if (waitingSince === null) waitingSince = time;
        if (shiftIntoRow(from)) return;
        if (time - waitingSince >= JUMP_MEASURE_WAIT_MS) return land();
        frame = requestAnimationFrame(poll);
      };
      frame = requestAnimationFrame(poll);
    });

  return { release: land, cancel: () => end(false) };
}

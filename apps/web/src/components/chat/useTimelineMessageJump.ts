import type { LegendListRef } from "@legendapp/list/react";
import type { ThreadMessageJump } from "@t3tools/client-runtime/thread-message-jump";
import type { MessageId } from "@t3tools/contracts";
import { useEffect, useEffectEvent, type RefObject } from "react";

import { TIMELINE_MINIMAP_TARGET_OFFSET } from "./MessagesTimeline.logic";
import { finishThreadMessageJump } from "./threadMessageJump";

const JUMP_FLASH_MS = 1_800;
// How long a landed row may take to report its height before the jump settles for its start.
const JUMP_MEASURE_WAIT_MS = 400;

function flashJumpTarget(viewport: HTMLElement | null, messageId: string): void {
  const id = CSS.escape(messageId);
  viewport
    ?.querySelector<HTMLElement>(`[data-message-id="${id}"], [data-view-item-id="${id}"]`)
    ?.animate(
      [
        { backgroundColor: "color-mix(in srgb, var(--primary) 18%, transparent)" },
        { backgroundColor: "transparent" },
      ],
      { duration: JUMP_FLASH_MS, easing: "ease-out" },
    );
}

/**
 * Scrolls to a linked message once its row exists and flashes it, loading earlier history
 * until it does. The jump ends when it lands or when the thread turns out not to hold the message.
 */
export function useTimelineMessageJump(input: {
  /** The jump to land; a new object jumps again, even to the same message. */
  readonly jump: ThreadMessageJump | null;
  /** -1 while no row shows the message. */
  readonly rowIndex: number;
  readonly listReady: boolean;
  readonly listRef: RefObject<LegendListRef | null>;
  readonly viewport: HTMLElement | null;
  readonly history:
    | {
        readonly hasMoreHistory: boolean;
        readonly loading: boolean;
        readonly error: string | null;
        readonly onLoadEarlier: (throughEntryId?: string) => void;
      }
    | undefined;
  /** Lets go of the live follow, which would pull the list back to the end. */
  readonly navigate: () => void;
}) {
  const { jump, rowIndex, listReady, history } = input;
  const land = useEffectEvent((index: number, target: ThreadMessageJump) => {
    const list = input.listRef.current;
    if (!list) return;
    const { from } = target;
    let cancelled = false;
    let frame: number | null = null;
    const finish = () => {
      finishThreadMessageJump(target.threadKey);
      flashJumpTarget(input.viewport, target.messageId);
    };
    // True once the scroll that puts `from` of the row's height above the top edge of the list's
    // scroll node is on its way; the view report measures from that edge. False while the row
    // has no height yet.
    const shiftIntoRow = (fraction: number): boolean => {
      const scrollNode = list.getScrollableNode();
      if (!scrollNode) {
        finish();
        return true;
      }
      const state = list.getState();
      const container: HTMLElement | undefined = state.elementAtIndex(index);
      // The part of the row the view report measures, which leaves out the row's spacing.
      const measured = container?.querySelector<HTMLElement>("[data-view-item-id]") ?? container;
      const rect = measured?.getBoundingClientRect();
      const height: number | undefined = rect?.height ?? state.sizeAtIndex(index);
      if (height === undefined || !(height > 0)) return false;
      const start = rect ? rect.top - scrollNode.getBoundingClientRect().top : 0;
      const room = scrollNode.scrollHeight - scrollNode.clientHeight - scrollNode.scrollTop;
      const offset = scrollNode.scrollTop + Math.min(start + fraction * height, room);
      void Promise.resolve(list.scrollToOffset({ offset, animated: false })).then(() => {
        if (!cancelled && input.listRef.current === list) finish();
      });
      return true;
    };
    input.navigate();
    void Promise.resolve(
      list.scrollToIndex({
        index,
        animated: false,
        // With `from`, the row's start goes on the viewport's top edge before the shift into it.
        viewOffset: from === null ? TIMELINE_MINIMAP_TARGET_OFFSET : 0,
      }),
    ).then(() => {
      if (cancelled || input.listRef.current !== list) return;
      if (from === null) return finish();
      if (shiftIntoRow(from)) return;
      let waitingSince: number | null = null;
      const poll = (time: number) => {
        frame = null;
        if (cancelled || input.listRef.current !== list) return;
        if (waitingSince === null) waitingSince = time;
        if (shiftIntoRow(from)) return;
        if (time - waitingSince >= JUMP_MEASURE_WAIT_MS) return finish();
        frame = requestAnimationFrame(poll);
      };
      frame = requestAnimationFrame(poll);
    });
    return () => {
      cancelled = true;
      if (frame !== null) cancelAnimationFrame(frame);
    };
  });
  const loadThrough = useEffectEvent((target: MessageId) => history?.onLoadEarlier(target));
  const historyLoading = history?.loading === true;
  const historyExhausted =
    history === undefined || !history.hasMoreHistory || history.error !== null;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- scrolls the list to a linked message after the commit that rendered its row, and asks the server for earlier history until that row exists
  useEffect(() => {
    if (jump === null || !listReady) return;
    if (rowIndex >= 0) return land(rowIndex, jump);
    if (historyLoading) return;
    if (historyExhausted) {
      finishThreadMessageJump(jump.threadKey);
      return;
    }
    loadThrough(jump.messageId);
  }, [historyExhausted, historyLoading, jump, listReady, rowIndex]);
}

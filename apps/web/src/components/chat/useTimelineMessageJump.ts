import type { LegendListRef } from "@legendapp/list/react";
import type { MessageId } from "@t3tools/contracts";
import { useEffect, useEffectEvent, type RefObject } from "react";

import { TIMELINE_MINIMAP_TARGET_OFFSET } from "./MessagesTimeline.logic";
import { finishThreadMessageJump } from "./threadMessageJump";

const JUMP_FLASH_MS = 1_800;

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
  readonly threadKey: string;
  readonly messageId: MessageId | null;
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
  const { threadKey, messageId, rowIndex, listReady, history } = input;
  const land = useEffectEvent((index: number, target: MessageId) => {
    const list = input.listRef.current;
    if (!list) return;
    let cancelled = false;
    input.navigate();
    void Promise.resolve(
      list.scrollToIndex({ index, animated: false, viewOffset: TIMELINE_MINIMAP_TARGET_OFFSET }),
    ).then(() => {
      if (cancelled || input.listRef.current !== list) return;
      finishThreadMessageJump(threadKey);
      flashJumpTarget(input.viewport, target);
    });
    return () => {
      cancelled = true;
    };
  });
  const loadThrough = useEffectEvent((target: MessageId) => history?.onLoadEarlier(target));
  const historyLoading = history?.loading === true;
  const historyExhausted =
    history === undefined || !history.hasMoreHistory || history.error !== null;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- scrolls the list to a linked message after the commit that rendered its row, and asks the server for earlier history until that row exists
  useEffect(() => {
    if (messageId === null || !listReady) return;
    if (rowIndex >= 0) return land(rowIndex, messageId);
    if (historyLoading) return;
    if (historyExhausted) {
      finishThreadMessageJump(threadKey);
      return;
    }
    loadThrough(messageId);
  }, [historyExhausted, historyLoading, listReady, messageId, rowIndex, threadKey]);
}

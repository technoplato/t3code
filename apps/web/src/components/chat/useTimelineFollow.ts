import { useStableCallback } from "../../hooks/useStableCallback";
import { type MessageId, type RunId } from "@t3tools/contracts";
import {
  CHAT_LIST_ANCHOR_OFFSET,
  createChatListHistoryPaging,
  type ChatListHistory,
  type ChatListStepResult,
} from "@t3tools/shared/chatList";
import { Debouncer } from "@tanstack/react-pacer";
import {
  type SetStateAction,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { type LegendListRef } from "@legendapp/list/react";
import {
  CHAT_TIMELINE_ANCHOR_OFFSET,
  timelineContentOverflowsViewport,
  readTimelinePosition,
  observeTimelineRun,
  type TimelineRunObservation,
} from "./timelineScrollAnchoring";
import { createPageScrollController, type PageScrollKey } from "./pageScrollController";
import {
  FOLLOWING,
  initialTimelineFollow,
  navigationReleasesFollow,
  transitionTimelineFollow,
  type TimelineFollow,
  type TimelineFollowEvent,
  type TimelineNavigation,
  type TimelineViewport,
} from "./timelineViewport";
import {
  deriveNavigableMessageRowIndices,
  resolveAdjacentMessageNavigationTarget,
  resolveTimelineContentScroll,
  resolveTimelineIsAtEnd,
  resolveTimelineMinimapVisibleRange,
  TIMELINE_MINIMAP_TARGET_OFFSET,
  type MessagesTimelineRow,
} from "./MessagesTimeline.logic";
import { measuredEndOffset, settleListScroll } from "./useTimelinePositionRestore";
import {
  releaseChatTimelineAnchor,
  shouldReleaseTimelineAnchorForToolActivity,
} from "../ChatView.logic";
import type { Dispatch, RefObject } from "react";
import type { ThreadStructure } from "@t3tools/client-runtime/state/shell";
import type { deriveThreadActivityRun } from "@t3tools/client-runtime/state/thread-execution";
import type { EnvironmentThreadStatus } from "@t3tools/client-runtime/state/threads";
import type { TimelineEntry } from "../../session-logic";

interface TimelineAnchor {
  readonly threadKey: string | null;
  readonly messageId: MessageId | null;
}

/** One visit to a thread; a switch starts a new one from the remembered position. */
interface TimelineFollowVisit {
  readonly threadKey: string | null;
  readonly followEnd: boolean;
}

/**
 * Scroll bookkeeping that belongs to one visit. Handlers fetch it for the
 * current visit, so a thread switch leaves the old one behind instead of
 * resetting it.
 */
function createVisitScrollState(
  visit: TimelineFollowVisit,
  showScrollToBottom: (visit: TimelineFollowVisit) => void,
) {
  return {
    visit,
    // Debounce *showing* the scroll-to-bottom pill so it doesn't flash during
    // thread switches. LegendList fires scroll events with isAtEnd=false while
    // initialScrollAtEnd is settling; hiding is always immediate.
    showScrollDebouncer: new Debouncer(() => showScrollToBottom(visit), { wait: 150 }),
    positionedAnchor: null as MessageId | null,
    settledAnchor: null as MessageId | null,
    releaseAnchorScrollHold: null as (() => void) | null,
    pendingAnchorScrollRestore: null as {
      readonly messageId: MessageId;
      readonly offset: number;
    } | null,
    anchorScrollRestoreFrame: null as number | null,
    pendingMessageNavRowId: null as string | null,
  };
}
type VisitScrollState = ReturnType<typeof createVisitScrollState>;

function stopAnchorPositioning(scroll: VisitScrollState) {
  scroll.positionedAnchor = null;
  scroll.settledAnchor = null;
  scroll.releaseAnchorScrollHold?.();
  scroll.releaseAnchorScrollHold = null;
}

/** Whether the list still shows the anchored message; a thread switch replaces its data. */
function listShowsMessage(list: LegendListRef | null, messageId: MessageId): boolean {
  const rows = list?.getState().data as ReadonlyArray<MessagesTimelineRow> | undefined;
  return rows?.some((row) => row.kind === "message" && row.message.id === messageId) === true;
}

/**
 * The follow mode, read by scroll listeners at event time and by render
 * through useSyncExternalStore. State recorded for an earlier visit is
 * discarded, so a thread switch needs no reset step.
 */
function createTimelineFollowStore() {
  let snapshot: { readonly visit: TimelineFollowVisit | null; readonly follow: TimelineFollow } = {
    visit: null,
    follow: FOLLOWING,
  };
  const listeners = new Set<() => void>();
  // Page keys read the overlay at keypress time; it changes no rendered state.
  let composerOverlay: HTMLElement | null = null;
  const read = (visit: TimelineFollowVisit) =>
    snapshot.visit === visit ? snapshot.follow : initialTimelineFollow(visit.followEnd);
  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    snapshot: () => snapshot,
    read,
    /** Ref callback for the composer overlay. */
    attachComposerOverlay: (element: HTMLElement | null) => {
      composerOverlay = element;
    },
    readComposerOverlayHeight: () => composerOverlay?.getBoundingClientRect().height ?? 0,
    dispatch: (visit: TimelineFollowVisit, event: TimelineFollowEvent) => {
      const before = read(visit);
      const after = transitionTimelineFollow(before, event);
      if (snapshot.visit !== visit || after !== snapshot.follow) {
        snapshot = { visit, follow: after };
        for (const listener of listeners) listener();
      }
      return { before, after };
    },
  };
}

function sameRunObservation(
  next: TimelineRunObservation,
  previous: TimelineRunObservation | null,
): boolean {
  return (
    previous !== null &&
    next.threadKey === previous.threadKey &&
    next.hydrated === previous.hydrated &&
    next.runId === previous.runId
  );
}

interface TimelineFollowInput {
  readonly legendListRef: RefObject<LegendListRef | null>;
  readonly composerTimelineInset: number;
  readonly routeThreadKey: string;
  readonly activeThreadKey: string | null;
  readonly isServerThread: boolean;
  readonly serverProjection: ThreadStructure | null;
  readonly threadStatus: EnvironmentThreadStatus;
  readonly activeActivityRun: ReturnType<typeof deriveThreadActivityRun>;
  readonly activeRunningTurnId: RunId | null;
  readonly timelineEntries: ReadonlyArray<TimelineEntry>;
  readonly timelineAnchorMessageId: MessageId | null;
  readonly setTimelineAnchor: Dispatch<SetStateAction<TimelineAnchor>>;
  /** Earlier history a step back loads when it reaches the start of what is loaded. */
  readonly historyControls?: ChatListHistory | undefined;
}

/**
 * Keeps the timeline following the live end, anchoring a newly sent turn near
 * the top, and letting the user scroll away. Follow lives in a store the
 * viewport's navigation signal writes, so a scroll gesture does not re-render
 * ChatView unless the follow mode flips.
 */
export function useTimelineFollow(input: TimelineFollowInput) {
  const {
    legendListRef,
    composerTimelineInset,
    routeThreadKey,
    activeThreadKey,
    isServerThread,
    serverProjection,
    threadStatus,
    activeActivityRun,
    activeRunningTurnId,
    timelineEntries,
    timelineAnchorMessageId,
    setTimelineAnchor,
    historyControls,
  } = input;
  const [visitState, setVisit] = useState<TimelineFollowVisit>({
    threadKey: activeThreadKey,
    followEnd: true,
  });
  let visit = visitState;
  if (visit.threadKey !== activeThreadKey) {
    visit = {
      threadKey: activeThreadKey,
      followEnd: readTimelinePosition(routeThreadKey)?.atEnd !== false,
    };
    setVisit(visit);
  }
  // Keyed by visit, so a pill decision from the previous thread (a pending
  // debounce) never shows here.
  const [pill, setPill] = useState<{ readonly visit: TimelineFollowVisit; readonly show: boolean }>(
    { visit, show: false },
  );
  const showScrollToBottom = pill.visit === visit ? pill.show : !visit.followEnd;
  // Called on every streamed chunk while following; an unchanged pill must
  // bail out instead of re-rendering ChatView.
  const setShowScrollToBottom = (show: boolean) =>
    setPill((current) =>
      current.visit === visit && current.show === show ? current : { visit, show },
    );
  const [followStore] = useState(createTimelineFollowStore);
  const followSnapshot = useSyncExternalStore(followStore.subscribe, followStore.snapshot);
  const follow =
    followSnapshot.visit === visit ? followSnapshot.follow : initialTimelineFollow(visit.followEnd);
  const timelineLiveFollowEnabled = follow.mode === "following";
  const readFollow = () => followStore.read(visit);
  // Async settles outlive their render; this reads the visit shown now.
  const readCurrentFollow = useStableCallback(readFollow);
  const isTimelineAtLogicalEnd = () => {
    const current = readFollow();
    return (
      resolveTimelineIsAtEnd(legendListRef.current?.getState()) ??
      (current.mode === "following" || current.atEnd)
    );
  };
  const visitScrollRef = useRef<VisitScrollState | null>(null);
  // Loads earlier history when steps back reach the start of what the timeline has loaded.
  const [historyPaging] = useState(createChatListHistoryPaging);
  /** Only from handlers: the bookkeeping of the visit they run in. */
  const visitScroll = () => {
    if (visitScrollRef.current?.visit !== visit) {
      visitScrollRef.current = createVisitScrollState(visit, (shownVisit) => {
        // A debounce that outlived its visit must not overwrite the current one's pill.
        if (visitScrollRef.current?.visit === shownVisit)
          setPill({ visit: shownVisit, show: true });
      });
    }
    return visitScrollRef.current;
  };
  // The anchor whose list position LegendList reported ready; until then a
  // newly started run must not re-anchor.
  const [laidOutAnchor, setLaidOutAnchor] = useState<MessageId | null>(null);
  const anchorPending =
    timelineAnchorMessageId !== null && laidOutAnchor !== timelineAnchorMessageId;
  const viewportRef = useRef<TimelineViewport | null>(null);
  const releaseFollowForNavigation = () => {
    const { before } = followStore.dispatch(visit, { type: "navigated" });
    if (before.mode === "following") viewportRef.current?.followReleased();
    const scroll = visitScroll();
    stopAnchorPositioning(scroll);
    scroll.pendingAnchorScrollRestore = null;
    if (scroll.anchorScrollRestoreFrame !== null) {
      cancelAnimationFrame(scroll.anchorScrollRestoreFrame);
      scroll.anchorScrollRestoreFrame = null;
    }
    if (before.mode === "following") legendListRef.current?.cancelScroll();
  };

  // A run that starts while the live end is followed anchors its user message
  // near the top, unless the previous anchor has not been laid out yet.
  const [observedRun, setObservedRun] = useState<TimelineRunObservation | null>(null);
  const dispatchedUserItem =
    observedRun?.hydrated &&
    observedRun.threadKey === activeThreadKey &&
    activeActivityRun !== null &&
    observedRun.runId !== activeActivityRun.runId
      ? serverProjection?.visibleTurnItems.find(
          (row) => row.item.type === "user_message" && row.item.runId === activeActivityRun.runId,
        )
      : undefined;
  const runObservation = observeTimelineRun(observedRun, {
    threadKey: activeThreadKey,
    hydrated: !isServerThread || (serverProjection !== null && threadStatus === "live"),
    runId: activeActivityRun?.runId ?? null,
    queued: activeActivityRun?.status === "queued",
    messageId:
      dispatchedUserItem?.item.type === "user_message" ? dispatchedUserItem.item.messageId : null,
  });
  if (!sameRunObservation(runObservation.observation, observedRun)) {
    setObservedRun(runObservation.observation);
    const startedRunAnchor = runObservation.anchorMessageId;
    if (startedRunAnchor !== null && !anchorPending && timelineLiveFollowEnabled) {
      setShowScrollToBottom(false);
      setTimelineAnchor({ threadKey: activeThreadKey, messageId: startedRunAnchor });
    }
  }
  const timelineRealContentOverflowsViewport = () =>
    timelineContentOverflowsViewport(legendListRef.current?.getState(), {
      composerInset: composerTimelineInset,
      anchorOffset: CHAT_TIMELINE_ANCHOR_OFFSET,
    });
  const pageScrollControllerRef = useRef<ReturnType<typeof createPageScrollController> | null>(
    null,
  );
  const handlePageScrollStart = useStableCallback((key: PageScrollKey) => {
    if ((key === "PageUp" && timelineRealContentOverflowsViewport()) || !isTimelineAtLogicalEnd()) {
      // Through the viewport, so a running position restore stops too.
      viewportRef.current?.navigate({ releasesFollow: true });
    }
  });
  const onComposerPageScrollKeyDown = (key: PageScrollKey) => {
    pageScrollControllerRef.current?.handleKeyDown(key);
  };
  const onComposerPageScrollKeyDownStable = useStableCallback(onComposerPageScrollKeyDown);
  const onComposerPageScrollKeyUp = (key: string) => {
    pageScrollControllerRef.current?.handleKeyUp(key);
  };
  const onComposerPageScrollKeyUpStable = useStableCallback(onComposerPageScrollKeyUp);
  const onComposerPageScrollRelease = () => {
    pageScrollControllerRef.current?.releaseActiveKey();
  };
  const onComposerPageScrollReleaseStable = useStableCallback(onComposerPageScrollRelease);
  const scrollToEnd = (animated: boolean = false) => {
    // Stops a running position restore; follow itself is re-armed below.
    viewportRef.current?.navigate({ releasesFollow: false });
    followStore.dispatch(visit, { type: "followEnd" });
    const scroll = visitScroll();
    scroll.pendingMessageNavRowId = null;
    scroll.showScrollDebouncer.cancel();
    setShowScrollToBottom(false);
    setTimelineAnchor(releaseChatTimelineAnchor);
    // The anchored end space must be gone before the scroll measures, or the
    // list lands short of the real end.
    requestAnimationFrame(() => {
      const list = legendListRef.current;
      if (!list) return;
      void Promise.resolve(
        list.scrollToEnd?.({
          animated: animated && !window.matchMedia("(prefers-reduced-motion: reduce)").matches,
        }),
      ).then(() =>
        settleListScroll(
          list,
          measuredEndOffset,
          () => readCurrentFollow().mode !== "following" || legendListRef.current !== list,
        ),
      );
    });
  };
  const scrollToEndStable = useStableCallback(scrollToEnd);
  // The list does not follow footer layout, so the resting composer cannot scroll it. Growth
  // above the composer (a new notice) would cover the last rows instead.
  const followedInsetRef = useRef(composerTimelineInset);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- scrolls the list after its bottom inset grows
  useLayoutEffect(() => {
    const grew = composerTimelineInset > followedInsetRef.current;
    followedInsetRef.current = composerTimelineInset;
    if (grew && readCurrentFollow().mode === "following") scrollToEndStable();
  }, [composerTimelineInset, readCurrentFollow, scrollToEndStable]);

  const stepToAdjacentMessage = (direction: "previous" | "next"): ChatListStepResult => {
    const list = legendListRef.current;
    const state = list?.getState?.();
    const viewport = list?.getScrollableNode?.();
    if (!list || !state || !viewport) return { kind: "none" };
    const rows = state.data as ReadonlyArray<MessagesTimelineRow>;
    const navigable = deriveNavigableMessageRowIndices(rows);

    const scroll = resolveTimelineContentScroll(state, viewport);
    const atStart = viewport.scrollTop <= 1;
    const atEnd = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 1;
    const visibleRange = resolveTimelineMinimapVisibleRange({ ...state, scroll });
    const currentVisitScroll = visitScroll();
    const pendingRowId = currentVisitScroll.pendingMessageNavRowId;
    const target = resolveAdjacentMessageNavigationTarget({
      rows,
      direction,
      scroll,
      atStart,
      atEnd,
      positionAtIndex: state.positionAtIndex,
      visibleStart: visibleRange.start,
      pendingRowId,
    });
    if (target === null) {
      if (direction === "next") return { kind: "none" };
      // The row a step counts back from once earlier history has loaded above it.
      const pendingIndex =
        pendingRowId === null ? -1 : rows.findIndex((row) => row.id === pendingRowId);
      const firstNavigable = navigable[0];
      const anchorRowId =
        pendingIndex >= 0
          ? pendingRowId
          : firstNavigable === undefined
            ? (rows[0]?.id ?? null)
            : rows[firstNavigable]!.id;
      return { kind: "start", anchorRowId };
    }
    if (target.kind === "end") {
      currentVisitScroll.pendingMessageNavRowId = null;
      scrollToEnd(true);
      return target;
    }
    currentVisitScroll.pendingMessageNavRowId = target.rowId;
    viewportRef.current?.navigate({ releasesFollow: true });
    // By key, so a page of history loading above mid-scroll does not move the target.
    void list.scrollToKey({
      key: target.rowId,
      animated: !window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      viewOffset: TIMELINE_MINIMAP_TARGET_OFFSET,
    });
    return target;
  };
  const navigateToAdjacentMessage = (direction: "previous" | "next"): boolean => {
    const state = legendListRef.current?.getState?.();
    if (!state || !legendListRef.current?.getScrollableNode?.()) return false;
    const outcome = historyPaging.afterStep(direction, stepToAdjacentMessage(direction), false);
    return (
      outcome !== "none" ||
      deriveNavigableMessageRowIndices(state.data as ReadonlyArray<MessagesTimelineRow>).length > 0
    );
  };
  const navigateToAdjacentMessageStable = useStableCallback(navigateToAdjacentMessage);
  const stepBackFromStable = useStableCallback((anchorRowId: string) => {
    visitScroll().pendingMessageNavRowId = anchorRowId;
    return stepToAdjacentMessage("previous").kind === "row";
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- hands the history paging the list it reads when a step runs into the loaded start
  useLayoutEffect(() => {
    const readRows = () =>
      legendListRef.current?.getState?.().data as ReadonlyArray<MessagesTimelineRow> | undefined;
    historyPaging.setHost({
      // The first row changes only when history lands above it, never as a reply streams in.
      headId: () => readRows()?.[0]?.id ?? "__empty__",
      hasEarlier: (anchorRowId) => {
        const rows = readRows();
        const index = rows?.findIndex((row) => row.id === anchorRowId) ?? -1;
        if (!rows || index < 0) return undefined;
        return deriveNavigableMessageRowIndices(rows).some((rowIndex) => rowIndex < index);
      },
      stepFrom: stepBackFromStable,
      onStepped: () => {},
      onExhausted: () => {},
      requestFrame: (callback) => requestAnimationFrame(callback),
    });
  }, [historyPaging, legendListRef, stepBackFromStable]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- hands the history paging each committed history state, so a step waiting on a page takes it once it lands
  useLayoutEffect(() => {
    historyPaging.setHistory(historyControls ?? null, activeThreadKey);
  }, [historyPaging, historyControls, activeThreadKey]);

  const handleNavigation = (navigation: TimelineNavigation) => {
    if (navigation.source !== "command") {
      visitScroll().pendingMessageNavRowId = null;
      historyPaging.cancel();
    }
    const awayFromEnd = () => resolveTimelineIsAtEnd(legendListRef.current?.getState()) === false;
    const releases = navigationReleasesFollow(navigation, {
      contentScrollsUp: timelineRealContentOverflowsViewport,
      awayFromEnd,
    });
    if (releases) releaseFollowForNavigation();
  };
  const handleNavigationStable = useStableCallback(handleNavigation);
  /**
   * Attached by the timeline's list ref callback, so follow hears the
   * viewport's navigation exactly as long as the scroll node exists.
   */
  const attachTimelineViewport = (viewport: TimelineViewport) => {
    viewportRef.current = viewport;
    const unsubscribe = viewport.subscribe(handleNavigationStable);
    const controller = createPageScrollController({
      getContainer: () => viewport.scrollNode,
      getScrollPaddingBottomPx: followStore.readComposerOverlayHeight,
      onScrollStart: handlePageScrollStart,
    });
    pageScrollControllerRef.current = controller;
    return () => {
      unsubscribe();
      controller.dispose();
      if (pageScrollControllerRef.current === controller) pageScrollControllerRef.current = null;
      if (viewportRef.current === viewport) viewportRef.current = null;
      const scroll = visitScrollRef.current;
      scroll?.releaseAnchorScrollHold?.();
      if (scroll) scroll.releaseAnchorScrollHold = null;
    };
  };

  const onTimelineAnchorReady = (messageId: MessageId, anchorIndex: number) => {
    setLaidOutAnchor(messageId);
    const scroll = visitScroll();
    if (scroll.positionedAnchor === messageId) {
      return;
    }
    stopAnchorPositioning(scroll);
    scroll.positionedAnchor = messageId;
    // The positioning scroll moves up when the anchor sits above the view.
    const releaseHold = viewportRef.current?.holdProgrammaticScroll() ?? (() => {});
    scroll.releaseAnchorScrollHold = releaseHold;
    const isPositioning = () =>
      scroll.positionedAnchor === messageId && listShowsMessage(legendListRef.current, messageId);
    // Releasing is idempotent, so an attempt that is no longer current (the
    // thread switched, the user navigated) always lets go of its own hold.
    const abandon = () => {
      releaseHold();
      if (scroll.positionedAnchor === messageId) stopAnchorPositioning(scroll);
    };
    const positionAnchor = (remainingAttempts: number) => {
      requestAnimationFrame(() => {
        if (!isPositioning()) {
          abandon();
          return;
        }
        const list = legendListRef.current;
        if (!list) {
          if (remainingAttempts > 0) {
            positionAnchor(remainingAttempts - 1);
          } else {
            abandon();
          }
          return;
        }
        // LegendList waits for queued layout and the animation before resolving.
        void list
          .scrollToIndex({
            index: anchorIndex,
            animated: !window.matchMedia("(prefers-reduced-motion: reduce)").matches,
            viewPosition: 0,
            viewOffset: CHAT_LIST_ANCHOR_OFFSET,
          })
          .then(() => {
            if (legendListRef.current === list && isPositioning()) {
              scroll.settledAnchor = messageId;
              releaseHold();
              scroll.releaseAnchorScrollHold = null;
            } else {
              abandon();
            }
          });
      });
    };
    requestAnimationFrame(() => positionAnchor(12));
  };
  const onTimelineAnchorReadyStable = useStableCallback(onTimelineAnchorReady);
  const onTimelineAnchorSizeChanged = (messageId: MessageId) => {
    const scroll = visitScroll();
    if (scroll.settledAnchor !== messageId || readFollow().mode === "following") {
      return;
    }
    const scrollOffset = legendListRef.current?.getState().scroll;
    if (scrollOffset === undefined) {
      return;
    }
    if (scroll.pendingAnchorScrollRestore === null) {
      scroll.pendingAnchorScrollRestore = { messageId, offset: scrollOffset };
    }
    if (scroll.anchorScrollRestoreFrame !== null) {
      return;
    }
    scroll.anchorScrollRestoreFrame = requestAnimationFrame(() => {
      scroll.anchorScrollRestoreFrame = null;
      const pending = scroll.pendingAnchorScrollRestore;
      scroll.pendingAnchorScrollRestore = null;
      if (pending && scroll.settledAnchor === pending.messageId) {
        const list = legendListRef.current;
        const currentScrollOffset = list?.getState().scroll;
        if (
          typeof currentScrollOffset === "number" &&
          Math.abs(currentScrollOffset - pending.offset) <= 2
        ) {
          void list?.scrollToOffset({ offset: pending.offset, animated: false });
        }
      }
    });
  };
  const onTimelineAnchorSizeChangedStable = useStableCallback(onTimelineAnchorSizeChanged);

  // The list ignores footer layout, so a new queued turn or status line there would land
  // under the composer. Follow it when the reader was following the end.
  const onTimelineFooterGrow = () => {
    if (readFollow().mode === "following") scrollToEndStable();
  };
  const onTimelineFooterGrowStable = useStableCallback(onTimelineFooterGrow);

  const onIsAtEndChange = (isAtEnd: boolean) => {
    const scroll = visitScroll();
    if (!isAtEnd && readFollow().mode === "following") {
      scroll.showScrollDebouncer.cancel();
      setShowScrollToBottom(false);
      return;
    }
    const { before, after } = followStore.dispatch(visit, {
      type: isAtEnd ? "reachedEnd" : "leftEnd",
    });
    if (after === before) return;
    if (after.mode === "following") {
      setTimelineAnchor(releaseChatTimelineAnchor);
      scroll.showScrollDebouncer.cancel();
      setShowScrollToBottom(false);
    } else {
      scroll.showScrollDebouncer.maybeExecute();
    }
  };
  const onIsAtEndChangeStable = useStableCallback(onIsAtEndChange);

  // timelineEntries leave out reasoning rows (their text is not in the
  // structure), and reasoning counts as tool activity, like any work row.
  const runningTurnHasReasoning =
    activeRunningTurnId !== null &&
    serverProjection?.visibleTurnItems.some(
      (row) => row.item.type === "reasoning" && row.item.runId === activeRunningTurnId,
    ) === true;
  // Z: the release scrolls, and that scroll must follow the commit that drops
  // the anchored end space; the trigger is streamed thread data. A
  // totalSize listener cannot replace it: the anchored end space can already
  // be 0, so dropping it changes no size and no list event fires.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- scrolls the timeline to the end after the commit that drops anchored end space
  useLayoutEffect(() => {
    if (timelineAnchorMessageId === null || !timelineLiveFollowEnabled) return;
    if (
      runningTurnHasReasoning ||
      shouldReleaseTimelineAnchorForToolActivity({
        anchorMessageId: timelineAnchorMessageId,
        liveFollowEnabled: timelineLiveFollowEnabled,
        runningTurnId: activeRunningTurnId,
        timelineEntries,
      })
    ) {
      scrollToEndStable();
    }
  }, [
    activeRunningTurnId,
    runningTurnHasReasoning,
    scrollToEndStable,
    timelineAnchorMessageId,
    timelineEntries,
    timelineLiveFollowEnabled,
  ]);

  /** Arms the anchor for a message the user just sent, before its run exists. */
  const anchorNewTurn = (threadKey: string, messageId: MessageId) => {
    followStore.dispatch(visit, { type: "followEnd" });
    const scroll = visitScroll();
    scroll.pendingMessageNavRowId = null;
    scroll.showScrollDebouncer.cancel();
    setShowScrollToBottom(false);
    setTimelineAnchor({ threadKey, messageId });
  };

  return {
    showScrollToBottom,
    timelineLiveFollowEnabled,
    onComposerPageScrollKeyDownStable,
    onComposerPageScrollKeyUpStable,
    onComposerPageScrollReleaseStable,
    scrollToEnd,
    navigateToAdjacentMessageStable,
    onTimelineAnchorReadyStable,
    onTimelineAnchorSizeChangedStable,
    onTimelineFooterGrowStable,
    onIsAtEndChangeStable,
    anchorNewTurn,
    attachTimelineViewport,
    attachComposerOverlay: followStore.attachComposerOverlay,
  };
}

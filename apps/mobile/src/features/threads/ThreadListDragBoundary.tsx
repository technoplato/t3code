import { useAtomValue } from "@effect/atom-react";
import type { LegendListRef } from "@legendapp/list/react-native";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import * as Haptics from "expo-haptics";
import { msg, useMessages } from "gt-react-native";
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { View, type ViewInstance } from "react-native";
import {
  GestureDetector,
  useCompetingGestures,
  type NativeGesture,
} from "react-native-gesture-handler";
import Reanimated, { useAnimatedStyle, useSharedValue } from "react-native-reanimated";

import { AppText as Text } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";
import { appAtomRegistry } from "../../state/atom-registry";
import { threadListEnvironmentsAtom } from "../../state/presentation";
import { environmentServerConfigsAtom } from "../../state/server";
import {
  getPendingThreadOrder,
  threadDropBusyAtom,
  usePendingThreadOrder,
} from "../../state/thread-order";
import { steadyNavigationThreadShellsAtom, steadyShellsHoldingAtom } from "../../state/threads";
import { queuedThreadKeysAtom } from "../../state/use-thread-outbox";
import {
  createThreadDropValidator,
  describeThreadDragRows,
  threadDragOrderVersion,
  type ThreadDragZone,
  type ThreadDropDestination,
} from "./threadListDrag";
import {
  createThreadListDrag,
  type ThreadDragPreview,
  type ThreadListDragHost,
} from "./threadListDragEngine";
import { getThreadListV2OrderedSection } from "./threadListV2";
import { createThreadMovePlanner, threadDragAction, type ThreadDragSection } from "./threadOrder";
import { THREAD_DRAG_LIFT, useThreadDragGesture } from "./useThreadDragGesture";

interface ThreadListDragBoundaryProps {
  /** The list this boundary wraps. Its state says where every row is. */
  readonly listRef: RefObject<LegendListRef | null>;
  /** The list's rows, as it renders them. */
  readonly items: ReadonlyArray<{ readonly type: string; readonly key: string }>;
  /** The list's own scroll gesture. The drag competes with it: whichever starts first wins. */
  readonly scrollGesture: NativeGesture;
  readonly estimatedItemSize: number;
  /** The list header's height, from the list's `onMetricsChange`. Zero with no header. */
  readonly headerSize: number;
  /** The list content's top padding. */
  readonly paddingTop: number;
  /**
   * How much of the list's top a bar covers, as far as the screen knows: Home's own
   * `contentInset.top`, or what the sidebar's scroll events report. The inset UIKit adds by
   * itself shows in neither, so the drag also learns it from where the list rests.
   */
  readonly contentInsetTop: number;
  /** No drags: the list is searching or selecting. */
  readonly disabled: boolean;
  /** Active lists by time, so it takes a drop's state change but no slot. */
  readonly activeTimeOrdered: boolean;
  readonly pane: "screen" | "sidebar";
  readonly onMoveThread: (
    thread: EnvironmentThreadShell,
    destination: ThreadDropDestination,
  ) => Promise<boolean>;
  readonly onDragStart?: () => void;
  readonly onDragEnd?: () => void;
  readonly children: ReactNode;
}

const PINNED_LABEL = msg("Pinned", { $context: "thread list section" });
const SETTLED_LABEL = msg("Settled", { $context: "thread list section" });

const liftHaptic = () => void Haptics.selectionAsync();

function dropValidator(
  row: {
    readonly thread: EnvironmentThreadShell;
    readonly threadKey: string;
    readonly section: ThreadDragSection;
  },
  activeTimeOrdered: boolean,
) {
  // Plan against the complete sections, as `moveThread` does, so a filtered list plans the same.
  const threads = appAtomRegistry.get(steadyNavigationThreadShellsAtom);
  const configs = appAtomRegistry.get(environmentServerConfigsAtom);
  const listEnvironments = appAtomRegistry.get(threadListEnvironmentsAtom);
  const now = new Date().toISOString();
  const planner = (section: "pinned" | "active") =>
    createThreadMovePlanner({
      ordered: getThreadListV2OrderedSection({
        threads,
        section,
        now,
        queuedThreadKeys: appAtomRegistry.get(queuedThreadKeysAtom),
        settlementEnvironmentIds: new Set(configs.keys()),
        snoozeEnvironmentIds: new Set(configs.keys()),
      }),
      allThreads: threads,
      section,
      reorderableEnvironmentIds:
        section === "pinned"
          ? listEnvironments.pinReorderEnvironmentIds
          : listEnvironments.activeReorderEnvironmentIds,
    });
  return createThreadDropValidator({
    thread: row.thread,
    threadKey: row.threadKey,
    sourceSection: row.section,
    configLoaded: configs.has(row.thread.environmentId),
    activeTimeOrdered,
    now,
    planPinned: planner("pinned"),
    planActive: planner("active"),
  });
}

/** A drop is saving, the list holds rows older than the server's, or the thread cannot move. */
function canLiftThread(thread: EnvironmentThreadShell): boolean {
  if (
    appAtomRegistry.get(threadDropBusyAtom) ||
    appAtomRegistry.get(steadyShellsHoldingAtom) ||
    getPendingThreadOrder() !== null
  ) {
    return false;
  }
  const listEnvironments = appAtomRegistry.get(threadListEnvironmentsAtom);
  return (
    listEnvironments.pinReorderEnvironmentIds.has(thread.environmentId) ||
    listEnvironments.activeReorderEnvironmentIds.has(thread.environmentId)
  );
}

function DropZone(props: {
  readonly zone: ThreadDragZone;
  readonly label: string;
  readonly active: boolean;
  readonly pane: "screen" | "sidebar";
}) {
  return (
    <View
      className={cn(
        "absolute left-4 right-4 items-center justify-center rounded-xl border border-dashed",
        props.active ? "border-primary" : "border-border",
        props.pane === "sidebar" ? "bg-drawer" : "bg-screen",
      )}
      style={{ top: props.zone.top, height: props.zone.height }}
    >
      <Text
        className={cn(
          "text-sm font-t3-semibold",
          props.active ? "text-foreground" : "text-foreground-muted",
        )}
      >
        {props.label}
      </Text>
    </View>
  );
}

/**
 * Direct drag for a thread list, as on the desktop sidebar: hold a row, then move it, to reorder,
 * pin, unpin, settle, un-settle or wake it. Everything lives on the list and nothing on a row:
 * the gesture, the card under the pointer, the bar at the drop's slot, the floating targets.
 * The list's data never changes during a drag, so no row shifts or remounts.
 */
export function ThreadListDragBoundary(props: ThreadListDragBoundaryProps) {
  const m = useMessages();
  const dropBusy = useAtomValue(threadDropBusyAtom);
  const holdingRows = useAtomValue(steadyShellsHoldingAtom);
  const pendingOrder = usePendingThreadOrder();
  const enabled = !props.disabled && !dropBusy && !holdingRows && pendingOrder === null;

  const wrapperRef = useRef<ViewInstance>(null);
  const pressSequence = useRef(0);
  const [preview, setPreview] = useState<ThreadDragPreview | null>(null);

  const liftable = useSharedValue<number>(THREAD_DRAG_LIFT.unknown);
  const pointerY = useSharedValue(0);
  const lifted = useSharedValue(0);
  const originY = useSharedValue(0);
  const grab = useSharedValue(0);
  const cardHeight = useSharedValue(0);
  const viewportHeight = useSharedValue(0);
  const barY = useSharedValue(0);
  const barShown = useSharedValue(0);
  const sourceTop = useSharedValue(0);
  const sourceHeight = useSharedValue(0);

  const [drag] = useState(() =>
    createThreadListDrag({
      lift: (card) => {
        originY.set(card.originY);
        grab.set(card.grab);
        cardHeight.set(card.height);
        viewportHeight.set(card.viewportHeight);
        lifted.set(1);
      },
      drop: () => lifted.set(0),
      setBar: (y) => {
        if (y !== null) barY.set(y);
        barShown.set(y === null ? 0 : 1);
      },
      setSource: (top, height) => {
        sourceTop.set(top);
        sourceHeight.set(height);
      },
      setPreview,
      requestFrame: (callback) => requestAnimationFrame(callback),
      cancelFrame: (frame) => cancelAnimationFrame(frame),
    }),
  );

  const { listRef, activeTimeOrdered, onMoveThread, onDragStart, onDragEnd } = props;
  const host = (): ThreadListDragHost => ({
    list: listRef.current,
    layout: {
      headerSize: props.headerSize,
      paddingTop: props.paddingTop,
      contentInsetTop: props.contentInsetTop,
      estimatedItemSize: props.estimatedItemSize,
    },
    canLift: canLiftThread,
    validate: (row) => dropValidator(row, activeTimeOrdered),
    action: (source, destination) => threadDragAction(source, destination, m),
    onLift: () => {
      liftHaptic();
      onDragStart?.();
    },
    onDrop: (thread, destination) => void onMoveThread(thread, destination),
    onEnd: onDragEnd,
  });

  const handlePress = (absoluteY: number) => {
    const sequence = (pressSequence.current += 1);
    const wrapper = wrapperRef.current;
    if (wrapper === null) {
      liftable.set(THREAD_DRAG_LIFT.refused);
      return;
    }
    // The pointer's y is the window's; the list's rows are measured from the list's own top.
    wrapper.measureInWindow((_x, y, _width, height) => {
      if (sequence !== pressSequence.current) return;
      const allowed = drag.press(host(), {
        pointerY: absoluteY - y,
        originY: y,
        viewportHeight: height,
      });
      liftable.set(allowed ? THREAD_DRAG_LIFT.allowed : THREAD_DRAG_LIFT.refused);
    });
  };
  const handleLift = (absoluteY: number) => drag.lift(host(), absoluteY);
  const handleMove = (absoluteY: number) => drag.move(host(), absoluteY);
  const handleRelease = (dropped: boolean) => drag.release(host(), dropped);

  const dragGesture = useThreadDragGesture({
    enabled,
    liftable,
    pointerY,
    onPress: handlePress,
    onLift: handleLift,
    onMove: handleMove,
    onRelease: handleRelease,
  });
  const gesture = useCompetingGestures(dragGesture, props.scrollGesture);

  // A drag is planned against the rows it lifted from. A row that joins, leaves, moves or takes
  // a new order key under it ends the drag, as does anything that turns drags off.
  const orderVersion =
    preview === null ? null : threadDragOrderVersion(describeThreadDragRows(props.items));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- cancels the in-progress drag, which lives outside React, when the thread order changes underneath it or drags turn off
  useEffect(() => {
    const liftedVersion = drag.orderVersion();
    if (liftedVersion === null) return;
    if (!enabled || (orderVersion !== null && orderVersion !== liftedVersion)) drag.cancel(host());
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- stops the drag's auto-scroll frames on unmount
  useEffect(() => () => drag.dispose(), [drag]);

  const cardStyle = useAnimatedStyle(() => ({
    opacity: lifted.value,
    transform: [
      {
        translateY: Math.max(
          0,
          Math.min(
            viewportHeight.value - cardHeight.value,
            pointerY.value - originY.value - grab.value,
          ),
        ),
      },
    ],
  }));
  const barStyle = useAnimatedStyle(() => ({
    opacity: barShown.value * lifted.value,
    transform: [{ translateY: barY.value - 1 }],
  }));
  const sourceStyle = useAnimatedStyle(() => ({
    opacity: lifted.value * 0.65,
    height: sourceHeight.value,
    transform: [{ translateY: sourceTop.value }],
  }));

  const surface = props.pane === "sidebar" ? "bg-drawer" : "bg-screen";
  return (
    <View
      ref={wrapperRef}
      collapsable={false}
      className="flex-1"
      onLayout={() => drag.forgetInset()}
    >
      <GestureDetector gesture={gesture}>{props.children}</GestureDetector>
      {preview === null ? null : (
        <View pointerEvents="none" className="absolute inset-0 overflow-hidden">
          {/* The dragged row stays in its slot, dimmed to 0.35 by a wash of the list's own
              surface: the row itself takes no drag state. */}
          <Reanimated.View
            className={cn("absolute left-0 right-0 top-0", surface)}
            style={sourceStyle}
          />
          <Reanimated.View
            className="absolute left-3 right-3 top-0 rounded-full bg-primary"
            style={[{ height: 2 }, barStyle]}
          />
          {preview.zones.pinned ? (
            <DropZone
              zone={preview.zones.pinned}
              label={m(PINNED_LABEL)}
              active={preview.zone === "pinned"}
              pane={props.pane}
            />
          ) : null}
          {preview.zones.settled ? (
            <DropZone
              zone={preview.zones.settled}
              label={m(SETTLED_LABEL)}
              active={preview.zone === "settled"}
              pane={props.pane}
            />
          ) : null}
          <Reanimated.View
            className={cn(
              "absolute left-3 right-3 top-0 flex-row items-center gap-3 rounded-xl border border-border px-4",
              surface,
            )}
            style={[{ height: preview.cardHeight }, cardStyle]}
          >
            <Text
              numberOfLines={preview.cardHeight >= 72 ? 2 : 1}
              className="flex-1 text-base font-t3-medium"
            >
              {preview.title}
            </Text>
            {preview.action === null ? null : (
              <View className="rounded-full bg-primary/20 px-2.5 py-1">
                <Text className="text-xs font-t3-semibold">{preview.action}</Text>
              </View>
            )}
          </Reanimated.View>
        </View>
      )}
    </View>
  );
}

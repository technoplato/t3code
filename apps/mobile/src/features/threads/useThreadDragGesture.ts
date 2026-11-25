import { Platform } from "react-native";
import {
  GestureStateManager,
  MouseButton,
  PointerType,
  usePanGesture,
} from "react-native-gesture-handler";
import { runOnJS, useSharedValue, type SharedValue } from "react-native-reanimated";

import { threadDragActivation } from "./threadListDrag";

/** What the pressed row's lift is waiting on, set by the list once it has found the row. */
export const THREAD_DRAG_LIFT = { unknown: 0, allowed: 1, refused: 2 } as const;

const TOUCH = PointerType.TOUCH;
const MOUSE = PointerType.MOUSE;

/**
 * When a held row's long-press menu opens on Android, whose menu window leaves the touch with
 * the list: from then on a move is the menu's, not a drag. Just under the platform's default
 * long-press delay of 400 ms. On iOS the menu takes the touch away itself.
 */
const MENU_OPENS_AT_MS = Platform.OS === "android" ? 380 : null;

/**
 * Starts a thread drag anywhere on the list, with no mode: a finger that holds then moves along
 * it, or a primary mouse click that moves along it. It sits on the list, so a recycled row takes
 * nothing with it, and never activates by itself, so scroll, swipe and the row's menu run until
 * it does. It is only the trigger: an Arrange mode could drive the same drag in its place.
 */
export function useThreadDragGesture(input: {
  readonly enabled: boolean;
  /** One of `THREAD_DRAG_LIFT`. `onPress` answers into it. */
  readonly liftable: SharedValue<number>;
  /** The lifted pointer's window y, written on the UI thread so the card follows it there. */
  readonly pointerY: SharedValue<number>;
  readonly onPress: (absoluteY: number) => void;
  readonly onLift: (absoluteY: number) => void;
  readonly onMove: (absoluteY: number) => void;
  readonly onRelease: (dropped: boolean) => void;
}) {
  const { liftable, pointerY, onPress, onLift, onMove, onRelease } = input;
  /** 0 at rest, 1 while a pressed pointer may still become a drag, 2 once lifted. */
  const phase = useSharedValue(0);
  const mouse = useSharedValue(false);
  const startX = useSharedValue(0);
  const startY = useSharedValue(0);
  const pressedAt = useSharedValue(0);
  const movedAt = useSharedValue(0);
  // Every option is named: the worklets Babel plugin rejects a spread in a gesture's options.
  return usePanGesture({
    enabled: input.enabled,
    manualActivation: true,
    maxPointers: 1,
    mouseButton: MouseButton.LEFT,
    enableTrackpadTwoFingerGesture: false,
    shouldCancelWhenOutside: false,
    onTouchesDown: (event) => {
      "worklet";
      if (phase.value === 2) return;
      const touch = event.allTouches[0];
      const known = event.pointerType === TOUCH || event.pointerType === MOUSE;
      if (event.numberOfTouches !== 1 || touch === undefined || !known) {
        phase.set(0);
        GestureStateManager.fail(event.handlerTag);
        return;
      }
      const now = Date.now();
      phase.set(1);
      mouse.set(event.pointerType === MOUSE);
      startX.set(touch.absoluteX);
      startY.set(touch.absoluteY);
      pressedAt.set(now);
      movedAt.set(now);
      liftable.set(THREAD_DRAG_LIFT.unknown);
      runOnJS(onPress)(touch.absoluteY);
    },
    onTouchesMove: (event) => {
      "worklet";
      if (phase.value !== 1) return;
      const touch = event.allTouches[0];
      if (touch === undefined) return;
      const now = Date.now();
      const decision = threadDragActivation({
        pointer: mouse.value ? "mouse" : "touch",
        elapsedMs: now - pressedAt.value,
        restMs: now - movedAt.value,
        dx: touch.absoluteX - startX.value,
        dy: touch.absoluteY - startY.value,
        menuOpensAtMs: MENU_OPENS_AT_MS,
      });
      movedAt.set(now);
      if (decision === "wait") return;
      if (decision === "fail" || liftable.value === THREAD_DRAG_LIFT.refused) {
        phase.set(0);
        GestureStateManager.fail(event.handlerTag);
        return;
      }
      // The list has not answered for the pressed row yet. The next move asks again.
      if (liftable.value !== THREAD_DRAG_LIFT.allowed) return;
      phase.set(2);
      pointerY.set(touch.absoluteY);
      GestureStateManager.activate(event.handlerTag);
    },
    onTouchesUp: (event) => {
      "worklet";
      if (phase.value !== 1) return;
      phase.set(0);
      GestureStateManager.fail(event.handlerTag);
    },
    onTouchesCancel: (event) => {
      "worklet";
      if (phase.value !== 1) return;
      phase.set(0);
      GestureStateManager.fail(event.handlerTag);
    },
    onActivate: (event) => {
      "worklet";
      pointerY.set(event.absoluteY);
      runOnJS(onLift)(event.absoluteY);
    },
    onUpdate: (event) => {
      "worklet";
      pointerY.set(event.absoluteY);
      runOnJS(onMove)(event.absoluteY);
    },
    onDeactivate: (event) => {
      "worklet";
      runOnJS(onRelease)(!event.canceled);
    },
    onFinalize: () => {
      "worklet";
      phase.set(0);
    },
  });
}

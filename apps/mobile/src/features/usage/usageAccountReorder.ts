import * as Haptics from "expo-haptics";
import { usePanGesture } from "react-native-gesture-handler";
import {
  ReduceMotion,
  runOnJS,
  type SharedValue,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";

const TIMING = { duration: 160, reduceMotion: ReduceMotion.System } as const;

/**
 * One drag across a row or column of equal slots. It lives on the UI thread, so a drag renders
 * nothing in React until the drop. Remount the slots on a drop (a new `key`) so the new order
 * and the cleared offsets land in one frame.
 */
export interface SlotDrag {
  /** Index of the lifted slot, or -1 at rest. */
  readonly active: SharedValue<number>;
  readonly translation: SharedValue<number>;
}

export interface Slot {
  readonly index: number;
  readonly count: number;
  /** Distance between two neighbouring slots, gap included. Zero until measured. */
  readonly pitch: number;
  readonly axis: "x" | "y";
}

export function useSlotDrag(): SlotDrag {
  const active = useSharedValue(-1);
  const translation = useSharedValue(0);
  return { active, translation };
}

function clamp(value: number, low: number, high: number) {
  "worklet";
  return Math.min(high, Math.max(low, value));
}

function dropIndex(from: number, translation: number, slot: Pick<Slot, "count" | "pitch">) {
  "worklet";
  return clamp(from + Math.round(translation / slot.pitch), 0, slot.count - 1);
}

const liftHaptic = () => void Haptics.selectionAsync();
const SIDEWAYS: { activeOffsetX: [number, number]; failOffsetY: [number, number] } = {
  activeOffsetX: [-10, 10],
  failOffsetY: [-12, 12],
};
const ON_TOUCH = { minDistance: 0 };

/**
 * The pan that lifts a slot. A horizontal slot waits for sideways travel so taps and vertical
 * scrolling pass through; a vertical one belongs on a drag handle and lifts on touch.
 */
export function useSlotGesture(
  drag: SlotDrag,
  slot: Slot,
  onDrop: (from: number, to: number) => void,
) {
  const { index, count, pitch, axis } = slot;
  const { active, translation } = drag;
  const engaged = useSharedValue(false);
  return usePanGesture({
    enabled: count > 1 && pitch > 0,
    ...(axis === "x" ? SIDEWAYS : ON_TOUCH),
    onActivate: () => {
      // Another slot is still lifted or settling.
      if (active.value !== -1) return;
      engaged.set(true);
      translation.set(0);
      active.set(index);
      runOnJS(liftHaptic)();
    },
    onUpdate: (event) => {
      if (!engaged.value) return;
      translation.set(
        clamp(
          axis === "x" ? event.translationX : event.translationY,
          -index * pitch,
          (count - 1 - index) * pitch,
        ),
      );
    },
    onDeactivate: (event) => {
      if (!engaged.value) return;
      engaged.set(false);
      const to = event.canceled ? index : dropIndex(index, translation.value, { count, pitch });
      // Settle into the slot first: the drop then swaps offsets for layout with nothing moving.
      translation.set(
        withTiming((to - index) * pitch, TIMING, (finished) => {
          if (!finished) return;
          if (to === index) active.set(-1);
          else runOnJS(onDrop)(index, to);
        }),
      );
    },
  });
}

/** Follows the finger while lifted; otherwise slides one slot aside to open the drop gap. */
export function useSlotStyle(drag: SlotDrag, slot: Slot) {
  const { index, count, pitch, axis } = slot;
  const { active, translation } = drag;
  const shift = useSharedValue(0);
  useAnimatedReaction(
    () => {
      const from = active.value;
      if (from === -1 || from === index || pitch <= 0) return 0;
      const to = dropIndex(from, translation.value, { count, pitch });
      if (from < to && index > from && index <= to) return -pitch;
      if (from > to && index < from && index >= to) return pitch;
      return 0;
    },
    (next, previous) => {
      if (next !== previous) shift.set(withTiming(next, TIMING));
    },
  );
  return useAnimatedStyle(() => {
    const lifted = active.value === index;
    const offset = lifted ? translation.value : shift.value;
    return {
      transform: [axis === "x" ? { translateX: offset } : { translateY: offset }],
      zIndex: lifted ? 1 : 0,
      opacity: lifted ? 0.85 : 1,
    };
  });
}

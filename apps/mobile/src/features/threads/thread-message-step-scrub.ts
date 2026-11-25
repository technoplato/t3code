import type { ChatListStepOutcome } from "@t3tools/shared/chatList";

import type { ThreadMessageStepDirection, ThreadMessageStepRequest } from "./thread-message-step";

// A finger this close to where it pressed holds the slowest pace.
const DEADZONE_PT = 12;
// A second press on the same arrow this soon after the first is a double tap.
const DOUBLE_TAP_WINDOW_MS = 300;
// How long a press rests before it starts repeating, and the shorter wait after a double tap.
const HOLD_DELAY_MS = 320;
const DOUBLE_TAP_HOLD_DELAY_MS = 120;
// Row ticks closer together than this blur into one buzz.
const SELECTION_MIN_GAP_MS = 55;

const HOLD_PACE = { base: 300, min: 60, range: 160 } as const;
// A double tap and hold starts quicker and reaches full speed with a slight drag.
const DOUBLE_TAP_PACE = { base: 160, min: 55, range: 80 } as const;

/**
 * Milliseconds between steps of a held arrow, from how far the finger has moved from where it
 * pressed. Faster the farther it goes, along an exponential curve, so each point of drag feels
 * like the same change in speed.
 */
export function intervalFor(distancePt: number, doubleTap: boolean): number {
  const { base, min, range } = doubleTap ? DOUBLE_TAP_PACE : HOLD_PACE;
  const t = Math.min(Math.max((distancePt - DEADZONE_PT) / range, 0), 1);
  return Math.round(base * (min / base) ** t);
}

export interface MessageStepScrubHandlers {
  readonly step: (
    direction: ThreadMessageStepDirection,
    request: ThreadMessageStepRequest,
  ) => ChatListStepOutcome;
  /** Puts the row a held arrow left off its line onto it. */
  readonly settle: () => void;
  readonly haptics: {
    readonly selection: () => void;
    /** The press turned into a hold; a double tap's hold feels firmer. */
    readonly engage: (doubleTap: boolean) => void;
    /** A held arrow ran out of messages. */
    readonly boundary: () => void;
  };
  readonly now?: () => number;
}

export interface MessageStepScrub {
  /** What the next press steps with; the screen's handlers change as it renders. */
  readonly setHandlers: (handlers: MessageStepScrubHandlers) => void;
  /** A finger pressed an arrow: one step now, and repeating steps if it stays. */
  readonly begin: (direction: ThreadMessageStepDirection) => void;
  /** How far the finger has moved from where it pressed, which sets the pace. */
  readonly setDistance: (distancePt: number) => void;
  /** The finger let go, or the arrow went away. Safe to call more than once. */
  readonly end: () => void;
  /** One step with no hold, as an accessibility activation makes. */
  readonly press: (direction: ThreadMessageStepDirection) => void;
  /** Stops without settling, so nothing it scheduled runs after the arrows unmount. */
  readonly dispose: () => void;
}

/**
 * Turns presses on the step arrows into steps: a press steps at once, like a key, and a press
 * that stays repeats, faster as the finger drags away. One for both arrows, so a second finger
 * on the other arrow takes over instead of running a second loop.
 */
export function createMessageStepScrub(): MessageStepScrub {
  let handlers: MessageStepScrubHandlers | null = null;
  let active: {
    readonly direction: ThreadMessageStepDirection;
    readonly doubleTap: boolean;
    engaged: boolean;
    distance: number;
    // A held step left a row off its line, for the release to put on it.
    settleOwed: boolean;
    timer: ReturnType<typeof setTimeout> | null;
  } | null = null;
  let lastPress: { readonly direction: ThreadMessageStepDirection; readonly at: number } | null =
    null;
  let lastSelectionAt = Number.NEGATIVE_INFINITY;

  const now = () => handlers?.now?.() ?? Date.now();
  // One source of step feedback; the screen fires none of its own for the arrows.
  const feedback = (outcome: ChatListStepOutcome, held: boolean) => {
    if (!handlers) return;
    if (outcome === "row" || (outcome === "end" && !held)) {
      const at = now();
      if (at - lastSelectionAt < SELECTION_MIN_GAP_MS) return;
      lastSelectionAt = at;
      handlers.haptics.selection();
    } else if (outcome !== "loading" && held) {
      handlers.haptics.boundary();
    }
  };
  const stop = () => {
    if (active?.timer != null) clearTimeout(active.timer);
    active = null;
  };

  const tick = () => {
    const hold = active;
    if (!hold || !handlers) return;
    hold.timer = null;
    // Unanimated, so a quick pace never waits on a scroll; the release settles the last row.
    const outcome = handlers.step(hold.direction, { repeat: true, animated: false, snap: false });
    if (active !== hold) return;
    feedback(outcome, true);
    if (outcome === "row") hold.settleOwed = true;
    if (outcome === "end" || outcome === "none") {
      hold.settleOwed = false;
      return;
    }
    // Still "loading" keeps ticking quietly, so the hold steps on as soon as history lands.
    hold.timer = setTimeout(tick, intervalFor(hold.distance, hold.doubleTap));
  };

  const end = () => {
    const hold = active;
    if (!hold) return;
    stop();
    if (hold.engaged && hold.settleOwed) handlers?.settle();
  };

  return {
    setHandlers(next) {
      handlers = next;
    },
    begin(direction) {
      end();
      if (!handlers) return;
      const at = now();
      const doubleTap =
        lastPress?.direction === direction && at - lastPress.at <= DOUBLE_TAP_WINDOW_MS;
      lastPress = { direction, at };
      const hold: NonNullable<typeof active> = {
        direction,
        doubleTap,
        engaged: false,
        distance: 0,
        settleOwed: false,
        timer: null,
      };
      active = hold;
      const outcome = handlers.step(direction, { repeat: false, snap: true });
      if (active !== hold) return;
      feedback(outcome, false);
      // Nothing to repeat into: the end of the list, or nothing to step at all.
      if (outcome === "end" || outcome === "none") return;
      hold.timer = setTimeout(
        () => {
          if (active !== hold || !handlers) return;
          hold.engaged = true;
          handlers.haptics.engage(hold.doubleTap);
          tick();
        },
        doubleTap ? DOUBLE_TAP_HOLD_DELAY_MS : HOLD_DELAY_MS,
      );
    },
    setDistance(distancePt) {
      if (active) active.distance = distancePt;
    },
    end,
    press(direction) {
      end();
      if (!handlers) return;
      feedback(handlers.step(direction, { repeat: false, snap: true }), false);
    },
    dispose: stop,
  };
}

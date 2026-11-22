import {
  type ClientViewContent,
  type ClientViewTarget,
  type ClientViewTracker,
  makeClientViewTracker,
} from "@t3tools/client-runtime/client-view";
import type { ClientView, EnvironmentId } from "@t3tools/contracts";

interface ViewedThread {
  readonly target: ClientViewTarget;
  readonly readContent: () => ClientViewContent;
}

let viewed: ViewedThread | null = null;
let active: ClientViewTracker | null = null;

/** Says which thread the focused screen shows until the returned cleanup runs. */
export function viewThread(
  target: ClientViewTarget,
  readContent: () => ClientViewContent,
): () => void {
  const entry: ViewedThread = { target, readContent };
  viewed = entry;
  active?.setThread(target);
  return () => {
    // Another screen may already have taken over.
    if (viewed !== entry) return;
    viewed = null;
    active?.setThread(null);
  };
}

/** A touch on the thread screen. A feed that scrolls by itself must not call this. */
export function recordClientViewGesture(): void {
  active?.recordGesture();
  active?.touch();
}

/** The feed moved, whether a finger or a streaming reply moved it. */
export function touchClientView(): void {
  active?.touch();
}

export function clientViewFor(environmentId: EnvironmentId): ClientView | undefined {
  return active?.viewFor(environmentId);
}

/** Starts tracking; `onChange` runs when `clientViewFor` has news. Returns the stop. */
export function observeClientView(options: {
  /** One per app launch: a phone has one window, and a relaunch is a new one. */
  readonly windowId: string;
  readonly nowMs: () => number;
  readonly readFocused: () => boolean;
  readonly onChange: () => void;
}): { readonly refresh: () => void; readonly stop: () => void } {
  const tracker = makeClientViewTracker({
    windowId: () => options.windowId,
    nowMs: options.nowMs,
    setTimer: (run, delayMs) => {
      const timer = setTimeout(run, delayMs);
      return () => clearTimeout(timer);
    },
    readContent: () => viewed?.readContent() ?? { items: [] },
    readFocused: options.readFocused,
    onChange: options.onChange,
  });
  active = tracker;
  tracker.setThread(viewed?.target ?? null);
  return {
    refresh: tracker.refresh,
    stop: () => {
      tracker.dispose();
      if (active === tracker) active = null;
    },
  };
}

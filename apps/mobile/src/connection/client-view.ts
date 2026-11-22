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

/** What the app's navigation says about the screen on top. */
export interface ClientViewOverlays {
  /** Whether a sheet or modal is on top, over the screen it was opened from. */
  readonly covered: () => boolean;
  /** Calls `listener` after each navigation change. Returns the stop. */
  readonly onChange: (listener: () => void) => () => void;
}

let viewed: ViewedThread | null = null;
let active: ClientViewTracker | null = null;
let overlays: ClientViewOverlays | null = null;

/** Says which thread the focused screen shows until the returned cleanup runs. */
export function viewThread(
  target: ClientViewTarget,
  readContent: () => ClientViewContent,
): () => void {
  const entry: ViewedThread = { target, readContent };
  viewed = entry;
  active?.setThread(target);
  const leave = () => {
    viewed = null;
    active?.setThread(null);
  };
  return () => {
    // Another screen may already have taken over.
    if (viewed !== entry) return;
    if (!overlays?.covered()) return leave();
    // A sheet over the thread takes its screen's focus, yet the user has not left the thread.
    // It stays in view until navigation ends with neither a sheet on top nor this screen back.
    const stop = overlays.onChange(() => {
      if (viewed === entry && overlays?.covered()) return;
      stop();
      if (viewed === entry) leave();
    });
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
  readonly overlays?: ClientViewOverlays;
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
  overlays = options.overlays ?? null;
  tracker.setThread(viewed?.target ?? null);
  return {
    refresh: tracker.refresh,
    stop: () => {
      tracker.dispose();
      if (active !== tracker) return;
      active = null;
      overlays = null;
    },
  };
}

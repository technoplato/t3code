import {
  CLIENT_IDENTITY_MAX_TEXT_LENGTH,
  CLIENT_VIEW_MAX_ITEMS,
  CLIENT_VIEW_MAX_SELECTION_LENGTH,
  type ClientActivityIdentity,
  type ClientView,
  type ClientViewItem,
  type ClientViewSelection,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";

/** How long a change in what shows waits, so one scroll is one report. */
export const CLIENT_VIEW_REPORT_DELAY_MS = 750;
/** A gesture that changes nothing on screen is reported no more often than this. */
export const CLIENT_VIEW_GESTURE_REPORT_INTERVAL_MS = 5_000;

export interface ClientViewTarget {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}

export interface ClientViewContent {
  readonly items: ReadonlyArray<ClientViewItem>;
  readonly selection?: ClientViewSelection | undefined;
}

/** A timeline row and the viewport, measured along the scroll axis in one coordinate space. */
export interface MeasuredViewRow {
  readonly id: string;
  readonly kind?: string | undefined;
  readonly top: number;
  readonly bottom: number;
}

function fraction(value: number): number {
  return Math.round(Math.min(Math.max(value, 0), 1) * 100) / 100;
}

/**
 * The rows that show, top to bottom, each with the part of it inside the viewport as fractions
 * of its own height. Hundredths, so a sub-pixel shift is not a new view.
 */
export function visibleViewItems(
  viewport: { readonly top: number; readonly bottom: number },
  rows: ReadonlyArray<MeasuredViewRow>,
): ClientViewItem[] {
  const seen = new Set<string>();
  const items: ClientViewItem[] = [];
  for (const row of [...rows].sort((left, right) => left.top - right.top)) {
    const height = row.bottom - row.top;
    const visibleTop = Math.max(row.top, viewport.top);
    const visibleBottom = Math.min(row.bottom, viewport.bottom);
    if (!(height > 0) || !(visibleBottom - visibleTop >= 1) || seen.has(row.id)) continue;
    seen.add(row.id);
    items.push({
      id: row.id,
      ...(row.kind === undefined ? {} : { kind: row.kind }),
      from: fraction((visibleTop - row.top) / height),
      to: fraction((visibleBottom - row.top) / height),
    });
    if (items.length === CLIENT_VIEW_MAX_ITEMS) break;
  }
  return items;
}

/** A selection worth reporting, cut to what a report may carry. */
export function clientViewSelection(
  text: string,
  itemId: string | undefined,
): ClientViewSelection | undefined {
  if (text.trim().length === 0) return undefined;
  return {
    ...(itemId === undefined ? {} : { itemId }),
    text: text.slice(0, CLIENT_VIEW_MAX_SELECTION_LENGTH),
  };
}

/** A client's identity fit for a report: blanks dropped and long values cut, so it always decodes. */
export function clientActivityIdentity(fields: {
  readonly [Field in keyof ClientActivityIdentity]?: string | null | undefined;
}): ClientActivityIdentity {
  return Object.fromEntries(
    Object.entries(fields).flatMap(([field, value]) => {
      const text = value?.trim().slice(0, CLIENT_IDENTITY_MAX_TEXT_LENGTH) ?? "";
      return text.length > 0 ? [[field, text]] : [];
    }),
  );
}

/** How a client reaches one server. `local` is a client on the server's own machine. */
export function clientViewConnection(
  target: { readonly _tag: string } | undefined,
  onServerHost = false,
): "local" | "direct" | "relay" | "ssh" | undefined {
  switch (target?._tag) {
    case undefined:
      return undefined;
    case "RelayConnectionTarget":
      return "relay";
    case "SshConnectionTarget":
      return "ssh";
    default:
      return onServerHost ? "local" : "direct";
  }
}

export interface ClientViewTracker {
  /** The thread this window shows, or null when it shows none. Reported at once. */
  readonly setThread: (target: ClientViewTarget | null) => void;
  /** What shows may have changed: a scroll, a layout, a selection. */
  readonly touch: () => void;
  /** The user acted. Rendering and streaming must never call this. Does not re-read the screen. */
  readonly recordGesture: () => void;
  /** Focus changed; reported at once. */
  readonly refresh: () => void;
  /** The view as last reported. Only the thread's own environment gets items and selection. */
  readonly viewFor: (environmentId: EnvironmentId) => ClientView | undefined;
  readonly dispose: () => void;
}

interface SentView {
  readonly target: ClientViewTarget;
  readonly focused: boolean;
  readonly items: ReadonlyArray<ClientViewItem>;
  readonly selection?: ClientViewSelection | undefined;
}

/**
 * Turns scrolls, gestures and thread switches into reports: `onChange` fires when `viewFor` has
 * something new. The screen is read only when a report is due, never per scroll event.
 */
export function makeClientViewTracker(options: {
  readonly windowId: () => string;
  readonly nowMs: () => number;
  readonly setTimer: (run: () => void, delayMs: number) => () => void;
  readonly readContent: () => ClientViewContent;
  readonly readFocused: () => boolean;
  readonly onChange: () => void;
}): ClientViewTracker {
  let target: ClientViewTarget | null = null;
  let lastGestureAtMs = options.nowMs();
  let seq = 0;
  let sent: {
    readonly signature: string;
    readonly gestureAtMs: number;
    readonly atMs: number;
    readonly view: SentView | null;
  } = {
    signature: "null",
    gestureAtMs: lastGestureAtMs,
    atMs: Number.NEGATIVE_INFINITY,
    view: null,
  };
  let timer: { readonly dueAtMs: number; readonly cancel: () => void } | null = null;
  let lookAgainAfterSwitch = false;
  // A gesture alone leaves the screen as it was, so only a touch makes the next flush read it.
  let stale = true;
  let content: ClientViewContent = { items: [] };

  const arm = (delayMs: number) => {
    const dueAtMs = options.nowMs() + delayMs;
    // An earlier flush already pending sends this change too.
    if (timer !== null && timer.dueAtMs <= dueAtMs) return;
    timer?.cancel();
    timer = { dueAtMs, cancel: options.setTimer(flush, delayMs) };
  };

  function flush(): void {
    timer = null;
    // A thread's rows mount after the switch to it, so its first report is followed by a second look.
    const lookAgain = lookAgainAfterSwitch;
    if (lookAgain) {
      lookAgainAfterSwitch = false;
      arm(CLIENT_VIEW_REPORT_DELAY_MS);
    }
    const nowMs = options.nowMs();
    if (target !== null && stale) content = options.readContent();
    stale = target === null || lookAgain;
    const view: SentView | null =
      target === null
        ? null
        : {
            target,
            focused: options.readFocused(),
            items: content.items.slice(0, CLIENT_VIEW_MAX_ITEMS),
            ...(content.selection === undefined ? {} : { selection: content.selection }),
          };
    const signature = JSON.stringify(view);
    if (signature === sent.signature) {
      if (view === null || lastGestureAtMs === sent.gestureAtMs) return;
      const waitMs = sent.atMs + CLIENT_VIEW_GESTURE_REPORT_INTERVAL_MS - nowMs;
      if (waitMs > 0) return arm(waitMs);
    }
    seq += 1;
    sent = { signature, gestureAtMs: lastGestureAtMs, atMs: nowMs, view };
    options.onChange();
  }

  return {
    setThread: (next) => {
      if (next?.environmentId === target?.environmentId && next?.threadId === target?.threadId) {
        return;
      }
      target = next;
      lookAgainAfterSwitch = next !== null;
      stale = true;
      arm(0);
    },
    touch: () => {
      stale = true;
      if (target !== null) arm(CLIENT_VIEW_REPORT_DELAY_MS);
    },
    recordGesture: () => {
      lastGestureAtMs = options.nowMs();
      if (target !== null) arm(CLIENT_VIEW_REPORT_DELAY_MS);
    },
    refresh: () => {
      stale = true;
      if (target !== null) arm(0);
    },
    viewFor: (environmentId) => {
      const { view } = sent;
      if (view === null) return undefined;
      return {
        windowId: options.windowId(),
        seq,
        focused: view.focused,
        lastGestureAtMs: sent.gestureAtMs,
        environmentId: view.target.environmentId,
        threadId: view.target.threadId,
        ...(environmentId === view.target.environmentId
          ? {
              items: view.items,
              ...(view.selection === undefined ? {} : { selection: view.selection }),
            }
          : {}),
      };
    },
    dispose: () => {
      timer?.cancel();
      timer = null;
    },
  };
}

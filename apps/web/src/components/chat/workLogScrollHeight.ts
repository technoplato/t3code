import type { WorkLogScrollHeight } from "@t3tools/contracts/settings";
import { useSyncExternalStore } from "react";

const STORAGE_KEY = "t3code:work-log-scroll-height-px";
const MIN_CUSTOM_HEIGHT_PX = 160;
const MAX_CUSTOM_HEIGHT_PX = 1200;

const listeners = new Set<() => void>();
let cachedCustomHeightPx: number | null | undefined;

function clampCustomHeight(px: number): number {
  return Math.round(Math.min(MAX_CUSTOM_HEIGHT_PX, Math.max(MIN_CUSTOM_HEIGHT_PX, px)));
}

function readStoredCustomHeight(): number | null {
  if (cachedCustomHeightPx !== undefined) return cachedCustomHeightPx;
  if (typeof window === "undefined") {
    cachedCustomHeightPx = null;
    return null;
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      cachedCustomHeightPx = null;
      return null;
    }
    const parsed = Number(raw);
    cachedCustomHeightPx = Number.isFinite(parsed) ? clampCustomHeight(parsed) : null;
  } catch {
    cachedCustomHeightPx = null;
  }
  return cachedCustomHeightPx;
}

function notifyListeners() {
  for (const listener of listeners) listener();
}

export function setCustomWorkLogScrollHeightPx(px: number | null) {
  const next = px === null ? null : clampCustomHeight(px);
  if (cachedCustomHeightPx === next) return;
  cachedCustomHeightPx = next;
  if (typeof window !== "undefined") {
    try {
      if (next === null) window.localStorage.removeItem(STORAGE_KEY);
      else window.localStorage.setItem(STORAGE_KEY, String(next));
    } catch {
      // Ignore storage quota or private-mode errors.
    }
  }
  notifyListeners();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useCustomWorkLogScrollHeightPx(): number | null {
  return useSyncExternalStore(subscribe, readStoredCustomHeight, () => null);
}

export function resolveReasoningMaxHeightCss(
  preset: WorkLogScrollHeight,
  customHeightPx: number | null,
): string | undefined {
  if (preset === "full") return undefined;
  if (customHeightPx !== null) return `${customHeightPx}px`;
  return preset === "tall" ? "min(44rem, 70dvh)" : "24rem";
}

export function resolveWorkGroupBaseMaxHeightCss(
  preset: WorkLogScrollHeight,
  customHeightPx: number | null,
): string | undefined {
  if (preset === "full") return undefined;
  if (customHeightPx !== null) return `${customHeightPx}px`;
  return preset === "tall" ? "min(36rem, 70dvh)" : "min(18rem, 50dvh)";
}

/** One cap for every tool output body. "full" still bounds a single output so a huge payload cannot swallow the timeline. */
export function resolveToolOutputMaxHeightClassName(preset: WorkLogScrollHeight): string {
  if (preset === "full") return "max-h-[80dvh]";
  if (preset === "tall") return "max-h-[min(36rem,80dvh)]";
  return "max-h-80";
}

const FULL_HEIGHT_VIRTUALIZE_ROW_THRESHOLD = 15;
const WORK_GROUP_EXPANDED_VIEWPORT_SHARE = 0.6;
/** The box a long auto-expanded group keeps in "full", where shorter groups render inline. */
export const WORK_GROUP_FULL_VIRTUALIZED_MAX_HEIGHT_CSS = "80dvh";
/** CSS twin of `clampWorkGroupExpandedHeightPx`, for a window resized between measurements. */
export const WORK_GROUP_EXPANDED_MAX_SHARE_CSS = "60dvh";

/** "full" renders a group inline unless every call in a long group opens itself, which needs virtualization. */
export function shouldVirtualizeFullHeightWorkGroup(
  preset: WorkLogScrollHeight,
  expandToolCallsByDefault: boolean,
  rowCount: number,
): boolean {
  return (
    preset === "full" && expandToolCallsByDefault && rowCount > FULL_HEIGHT_VIRTUALIZE_ROW_THRESHOLD
  );
}

/** Expanded rows widen their group's box by a share of the viewport, so the list inside stays virtualized. */
export function clampWorkGroupExpandedHeightPx(
  expandedHeightPx: number,
  viewportHeightPx: number,
): number {
  return Math.min(
    expandedHeightPx,
    Math.round(viewportHeightPx * WORK_GROUP_EXPANDED_VIEWPORT_SHARE),
  );
}

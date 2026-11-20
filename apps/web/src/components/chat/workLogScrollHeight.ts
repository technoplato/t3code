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

export function resolveToolOutputMaxHeightClassName(preset: WorkLogScrollHeight): string {
  if (preset === "full") return "max-h-none";
  if (preset === "tall") return "max-h-[32rem]";
  return "max-h-64";
}

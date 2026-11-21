import type { ScopedThreadRef } from "@t3tools/contracts";

export type DesktopMessageNavigationDirection = "previous" | "next" | "top" | "bottom";
export type DesktopTimelineScrollDirection = "up" | "down" | "top" | "bottom";

export interface DesktopChatControlHandle {
  readonly getActiveThreadRef: () => ScopedThreadRef | null;
  readonly navigateMessage: (
    direction: DesktopMessageNavigationDirection,
    count?: number,
  ) => boolean;
  readonly scrollTimeline: (direction: DesktopTimelineScrollDirection, amount?: number) => boolean;
  readonly sendMessage: (text: string, mode?: "auto" | "steer") => Promise<boolean>;
  readonly interrupt: () => Promise<boolean>;
  readonly toggleRightPanel: () => boolean;
  readonly toggleTerminal: () => boolean;
}

export interface DesktopSidebarControlHandle {
  readonly toggleSidebar: () => void;
}

let activeChatControl: DesktopChatControlHandle | null = null;
let activeSidebarControl: DesktopSidebarControlHandle | null = null;

export function registerDesktopChatControl(handle: DesktopChatControlHandle): () => void {
  activeChatControl = handle;
  return () => {
    if (activeChatControl === handle) {
      activeChatControl = null;
    }
  };
}

export function getDesktopChatControl(): DesktopChatControlHandle | null {
  return activeChatControl;
}

export function registerDesktopSidebarControl(handle: DesktopSidebarControlHandle): () => void {
  activeSidebarControl = handle;
  return () => {
    if (activeSidebarControl === handle) {
      activeSidebarControl = null;
    }
  };
}

export function getDesktopSidebarControl(): DesktopSidebarControlHandle | null {
  return activeSidebarControl;
}

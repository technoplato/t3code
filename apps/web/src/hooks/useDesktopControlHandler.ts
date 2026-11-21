import type { DesktopAppControlRequest, ScopedThreadRef } from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";

import { handleDesktopAppControlRequest } from "../desktopAppControl";
import { getClientSettings, updateClientSettings } from "./useSettings";
import { getDesktopChatControl, getDesktopSidebarControl } from "../lib/desktopControlBridge";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readProjects, readThreadShells } from "../state/entities";
import { environmentThreadDetails } from "../state/threads";
import { buildThreadRouteParams } from "../threadRoutes";

function readLatestAssistantMessageForThread(ref: ScopedThreadRef): {
  readonly text: string;
  readonly itemId: string;
} | null {
  const detail = appAtomRegistry.get(environmentThreadDetails.threadAtom(ref));
  if (detail === null) return null;
  const items = detail.projection.visibleTurnItems;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const projected = items[index];
    if (!projected || projected.item.type !== "assistant_message") continue;
    const text = projected.item.text.trim();
    if (text.length === 0) continue;
    return { text, itemId: projected.sourceItemId };
  }
  return null;
}

export function useDesktopControlHandler() {
  const router = useRouter();

  const handle = (request: DesktopAppControlRequest) =>
    handleDesktopAppControlRequest(request, {
      getPathname: () => router.state.location.pathname,
      navigateToRoute: async (to) => {
        await router.navigate({ to });
      },
      navigateToThread: async (ref) => {
        await router.navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(ref),
        });
      },
      goBack: () => {
        router.history.back();
      },
      goForward: () => {
        router.history.forward();
      },
      readThreads: readThreadShells,
      readProjects,
      readLatestAssistantMessage: readLatestAssistantMessageForThread,
      getSettings: () => {
        const settings = getClientSettings();
        return {
          expandThinkingByDefault: settings.expandThinkingByDefault,
          expandToolCallsByDefault: settings.expandToolCallsByDefault,
          workLogScrollHeight: settings.workLogScrollHeight,
        };
      },
      updateSettings: async (patch) => {
        await updateClientSettings(patch);
      },
      getChatControl: getDesktopChatControl,
      getSidebarControl: getDesktopSidebarControl,
    });

  return { handle };
}

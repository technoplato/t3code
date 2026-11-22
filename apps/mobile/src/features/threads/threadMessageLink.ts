import type { NavigationState, PartialState } from "@react-navigation/native";
import {
  linkedMessageId,
  THREAD_MESSAGE_LINK_PARAM,
} from "@t3tools/client-runtime/thread-message-link";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { scopedThreadKey } from "../../lib/scopedEntities";
import { requestThreadMessageJump } from "./threadMessageJump";

function firstString(value: unknown): string | null {
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === "string" && first.length > 0 ? first : null;
}

/**
 * `threads/<environment>/<thread>?messageId=…` opens that thread at the message. The param is
 * dropped as the link arrives, so the thread screen never sees it and a later visit does not
 * jump again; the jump itself waits for the screen and lapses if the thread never shows.
 */
export function takeThreadMessageLink(
  state: PartialState<NavigationState> | undefined,
): PartialState<NavigationState> | undefined {
  if (!state) return state;
  const index = state.routes.findIndex((route) => route.name === "Thread");
  const route = state.routes[index];
  const params = route?.params as Readonly<Record<string, unknown>> | undefined;
  if (!route || !params || !(THREAD_MESSAGE_LINK_PARAM in params)) return state;

  const { [THREAD_MESSAGE_LINK_PARAM]: linked, ...rest } = params;
  const routes = state.routes.slice();
  routes[index] = { ...route, params: rest };

  const environmentId = firstString(params.environmentId);
  const threadId = firstString(params.threadId);
  const messageId = linkedMessageId(linked);
  if (environmentId !== null && threadId !== null && messageId !== null) {
    requestThreadMessageJump(
      scopedThreadKey(EnvironmentId.make(environmentId), ThreadId.make(threadId)),
      messageId,
    );
  }
  return { ...state, routes };
}

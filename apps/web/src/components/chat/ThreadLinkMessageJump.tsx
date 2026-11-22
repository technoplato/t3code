import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import { isThreadRoutePathname } from "../../threadRoutes";
import { requestThreadMessageJump, takeMessageJumpParam } from "./threadMessageJump";

/** Hands a thread link's `?messageId=` to the timeline, then drops it from the URL. */
export function ThreadLinkMessageJump({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const navigate = useNavigate();
  const location = useLocation({
    select: (current) => ({ pathname: current.pathname, search: current.searchStr }),
    structuralSharing: true,
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks the timeline to open at a linked message once per location and strips ?messageId from the URL via the router
  useEffect(() => {
    // A pending navigation shows the next location while the params still name this thread.
    if (!isThreadRoutePathname(location.pathname, threadRef)) return;
    const link = takeMessageJumpParam(location.search);
    if (link === null) return;
    if (link.messageId !== null) {
      requestThreadMessageJump(scopedThreadKey(threadRef), link.messageId);
    }
    void navigate({ href: `${location.pathname}${link.rest}`, replace: true });
  }, [location, navigate, threadRef]);

  return null;
}

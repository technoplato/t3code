import type { DesktopAppActivationRequest } from "@t3tools/contracts";
import { useEffect, useEffectEvent, useRef } from "react";

import { useDesktopControlHandler } from "../../hooks/useDesktopControlHandler";
import { useOpenLocalWorkspace } from "../../hooks/useOpenLocalWorkspace";

export function DesktopAppActivationCoordinator() {
  const openLocalWorkspace = useOpenLocalWorkspace();
  const desktopControl = useDesktopControlHandler();
  const queueRef = useRef(Promise.resolve());
  const activation = window.desktopBridge?.appActivation;
  const ready = activation !== undefined && openLocalWorkspace.ready;

  const processRequest = useEffectEvent(async (request: DesktopAppActivationRequest) => {
    if (request.type === "control") {
      return desktopControl.handle(request);
    }
    return openLocalWorkspace.open(request);
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to desktop activation requests over the bridge and marks the renderer ready
  useEffect(() => {
    if (!ready || activation === undefined) return;

    let subscribed = true;
    const unsubscribe = activation.onRequest((request) => {
      queueRef.current = queueRef.current.then(async () => {
        const response = await processRequest(request);
        await activation.complete(response);
      });
      queueRef.current = queueRef.current.catch(() => undefined);
    });
    // Skip readiness if React runs cleanup before this subscription can receive requests.
    queueMicrotask(() => {
      if (subscribed) void activation.setReady(true).catch(() => undefined);
    });
    return () => {
      subscribed = false;
      void activation.setReady(false).catch(() => undefined);
      unsubscribe();
    };
  }, [activation, ready]);

  return null;
}

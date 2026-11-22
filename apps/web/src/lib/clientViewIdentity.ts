import { clientActivityIdentity, clientViewConnection } from "@t3tools/client-runtime/client-view";
import type { ConnectionTarget } from "@t3tools/client-runtime/connection";
import type { ClientActivityIdentity } from "@t3tools/contracts";

import { APP_DISPLAY_NAME, APP_VERSION } from "../branding";
import { clientPresentationMetadata } from "../connection/clientMetadata";
import { isLoopbackHostname } from "../environments/primary/target";
import { isHostedStaticApp } from "../hostedPairing";

// The desktop app's own server, or the server a browser on the same machine loaded this page from.
function runsOnServerHost(target: ConnectionTarget | undefined): boolean {
  if (target?._tag !== "PrimaryConnectionTarget") return false;
  if (window.desktopBridge !== undefined) return true;
  try {
    return isLoopbackHostname(new URL(target.httpBaseUrl).hostname);
  } catch {
    return false;
  }
}

/** Who this window's client is, to the server reached through `target`. */
export function clientViewIdentity(target: ConnectionTarget | undefined): ClientActivityIdentity {
  const metadata = clientPresentationMetadata({
    appVersion: APP_VERSION,
    hosted: isHostedStaticApp(),
    identity: {
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      maxTouchPoints: navigator.maxTouchPoints,
    },
    desktopBridge: window.desktopBridge,
  });
  return clientActivityIdentity({
    formFactor: metadata.deviceType === "mobile" ? "phone" : metadata.deviceType,
    os: metadata.os,
    browser: metadata.browser,
    appName: APP_DISPLAY_NAME,
    appVersion: metadata.appVersion,
    webDeployment: metadata.webDeployment,
    connection: clientViewConnection(target, runsOnServerHost(target)),
  });
}

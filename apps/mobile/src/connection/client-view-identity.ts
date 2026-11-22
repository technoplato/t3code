import { clientActivityIdentity, clientViewConnection } from "@t3tools/client-runtime/client-view";
import type { ConnectionTarget } from "@t3tools/client-runtime/connection";
import type { ClientActivityIdentity } from "@t3tools/contracts";
import Constants from "expo-constants";
import * as Device from "expo-device";
import { Platform } from "react-native";

function formFactor(): string | undefined {
  switch (Device.deviceType) {
    case Device.DeviceType.PHONE:
      return "phone";
    case Device.DeviceType.TABLET:
      return "tablet";
    case Device.DeviceType.DESKTOP:
      return "desktop";
    default:
      return undefined;
  }
}

/** Who this app is, to the server reached through `target`. */
export function clientViewIdentity(target: ConnectionTarget | undefined): ClientActivityIdentity {
  return clientActivityIdentity({
    formFactor: formFactor(),
    // An iPad says iPadOS here, where the platform alone would say iOS.
    os: Device.osName ?? Platform.select({ ios: "iOS", android: "Android" }),
    osVersion: Device.osVersion,
    deviceName: Device.deviceName,
    deviceModel: Device.modelName,
    appName: Constants.expoConfig?.name,
    appVersion: Constants.expoConfig?.version,
    connection: clientViewConnection(target),
  });
}

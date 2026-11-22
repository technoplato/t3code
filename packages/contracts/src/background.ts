import * as Schema from "effect/Schema";

import {
  AuthSessionId,
  EnvironmentId,
  NonNegativeInt,
  RpcClientId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const BackgroundBooleanState = Schema.Literals(["true", "false", "unknown"]);
export type BackgroundBooleanState = typeof BackgroundBooleanState.Type;

export const HostPowerThermalState = Schema.Literals([
  "unknown",
  "nominal",
  "fair",
  "serious",
  "critical",
]);
export type HostPowerThermalState = typeof HostPowerThermalState.Type;

export const HostPowerSource = Schema.Literals([
  "unknown",
  "node-macos-shell",
  "node-macos-native",
  "node-linux",
  "node-windows",
  "electron-main",
]);
export type HostPowerSource = typeof HostPowerSource.Type;

export const HostPowerSnapshot = Schema.Struct({
  source: HostPowerSource,
  idle: BackgroundBooleanState,
  idleSeconds: Schema.NullOr(Schema.Number),
  locked: BackgroundBooleanState,
  suspended: Schema.Boolean,
  onBattery: BackgroundBooleanState,
  lowPowerMode: BackgroundBooleanState,
  thermalState: HostPowerThermalState,
  stale: Schema.Boolean,
  updatedAt: Schema.DateTimeUtc,
});
export type HostPowerSnapshot = typeof HostPowerSnapshot.Type;

export const BackgroundScope = Schema.Union([
  Schema.Struct({ type: Schema.Literal("server-config") }),
  Schema.Struct({
    type: Schema.Literal("provider-status"),
    instanceId: Schema.optionalKey(ProviderInstanceId),
  }),
  Schema.Struct({ type: Schema.Literal("vcs-status"), cwd: Schema.String }),
  Schema.Struct({ type: Schema.Literal("git-refs"), cwd: Schema.String }),
  Schema.Struct({ type: Schema.Literal("diagnostics") }),
  Schema.Struct({ type: Schema.Literal("thread"), threadId: ThreadId }),
]);
export type BackgroundScope = typeof BackgroundScope.Type;

export const ClientKind = Schema.Literals(["web", "desktop-renderer", "mobile", "unknown"]);
export type ClientKind = typeof ClientKind.Type;

export const ClientActivityClientId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
export type ClientActivityClientId = typeof ClientActivityClientId.Type;

export const CLIENT_VIEW_MAX_ITEMS = 12;
export const CLIENT_VIEW_MAX_SELECTION_LENGTH = 2048;

const ClientViewFraction = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }));
const ClientViewItemId = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(256));

/** One timeline item in the viewport; `from` and `to` bound the part of it that shows. */
export const ClientViewItem = Schema.Struct({
  id: ClientViewItemId,
  kind: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(64))),
  from: ClientViewFraction,
  to: ClientViewFraction,
});
export type ClientViewItem = typeof ClientViewItem.Type;

export const ClientViewSelection = Schema.Struct({
  itemId: Schema.optionalKey(ClientViewItemId),
  text: Schema.String.check(Schema.isMaxLength(CLIENT_VIEW_MAX_SELECTION_LENGTH)),
});
export type ClientViewSelection = typeof ClientViewSelection.Type;

/**
 * The thread one window shows. Every connected server hears which environment and thread;
 * `items` and `selection` go only to the server that owns `environmentId`.
 */
export const ClientView = Schema.Struct({
  windowId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  /** Rises with each change in one window, so a server can drop a report that arrives late. */
  seq: NonNegativeInt,
  focused: Schema.Boolean,
  /** The user's last pointer, wheel, key, touch or selection input; rendering never moves it. */
  lastGestureAtMs: Schema.Number.check(Schema.isFinite()),
  environmentId: EnvironmentId,
  threadId: ThreadId,
  /** Top to bottom. */
  items: Schema.optionalKey(
    Schema.Array(ClientViewItem).check(Schema.isMaxLength(CLIENT_VIEW_MAX_ITEMS)),
  ),
  selection: Schema.optionalKey(ClientViewSelection),
});
export type ClientView = typeof ClientView.Type;

export const CLIENT_IDENTITY_MAX_TEXT_LENGTH = 128;

const IdentityText = Schema.String.check(Schema.isMaxLength(CLIENT_IDENTITY_MAX_TEXT_LENGTH));

/**
 * Who a client says it is, sent with its view. Capped text, not literals: a value a server has
 * not heard of must never fail the report that carries it.
 */
export const ClientActivityIdentity = Schema.Struct({
  /** `phone`, `tablet` or `desktop`. */
  formFactor: Schema.optionalKey(IdentityText),
  os: Schema.optionalKey(IdentityText),
  osVersion: Schema.optionalKey(IdentityText),
  /** What the device or its owner calls it. */
  deviceName: Schema.optionalKey(IdentityText),
  deviceModel: Schema.optionalKey(IdentityText),
  browser: Schema.optionalKey(IdentityText),
  appName: Schema.optionalKey(IdentityText),
  appVersion: Schema.optionalKey(IdentityText),
  /** A browser only: `hosted` or `server`. */
  webDeployment: Schema.optionalKey(IdentityText),
  /** How this client reaches the server it reports to: `local`, `direct`, `relay` or `ssh`. */
  connection: Schema.optionalKey(IdentityText),
});
export type ClientActivityIdentity = typeof ClientActivityIdentity.Type;

export const ClientActivityReportInput = Schema.Struct({
  environmentId: Schema.optionalKey(EnvironmentId),
  clientId: ClientActivityClientId,
  clientKind: ClientKind,
  visible: Schema.Boolean,
  focused: Schema.Boolean,
  recentlyInteracted: Schema.Boolean,
  appState: Schema.optionalKey(Schema.Literals(["active", "inactive", "background", "unknown"])),
  lowPowerMode: Schema.optionalKey(BackgroundBooleanState),
  scopes: Schema.Array(BackgroundScope),
  ttlMs: Schema.optionalKey(Schema.Number),
  observedAt: Schema.DateTimeUtc,
  /** Top level, not a scope: scopes are filtered per server, and every server hears the view. */
  view: Schema.optionalKey(ClientView),
  identity: Schema.optionalKey(ClientActivityIdentity),
});
export type ClientActivityReportInput = typeof ClientActivityReportInput.Type;

export const ClientActivityLease = Schema.Struct({
  sessionId: AuthSessionId,
  rpcClientId: RpcClientId,
  clientId: ClientActivityClientId,
  clientKind: ClientKind,
  visible: Schema.Boolean,
  focused: Schema.Boolean,
  recentlyInteracted: Schema.Boolean,
  appState: Schema.optionalKey(Schema.Literals(["active", "inactive", "background", "unknown"])),
  lowPowerMode: Schema.optionalKey(BackgroundBooleanState),
  scopes: Schema.Array(BackgroundScope),
  updatedAt: Schema.DateTimeUtc,
  expiresAt: Schema.DateTimeUtc,
});
export type ClientActivityLease = typeof ClientActivityLease.Type;

export const BackgroundPolicySnapshot = Schema.Struct({
  hostPower: HostPowerSnapshot,
  leases: Schema.Array(ClientActivityLease),
  activeForegroundLeaseCount: Schema.Number,
  activeScopeKeys: Schema.Array(Schema.String),
  shouldRunOpportunisticWork: Schema.Boolean,
  updatedAt: Schema.DateTimeUtc,
});
export type BackgroundPolicySnapshot = typeof BackgroundPolicySnapshot.Type;

import * as Schema from "effect/Schema";

import {
  ForwardCompatibleArray,
  IsoDateTime,
  NonNegativeInt,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import { UsageLimitSourceId } from "./usageLimitSourceId.ts";

/** Stable per-provider ids let sparse updates merge with full probes. */
export const ServerProviderUsageWindow = Schema.Struct({
  id: TrimmedNonEmptyString,
  kind: Schema.Literals(["session", "weekly", "monthly", "other"]),
  label: TrimmedNonEmptyString,
  /** When present, this limit applies only to these provider model IDs. */
  modelIds: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  providerIds: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  usedPercent: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  resetsAt: Schema.optional(IsoDateTime),
  windowDurationMins: Schema.optional(NonNegativeInt),
});
export type ServerProviderUsageWindow = typeof ServerProviderUsageWindow.Type;

/** One kind of banked reset, such as Claude's weekly reset or its Fable-only reset. */
export const ServerProviderResetCreditOption = Schema.Struct({
  creditId: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  description: TrimmedNonEmptyString,
  availableCount: NonNegativeInt,
  expiresAt: Schema.optional(IsoDateTime),
});
export type ServerProviderResetCreditOption = typeof ServerProviderResetCreditOption.Type;

export const ServerProviderResetCredits = Schema.Struct({
  availableCount: NonNegativeInt,
  nextExpiresAt: Schema.optional(IsoDateTime),
  /** Pins hub redemption to the displayed credit, including retries from another client. */
  nextCreditId: Schema.optional(TrimmedNonEmptyString),
  /** Present when resets differ in what they refill; redeem one by its `creditId`. */
  options: Schema.optional(ForwardCompatibleArray(ServerProviderResetCreditOption)),
});
export type ServerProviderResetCredits = typeof ServerProviderResetCredits.Type;

/** Clear bars for unavailable accounts; retain last good bars after a failed probe. */
export const ServerProviderUsageLimits = Schema.Struct({
  checkedAt: IsoDateTime,
  windows: ForwardCompatibleArray(ServerProviderUsageWindow),
  /** A $0 monthly spend cap has no percentage, so it cannot be a window. */
  zeroSpendCap: Schema.optional(Schema.Boolean),
  credentialFingerprint: Schema.optional(TrimmedNonEmptyString),
  resetCredits: Schema.optional(ServerProviderResetCredits),
  externalUsage: Schema.optional(
    Schema.Struct({
      label: TrimmedNonEmptyString,
      url: TrimmedNonEmptyString,
    }),
  ),
  unavailable: Schema.optional(
    Schema.Struct({
      reason: Schema.Literals(["unsupported", "probeFailed"]),
      message: Schema.optional(TrimmedNonEmptyString),
    }),
  ),
});
export type ServerProviderUsageLimits = typeof ServerProviderUsageLimits.Type;

/** Partial updates merge windows by id; omitted windows remain unchanged. */
export const ProviderUsageLimitsUpdate = Schema.Struct({
  windows: Schema.Array(ServerProviderUsageWindow),
});
export type ProviderUsageLimitsUpdate = typeof ProviderUsageLimitsUpdate.Type;

export const UsageLimitSourceAccount = Schema.Struct({
  id: TrimmedNonEmptyString,
  driver: ProviderDriverKind,
  email: Schema.optional(TrimmedNonEmptyString),
  plan: Schema.optional(TrimmedNonEmptyString),
  workspaceId: Schema.optional(TrimmedNonEmptyString),
  /** The models the hub routes to this account. */
  models: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  usageLimits: ServerProviderUsageLimits,
});
export type UsageLimitSourceAccount = typeof UsageLimitSourceAccount.Type;

export const UsageLimitSourceSnapshot = Schema.Struct({
  id: UsageLimitSourceId,
  kind: Schema.Literal("cliproxy"),
  label: TrimmedNonEmptyString,
  /** Origin of the hub, which also serves the agents sent through it. */
  origin: Schema.optional(TrimmedNonEmptyString),
  /** Origin and base path of the hub, which tell apart hubs served from one origin. */
  endpoint: Schema.optional(TrimmedNonEmptyString),
  checkedAt: IsoDateTime,
  accounts: ForwardCompatibleArray(UsageLimitSourceAccount),
  error: Schema.optional(TrimmedNonEmptyString),
});
export type UsageLimitSourceSnapshot = typeof UsageLimitSourceSnapshot.Type;

export const UsageLimitSourceSnapshots = ForwardCompatibleArray(UsageLimitSourceSnapshot);
export type UsageLimitSourceSnapshots = typeof UsageLimitSourceSnapshots.Type;

export const UsageLimitSourceConsumeResetCreditInput = Schema.Struct({
  sourceId: UsageLimitSourceId,
  accountId: TrimmedNonEmptyString,
  creditId: TrimmedNonEmptyString,
});
export type UsageLimitSourceConsumeResetCreditInput =
  typeof UsageLimitSourceConsumeResetCreditInput.Type;

export const ProviderConsumeResetCreditInput = Schema.Union([
  Schema.Struct({
    instanceId: ProviderInstanceId,
    creditId: Schema.optional(TrimmedNonEmptyString),
  }),
  UsageLimitSourceConsumeResetCreditInput,
]);
export type ProviderConsumeResetCreditInput = typeof ProviderConsumeResetCreditInput.Type;

export class UsageLimitSourceError extends Schema.TaggedError<UsageLimitSourceError>()(
  "UsageLimitSourceError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

export const ProviderConsumeResetCreditOutcome = Schema.Literals([
  "reset",
  "nothingToReset",
  "noCredit",
  "alreadyRedeemed",
]);
export type ProviderConsumeResetCreditOutcome = typeof ProviderConsumeResetCreditOutcome.Type;

export const ProviderConsumeResetCreditResult = Schema.Struct({
  outcome: ProviderConsumeResetCreditOutcome,
  warning: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderConsumeResetCreditResult = typeof ProviderConsumeResetCreditResult.Type;

export const UsageLimitsReport = Schema.Struct({
  createdAt: IsoDateTime,
  accounts: Schema.Array(
    Schema.Struct({
      id: TrimmedNonEmptyString,
      driver: ProviderDriverKind,
      label: TrimmedNonEmptyString,
      plan: Schema.optional(TrimmedNonEmptyString),
      email: Schema.optional(TrimmedNonEmptyString),
      sourceLabel: Schema.optional(TrimmedNonEmptyString),
      instanceId: Schema.optional(ProviderInstanceId),
      resetCreditInput: Schema.optional(ProviderConsumeResetCreditInput),
      displayName: Schema.optional(Schema.String),
      accentColor: Schema.optional(Schema.String),
      limits: ServerProviderUsageLimits,
    }),
  ),
  notices: Schema.Array(Schema.String),
});
export type UsageLimitsReport = typeof UsageLimitsReport.Type;

/** One metered allowance as last read: how much is spent, when it refills, when it was read. */
export const ProviderQuotaWindow = Schema.Struct({
  id: TrimmedNonEmptyString,
  kind: ServerProviderUsageWindow.fields.kind,
  label: TrimmedNonEmptyString,
  usedFraction: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  resetsAt: Schema.NullOr(IsoDateTime),
  measuredAt: IsoDateTime,
});
export type ProviderQuotaWindow = typeof ProviderQuotaWindow.Type;

/**
 * Allowances that meter only some of a login's models, such as Claude's Fable week or an
 * Antigravity family's 5-hour and weekly windows. Every window binds every listed model.
 */
export const ProviderQuotaModelGroup = Schema.Struct({
  models: Schema.NonEmptyArray(TrimmedNonEmptyString),
  windows: Schema.NonEmptyArray(ProviderQuotaWindow),
});
export type ProviderQuotaModelGroup = typeof ProviderQuotaModelGroup.Type;

export const ProviderQuotaUnavailableReason = Schema.Literals([
  /** The provider has not reported limits, or does not report them at all. */
  "notReported",
  "unsupported",
  "probeFailed",
  /** Turns go to a custom endpoint, so this login's own reading is not their quota. */
  "customEndpoint",
]);
export type ProviderQuotaUnavailableReason = typeof ProviderQuotaUnavailableReason.Type;

/** What a login's quota reading is, one variant per shape providers report. */
export const ProviderQuota = Schema.Union([
  /**
   * Plan allowances every model draws on (a 5-hour session and a week), plus allowances for one
   * model tier and paid usage past the plan, which keeps the login running but is not plan quota.
   */
  Schema.TaggedStruct("Plan", {
    shared: Schema.NonEmptyArray(ProviderQuotaWindow),
    modelScoped: Schema.Array(ProviderQuotaModelGroup),
    overage: Schema.NullOr(ProviderQuotaWindow),
  }),
  /** Every allowance meters a group of models and none meters all, as Antigravity's do. */
  Schema.TaggedStruct("ModelGroups", {
    groups: Schema.NonEmptyArray(ProviderQuotaModelGroup),
  }),
  /** Only a monthly credit cap meters the login; it is read as a share of the cap, not a balance. */
  Schema.TaggedStruct("CreditCap", { cap: ProviderQuotaWindow }),
  Schema.TaggedStruct("Unavailable", {
    reason: ProviderQuotaUnavailableReason,
    message: Schema.NullOr(TrimmedNonEmptyString),
  }),
]);
export type ProviderQuota = typeof ProviderQuota.Type;

/** What a picker shows for a login, or for one of its models. */
export const ProviderQuotaLine = Schema.Union([
  Schema.TaggedStruct("Remaining", {
    /** Whole percent left on the tightest window, 1 to 100. */
    remainingPercent: Schema.Number.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
    window: ProviderQuotaWindow,
    /** The reading is older than a few missed refreshes. */
    stale: Schema.Boolean,
  }),
  /** A window is spent; `window` is the one that refills last. */
  Schema.TaggedStruct("Exhausted", {
    window: ProviderQuotaWindow,
    stale: Schema.Boolean,
  }),
  Schema.TaggedStruct("Unknown", {
    reason: ProviderQuotaUnavailableReason,
    message: Schema.NullOr(TrimmedNonEmptyString),
  }),
]);
export type ProviderQuotaLine = typeof ProviderQuotaLine.Type;

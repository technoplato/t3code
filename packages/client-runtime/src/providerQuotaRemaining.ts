import type { ServerProvider, ServerProviderUsageWindow } from "@t3tools/contracts";
import { antigravityWindowLimitsModel } from "@t3tools/shared/usageLimits";

/** How much of a model's quota one provider instance has left. */
export type ProviderQuota =
  | {
      readonly kind: "available";
      /** Whole percent left on the tightest window that meters the model. */
      readonly remainingPercent: number;
      /** When that window resets, in epoch milliseconds. */
      readonly resetsAt: number | null;
    }
  /** Spent on a window that meters the model; `resetsAt` is when the last spent window refills. */
  | { readonly kind: "exhausted"; readonly resetsAt: number | null }
  | { readonly kind: "unknown" };

type QuotaProvider = Pick<ServerProvider, "driver" | "usageLimits">;

const CLAUDE_SCOPED_WINDOW_PREFIX = "seven_day_";
const scopeToken = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "_");

function resetMillis(window: ServerProviderUsageWindow): number | null {
  if (window.resetsAt === undefined) return null;
  const at = Date.parse(window.resetsAt);
  return Number.isFinite(at) ? at : null;
}

/** Whether a provider's usage window meters the given model. */
function usageWindowMetersModel(
  provider: QuotaProvider,
  window: ServerProviderUsageWindow,
  model: string,
): boolean {
  if (window.modelIds !== undefined && !window.modelIds.includes(model)) return false;
  if (window.providerIds !== undefined && !window.providerIds.includes(model.split("/")[0] ?? "")) {
    return false;
  }
  switch (provider.driver) {
    case "claudeAgent":
      // Extra-usage spend is billed past the plan, so it is not plan quota.
      if (window.id === "monthly_spend") return false;
      // A model-scoped weekly allowance, such as "seven_day_fable", meters only its own model.
      return (
        !window.id.startsWith(CLAUDE_SCOPED_WINDOW_PREFIX) ||
        scopeToken(model).includes(window.id.slice(CLAUDE_SCOPED_WINDOW_PREFIX.length))
      );
    case "antigravity":
      return antigravityWindowLimitsModel(window, model);
    case "codex":
      // Seat-based plans spend credits only past their plan windows.
      return (
        window.id !== "individual" ||
        !provider.usageLimits?.windows.some(
          (entry) => entry.id === "primary" || entry.id === "secondary",
        )
      );
    case "opencode":
      return !window.id.startsWith("go_") || model.startsWith("opencode-go/");
    default:
      return true;
  }
}

/**
 * A login's remaining quota for a model is its tightest window: the least left
 * across every window that meters the model (session, weekly, model-scoped).
 */
export function providerQuotaForModel(
  provider: QuotaProvider | undefined,
  model: string,
  now: number,
): ProviderQuota {
  const limits = provider?.usageLimits;
  if (!provider || !limits || limits.unavailable) return { kind: "unknown" };
  const windows = limits.windows.filter((window) =>
    usageWindowMetersModel(provider, window, model),
  );
  if (windows.length === 0) return { kind: "unknown" };

  let tightest: { remainingPercent: number; resetsAt: number | null } | null = null;
  let exhausted: { resetsAt: number | null } | null = null;
  for (const window of windows) {
    const resetsAt = resetMillis(window);
    // A window whose reset has passed is full again, whatever the last reading said.
    const remainingPercent =
      resetsAt !== null && resetsAt <= now
        ? 100
        : Math.round(100 - Math.max(0, Math.min(100, window.usedPercent)));
    if (remainingPercent <= 0) {
      exhausted =
        exhausted === null
          ? { resetsAt }
          : {
              resetsAt:
                exhausted.resetsAt === null || resetsAt === null
                  ? null
                  : Math.max(exhausted.resetsAt, resetsAt),
            };
      continue;
    }
    // Equally tight windows keep the later reset: the login stays this low until then.
    if (
      tightest === null ||
      remainingPercent < tightest.remainingPercent ||
      (remainingPercent === tightest.remainingPercent &&
        (resetsAt ?? Number.POSITIVE_INFINITY) > (tightest.resetsAt ?? Number.POSITIVE_INFINITY))
    ) {
      tightest = { remainingPercent, resetsAt };
    }
  }
  if (exhausted) return { kind: "exhausted", ...exhausted };
  return tightest ? { kind: "available", ...tightest } : { kind: "unknown" };
}

const QUOTA_RANK: Record<ProviderQuota["kind"], number> = {
  available: 0,
  unknown: 1,
  exhausted: 2,
};

const resetOrder = (resetsAt: number | null) => resetsAt ?? Number.POSITIVE_INFINITY;

/**
 * Orders most remaining first, then the earlier reset. Logins without usage
 * data follow the ones with quota left, and spent logins come last.
 */
function compareProviderQuota(left: ProviderQuota, right: ProviderQuota): number {
  const rank = QUOTA_RANK[left.kind] - QUOTA_RANK[right.kind];
  if (rank !== 0) return rank;
  if (left.kind === "available" && right.kind === "available") {
    return (
      right.remainingPercent - left.remainingPercent ||
      resetOrder(left.resetsAt) - resetOrder(right.resetsAt)
    );
  }
  if (left.kind === "exhausted" && right.kind === "exhausted") {
    return resetOrder(left.resetsAt) - resetOrder(right.resetsAt);
  }
  return 0;
}

/** Stable: logins that compare equal keep the order they came in. */
export function sortByMostRemaining<T>(
  items: ReadonlyArray<T>,
  quotaOf: (item: T) => ProviderQuota,
): ReadonlyArray<T> {
  return items
    .map((item, index) => ({ item, index, quota: quotaOf(item) }))
    .sort(
      (left, right) => compareProviderQuota(left.quota, right.quota) || left.index - right.index,
    )
    .map((entry) => entry.item);
}

/**
 * The login to switch to: the one with the most known quota left. Null when
 * none is known to have any, or when the current login is already as good.
 */
export function mostRemainingChoice<T>(
  items: ReadonlyArray<T>,
  quotaOf: (item: T) => ProviderQuota,
  isCurrent: (item: T) => boolean,
): T | null {
  const best = sortByMostRemaining(items, quotaOf)[0];
  if (best === undefined || quotaOf(best).kind !== "available" || isCurrent(best)) return null;
  const current = items.find(isCurrent);
  if (current !== undefined && compareProviderQuota(quotaOf(current), quotaOf(best)) === 0) {
    return null;
  }
  return best;
}

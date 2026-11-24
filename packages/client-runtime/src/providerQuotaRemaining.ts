import type {
  ProviderQuota,
  ProviderQuotaLine,
  ProviderQuotaModelGroup,
  ProviderQuotaWindow,
  ServerProvider,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";
import { antigravityWindowLimitsModel } from "@t3tools/shared/usageLimits";

export type { ProviderQuota, ProviderQuotaLine } from "@t3tools/contracts";

/** Providers refresh limits every 5 minutes by default; three missed refreshes mark a reading stale. */
export const QUOTA_STALE_AFTER_MS = 15 * 60_000;

export type QuotaProvider = Pick<ServerProvider, "driver" | "usageLimits"> & {
  readonly auth: Pick<ServerProvider["auth"], "endpoint">;
  /** Scoped windows are resolved to the models the login offers. */
  readonly models: ReadonlyArray<Pick<ServerProvider["models"][number], "slug">>;
};

const CLAUDE_SCOPED_WINDOW_PREFIX = "seven_day_";
const scopeToken = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "_");

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
      // A model-scoped weekly allowance, such as "seven_day_fable", meters only its own model.
      return (
        !window.id.startsWith(CLAUDE_SCOPED_WINDOW_PREFIX) ||
        scopeToken(model).includes(window.id.slice(CLAUDE_SCOPED_WINDOW_PREFIX.length))
      );
    case "antigravity":
      return antigravityWindowLimitsModel(window, model);
    case "opencode":
      return !window.id.startsWith("go_") || model.startsWith("opencode-go/");
    default:
      return true;
  }
}

/** A monthly money cap: paid usage past a plan, or the only meter of a credit-billed login. */
const isCreditWindow = (provider: QuotaProvider, id: string) =>
  (provider.driver === "claudeAgent" && id === "monthly_spend") ||
  (provider.driver === "codex" && id === "individual");

function quotaWindow(window: ServerProviderUsageWindow, measuredAt: string): ProviderQuotaWindow {
  return {
    id: window.id,
    kind: window.kind,
    label: window.label,
    usedFraction: Math.max(0, Math.min(100, window.usedPercent)) / 100,
    resetsAt: window.resetsAt ?? null,
    measuredAt,
  };
}

const isNonEmpty = <A>(items: ReadonlyArray<A>): items is readonly [A, ...A[]] => items.length > 0;

/** Sorts a login's usage reading into the shape its provider meters by. */
export function providerQuota(provider: QuotaProvider | undefined): ProviderQuota {
  const limits = provider?.usageLimits;
  if (!provider || !limits) return { _tag: "Unavailable", reason: "notReported", message: null };
  if (limits.unavailable) {
    return {
      _tag: "Unavailable",
      reason: limits.unavailable.reason,
      message: limits.unavailable.message ?? null,
    };
  }
  if (provider.auth.endpoint !== undefined) {
    return { _tag: "Unavailable", reason: "customEndpoint", message: null };
  }
  const models = provider.models.map((model) => model.slug);
  const shared: Array<ProviderQuotaWindow> = [];
  const modelScoped = new Map<string, ProviderQuotaModelGroup>();
  let overage: ProviderQuotaWindow | null = null;
  for (const usage of limits.windows) {
    const window = quotaWindow(usage, limits.checkedAt);
    if (isCreditWindow(provider, usage.id)) {
      overage = window;
      continue;
    }
    // An empty id finds the windows that name their models, whatever the login lists.
    const metersEvery =
      usageWindowMetersModel(provider, usage, "") &&
      models.every((model) => usageWindowMetersModel(provider, usage, model));
    if (metersEvery) {
      shared.push(window);
      continue;
    }
    const metered = models.filter((model) => usageWindowMetersModel(provider, usage, model));
    // A window for models the login does not offer says nothing about what can be picked.
    if (!isNonEmpty(metered)) continue;
    const key = metered.join("\n");
    const group = modelScoped.get(key);
    modelScoped.set(key, {
      models: metered,
      windows: group ? [...group.windows, window] : [window],
    });
  }
  const groups = [...modelScoped.values()];
  if (isNonEmpty(shared)) return { _tag: "Plan", shared, modelScoped: groups, overage };
  if (isNonEmpty(groups)) return { _tag: "ModelGroups", groups };
  if (overage) return { _tag: "CreditCap", cap: overage };
  return { _tag: "Unavailable", reason: "notReported", message: null };
}

const resetMillis = (window: ProviderQuotaWindow) => {
  if (window.resetsAt === null) return null;
  const at = Date.parse(window.resetsAt);
  return Number.isFinite(at) ? at : null;
};

/** Equally spent windows keep the later reset: the login stays this low until then. */
const laterReset = (left: ProviderQuotaWindow, right: ProviderQuotaWindow) =>
  (resetMillis(left) ?? Number.POSITIVE_INFINITY) >=
  (resetMillis(right) ?? Number.POSITIVE_INFINITY)
    ? left
    : right;

type NonEmpty<A> = readonly [A, ...A[]];
type MeteredLine = Exclude<ProviderQuotaLine, { _tag: "Unknown" }>;

/** The line for a set of windows that all bind: the tightest, or spent if any one is. */
function tightestLine(windows: NonEmpty<ProviderQuotaWindow>, now: number): MeteredLine {
  const readings = windows.map((read) => {
    const resetsAt = resetMillis(read);
    // A window whose reset has passed is full again, whatever the last reading said.
    const window =
      resetsAt !== null && resetsAt <= now ? { ...read, usedFraction: 0, resetsAt: null } : read;
    return { window, remainingPercent: Math.round(100 - window.usedFraction * 100) };
  });
  const stale = (window: ProviderQuotaWindow) =>
    now - Date.parse(window.measuredAt) > QUOTA_STALE_AFTER_MS;
  const spent = readings.filter((reading) => reading.remainingPercent <= 0);
  if (isNonEmpty(spent)) {
    const window = spent.map((reading) => reading.window).reduce(laterReset);
    return { _tag: "Exhausted", window, stale: stale(window) };
  }
  const tightest = readings.reduce((best, reading) =>
    reading.remainingPercent < best.remainingPercent ||
    (reading.remainingPercent === best.remainingPercent &&
      laterReset(reading.window, best.window) === reading.window)
      ? reading
      : best,
  );
  return { _tag: "Remaining", ...tightest, stale: stale(tightest.window) };
}

const unknownLine = (
  quota: Extract<ProviderQuota, { _tag: "Unavailable" }>,
): ProviderQuotaLine => ({
  _tag: "Unknown",
  reason: quota.reason,
  message: quota.message,
});

const metering = (groups: ReadonlyArray<ProviderQuotaModelGroup>, model: string) =>
  groups.filter((group) => group.models.includes(model)).flatMap((group) => group.windows);

/**
 * What a picker shows for a login (`model` null) or for one of its models: the tightest window
 * that meters it. A login whose groups each meter some models is spent only when every group is;
 * otherwise it shows its tightest group that still has quota.
 */
export function quotaLineFor(
  quota: ProviderQuota,
  model: string | null,
  now: number,
): ProviderQuotaLine {
  switch (quota._tag) {
    case "Unavailable":
      return unknownLine(quota);
    case "CreditCap":
      return tightestLine([quota.cap], now);
    case "Plan":
      return tightestLine(
        model === null ? quota.shared : [...quota.shared, ...metering(quota.modelScoped, model)],
        now,
      );
    case "ModelGroups": {
      if (model !== null) {
        const windows = metering(quota.groups, model);
        if (isNonEmpty(windows)) return tightestLine(windows, now);
        return { _tag: "Unknown", reason: "notReported", message: null };
      }
      const open = quota.groups
        .map((group) => tightestLine(group.windows, now))
        .filter(
          (line): line is Extract<MeteredLine, { _tag: "Remaining" }> => line._tag === "Remaining",
        );
      if (isNonEmpty(open)) {
        return open.reduce((tightest, line) =>
          line.remainingPercent < tightest.remainingPercent ? line : tightest,
        );
      }
      const [first, ...rest] = quota.groups;
      return tightestLine([...first.windows, ...rest.flatMap((group) => group.windows)], now);
    }
  }
}

/**
 * The line a model row shows: only for a model its login meters apart from the rest, such as
 * Fable's own week or each Antigravity model family. Null when the login's line already says it.
 */
export function modelQuotaLine(
  quota: ProviderQuota,
  model: string,
  now: number,
): ProviderQuotaLine | null {
  switch (quota._tag) {
    case "Plan":
      return metering(quota.modelScoped, model).length > 0 ? quotaLineFor(quota, model, now) : null;
    case "ModelGroups":
      return metering(quota.groups, model).length > 0 ? quotaLineFor(quota, model, now) : null;
    default:
      return null;
  }
}

/** A login's remaining quota for a model is the tightest window that meters it. */
export function providerQuotaForModel(
  provider: QuotaProvider | undefined,
  model: string,
  now: number,
): ProviderQuotaLine {
  return quotaLineFor(providerQuota(provider), model, now);
}

const QUOTA_RANK: Record<ProviderQuotaLine["_tag"], number> = {
  Remaining: 0,
  Unknown: 1,
  Exhausted: 2,
};

const resetOrder = (line: MeteredLine) => resetMillis(line.window) ?? Number.POSITIVE_INFINITY;

/**
 * Orders most remaining first, then the earlier reset. Logins without usage
 * data follow the ones with quota left, and spent logins come last.
 */
function compareProviderQuota(left: ProviderQuotaLine, right: ProviderQuotaLine): number {
  const rank = QUOTA_RANK[left._tag] - QUOTA_RANK[right._tag];
  if (rank !== 0) return rank;
  if (left._tag === "Remaining" && right._tag === "Remaining") {
    return right.remainingPercent - left.remainingPercent || resetOrder(left) - resetOrder(right);
  }
  if (left._tag === "Exhausted" && right._tag === "Exhausted") {
    return resetOrder(left) - resetOrder(right);
  }
  return 0;
}

/** Stable: logins that compare equal keep the order they came in. */
export function sortByMostRemaining<T>(
  items: ReadonlyArray<T>,
  quotaOf: (item: T) => ProviderQuotaLine,
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
  quotaOf: (item: T) => ProviderQuotaLine,
  isCurrent: (item: T) => boolean,
): T | null {
  const best = sortByMostRemaining(items, quotaOf)[0];
  if (best === undefined || quotaOf(best)._tag !== "Remaining" || isCurrent(best)) return null;
  const current = items.find(isCurrent);
  if (current !== undefined && compareProviderQuota(quotaOf(current), quotaOf(best)) === 0) {
    return null;
  }
  return best;
}

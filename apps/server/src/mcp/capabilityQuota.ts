import type {
  OrchestratorMcpProviderQuota,
  OrchestratorMcpQuotaWindow,
  ServerProvider,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";
import { antigravityWindowLimitsModel, remainingPercent } from "@t3tools/shared/usageLimits";

import { windowLimitsModel } from "../provider/claudeUsageLimits.ts";

type QuotaProvider = Pick<ServerProvider, "driver" | "auth" | "models" | "usageLimits">;

function windowMetersModel(
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
      return windowLimitsModel(window, model);
    case "antigravity":
      return antigravityWindowLimitsModel(window, model);
    case "opencode":
      return !window.id.startsWith("go_") || model.startsWith("opencode-go/");
    default:
      return true;
  }
}

/** Paid usage past the plan: it keeps a login running after its plan windows are spent. */
function isOverageWindow(provider: QuotaProvider, window: ServerProviderUsageWindow): boolean {
  if (provider.driver === "claudeAgent") return window.id === "monthly_spend";
  return (
    provider.driver === "codex" &&
    window.id === "individual" &&
    (provider.usageLimits?.windows.some(
      (entry) => entry.id === "primary" || entry.id === "secondary",
    ) ??
      false)
  );
}

const limitName = (window: ServerProviderUsageWindow) =>
  window.kind === "session" ? "Session" : window.kind === "weekly" ? "Weekly" : window.label;

/**
 * What `orchestrator_capabilities` says about an instance's remaining quota. No reading, an
 * unreadable one and a window past its reset are all unknown, so they are left out.
 */
export function capabilityQuota(input: {
  readonly provider: QuotaProvider;
  /** The model ids the capability entry lists; scoped windows name only these. */
  readonly listedModels: ReadonlyArray<string>;
  readonly now: number;
}): {
  readonly quota?: OrchestratorMcpProviderQuota;
  readonly constraints: ReadonlyArray<string>;
} {
  const { provider, listedModels, now } = input;
  const limits = provider.usageLimits;
  // A custom endpoint serves the instance's turns, so its own login's reading is not their quota.
  if (
    limits === undefined ||
    limits.unavailable !== undefined ||
    provider.auth.endpoint !== undefined
  ) {
    return { constraints: [] };
  }
  const current = limits.windows.filter((window) => {
    const resetsAt = window.resetsAt === undefined ? Number.NaN : Date.parse(window.resetsAt);
    return !(resetsAt <= now);
  });
  const overagePays =
    limits.zeroSpendCap !== true &&
    current.some((window) => isOverageWindow(provider, window) && remainingPercent(window) > 0);
  const windows: Array<OrchestratorMcpQuotaWindow> = [];
  const constraints: Array<string> = [];
  let exhausted = false;
  for (const window of current) {
    const metersEvery =
      // An empty id finds the windows that name their models, whatever the instance lists.
      windowMetersModel(provider, window, "") &&
      provider.models.every((model) => windowMetersModel(provider, window, model.slug));
    const models = metersEvery
      ? []
      : listedModels.filter((model) => windowMetersModel(provider, window, model));
    // A window for models the entry does not list tells the reader nothing it can act on.
    if (!metersEvery && models.length === 0) continue;
    const remaining = remainingPercent(window);
    windows.push({
      kind: window.kind,
      ...(window.label.toLowerCase() === window.kind ? {} : { label: window.label }),
      ...(metersEvery ? {} : { models }),
      remainingPercent: remaining,
      ...(window.resetsAt === undefined ? {} : { resetsAt: window.resetsAt }),
    });
    if (remaining > 0 || overagePays || isOverageWindow(provider, window)) continue;
    const resets = window.resetsAt === undefined ? "" : `; resets ${window.resetsAt}`;
    if (metersEvery) {
      exhausted = true;
      constraints.push(`${limitName(window)} limit reached${resets}.`);
    } else {
      constraints.push(`${limitName(window)} limit reached for ${models.join(", ")}${resets}.`);
    }
  }
  if (windows.length === 0) return { constraints };
  return {
    quota: { checkedAt: limits.checkedAt, windows, ...(exhausted ? { exhausted: true } : {}) },
    constraints,
  };
}

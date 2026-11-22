import type { ServerProvider, ServerProviderUsageWindow } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  mostRemainingChoice,
  providerQuotaForModel,
  sortByMostRemaining,
  type ProviderQuota,
} from "./providerQuotaRemaining.ts";

const NOW = Date.parse("2026-03-10T12:00:00.000Z");
const HOUR = 60 * 60_000;
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

function usageWindow(
  id: string,
  usedPercent: number,
  resetsInMs?: number,
  extra: Partial<ServerProviderUsageWindow> = {},
): ServerProviderUsageWindow {
  return {
    id,
    kind: id === "five_hour" ? "session" : "weekly",
    label: id,
    usedPercent,
    ...(resetsInMs === undefined ? {} : { resetsAt: iso(resetsInMs) }),
    ...extra,
  };
}

function login(
  windows: ReadonlyArray<ServerProviderUsageWindow> | null,
  driver: ServerProvider["driver"] = "claudeAgent" as ServerProvider["driver"],
): Pick<ServerProvider, "driver" | "usageLimits"> {
  return {
    driver,
    ...(windows === null ? {} : { usageLimits: { checkedAt: iso(0), windows: [...windows] } }),
  };
}

const FABLE = "claude-fable-5-2";
const quota = (windows: ReadonlyArray<ServerProviderUsageWindow> | null, model = FABLE) =>
  providerQuotaForModel(login(windows), model, NOW);

describe("providerQuotaForModel", () => {
  it("takes the tightest of the session and weekly windows", () => {
    expect(
      quota([usageWindow("five_hour", 20, 2 * HOUR), usageWindow("seven_day", 65, 72 * HOUR)]),
    ).toEqual({ kind: "available", remainingPercent: 35, resetsAt: NOW + 72 * HOUR });
    expect(
      quota([usageWindow("five_hour", 90, 2 * HOUR), usageWindow("seven_day", 10, 72 * HOUR)]),
    ).toEqual({ kind: "available", remainingPercent: 10, resetsAt: NOW + 2 * HOUR });
  });

  it("counts a model-scoped weekly limit only for its own model", () => {
    const windows = [
      usageWindow("five_hour", 10, 2 * HOUR),
      usageWindow("seven_day", 30, 72 * HOUR),
      usageWindow("seven_day_fable", 95, 48 * HOUR),
    ];
    expect(quota(windows)).toEqual({
      kind: "available",
      remainingPercent: 5,
      resetsAt: NOW + 48 * HOUR,
    });
    expect(quota(windows, "claude-opus-5-5")).toEqual({
      kind: "available",
      remainingPercent: 70,
      resetsAt: NOW + 72 * HOUR,
    });
  });

  it("honors a window's own model list", () => {
    const windows = [
      usageWindow("seven_day", 10, 72 * HOUR),
      usageWindow("budget", 100, 24 * HOUR, { modelIds: ["other-model"] }),
    ];
    expect(providerQuotaForModel(login(windows, "opencode"), "my-model", NOW).kind).toBe(
      "available",
    );
    expect(providerQuotaForModel(login(windows, "opencode"), "other-model", NOW).kind).toBe(
      "exhausted",
    );
  });

  it("is exhausted when any metering window is spent, until the last one refills", () => {
    expect(
      quota([usageWindow("five_hour", 100, 2 * HOUR), usageWindow("seven_day", 5, 72 * HOUR)]),
    ).toEqual({ kind: "exhausted", resetsAt: NOW + 2 * HOUR });
    expect(
      quota([usageWindow("five_hour", 100, 2 * HOUR), usageWindow("seven_day", 100, 72 * HOUR)]),
    ).toEqual({ kind: "exhausted", resetsAt: NOW + 72 * HOUR });
    // A reading that rounds to nothing left is as good as spent.
    expect(quota([usageWindow("seven_day", 99.6, 72 * HOUR)]).kind).toBe("exhausted");
  });

  it("treats a window past its reset as full again", () => {
    expect(
      quota([usageWindow("five_hour", 100, -HOUR), usageWindow("seven_day", 40, 72 * HOUR)]),
    ).toEqual({ kind: "available", remainingPercent: 60, resetsAt: NOW + 72 * HOUR });
  });

  it("ignores extra-usage spend, which is not plan quota", () => {
    expect(
      quota([
        usageWindow("seven_day", 40, 72 * HOUR),
        usageWindow("monthly_spend", 100, undefined, { kind: "monthly" }),
      ]),
    ).toEqual({ kind: "available", remainingPercent: 60, resetsAt: NOW + 72 * HOUR });
  });

  it("is unknown without readable limits", () => {
    expect(quota(null)).toEqual({ kind: "unknown" });
    expect(quota([])).toEqual({ kind: "unknown" });
    expect(providerQuotaForModel(undefined, FABLE, NOW)).toEqual({ kind: "unknown" });
    expect(
      providerQuotaForModel(
        {
          ...login([]),
          usageLimits: { checkedAt: iso(0), windows: [], unavailable: { reason: "probeFailed" } },
        },
        FABLE,
        NOW,
      ),
    ).toEqual({ kind: "unknown" });
  });
});

describe("most remaining order", () => {
  const available = (
    remainingPercent: number,
    resetsInMs: number | null = null,
  ): ProviderQuota => ({
    kind: "available",
    remainingPercent,
    resetsAt: resetsInMs === null ? null : NOW + resetsInMs,
  });
  const exhausted = (resetsInMs: number | null): ProviderQuota => ({
    kind: "exhausted",
    resetsAt: resetsInMs === null ? null : NOW + resetsInMs,
  });
  const unknown: ProviderQuota = { kind: "unknown" };
  const order = (quotas: Record<string, ProviderQuota>) =>
    sortByMostRemaining(Object.keys(quotas), (id) => quotas[id]!);
  const choice = (quotas: Record<string, ProviderQuota>, current: string) =>
    mostRemainingChoice(
      Object.keys(quotas),
      (id) => quotas[id]!,
      (id) => id === current,
    );

  it("puts the most remaining first, then no data, then spent logins", () => {
    expect(
      order({
        spent: exhausted(HOUR),
        low: available(12),
        noData: unknown,
        high: available(80),
      }),
    ).toEqual(["high", "low", "noData", "spent"]);
  });

  it("breaks ties on the earlier reset and otherwise keeps the given order", () => {
    expect(
      order({
        later: available(50, 30 * HOUR),
        sooner: available(50, 3 * HOUR),
        noReset: available(50),
        spentLater: exhausted(9 * HOUR),
        spentSooner: exhausted(HOUR),
        first: unknown,
        second: unknown,
      }),
    ).toEqual(["sooner", "later", "noReset", "first", "second", "spentSooner", "spentLater"]);
  });

  it("chooses the login with the most known quota left", () => {
    expect(choice({ a: available(20), b: available(70), c: unknown }, "a")).toBe("b");
    expect(choice({ a: exhausted(HOUR), b: available(1), c: unknown }, "a")).toBe("b");
  });

  it("keeps the current login when it is already the best or as good", () => {
    expect(choice({ a: available(70), b: available(20) }, "a")).toBeNull();
    expect(choice({ a: available(50, HOUR), b: available(50, HOUR) }, "b")).toBeNull();
  });

  it("never chooses a login that is spent or has no usage data", () => {
    expect(choice({ a: exhausted(HOUR), b: unknown, c: exhausted(2 * HOUR) }, "a")).toBeNull();
    expect(choice({ a: unknown, b: unknown }, "a")).toBeNull();
  });
});

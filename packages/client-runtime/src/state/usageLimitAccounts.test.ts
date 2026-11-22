import { ProviderDriverKind, type ServerProviderUsageWindow } from "@t3tools/contracts";
import { collectLimitPools, type LimitAccount } from "@t3tools/shared/usageLimits";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  arrangeLimitPools,
  DEFAULT_LIMIT_ACCOUNTS_VIEW,
  type LimitAccountsView,
  moveLimitAccount,
} from "./usageLimitAccounts.ts";

const NOW = Date.parse("2026-09-03T12:00:00.000Z");
const at = (hours: number) => DateTime.formatIso(DateTime.makeUnsafe(NOW + hours * 3_600_000));

const session = (usedPercent: number, resetsInHours?: number): ServerProviderUsageWindow => ({
  id: "five_hour",
  kind: "session",
  label: "Session",
  usedPercent,
  windowDurationMins: 300,
  ...(resetsInHours === undefined ? {} : { resetsAt: at(resetsInHours) }),
});
const week = (usedPercent: number, resetsInHours?: number): ServerProviderUsageWindow => ({
  id: "seven_day",
  kind: "weekly",
  label: "Weekly",
  usedPercent,
  windowDurationMins: 7 * 24 * 60,
  ...(resetsInHours === undefined ? {} : { resetsAt: at(resetsInHours) }),
});

const account = (key: string, windows: readonly ServerProviderUsageWindow[]): LimitAccount => ({
  key,
  driver: ProviderDriverKind.make("claudeAgent"),
  displayName: key,
  email: undefined,
  plan: undefined,
  accentColor: undefined,
  environments: [],
  sourceLabel: "Hub",
  redeem: null,
  limits: { checkedAt: at(0), windows },
});

// Pool order is the soonest session reset: fresh, busy, spent, blocked, stale, weekOnly.
const pools = collectLimitPools(
  [
    account("fresh", [session(0, 1), week(10, 50)]),
    account("busy", [session(60, 2), week(80, 20)]),
    account("spent", [session(100, 3), week(40, 90)]),
    account("blocked", [session(20, 4), week(100, 30)]),
    account("stale", [session(100, -1), week(5, 70)]),
    account("weekOnly", [week(100, 10)]),
  ],
  NOW,
);
const view = (patch: Partial<LimitAccountsView>) => ({ ...DEFAULT_LIMIT_ACCOUNTS_VIEW, ...patch });
const shown = (patch: Partial<LimitAccountsView>, reveal = false) =>
  arrangeLimitPools(pools, view(patch), NOW, reveal)[0]!.accounts.map((entry) => entry.key);

describe("arrangeLimitPools", () => {
  it("keeps the pool as it is by default", () => {
    const [pool] = arrangeLimitPools(pools, DEFAULT_LIMIT_ACCOUNTS_VIEW, NOW);
    expect(pool).toMatchObject({ accounts: pools[0]!.accounts, windows: pools[0]!.windows });
    expect(pool!.hidden).toEqual([]);
  });

  it("hides empty sessions, counting a session its spent week blocks and not a stale read", () => {
    const [pool] = arrangeLimitPools(pools, view({ hideEmptySessions: true }), NOW);
    expect(pool!.accounts.map((entry) => entry.key)).toEqual([
      "stale",
      "fresh",
      "busy",
      "weekOnly",
    ]);
    expect(pool!.hidden.map((entry) => entry.key)).toEqual(["spent", "blocked"]);
    expect(pool!.hiddenEmptySessions).toBe(2);
    expect(pool!.windows.map((window) => window.columns.length)).toEqual([4, 4]);
    // The total still counts the hidden accounts.
    expect(pool!.windows[0]!.remainingPercent).toBe(pools[0]!.windows[0]!.remainingPercent);
  });

  it("hides empty weeks, counts an account once under both filters, and reveals on request", () => {
    expect(shown({ hideEmptyWeeks: true })).toEqual(["stale", "fresh", "busy", "spent"]);
    const both = view({ hideEmptySessions: true, hideEmptyWeeks: true });
    const [pool] = arrangeLimitPools(pools, both, NOW);
    expect(pool!.hidden.map((entry) => entry.key)).toEqual(["spent", "blocked", "weekOnly"]);
    expect([pool!.hiddenEmptySessions, pool!.hiddenEmptyWeeks]).toEqual([2, 2]);
    expect(shown(both, true)).toEqual(["stale", "fresh", "busy", "spent", "blocked", "weekOnly"]);
  });

  it("drops a window none of the shown accounts report", () => {
    const sessionless = collectLimitPools(
      [account("spent", [session(100, 3)]), account("weekOnly", [week(20, 10)])],
      NOW,
    );
    const [pool] = arrangeLimitPools(sessionless, view({ hideEmptySessions: true }), NOW);
    expect(pool!.windows.map((window) => window.kind)).toEqual(["weekly"]);
  });

  it.each([
    ["sessionMostLeft", ["fresh", "busy", "stale", "spent", "blocked", "weekOnly"]],
    ["sessionMostUsed", ["stale", "spent", "blocked", "busy", "fresh", "weekOnly"]],
    ["weekMostLeft", ["stale", "fresh", "spent", "busy", "weekOnly", "blocked"]],
    ["weekMostUsed", ["weekOnly", "blocked", "busy", "spent", "fresh", "stale"]],
    ["weekSoonest", ["weekOnly", "busy", "blocked", "fresh", "stale", "spent"]],
  ] as const)("sorts by %s with an account that lacks the window last", (sort, expected) => {
    expect(shown({ sort })).toEqual(expected);
  });

  it("follows the manual order and leaves unplaced accounts in pool order after it", () => {
    expect(shown({ sort: "manual", order: ["weekOnly", "gone", "busy"] })).toEqual([
      "weekOnly",
      "busy",
      "stale",
      "fresh",
      "spent",
      "blocked",
    ]);
  });
});

describe("moveLimitAccount", () => {
  it("switches a sorted view to the manual order with only the dragged account moved", () => {
    const sorted = view({ sort: "weekSoonest", hideEmptySessions: true, order: ["gone"] });
    // Shown: weekOnly, busy, fresh, stale. Dragging stale onto busy lands it before busy.
    const next = moveLimitAccount(pools, sorted, "stale", "busy");
    expect(next).toEqual({
      ...sorted,
      sort: "manual",
      order: ["gone", "weekOnly", "stale", "busy", "blocked", "fresh", "spent"],
    });
    expect(arrangeLimitPools(pools, next, NOW)[0]!.accounts.map((entry) => entry.key)).toEqual([
      "weekOnly",
      "stale",
      "busy",
      "fresh",
    ]);
  });

  it("lands a downward drag after its target and ignores an unknown account", () => {
    expect(moveLimitAccount(pools, view({}), "fresh", "spent").order.slice(0, 4)).toEqual([
      "stale",
      "busy",
      "spent",
      "fresh",
    ]);
    expect(moveLimitAccount(pools, view({}), "fresh", "gone")).toEqual(view({}));
  });
});

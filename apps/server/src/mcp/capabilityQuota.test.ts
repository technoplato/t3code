import type { ServerProvider, ServerProviderUsageWindow } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { capabilityQuota } from "./capabilityQuota.ts";

const NOW = Date.parse("2026-11-22T12:00:00.000Z");
const SESSION_RESET = "2026-11-22T15:00:00.000Z";
const WEEK_RESET = "2026-11-25T08:00:00.000Z";

const session = (usedPercent: number, resetsAt = SESSION_RESET): ServerProviderUsageWindow => ({
  id: "five_hour",
  kind: "session",
  label: "Session",
  usedPercent,
  resetsAt,
});
const weekly = (usedPercent: number, resetsAt = WEEK_RESET): ServerProviderUsageWindow => ({
  id: "seven_day",
  kind: "weekly",
  label: "Weekly",
  usedPercent,
  resetsAt,
});
const weeklyFable = (usedPercent: number): ServerProviderUsageWindow => ({
  id: "seven_day_fable",
  kind: "weekly",
  label: "Weekly · Fable",
  usedPercent,
  resetsAt: WEEK_RESET,
});
const monthlySpend = (usedPercent: number): ServerProviderUsageWindow => ({
  id: "monthly_spend",
  kind: "monthly",
  label: "Monthly spend",
  usedPercent,
});

const MODELS = ["claude-fable-5-2", "claude-sonnet-5-5"];

function quotaOf(
  windows: ReadonlyArray<ServerProviderUsageWindow> | undefined,
  overrides: {
    readonly unavailable?: boolean;
    readonly endpoint?: string;
    readonly zeroSpendCap?: boolean;
    readonly listedModels?: ReadonlyArray<string>;
  } = {},
) {
  return capabilityQuota({
    provider: {
      driver: "claudeAgent",
      auth: {
        status: "authenticated",
        ...(overrides.endpoint === undefined ? {} : { endpoint: overrides.endpoint }),
      },
      models: MODELS.map((slug) => ({ slug, name: slug, isCustom: false, capabilities: null })),
      ...(windows === undefined
        ? {}
        : {
            usageLimits: {
              checkedAt: "2026-11-22T11:58:00.000Z",
              windows,
              ...(overrides.unavailable ? { unavailable: { reason: "probeFailed" as const } } : {}),
              ...(overrides.zeroSpendCap ? { zeroSpendCap: true } : {}),
            },
          }),
    } as Pick<ServerProvider, "driver" | "auth" | "models" | "usageLimits">,
    listedModels: overrides.listedModels ?? MODELS,
    now: NOW,
  });
}

describe("capabilityQuota", () => {
  it("reports what is left of each window with its reset and the reading's age", () => {
    expect(quotaOf([session(38), weekly(59.4), weeklyFable(30)])).toEqual({
      quota: {
        checkedAt: "2026-11-22T11:58:00.000Z",
        windows: [
          { kind: "session", remainingPercent: 62, resetsAt: SESSION_RESET },
          { kind: "weekly", remainingPercent: 41, resetsAt: WEEK_RESET },
          {
            kind: "weekly",
            label: "Weekly · Fable",
            models: ["claude-fable-5-2"],
            remainingPercent: 70,
            resetsAt: WEEK_RESET,
          },
        ],
      },
      constraints: [],
    });
  });

  it.each([
    ["no reading", quotaOf(undefined)],
    ["an unreadable reading", quotaOf([weekly(100)], { unavailable: true })],
    ["a reading with no windows", quotaOf([])],
    [
      "a login whose turns go to a custom endpoint",
      quotaOf([weekly(100)], { endpoint: "http://hub" }),
    ],
    ["a window whose reset has passed", quotaOf([weekly(100, "2026-11-22T11:00:00.000Z")])],
  ])("leaves %s unknown instead of full or spent", (_name, result) => {
    expect(result).toEqual({ constraints: [] });
  });

  it("marks a login spent when a window that meters every model ran out", () => {
    const result = quotaOf([session(12), weekly(100)]);
    expect(result.quota?.exhausted).toBe(true);
    expect(result.quota?.windows[1]).toEqual({
      kind: "weekly",
      remainingPercent: 0,
      resetsAt: WEEK_RESET,
    });
    expect(result.constraints).toEqual([`Weekly limit reached; resets ${WEEK_RESET}.`]);
  });

  it("scopes a spent model allowance to that model and keeps the login usable", () => {
    const result = quotaOf([session(12), weekly(40), weeklyFable(100)]);
    expect(result.quota?.exhausted).toBeUndefined();
    expect(result.constraints).toEqual([
      `Weekly limit reached for claude-fable-5-2; resets ${WEEK_RESET}.`,
    ]);
  });

  it("drops a model allowance when the entry lists none of its models", () => {
    const result = quotaOf([weekly(40), weeklyFable(100)], {
      listedModels: ["claude-sonnet-5-5"],
    });
    expect(result.quota?.windows).toEqual([
      { kind: "weekly", remainingPercent: 60, resetsAt: WEEK_RESET },
    ]);
    expect(result.constraints).toEqual([]);
  });

  it("does not call a login spent while paid extra usage still has room", () => {
    const paying = quotaOf([weekly(100), monthlySpend(20)]);
    expect(paying.quota?.exhausted).toBeUndefined();
    expect(paying.constraints).toEqual([]);

    const capped = quotaOf([weekly(100), monthlySpend(0)], { zeroSpendCap: true });
    expect(capped.quota?.exhausted).toBe(true);

    const spendGone = quotaOf([weekly(40), monthlySpend(100)]);
    expect(spendGone.quota?.exhausted).toBeUndefined();
    expect(spendGone.constraints).toEqual([]);
  });
});

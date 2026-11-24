import {
  ProviderDriverKind,
  type ProviderQuotaLine,
  type ProviderQuotaWindow,
  type ServerProviderUsageLimits,
  type ServerProviderUsageWindow,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  QUOTA_STALE_AFTER_MS,
  modelQuotaLine,
  mostRemainingChoice,
  providerQuota,
  providerQuotaForModel,
  quotaLineFor,
  sortByMostRemaining,
} from "./providerQuotaRemaining.ts";

const NOW = Date.parse("2026-03-10T12:00:00.000Z");
const HOUR = 60 * 60_000;
const iso = (offsetMs: number) => DateTime.formatIso(DateTime.makeUnsafe(NOW + offsetMs));

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

const FABLE = "claude-fable-5-2";
const OPUS = "claude-opus-5-5";
const CLAUDE_MODELS = [OPUS, FABLE, "claude-haiku-5-5"];
const GEMINI_MODELS = ["gemini-4-neon", "gemini-4-carbon", "gemini-4-argon", OPUS];

function login(
  windows: ReadonlyArray<ServerProviderUsageWindow> | null,
  options: {
    readonly driver?: string;
    readonly models?: ReadonlyArray<string>;
    readonly checkedAtMs?: number;
    readonly extra?: Partial<ServerProviderUsageLimits>;
    readonly endpoint?: string;
  } = {},
) {
  return {
    driver: ProviderDriverKind.make(options.driver ?? "claudeAgent"),
    models: (options.models ?? CLAUDE_MODELS).map((slug) => ({ slug })),
    auth: options.endpoint === undefined ? {} : { endpoint: options.endpoint },
    ...(windows === null
      ? {}
      : {
          usageLimits: {
            checkedAt: iso(options.checkedAtMs ?? 0),
            windows: [...windows],
            ...options.extra,
          },
        }),
  } satisfies Parameters<typeof providerQuota>[0];
}

const line = (
  windows: ReadonlyArray<ServerProviderUsageWindow> | null,
  model: string | null = FABLE,
  options: Parameters<typeof login>[1] = {},
) => quotaLineFor(providerQuota(login(windows, options)), model, NOW);

const remaining = (percent: number, id: string) =>
  expect.objectContaining({
    _tag: "Remaining",
    remainingPercent: percent,
    window: expect.objectContaining({ id }),
    stale: false,
  });

const CLAUDE_MAX = [
  usageWindow("five_hour", 10, 2 * HOUR),
  usageWindow("seven_day", 30, 72 * HOUR),
  usageWindow("seven_day_fable", 95, 48 * HOUR),
  usageWindow("monthly_spend", 20, undefined, { kind: "monthly" }),
];

describe("providerQuota", () => {
  it("reads a Claude plan as shared windows, a Fable-only week and paid overage", () => {
    const quota = providerQuota(login(CLAUDE_MAX));
    expect(quota._tag).toBe("Plan");
    if (quota._tag !== "Plan") return;
    expect(quota.shared.map((window) => window.id)).toEqual(["five_hour", "seven_day"]);
    expect(quota.modelScoped).toEqual([
      {
        models: [FABLE],
        windows: [
          {
            id: "seven_day_fable",
            kind: "weekly",
            label: "seven_day_fable",
            usedFraction: 0.95,
            resetsAt: iso(48 * HOUR),
            measuredAt: iso(0),
          },
        ],
      },
    ]);
    expect(quota.overage?.id).toBe("monthly_spend");
  });

  it("reads Antigravity as model groups, one per family it offers", () => {
    const quota = providerQuota(
      login(
        [
          usageWindow("gemini-carbon-5h", 40, 3 * HOUR),
          usageWindow("gemini-argon-weekly", 100, 50 * HOUR),
          usageWindow("gemini-5h", 20, 4 * HOUR),
          usageWindow("gemini-weekly", 35, 90 * HOUR),
          usageWindow("3p-weekly", 60, 6 * HOUR),
        ],
        { driver: "antigravity", models: GEMINI_MODELS },
      ),
    );
    expect(quota._tag).toBe("ModelGroups");
    if (quota._tag !== "ModelGroups") return;
    // A family's 5-hour and weekly windows meter the same models, so they form one group.
    expect(
      quota.groups.map((group) => [group.models, group.windows.map((window) => window.id)]),
    ).toEqual([
      [["gemini-4-carbon"], ["gemini-carbon-5h"]],
      [["gemini-4-argon"], ["gemini-argon-weekly"]],
      [["gemini-4-neon"], ["gemini-5h", "gemini-weekly"]],
      [[OPUS], ["3p-weekly"]],
    ]);
  });

  it("reads a login metered only by a monthly credit cap as a credit cap", () => {
    expect(
      providerQuota(
        login([usageWindow("individual", 25, undefined, { kind: "monthly" })], { driver: "codex" }),
      )._tag,
    ).toBe("CreditCap");
    expect(
      providerQuota(
        login(
          [
            usageWindow("primary", 10, HOUR),
            usageWindow("individual", 25, undefined, { kind: "monthly" }),
          ],
          { driver: "codex" },
        ),
      ),
    ).toMatchObject({ _tag: "Plan", overage: { id: "individual" } });
  });

  it("says why a login has no reading", () => {
    expect(providerQuota(undefined)).toEqual({
      _tag: "Unavailable",
      reason: "notReported",
      message: null,
    });
    expect(providerQuota(login(null, { driver: "grok" }))).toMatchObject({
      reason: "notReported",
    });
    expect(providerQuota(login([]))).toMatchObject({ reason: "notReported" });
    expect(
      providerQuota(
        login([], { extra: { unavailable: { reason: "probeFailed", message: "Login expired" } } }),
      ),
    ).toEqual({ _tag: "Unavailable", reason: "probeFailed", message: "Login expired" });
    expect(
      providerQuota(login([], { extra: { unavailable: { reason: "unsupported" } } })),
    ).toMatchObject({ reason: "unsupported", message: null });
    expect(providerQuota(login(CLAUDE_MAX, { endpoint: "http://127.0.0.1:8317" }))).toMatchObject({
      reason: "customEndpoint",
    });
  });
});

describe("quotaLineFor", () => {
  it("takes the tightest of the session and weekly windows", () => {
    expect(
      line([usageWindow("five_hour", 20, 2 * HOUR), usageWindow("seven_day", 65, 72 * HOUR)]),
    ).toEqual(remaining(35, "seven_day"));
    expect(
      line([usageWindow("five_hour", 90, 2 * HOUR), usageWindow("seven_day", 10, 72 * HOUR)]),
    ).toEqual(remaining(10, "five_hour"));
  });

  it("counts a model-scoped weekly limit only for its own model", () => {
    expect(line(CLAUDE_MAX, FABLE)).toEqual(remaining(5, "seven_day_fable"));
    expect(line(CLAUDE_MAX, OPUS)).toEqual(remaining(70, "seven_day"));
    expect(line(CLAUDE_MAX, null)).toEqual(remaining(70, "seven_day"));
  });

  it("honors a window's own model list", () => {
    const windows = [
      usageWindow("seven_day", 10, 72 * HOUR),
      usageWindow("budget", 100, 24 * HOUR, { modelIds: ["other-model"] }),
    ];
    const options = { driver: "opencode", models: ["my-model", "other-model"] };
    expect(line(windows, "my-model", options)._tag).toBe("Remaining");
    expect(line(windows, "other-model", options)._tag).toBe("Exhausted");
  });

  it("is exhausted when any metering window is spent, until the last one refills", () => {
    expect(
      line([usageWindow("five_hour", 100, 2 * HOUR), usageWindow("seven_day", 5, 72 * HOUR)]),
    ).toMatchObject({ _tag: "Exhausted", window: { id: "five_hour", resetsAt: iso(2 * HOUR) } });
    expect(
      line([usageWindow("five_hour", 100, 2 * HOUR), usageWindow("seven_day", 100, 72 * HOUR)]),
    ).toMatchObject({ _tag: "Exhausted", window: { id: "seven_day", resetsAt: iso(72 * HOUR) } });
    // A reading that rounds to nothing left is as good as spent.
    expect(line([usageWindow("seven_day", 99.6, 72 * HOUR)])._tag).toBe("Exhausted");
  });

  it("keeps a spent Fable week to Fable, with the rest of the plan open", () => {
    const windows = [
      usageWindow("five_hour", 10, 2 * HOUR),
      usageWindow("seven_day", 30, 72 * HOUR),
      usageWindow("seven_day_fable", 100, 60 * HOUR),
    ];
    expect(line(windows, FABLE)).toMatchObject({
      _tag: "Exhausted",
      window: { id: "seven_day_fable", resetsAt: iso(60 * HOUR) },
    });
    expect(line(windows, null)).toEqual(remaining(70, "seven_day"));
  });

  it("treats a window past its reset as full again", () => {
    expect(
      line([usageWindow("five_hour", 100, -HOUR), usageWindow("seven_day", 40, 72 * HOUR)]),
    ).toEqual(remaining(60, "seven_day"));
    expect(line([usageWindow("seven_day", 100, -HOUR)])).toMatchObject({
      _tag: "Remaining",
      remainingPercent: 100,
      window: { usedFraction: 0, resetsAt: null },
    });
  });

  it("ignores paid overage, which is not plan quota", () => {
    expect(
      line([
        usageWindow("seven_day", 40, 72 * HOUR),
        usageWindow("monthly_spend", 100, undefined, { kind: "monthly" }),
      ]),
    ).toEqual(remaining(60, "seven_day"));
  });

  it("shows a credit cap's share left", () => {
    expect(
      line([usageWindow("individual", 75, undefined, { kind: "monthly" })], "gpt-5", {
        driver: "codex",
        models: ["gpt-5"],
      }),
    ).toEqual(remaining(25, "individual"));
  });

  it("marks a reading older than three missed refreshes stale", () => {
    const windows = [usageWindow("five_hour", 20, 2 * HOUR)];
    expect(line(windows, null, { checkedAtMs: -QUOTA_STALE_AFTER_MS })).toMatchObject({
      stale: false,
    });
    expect(line(windows, null, { checkedAtMs: -QUOTA_STALE_AFTER_MS - 1 })).toMatchObject({
      _tag: "Remaining",
      stale: true,
    });
    expect(
      line([usageWindow("five_hour", 100, 2 * HOUR)], null, { checkedAtMs: -HOUR }),
    ).toMatchObject({ _tag: "Exhausted", stale: true });
  });

  it("is unknown, with its reason, without a usable reading", () => {
    expect(line(null, FABLE, { driver: "grok" })).toEqual({
      _tag: "Unknown",
      reason: "notReported",
      message: null,
    });
    expect(
      line([], null, {
        extra: { unavailable: { reason: "probeFailed", message: "Login expired" } },
      }),
    ).toEqual({ _tag: "Unknown", reason: "probeFailed", message: "Login expired" });
    expect(providerQuotaForModel(undefined, FABLE, NOW)._tag).toBe("Unknown");
  });

  describe("Antigravity model groups", () => {
    const options = { driver: "antigravity", models: GEMINI_MODELS };
    const groups = [
      usageWindow("gemini-carbon-5h", 40, 3 * HOUR),
      usageWindow("gemini-argon-weekly", 100, 50 * HOUR),
      usageWindow("gemini-5h", 20, 4 * HOUR),
      usageWindow("gemini-weekly", 100, 90 * HOUR),
      usageWindow("3p-weekly", 60, 6 * HOUR),
    ];

    it("gives each model its own family's window", () => {
      expect(line(groups, "gemini-4-carbon", options)).toEqual(remaining(60, "gemini-carbon-5h"));
      expect(line(groups, "gemini-4-argon", options)).toMatchObject({
        _tag: "Exhausted",
        window: { id: "gemini-argon-weekly", resetsAt: iso(50 * HOUR) },
      });
      // Its 5-hour window has room, but its spent week blocks it.
      expect(line(groups, "gemini-4-neon", options)).toMatchObject({
        _tag: "Exhausted",
        window: { id: "gemini-weekly" },
      });
      expect(line(groups, OPUS, options)).toEqual(remaining(40, "3p-weekly"));
    });

    it("shows the login's tightest open family, and spent only when every family is", () => {
      expect(line(groups, null, options)).toEqual(remaining(40, "3p-weekly"));
      expect(
        line(
          groups.map((window) => ({ ...window, usedPercent: 100 })),
          null,
          options,
        ),
      ).toMatchObject({
        _tag: "Exhausted",
        window: { id: "gemini-weekly", resetsAt: iso(90 * HOUR) },
      });
    });
  });
});

describe("modelQuotaLine", () => {
  it("shows only on models their login meters apart", () => {
    const quota = providerQuota(login(CLAUDE_MAX));
    expect(modelQuotaLine(quota, FABLE, NOW)).toEqual(remaining(5, "seven_day_fable"));
    expect(modelQuotaLine(quota, OPUS, NOW)).toBeNull();
    expect(
      modelQuotaLine(
        providerQuota(
          login([usageWindow("gemini-5h", 20, 4 * HOUR)], {
            driver: "antigravity",
            models: GEMINI_MODELS,
          }),
        ),
        "gemini-4-neon",
        NOW,
      ),
    ).toEqual(remaining(80, "gemini-5h"));
    expect(modelQuotaLine(providerQuota(login(null)), FABLE, NOW)).toBeNull();
  });
});

describe("most remaining order", () => {
  const window = (resetsInMs: number | null): ProviderQuotaWindow => ({
    id: "seven_day",
    kind: "weekly",
    label: "Weekly",
    usedFraction: 0.5,
    resetsAt: resetsInMs === null ? null : iso(resetsInMs),
    measuredAt: iso(0),
  });
  const available = (remainingPercent: number, resetsInMs: number | null = null) =>
    ({
      _tag: "Remaining",
      remainingPercent,
      window: window(resetsInMs),
      stale: false,
    }) satisfies ProviderQuotaLine;
  const exhausted = (resetsInMs: number | null) =>
    ({ _tag: "Exhausted", window: window(resetsInMs), stale: false }) satisfies ProviderQuotaLine;
  const unknown: ProviderQuotaLine = { _tag: "Unknown", reason: "notReported", message: null };
  const order = (quotas: Record<string, ProviderQuotaLine>) =>
    sortByMostRemaining(Object.keys(quotas), (id) => quotas[id]!);
  const choice = (quotas: Record<string, ProviderQuotaLine>, current: string) =>
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

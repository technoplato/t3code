import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderOptionSelection,
} from "@t3tools/contracts";
import { getProviderOptionDescriptors } from "@t3tools/shared/model";

import type { ModelOption } from "../../lib/modelOptions";
import { appAtomRegistry } from "../../state/atom-registry";
import { modelOptionMemoryAtom } from "../../state/use-composer-drafts";
import {
  rememberModelOptions,
  withRememberedModelOptions,
} from "../../state/use-model-option-memory";
import {
  canCommitPendingModel,
  mostRemainingOrder,
  pendingModelAfterPress,
  pendingModelForLogin,
  visibleCatalogModels,
} from "./thread-settings-sheet-state";

function modelOption(
  model: string,
  options: ReadonlyArray<ProviderOptionSelection> = [],
): ModelOption {
  return {
    key: `codex:${model}`,
    label: model,
    subtitle: "",
    providerKey: "codex",
    providerLabel: "Codex",
    providerDriver: "codex",
    isDefault: false,
    isLegacy: false,
    capabilities: {
      optionDescriptors: [
        {
          id: "effort",
          label: "Reasoning",
          type: "select",
          options: [
            { id: "medium", label: "Medium", isDefault: true },
            { id: "high", label: "High" },
          ],
          currentValue: "medium",
        },
        {
          id: "serviceTier",
          label: "Service Tier",
          type: "select",
          options: [
            { id: "default", label: "Standard", isDefault: true },
            { id: "priority", label: "Fast" },
          ],
          currentValue: "default",
        },
      ],
    },
    selection: {
      instanceId: ProviderInstanceId.make("codex"),
      model,
      options,
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  appAtomRegistry.set(modelOptionMemoryAtom, {});
});

describe("thread settings sheet state", () => {
  it("preserves in-progress edits when the staged model is pressed again", () => {
    rememberModelOptions("codex", "gpt-next", [{ id: "effort", value: "medium" }]);
    const pending = modelOption("gpt-next", [{ id: "effort", value: "high" }]);

    expect(
      pendingModelAfterPress({
        current: pending,
        pressed: modelOption("gpt-next"),
        pressedIsApplied: false,
        restoreSelection: withRememberedModelOptions,
      })?.selection.options,
    ).toEqual([{ id: "effort", value: "high" }]);
  });

  it("previews remembered options before Save when switching models", () => {
    const remembered = [
      { id: "effort", value: "high" },
      { id: "serviceTier", value: "priority" },
    ];
    rememberModelOptions("codex", "gpt-other", remembered);
    const pressed = modelOption("gpt-other");

    const pending = pendingModelAfterPress({
      current: modelOption("gpt-next"),
      pressed,
      pressedIsApplied: false,
      restoreSelection: withRememberedModelOptions,
    });

    expect(pending?.selection).toEqual({ ...pressed.selection, options: remembered });
    const preview = getProviderOptionDescriptors({
      caps: pressed.capabilities!,
      selections: pending?.selection.options,
    });
    expect(preview.map(({ id, currentValue }) => ({ id, value: currentValue }))).toEqual(
      remembered,
    );
    expect(pending?.selection).toEqual(withRememberedModelOptions(pressed.selection));
  });

  it("keeps catalog defaults for scheduled-task picks even when options are remembered", () => {
    rememberModelOptions("codex", "gpt-other", [
      { id: "effort", value: "high" },
      { id: "serviceTier", value: "priority" },
    ]);
    const pressed = modelOption("gpt-other");

    const pending = pendingModelAfterPress({
      current: modelOption("gpt-next"),
      pressed,
      pressedIsApplied: false,
    });

    expect(pending?.selection).toEqual(pressed.selection);
    const preview = getProviderOptionDescriptors({
      caps: pressed.capabilities!,
      selections: pending?.selection.options,
    });
    expect(preview.map(({ id, currentValue }) => ({ id, value: currentValue }))).toEqual([
      { id: "effort", value: "medium" },
      { id: "serviceTier", value: "default" },
    ]);
  });

  // regression: #16816 sync model favorites and visibility across clients
  it("cannot select a hidden model exposed only for visibility management", () => {
    const pending = modelOption("gpt-next");
    expect(
      canCommitPendingModel(pending, [
        { providerKey: "codex", providerLabel: "Codex", models: [{ ...pending, isHidden: true }] },
      ]),
    ).toBe(false);
  });

  it("cannot save a staged model after sign-out removes it from the catalog", () => {
    const pending = modelOption("gemini-native");
    const group = { providerKey: "codex", providerLabel: "Codex", models: [pending] };

    expect(canCommitPendingModel(pending, [group])).toBe(true);
    expect(canCommitPendingModel(pending, [])).toBe(false);
    expect(
      canCommitPendingModel(pending, [
        {
          ...group,
          models: [{ ...pending, isUnavailable: true }],
        },
      ]),
    ).toBe(false);
  });

  it("finds legacy models by search without enabling Show legacy models", () => {
    const current = modelOption("gpt-next");
    const legacy = { ...modelOption("claude-opus-4-8"), label: "Claude Opus 4.8", isLegacy: true };
    const visible = (query: string) =>
      visibleCatalogModels({
        models: [current, legacy],
        providerLabel: "Codex",
        query,
        favoriteKeys: new Set(),
        favoritesOnly: false,
        showLegacy: false,
        isDisplayed: () => false,
      }).map((model) => model.label);

    expect(visible("")).toEqual(["gpt-next"]);
    expect(visible("   ")).toEqual(["gpt-next"]);
    expect(visible("Claude Opus 4.8")).toEqual(["Claude Opus 4.8"]);
  });
  it("orders the logins of the selected model by quota left and carries its options over", () => {
    const now = Date.parse("2026-03-10T12:00:00.000Z");
    const login = (instance: string, model: string, driver = "claudeAgent"): ModelOption => ({
      ...modelOption(model),
      key: `${instance}:${model}`,
      providerKey: instance,
      providerLabel: instance,
      providerDriver: driver,
      selection: { instanceId: ProviderInstanceId.make(instance), model },
    });
    const group = (instance: string, models: ReadonlyArray<ModelOption>) => ({
      providerKey: instance,
      providerLabel: instance,
      models,
    });
    const limits = (instance: string, sessionUsed: number, weeklyUsed: number) => ({
      instanceId: ProviderInstanceId.make(instance),
      driver: ProviderDriverKind.make("claudeAgent"),
      auth: {},
      models: [{ slug: "fable" }, { slug: "opus" }],
      usageLimits: {
        checkedAt: "2026-03-10T11:59:00.000Z",
        windows: [
          { id: "five_hour", kind: "session" as const, label: "Session", usedPercent: sessionUsed },
          { id: "seven_day", kind: "weekly" as const, label: "Weekly", usedPercent: weeklyUsed },
        ],
      },
    });
    const selected = {
      ...login("low", "fable"),
      selection: {
        ...login("low", "fable").selection,
        options: [{ id: "effort", value: "high" }],
      },
    };
    const order = mostRemainingOrder({
      groups: [
        group("codex", [login("codex", "fable", "codex")]),
        group("low", [login("low", "opus"), selected]),
        group("spent", [login("spent", "fable")]),
        group("unread", [login("unread", "fable")]),
        group("high", [login("high", "fable")]),
        group("other-model", [login("other-model", "opus")]),
      ],
      selected,
      providers: [limits("low", 10, 80), limits("spent", 100, 5), limits("high", 30, 40)],
      now,
    });

    expect(order.groups.map((entry) => entry.providerKey)).toEqual([
      "high",
      "low",
      "unread",
      "spent",
      "codex",
      "other-model",
    ]);
    expect(order.choice?.key).toBe("high:fable");
    rememberModelOptions("high", "fable", [{ id: "effort", value: "medium" }]);
    expect(
      pendingModelForLogin({
        login: order.choice!,
        current: selected,
        restoreSelection: withRememberedModelOptions,
      }).selection,
    ).toEqual({
      instanceId: "high",
      model: "fable",
      options: [{ id: "effort", value: "high" }],
    });
    expect(
      pendingModelForLogin({
        login: order.choice!,
        current: login("low", "fable"),
        restoreSelection: withRememberedModelOptions,
      }).selection.options,
    ).toEqual([{ id: "effort", value: "medium" }]);
  });
});

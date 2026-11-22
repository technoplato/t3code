import {
  mostRemainingChoice,
  providerQuotaForModel,
  sortByMostRemaining,
  type ProviderQuota,
} from "@t3tools/client-runtime/provider-quota-remaining";
import type { ModelOption, ProviderGroup } from "../../lib/modelOptions";
import type { ModelSelection, ProviderInstanceId, ServerProvider } from "@t3tools/contracts";

export function modelFavoriteKey(provider: ProviderInstanceId, model: string): string {
  return `${provider}:${model}`;
}

export function favoritesFirst(
  models: ReadonlyArray<ModelOption>,
  favoriteKeys: ReadonlySet<string>,
): ReadonlyArray<ModelOption> {
  const favorites: ModelOption[] = [];
  const others: ModelOption[] = [];
  for (const model of models) {
    (favoriteKeys.has(model.key) ? favorites : others).push(model);
  }
  return [...favorites, ...others];
}

export function modelMatchesCatalogQuery(input: {
  readonly model: ModelOption;
  readonly providerLabel: string;
  readonly query: string;
}): boolean {
  const query = input.query.trim().toLocaleLowerCase();
  if (query.length === 0) {
    return true;
  }

  return [
    input.model.label,
    input.model.subtitle,
    input.model.selection.model,
    input.providerLabel,
  ].some((value) => value.toLocaleLowerCase().includes(query));
}

export function visibleCatalogModels(input: {
  readonly models: ReadonlyArray<ModelOption>;
  readonly providerLabel: string;
  readonly query: string;
  readonly favoriteKeys: ReadonlySet<string>;
  readonly favoritesOnly: boolean;
  readonly showLegacy: boolean;
  readonly isDisplayed: (model: ModelOption) => boolean;
}): ReadonlyArray<ModelOption> {
  const catalogModels =
    input.showLegacy || input.favoritesOnly || input.query.trim().length > 0
      ? input.models
      : input.models.filter(
          (model) =>
            !model.isLegacy || input.isDisplayed(model) || input.favoriteKeys.has(model.key),
        );
  return favoritesFirst(
    catalogModels.filter(
      (model) =>
        (!input.favoritesOnly || input.favoriteKeys.has(model.key)) &&
        modelMatchesCatalogQuery({
          model,
          providerLabel: input.providerLabel,
          query: input.query,
        }),
    ),
    input.favoriteKeys,
  );
}

export function pendingModelAfterPress(input: {
  readonly current: ModelOption | null;
  readonly pressed: ModelOption;
  readonly pressedIsApplied: boolean;
  readonly restoreSelection?: (selection: ModelSelection) => ModelSelection;
}): ModelOption | null {
  if (input.pressedIsApplied) {
    return null;
  }
  if (input.current?.key === input.pressed.key) {
    return input.current;
  }
  return input.restoreSelection
    ? { ...input.pressed, selection: input.restoreSelection(input.pressed.selection) }
    : input.pressed;
}

export function canCommitPendingModel(
  pending: ModelOption,
  groups: ReadonlyArray<ProviderGroup>,
): boolean {
  return groups.some((group) =>
    group.models.some(
      (model) => model.key === pending.key && !model.isUnavailable && !model.isHidden,
    ),
  );
}

export function providerSectionIsCollapsed(input: {
  readonly defaultExpanded: boolean;
  readonly hasExpansionOverride: boolean;
  readonly isNarrowed: boolean;
}): boolean {
  if (input.isNarrowed) {
    return false;
  }
  return input.defaultExpanded ? input.hasExpansionOverride : !input.hasExpansionOverride;
}

/**
 * Orders the logins that offer the selected model (the same driver's instances
 * listing its id) by quota left; every other provider keeps its place after them.
 */
export function mostRemainingOrder(input: {
  readonly groups: ReadonlyArray<ProviderGroup>;
  readonly selected: ModelOption | null;
  readonly providers: ReadonlyArray<Pick<ServerProvider, "instanceId" | "driver" | "usageLimits">>;
  readonly now: number;
}): {
  readonly groups: ReadonlyArray<ProviderGroup>;
  readonly quotas: ReadonlyMap<string, ProviderQuota>;
  /** The login with more quota left than the selected one, if any. */
  readonly choice: ModelOption | null;
} {
  const selected = input.selected;
  const logins = new Map<string, ModelOption>();
  const quotas = new Map<string, ProviderQuota>();
  if (selected) {
    for (const group of input.groups) {
      const login = group.models.find(
        (model) =>
          model.providerDriver === selected.providerDriver &&
          model.selection.model === selected.selection.model &&
          !model.isUnavailable &&
          !model.isHidden,
      );
      if (!login) continue;
      logins.set(group.providerKey, login);
      quotas.set(
        group.providerKey,
        providerQuotaForModel(
          input.providers.find((provider) => provider.instanceId === login.selection.instanceId),
          login.selection.model,
          input.now,
        ),
      );
    }
  }
  const quotaOf = (providerKey: string): ProviderQuota =>
    quotas.get(providerKey) ?? { kind: "unknown" };
  return {
    groups: [
      ...sortByMostRemaining(
        input.groups.filter((group) => logins.has(group.providerKey)),
        (group) => quotaOf(group.providerKey),
      ),
      ...input.groups.filter((group) => !logins.has(group.providerKey)),
    ],
    quotas,
    choice: mostRemainingChoice(
      [...logins.values()],
      (login) => quotaOf(login.providerKey),
      (login) => login.key === selected?.key,
    ),
  };
}

/** Moving to another login of the same model keeps the options already chosen for it. */
export function pendingModelForLogin(input: {
  readonly login: ModelOption;
  readonly current: ModelOption | null;
  readonly restoreSelection?: (selection: ModelSelection) => ModelSelection;
}): ModelOption {
  const options = input.current?.selection.options;
  if (options?.length) {
    return { ...input.login, selection: { ...input.login.selection, options } };
  }
  return input.restoreSelection
    ? { ...input.login, selection: input.restoreSelection(input.login.selection) }
    : input.login;
}

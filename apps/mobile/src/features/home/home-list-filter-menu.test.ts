import type { EnvironmentId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import type { WorkspaceEnvironment } from "../../state/workspaceModel";
import { buildHomeListFilterMenuItems, homeListFilterEnvironments } from "./home-list-filter-menu";

function environment(
  environmentId: string,
  environmentLabel: string,
  isEnabled: boolean,
): WorkspaceEnvironment {
  return {
    environmentId: environmentId as EnvironmentId,
    environmentLabel,
    displayUrl: "",
    isRelayManaged: false,
    isEnabled,
    connectionState: isEnabled ? "connected" : "available",
    connectionError: null,
    connectionErrorTraceId: null,
  };
}

it("offers only switched-on environments, sorted by label", () => {
  expect(
    homeListFilterEnvironments([
      environment("env-studio", "Studio", true),
      environment("env-laptop", "Laptop", false),
      environment("env-desk", "Desk", true),
    ]),
  ).toEqual([
    { environmentId: "env-desk", label: "Desk", connectionState: "connected" },
    { environmentId: "env-studio", label: "Studio", connectionState: "connected" },
  ]);
});

it("includes a sort section for recently done vs longest waiting", () => {
  const onInboxSortOrderChange = vi.fn();
  const items = buildHomeListFilterMenuItems({
    environments: [{ environmentId: "env-desk" as EnvironmentId, label: "Desk" }],
    projects: [],
    selectedEnvironmentId: null,
    selectedProjectKey: null,
    inboxSortOrder: "longest_waiting",
    workingShelfEnabled: true,
    onEnvironmentChange: () => undefined,
    onProjectChange: () => undefined,
    onInboxSortOrderChange,
  });

  const sortSection = items.find((item) => item.id === "sort");
  expect(sortSection && "items" in sortSection ? sortSection.items : []).toMatchObject([
    { id: "sort:recent", title: "Recently done", selected: false },
    { id: "sort:longest_waiting", title: "Longest waiting", selected: true },
  ]);

  if (sortSection && "items" in sortSection) {
    const first = sortSection.items[0];
    if (first && "onPress" in first) {
      first.onPress();
    }
  }
  expect(onInboxSortOrderChange).toHaveBeenCalledWith("recent");
});

it("includes a select-threads action when multi-select is wired", () => {
  const onStartMultiSelect = vi.fn();
  const items = buildHomeListFilterMenuItems({
    environments: [{ environmentId: "env-desk" as EnvironmentId, label: "Desk" }],
    projects: [],
    selectedEnvironmentId: null,
    selectedProjectKey: null,
    onEnvironmentChange: () => undefined,
    onProjectChange: () => undefined,
    onStartMultiSelect,
  });

  const selectItem = items.find((item) => item.id === "select-threads");
  expect(selectItem).toBeDefined();
  if (selectItem && "onPress" in selectItem) {
    selectItem.onPress();
  }
  expect(onStartMultiSelect).toHaveBeenCalledOnce();
});

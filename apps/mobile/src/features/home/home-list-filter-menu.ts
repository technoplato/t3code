import type { EnvironmentId } from "@t3tools/contracts";
import type { SidebarInboxSortOrder } from "@t3tools/contracts/settings";
import * as Arr from "effect/Array";
import * as Order from "effect/Order";

import { msg } from "gt-react-native";

import type { AppBarMenuItem } from "../../components/ui/AppBar.types";
import { m, type MessageResolver } from "../../i18n/messages";
import type { WorkspaceEnvironment } from "../../state/workspaceModel";

export interface HomeListFilterMenuEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

export function homeListFilterEnvironments(environments: ReadonlyArray<WorkspaceEnvironment>) {
  return Arr.sort(
    environments
      .filter((environment) => environment.isEnabled)
      .map((environment) => ({
        environmentId: environment.environmentId,
        label: environment.environmentLabel,
        connectionState: environment.connectionState,
      })),
    Order.mapInput(Order.String, (environment: { readonly label: string }) => environment.label),
  );
}

export interface HomeListFilterMenuProject {
  readonly key: string;
  readonly label: string;
}

export function buildHomeListFilterMenuItems(
  props: {
    readonly environments: ReadonlyArray<HomeListFilterMenuEnvironment>;
    readonly projects: ReadonlyArray<HomeListFilterMenuProject>;
    readonly selectedEnvironmentId: EnvironmentId | null;
    readonly selectedProjectKey: string | null;
    readonly inboxSortOrder?: SidebarInboxSortOrder;
    readonly workingShelfEnabled?: boolean;
    readonly onEnvironmentChange: (environmentId: EnvironmentId | null) => void;
    readonly onProjectChange: (projectKey: string | null) => void;
    readonly onInboxSortOrderChange?: (sortOrder: SidebarInboxSortOrder) => void;
    readonly onStartMultiSelect?: () => void;
  },
  resolve: MessageResolver = m,
): AppBarMenuItem[] {
  const items: AppBarMenuItem[] = [
    {
      id: "environment",
      title: resolve(msg("Environment", { $context: "filter menu heading" })),
      items: [
        {
          id: "environment:all",
          title: resolve(msg("All environments")),
          subtitle: resolve(msg("Show threads from every environment")),
          selected: props.selectedEnvironmentId === null,
          onPress: () => props.onEnvironmentChange(null),
        },
        ...props.environments.map((environment) => ({
          id: `environment:${environment.environmentId}`,
          title: environment.label,
          selected: props.selectedEnvironmentId === environment.environmentId,
          onPress: () => props.onEnvironmentChange(environment.environmentId),
        })),
      ],
    },
  ];

  if (props.projects.length > 0) {
    items.push({
      id: "project",
      title: resolve(msg("Project", { $context: "filter menu heading" })),
      items: [
        {
          id: "project:all",
          title: resolve(msg("All projects")),
          subtitle: resolve(msg("Show threads from every project")),
          selected: props.selectedProjectKey === null,
          onPress: () => props.onProjectChange(null),
        },
        ...props.projects.map((project) => ({
          id: `project:${project.key}`,
          title: project.label,
          selected: props.selectedProjectKey === project.key,
          onPress: () => props.onProjectChange(project.key),
        })),
      ],
    });
  }

  if (props.onInboxSortOrderChange) {
    const sortOrder = props.inboxSortOrder ?? "recent";
    const workingShelfEnabled = props.workingShelfEnabled !== false;
    const onSortChange = props.onInboxSortOrderChange;
    items.push({
      id: "sort",
      title: resolve(msg("Sort", { $context: "noun, sort order menu" })),
      items: [
        {
          id: "sort:recent",
          title: workingShelfEnabled ? resolve(msg("Recently done")) : resolve(msg("Manual order")),
          subtitle: workingShelfEnabled
            ? resolve(msg("Most recently finished first"))
            : resolve(msg("Your custom thread order")),
          selected: sortOrder === "recent",
          onPress: () => onSortChange("recent"),
        },
        {
          id: "sort:longest_waiting",
          title: resolve(msg("Longest waiting")),
          subtitle: resolve(msg("Longest waiting for you first")),
          selected: sortOrder === "longest_waiting",
          onPress: () => onSortChange("longest_waiting"),
        },
      ],
    });
  }

  if (props.onStartMultiSelect) {
    const onStartMultiSelect = props.onStartMultiSelect;
    items.push({
      id: "select-threads",
      title: resolve(msg("Select threads")),
      icon: "checkmark.circle",
      onPress: onStartMultiSelect,
    });
  }

  return items;
}

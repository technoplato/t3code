import type { EnvironmentId } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

import type { ThreadFeedActivity } from "../../lib/threadActivity";

type Children = { children?: ReactNode };

vi.mock("react-native", () => ({
  View: ({ children }: Children) => <div>{children}</div>,
  Pressable: (props: Children & { accessibilityRole?: string; onPress?: () => void }) => (
    <div data-role={props.accessibilityRole} onClick={props.onPress}>
      {props.children}
    </div>
  ),
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => undefined }));
vi.mock("@react-navigation/native", () => ({
  StackActions: { push: () => ({}) },
  useNavigation: () => ({ dispatch: () => {} }),
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: Children) => <span>{children}</span>,
}));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ProviderIcon", () => ({
  ProviderIcon: () => null,
  ProviderInstanceIcon: () => null,
}));
vi.mock("../../state/server", () => ({ serverEnvironment: { configValueAtom: () => ({}) } }));
vi.mock("../../state/threads", () => ({ environmentThreadDetails: { threadAtom: () => ({}) } }));
vi.mock("../../state/entities", () => ({ useServerConfigs: () => new Map() }));
vi.mock("../../state/linkedThread", () => ({
  useLinkedThreadReach: () => ({ ownConnection: null, isLinked: () => false }),
}));
vi.mock("./SubagentRow", () => ({
  SubagentRow: (props: { subagent: { title: string } }) => <p>{props.subagent.title}</p>,
}));
vi.mock("./use-visible-second-clock", () => ({ useVisibleSecondClock: () => 0 }));
vi.mock("./threadAgentsPresentation", () => ({ subagentThreadTarget: () => null }));
vi.mock("./work-log-layout", () => ({
  WorkLogBlock: ({ children }: Children) => <section>{children}</section>,
}));
vi.mock("./thread-inspector-navigation", () => ({ useOpenThreadInspector: () => () => false }));
vi.mock("./useOpenLinkedThread", () => ({ useOpenLinkedThreadRead: () => () => {} }));

import { ThreadSubagentGroup } from "./thread-subagent-group";

const agent = (id: string, title: string) =>
  ({
    id,
    projectedItem: {
      item: {
        type: "subagent",
        id,
        threadId: "thread-1",
        subagentId: id,
        title,
        status: "completed",
        startedAt: null,
        completedAt: null,
      },
    },
  }) as unknown as ThreadFeedActivity;

it("a subagent group the setting opened shows its agents and closes on the first tap", () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  using _root = { [Symbol.dispose]: () => act(() => root.unmount()) };
  const onToggleRow = vi.fn();
  const group = (expandedRows: Record<string, boolean>, expandToolCallsByDefault: boolean) => (
    <ThreadSubagentGroup
      activities={[agent("agent-1", "Review the diff"), agent("agent-2", "Run the tests")]}
      environmentId={"env-1" as EnvironmentId}
      anchorKey="group-1"
      expandedRows={expandedRows}
      expandToolCallsByDefault={expandToolCallsByDefault}
      iconSubtleColor="#000"
      onToggleRow={onToggleRow}
    />
  );

  act(() => root.render(group({}, false)));
  expect(container.textContent).not.toContain("Review the diff");

  act(() => root.render(group({}, true)));
  expect(container.textContent).toContain("Review the diff");
  act(() => container.querySelector<HTMLElement>('[data-role="button"]')!.click());
  // The feed flips the state it is told; without it, a group opened by the setting would reopen.
  expect(onToggleRow).toHaveBeenCalledWith("group-1", "group-1", undefined, true);

  act(() => root.render(group({ "group-1": false }, true)));
  expect(container.textContent).not.toContain("Review the diff");
});

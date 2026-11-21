import {
  DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type DesktopAppControlCommand,
  type DesktopAppControlRequest,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  handleDesktopAppControlRequest,
  scoreThreadMatch,
  type DesktopAppControlDependencies,
  type DesktopControlSettingsSnapshot,
} from "./desktopAppControl";

const ENV_ID = EnvironmentId.make("env-local");
const PROJ_SCRIBE = ProjectId.make("proj-scribe");
const PROJ_T3 = ProjectId.make("proj-t3");
const THREAD_A = ThreadId.make("thread-a");
const THREAD_B = ThreadId.make("thread-b");
const THREAD_C = ThreadId.make("thread-c");

function makeProject(id: ProjectId, title: string): EnvironmentProject {
  return {
    environmentId: ENV_ID,
    id,
    title,
    workspaceRoot: `/tmp/${title.toLowerCase()}`,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-11-20T10:00:00.000Z",
    updatedAt: "2026-11-20T10:00:00.000Z",
    archivedAt: null,
  } as unknown as EnvironmentProject;
}

function makeThread(
  overrides: Partial<EnvironmentThreadShell> & {
    readonly id: ThreadId;
    readonly projectId: ProjectId;
    readonly title: string;
  },
): EnvironmentThreadShell {
  return {
    environmentId: ENV_ID,
    id: overrides.id,
    projectId: overrides.projectId,
    title: overrides.title,
    providerInstanceId: ProviderInstanceId.make("antigravity"),
    modelSelection: { provider: "antigravity", model: "gemini-4-neon" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: overrides.branch ?? null,
    worktreePath: null,
    lineage: {
      relationshipToParent: "root",
      parentThreadId: null,
      parentRunId: null,
      rootThreadId: overrides.id,
      depth: 0,
      sideChat: false,
    },
    forkedFrom: null,
    linkOrigin: null,
    delegatedFrom: null,
    activeProviderThreadId: null,
    latestRun: overrides.latestRun ?? null,
    runtime: overrides.runtime ?? null,
    latestUserMessageAt: overrides.updatedAt ?? "2026-11-21T10:00:00.000Z",
    hasPendingApprovals: overrides.hasPendingApprovals ?? false,
    hasPendingUserInput: overrides.hasPendingUserInput ?? false,
    hasActionableProposedPlan: false,
    pendingBackgroundTasks: [],
    providerInstanceHistory: [],
    goal: null,
    itemCount: 4,
    visibleItemCount: 4,
    createdAt: "2026-11-21T09:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-11-21T10:00:00.000Z",
    archivedAt: null,
    settledOverride: overrides.settledOverride ?? null,
    settledAt: overrides.settledAt ?? null,
    unsettledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: overrides.pinnedAt ?? null,
  } as unknown as EnvironmentThreadShell;
}

function makeRequest(
  command: DesktopAppControlCommand,
  args?: Record<string, unknown>,
  focusWindow?: boolean,
): DesktopAppControlRequest {
  return {
    version: DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION,
    requestId: `req-${command}`,
    type: "control",
    command,
    ...(args === undefined ? {} : { args }),
    ...(focusWindow === undefined ? {} : { focusWindow }),
  };
}

function makeDeps(initial?: {
  pathname?: string;
  activeThreadRef?: ScopedThreadRef | null;
  settings?: Partial<DesktopControlSettingsSnapshot>;
}) {
  let pathname = initial?.pathname ?? `/${ENV_ID}/${THREAD_A}`;
  let activeRef: ScopedThreadRef | null =
    initial?.activeThreadRef !== undefined
      ? initial.activeThreadRef
      : { environmentId: ENV_ID, threadId: THREAD_A };
  let settings: DesktopControlSettingsSnapshot = {
    expandThinkingByDefault: false,
    expandToolCallsByDefault: false,
    workLogScrollHeight: "default",
    ...initial?.settings,
  };

  const navigateToRoute = vi.fn(async (to: string) => {
    pathname = to;
  });
  const navigateToThread = vi.fn(async (ref: ScopedThreadRef) => {
    activeRef = ref;
    pathname = `/${ref.environmentId}/${ref.threadId}`;
  });
  const goBack = vi.fn();
  const goForward = vi.fn();
  const navigateMessage = vi.fn(() => true);
  const scrollTimeline = vi.fn(() => true);
  const sendMessage = vi.fn(async () => true);
  const interrupt = vi.fn(async () => true);
  const toggleRightPanel = vi.fn(() => true);
  const toggleTerminal = vi.fn(() => true);
  const toggleSidebar = vi.fn();
  const updateSettings = vi.fn(async (patch: Partial<DesktopControlSettingsSnapshot>) => {
    settings = { ...settings, ...patch };
  });

  const threads = [
    makeThread({
      id: THREAD_A,
      projectId: PROJ_SCRIBE,
      title: "Show Linked Gemini Quota",
      pinnedAt: "2026-11-21T09:30:00.000Z",
      updatedAt: "2026-11-21T10:30:00.000Z",
    }),
    makeThread({
      id: THREAD_B,
      projectId: PROJ_T3,
      title: "Voice Navigation Bridge",
      branch: "custom",
      runtime: {
        status: "running",
        activeRunId: null,
        providerInstanceId: ProviderInstanceId.make("antigravity"),
        providerName: "Antigravity",
        lastError: null,
        updatedAt: "2026-11-21T10:45:00.000Z",
      },
      updatedAt: "2026-11-21T10:45:00.000Z",
    }),
    makeThread({
      id: THREAD_C,
      projectId: PROJ_SCRIBE,
      title: "Older Settled Cleanup",
      settledAt: "2026-11-20T18:00:00.000Z",
      updatedAt: "2026-11-20T18:00:00.000Z",
    }),
  ];
  const projects = [makeProject(PROJ_SCRIBE, "Scribe"), makeProject(PROJ_T3, "t3code")];

  const deps: DesktopAppControlDependencies = {
    getPathname: () => pathname,
    navigateToRoute,
    navigateToThread,
    goBack,
    goForward,
    readThreads: () => threads,
    readProjects: () => projects,
    readLatestAssistantMessage: () => ({
      itemId: "item-1",
      text: "The control bridge is ready.",
    }),
    getSettings: () => settings,
    updateSettings,
    getChatControl: () => ({
      getActiveThreadRef: () => activeRef,
      navigateMessage,
      scrollTimeline,
      sendMessage,
      interrupt,
      toggleRightPanel,
      toggleTerminal,
    }),
    getSidebarControl: () => ({ toggleSidebar }),
  };

  return {
    deps,
    mocks: {
      navigateToRoute,
      navigateToThread,
      goBack,
      goForward,
      navigateMessage,
      scrollTimeline,
      sendMessage,
      interrupt,
      toggleRightPanel,
      toggleTerminal,
      toggleSidebar,
      updateSettings,
    },
    getSettings: () => settings,
  };
}

describe("handleDesktopAppControlRequest", () => {
  it("reports active thread status and counts", async () => {
    const { deps } = makeDeps();
    const response = await handleDesktopAppControlRequest(makeRequest("status"), deps);
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.summary).toContain("Show Linked Gemini Quota");
    expect(response.data).toMatchObject({
      counts: {
        total: 3,
        active: 2,
        working: 1,
        waiting: 0,
        pinned: 1,
        settled: 1,
      },
    });
  });

  it("opens threads by fuzzy query and prefers active over settled matches", async () => {
    const { deps, mocks } = makeDeps();
    const response = await handleDesktopAppControlRequest(
      makeRequest("open-thread", { query: "voice bridge" }),
      deps,
    );
    expect(response.ok).toBe(true);
    expect(mocks.navigateToThread).toHaveBeenCalledWith({
      environmentId: ENV_ID,
      threadId: THREAD_B,
    });
  });

  it("cycles to next and previous active threads", async () => {
    const { deps, mocks } = makeDeps();
    const nextRes = await handleDesktopAppControlRequest(
      makeRequest("open-thread", { direction: "next" }),
      deps,
    );
    expect(nextRes.ok).toBe(true);
    expect(mocks.navigateToThread).toHaveBeenLastCalledWith({
      environmentId: ENV_ID,
      threadId: THREAD_B,
    });

    const prevRes = await handleDesktopAppControlRequest(
      makeRequest("open-thread", { direction: "previous" }),
      deps,
    );
    expect(prevRes.ok).toBe(true);
    expect(mocks.navigateToThread).toHaveBeenLastCalledWith({
      environmentId: ENV_ID,
      threadId: THREAD_A,
    });
  });

  it("navigates messages and scrolls the timeline", async () => {
    const { deps, mocks } = makeDeps();
    const navRes = await handleDesktopAppControlRequest(
      makeRequest("navigate-message", { direction: "prev", count: 2 }),
      deps,
    );
    expect(navRes.ok).toBe(true);
    expect(mocks.navigateMessage).toHaveBeenCalledWith("previous", 2);

    const scrollRes = await handleDesktopAppControlRequest(
      makeRequest("scroll", { direction: "down", amount: 0.5 }),
      deps,
    );
    expect(scrollRes.ok).toBe(true);
    expect(mocks.scrollTimeline).toHaveBeenCalledWith("down", 0.5);
  });

  it("toggles thinking, tools, and cycles scroll height", async () => {
    const { deps, getSettings } = makeDeps();

    await handleDesktopAppControlRequest(makeRequest("set-thinking", { mode: "toggle" }), deps);
    expect(getSettings().expandThinkingByDefault).toBe(true);

    await handleDesktopAppControlRequest(makeRequest("set-tools", { mode: "on" }), deps);
    expect(getSettings().expandToolCallsByDefault).toBe(true);

    await handleDesktopAppControlRequest(
      makeRequest("set-scroll-height", { value: "cycle" }),
      deps,
    );
    expect(getSettings().workLogScrollHeight).toBe("tall");

    await handleDesktopAppControlRequest(
      makeRequest("set-scroll-height", { value: "cycle" }),
      deps,
    );
    expect(getSettings().workLogScrollHeight).toBe("full");
  });

  it("opens built-in routes, toggles panels, reads latest reply, and sends/stops", async () => {
    const { deps, mocks } = makeDeps();

    const usageRes = await handleDesktopAppControlRequest(
      makeRequest("open-route", { route: "quota" }),
      deps,
    );
    expect(usageRes.ok).toBe(true);
    expect(mocks.navigateToRoute).toHaveBeenCalledWith("/usage");

    await handleDesktopAppControlRequest(makeRequest("open-route", { route: "back" }), deps);
    expect(mocks.goBack).toHaveBeenCalled();

    await handleDesktopAppControlRequest(makeRequest("toggle-panel", { panel: "sidebar" }), deps);
    expect(mocks.toggleSidebar).toHaveBeenCalled();

    await handleDesktopAppControlRequest(makeRequest("toggle-panel", { panel: "right" }), deps);
    expect(mocks.toggleRightPanel).toHaveBeenCalled();

    const latestRes = await handleDesktopAppControlRequest(makeRequest("read-latest"), deps);
    expect(latestRes.ok).toBe(true);
    if (latestRes.ok) {
      expect(latestRes.data).toMatchObject({ text: "The control bridge is ready." });
    }

    const sendRes = await handleDesktopAppControlRequest(
      makeRequest("send-message", { text: "Check tests" }),
      deps,
    );
    expect(sendRes.ok).toBe(true);
    expect(mocks.sendMessage).toHaveBeenCalledWith("Check tests", "auto");

    const stopRes = await handleDesktopAppControlRequest(makeRequest("stop-thread"), deps);
    expect(stopRes.ok).toBe(true);
    expect(mocks.interrupt).toHaveBeenCalled();
  });

  it("scores exact and active thread titles above settled matches", () => {
    const active = {
      environmentId: ENV_ID,
      threadId: THREAD_A,
      title: "Quota Check",
      projectTitle: "Scribe",
      branch: null,
      status: "working" as const,
      pinned: false,
      settled: false,
      working: true,
      waiting: false,
      updatedAt: "2026-11-21T10:00:00.000Z",
    };
    const settled = {
      ...active,
      threadId: THREAD_C,
      status: "settled" as const,
      settled: true,
      working: false,
    };
    expect(scoreThreadMatch(active, "quota")).toBeGreaterThan(scoreThreadMatch(settled, "quota"));
    expect(scoreThreadMatch(active, "unrelated xyz")).toBe(0);
  });
});

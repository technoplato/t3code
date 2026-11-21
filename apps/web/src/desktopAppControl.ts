/* oxlint-disable t3code/no-untranslated-copy -- local desktop control socket protocol summaries returned to CLI/automation callers */
import {
  DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION,
  isListedThreadLineage,
  type DesktopAppActivationErrorCode,
  type DesktopAppActivationFailure,
  type DesktopAppControlCommand,
  type DesktopAppControlRequest,
  type DesktopAppControlSuccess,
  type EnvironmentId,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import type { WorkLogScrollHeight } from "@t3tools/contracts/settings";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";

import type {
  DesktopChatControlHandle,
  DesktopMessageNavigationDirection,
  DesktopSidebarControlHandle,
  DesktopTimelineScrollDirection,
} from "./lib/desktopControlBridge";

export type DesktopThreadFilter = "all" | "active" | "working" | "waiting" | "pinned" | "settled";

export interface DesktopControlThreadSummary {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly title: string;
  readonly projectTitle: string | null;
  readonly branch: string | null;
  readonly status: "working" | "waiting" | "idle" | "settled";
  readonly pinned: boolean;
  readonly settled: boolean;
  readonly working: boolean;
  readonly waiting: boolean;
  readonly updatedAt: string;
}

export interface DesktopControlSettingsSnapshot {
  readonly expandThinkingByDefault: boolean;
  readonly expandToolCallsByDefault: boolean;
  readonly workLogScrollHeight: WorkLogScrollHeight;
}

export interface DesktopAppControlDependencies {
  readonly getPathname: () => string;
  readonly navigateToRoute: (to: string) => Promise<void>;
  readonly navigateToThread: (ref: ScopedThreadRef) => Promise<void>;
  readonly goBack: () => void;
  readonly goForward: () => void;
  readonly readThreads: () => ReadonlyArray<EnvironmentThreadShell>;
  readonly readProjects: () => ReadonlyArray<EnvironmentProject>;
  readonly readLatestAssistantMessage: (ref: ScopedThreadRef) => {
    readonly text: string;
    readonly itemId: string;
  } | null;
  readonly getSettings: () => DesktopControlSettingsSnapshot;
  readonly updateSettings: (patch: Partial<DesktopControlSettingsSnapshot>) => Promise<void>;
  readonly getChatControl: () => DesktopChatControlHandle | null;
  readonly getSidebarControl: () => DesktopSidebarControlHandle | null;
}

const ROUTE_TARGETS: Readonly<Record<string, { readonly path: string; readonly label: string }>> = {
  usage: { path: "/usage", label: "Usage & Quota" },
  quota: { path: "/usage", label: "Usage & Quota" },
  settings: { path: "/settings/general", label: "Settings" },
  "settings-general": { path: "/settings/general", label: "General Settings" },
  "settings-chat": { path: "/settings/chat", label: "Chat Settings" },
  "chat-settings": { path: "/settings/chat", label: "Chat Settings" },
  "settings-providers": { path: "/settings/providers", label: "Provider Settings" },
  providers: { path: "/settings/providers", label: "Provider Settings" },
  "settings-keybindings": { path: "/settings/keybindings", label: "Keybindings Settings" },
  keybindings: { path: "/settings/keybindings", label: "Keybindings Settings" },
  "settings-appearance": { path: "/settings/appearance", label: "Appearance Settings" },
  appearance: { path: "/settings/appearance", label: "Appearance Settings" },
  "pull-requests": { path: "/pull-requests", label: "Pull Requests" },
  prs: { path: "/pull-requests", label: "Pull Requests" },
  issues: { path: "/issues", label: "Issues" },
  new: { path: "/new", label: "New Thread" },
  home: { path: "/", label: "Home" },
};

const SCROLL_HEIGHT_ORDER: ReadonlyArray<WorkLogScrollHeight> = ["default", "tall", "full"];

function isWorkLogScrollHeight(value: string): value is WorkLogScrollHeight {
  return value === "default" || value === "tall" || value === "full";
}

function ok(
  request: DesktopAppControlRequest,
  summary: string,
  data?: unknown,
): DesktopAppControlSuccess {
  return {
    version: DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION,
    requestId: request.requestId,
    ok: true,
    command: request.command,
    summary,
    ...(data === undefined ? {} : { data }),
  };
}

function fail(
  request: DesktopAppControlRequest,
  code: DesktopAppActivationErrorCode,
  message: string,
): DesktopAppActivationFailure {
  return {
    version: DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION,
    requestId: request.requestId,
    ok: false,
    code,
    message,
  };
}

function argString(
  args: Readonly<Record<string, unknown>> | undefined,
  key: string,
): string | null {
  const value = args?.[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function argNumber(
  args: Readonly<Record<string, unknown>> | undefined,
  key: string,
): number | null {
  const value = args?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function argBoolean(
  args: Readonly<Record<string, unknown>> | undefined,
  key: string,
): boolean | null {
  const value = args?.[key];
  return typeof value === "boolean" ? value : null;
}

function isShellSettled(thread: EnvironmentThreadShell): boolean {
  if (thread.settledOverride === "active") return false;
  if (thread.settledOverride === "settled") return true;
  return thread.settledAt !== null;
}

function isActiveRunStatus(status: string | null | undefined): boolean {
  return (
    status === "preparing" || status === "starting" || status === "running" || status === "queued"
  );
}

function isShellWorking(thread: EnvironmentThreadShell): boolean {
  return isActiveRunStatus(thread.runtime?.status) || isActiveRunStatus(thread.latestRun?.status);
}

function latestThreadTimestamp(thread: EnvironmentThreadShell): string {
  const candidates = [
    thread.latestUserMessageAt,
    thread.latestRun?.requestedAt,
    thread.latestRun?.startedAt,
    thread.latestRun?.completedAt,
    thread.updatedAt,
  ];
  let best = thread.updatedAt;
  let bestMs = Date.parse(best);
  if (!Number.isFinite(bestMs)) bestMs = Number.NEGATIVE_INFINITY;
  for (const candidate of candidates) {
    if (!candidate) continue;
    const ms = Date.parse(candidate);
    if (Number.isFinite(ms) && ms > bestMs) {
      bestMs = ms;
      best = candidate;
    }
  }
  return best;
}

function isShellWaiting(thread: EnvironmentThreadShell): boolean {
  return (
    thread.hasPendingApprovals ||
    thread.hasPendingUserInput ||
    thread.hasActionableProposedPlan ||
    thread.pendingBackgroundTasks.length > 0
  );
}

function buildThreadSummaries(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  projects: ReadonlyArray<EnvironmentProject>,
  includeSubagents: boolean,
): DesktopControlThreadSummary[] {
  const projectByKey = new Map<string, string>();
  for (const project of projects) {
    projectByKey.set(`${project.environmentId}:${project.id}`, project.title);
  }

  const listed = threads.filter((thread) => {
    if (thread.archivedAt !== null) return false;
    if (!includeSubagents && !isListedThreadLineage(thread.lineage)) return false;
    return true;
  });

  const sorted = [...listed].sort((left, right) => {
    const leftSettled = isShellSettled(left);
    const rightSettled = isShellSettled(right);
    if (leftSettled !== rightSettled) return leftSettled ? 1 : -1;

    const leftPinned = left.pinnedAt !== null;
    const rightPinned = right.pinnedAt !== null;
    if (leftPinned !== rightPinned) return leftPinned ? -1 : 1;

    const leftActive = isShellWorking(left) || isShellWaiting(left);
    const rightActive = isShellWorking(right) || isShellWaiting(right);
    if (leftActive !== rightActive) return leftActive ? -1 : 1;

    const leftTs = latestThreadTimestamp(left);
    const rightTs = latestThreadTimestamp(right);
    return Date.parse(rightTs) - Date.parse(leftTs);
  });

  return sorted.map((thread) => {
    const settled = isShellSettled(thread);
    const working = isShellWorking(thread);
    const waiting = isShellWaiting(thread);
    const status = settled ? "settled" : waiting ? "waiting" : working ? "working" : "idle";
    return {
      environmentId: thread.environmentId,
      threadId: thread.id,
      title: thread.title.trim() || "Untitled thread",
      projectTitle: projectByKey.get(`${thread.environmentId}:${thread.projectId}`) ?? null,
      branch: thread.branch,
      status,
      pinned: thread.pinnedAt !== null,
      settled,
      working,
      waiting,
      updatedAt: latestThreadTimestamp(thread),
    };
  });
}

function filterThreads(
  threads: ReadonlyArray<DesktopControlThreadSummary>,
  filter: DesktopThreadFilter,
): DesktopControlThreadSummary[] {
  switch (filter) {
    case "all":
      return [...threads];
    case "active":
      return threads.filter((thread) => !thread.settled);
    case "working":
      return threads.filter((thread) => thread.working);
    case "waiting":
      return threads.filter((thread) => thread.waiting);
    case "pinned":
      return threads.filter((thread) => thread.pinned);
    case "settled":
      return threads.filter((thread) => thread.settled);
  }
}

function normalizeQuery(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function scoreThreadMatch(thread: DesktopControlThreadSummary, rawQuery: string): number {
  const query = normalizeQuery(rawQuery);
  if (query.length === 0) return 0;

  if (thread.threadId.toLowerCase() === rawQuery.trim().toLowerCase()) return 1000;
  if (thread.threadId.toLowerCase().startsWith(rawQuery.trim().toLowerCase())) return 900;

  const title = normalizeQuery(thread.title);
  const project = normalizeQuery(thread.projectTitle ?? "");
  const branch = normalizeQuery(thread.branch ?? "");
  const combined = `${title} ${project} ${branch}`.trim();

  let score = 0;
  if (title === query) score += 500;
  else if (title.startsWith(query)) score += 360;
  else if (title.includes(query)) score += 260;

  if (project.length > 0) {
    if (project === query) score += 320;
    else if (project.startsWith(query)) score += 220;
    else if (project.includes(query)) score += 160;
  }

  if (branch.length > 0 && branch.includes(query)) {
    score += 120;
  }

  const tokens = query.split(/\s+/).filter((token) => token.length > 0);
  if (tokens.length > 0) {
    let matchedTokens = 0;
    const words = combined.split(/\s+/);
    for (const token of tokens) {
      if (words.some((word) => word === token)) {
        matchedTokens += 1;
        score += 75;
      } else if (words.some((word) => word.startsWith(token))) {
        matchedTokens += 1;
        score += 50;
      } else if (combined.includes(token)) {
        matchedTokens += 1;
        score += 30;
      }
    }
    if (matchedTokens === 0) return 0;
    if (matchedTokens === tokens.length) score += 100;
    else if (score < 160 && matchedTokens / tokens.length < 0.5) return 0;
  }

  if (score === 0) return 0;
  // Prefer active/working/pinned threads when titles are similar.
  if (!thread.settled) score += 40;
  if (thread.working || thread.waiting) score += 20;
  if (thread.pinned) score += 15;
  return score;
}

function parseThreadFilter(
  value: string | null,
  fallback: DesktopThreadFilter,
): DesktopThreadFilter {
  if (
    value === "all" ||
    value === "active" ||
    value === "working" ||
    value === "waiting" ||
    value === "pinned" ||
    value === "settled"
  ) {
    return value;
  }
  return fallback;
}

function parseActiveThreadFromPathname(pathname: string): ScopedThreadRef | null {
  const parts = pathname.replace(/\/$/, "").split("/");
  if (parts.length !== 3 || parts[0] !== "") return null;
  if (parts[1] === "settings" || parts[1] === "draft" || parts[1] === "projects") return null;
  try {
    return {
      environmentId: decodeURIComponent(parts[1]!) as EnvironmentId,
      threadId: decodeURIComponent(parts[2]!) as ThreadId,
    };
  } catch {
    return null;
  }
}

function resolveActiveThreadRef(
  dependencies: DesktopAppControlDependencies,
): ScopedThreadRef | null {
  return (
    dependencies.getChatControl()?.getActiveThreadRef() ??
    parseActiveThreadFromPathname(dependencies.getPathname())
  );
}

function buildStatusPayload(dependencies: DesktopAppControlDependencies) {
  const pathname = dependencies.getPathname();
  const summaries = buildThreadSummaries(
    dependencies.readThreads(),
    dependencies.readProjects(),
    false,
  );
  const activeRef = resolveActiveThreadRef(dependencies);
  const activeThread =
    activeRef === null
      ? null
      : (summaries.find(
          (thread) =>
            thread.environmentId === activeRef.environmentId &&
            thread.threadId === activeRef.threadId,
        ) ?? null);
  const settings = dependencies.getSettings();
  const counts = {
    total: summaries.length,
    active: summaries.filter((thread) => !thread.settled).length,
    working: summaries.filter((thread) => thread.working).length,
    waiting: summaries.filter((thread) => thread.waiting).length,
    pinned: summaries.filter((thread) => thread.pinned).length,
    settled: summaries.filter((thread) => thread.settled).length,
  };
  return {
    pathname,
    activeThread,
    activeThreadRef: activeRef,
    settings,
    counts,
  };
}

export async function handleDesktopAppControlRequest(
  request: DesktopAppControlRequest,
  dependencies: DesktopAppControlDependencies,
): Promise<DesktopAppControlSuccess | DesktopAppActivationFailure> {
  const args = request.args;
  const command: DesktopAppControlCommand = request.command;

  try {
    switch (command) {
      case "focus": {
        const status = buildStatusPayload(dependencies);
        const label = status.activeThread
          ? `Focused T3 Code (${status.activeThread.title})`
          : "Focused T3 Code";
        return ok(request, label, status);
      }

      case "status": {
        const status = buildStatusPayload(dependencies);
        const summary = status.activeThread
          ? `${status.activeThread.title} (${status.activeThread.status}) · ${status.counts.working} working, ${status.counts.waiting} waiting`
          : `${status.pathname} · ${status.counts.working} working, ${status.counts.waiting} waiting`;
        return ok(request, summary, status);
      }

      case "list-threads": {
        const filter = parseThreadFilter(argString(args, "filter"), "active");
        const query = argString(args, "query");
        const includeSubagents = argBoolean(args, "includeSubagents") === true;
        const limit = Math.max(1, Math.min(100, Math.floor(argNumber(args, "limit") ?? 25)));
        const all = buildThreadSummaries(
          dependencies.readThreads(),
          dependencies.readProjects(),
          includeSubagents,
        );
        let filtered = filterThreads(all, filter);
        if (query !== null) {
          filtered = filtered
            .map((thread) => ({ thread, score: scoreThreadMatch(thread, query) }))
            .filter((entry) => entry.score > 0)
            .sort((left, right) => right.score - left.score)
            .map((entry) => entry.thread);
        }
        const threads = filtered.slice(0, limit);
        const activeRef = resolveActiveThreadRef(dependencies);
        return ok(
          request,
          `Found ${threads.length} ${filter} thread${threads.length === 1 ? "" : "s"}`,
          {
            filter,
            query,
            activeThreadRef: activeRef,
            threads,
          },
        );
      }

      case "open-thread": {
        const threadId = argString(args, "threadId");
        const environmentId = argString(args, "environmentId");
        const direction = argString(args, "direction");
        const query = argString(args, "query");
        const indexArg = argNumber(args, "index");
        const scope = parseThreadFilter(argString(args, "scope"), "active");
        const all = buildThreadSummaries(
          dependencies.readThreads(),
          dependencies.readProjects(),
          true,
        );
        const topLevel = buildThreadSummaries(
          dependencies.readThreads(),
          dependencies.readProjects(),
          false,
        );

        let chosen: DesktopControlThreadSummary | null = null;
        if (threadId !== null) {
          chosen =
            all.find(
              (thread) =>
                thread.threadId === threadId &&
                (environmentId === null || thread.environmentId === environmentId),
            ) ?? null;
          if (chosen === null && environmentId !== null) {
            const directRef: ScopedThreadRef = {
              environmentId: environmentId as EnvironmentId,
              threadId: threadId as ThreadId,
            };
            await dependencies.navigateToThread(directRef);
            return ok(request, `Opened thread ${threadId}`, { threadRef: directRef });
          }
        } else if (direction === "next" || direction === "previous" || direction === "prev") {
          const pool = filterThreads(topLevel, scope);
          const candidates = pool.length > 0 ? pool : topLevel;
          if (candidates.length === 0) {
            return fail(request, "not-found", "No threads are available to open.");
          }
          const activeRef = resolveActiveThreadRef(dependencies);
          const currentIndex =
            activeRef === null
              ? -1
              : candidates.findIndex(
                  (thread) =>
                    thread.environmentId === activeRef.environmentId &&
                    thread.threadId === activeRef.threadId,
                );
          const delta = direction === "next" ? 1 : -1;
          const nextIndex =
            currentIndex === -1
              ? direction === "next"
                ? 0
                : candidates.length - 1
              : (currentIndex + delta + candidates.length) % candidates.length;
          chosen = candidates[nextIndex] ?? null;
        } else if (indexArg !== null) {
          const pool = filterThreads(topLevel, scope);
          const oneBased = Math.floor(indexArg);
          if (oneBased < 1 || oneBased > pool.length) {
            return fail(
              request,
              "not-found",
              `Thread #${oneBased} is out of range (1..${pool.length}).`,
            );
          }
          chosen = pool[oneBased - 1] ?? null;
        } else if (query !== null) {
          const ranked = topLevel
            .map((thread) => ({ thread, score: scoreThreadMatch(thread, query) }))
            .filter((entry) => entry.score > 0)
            .sort((left, right) => right.score - left.score);
          chosen = ranked[0]?.thread ?? null;
          if (chosen === null) {
            return fail(request, "not-found", `No thread matched "${query}".`);
          }
        } else {
          return fail(
            request,
            "invalid-request",
            "open-thread requires threadId, query, direction (next|previous), or index.",
          );
        }

        if (chosen === null) {
          return fail(request, "not-found", "Could not find a matching thread.");
        }

        await dependencies.navigateToThread({
          environmentId: chosen.environmentId,
          threadId: chosen.threadId,
        });
        return ok(request, `Opened thread “${chosen.title}”`, { thread: chosen });
      }

      case "navigate-message": {
        const rawDirection = argString(args, "direction") ?? "previous";
        const direction: DesktopMessageNavigationDirection | null =
          rawDirection === "prev" || rawDirection === "previous" || rawDirection === "up"
            ? "previous"
            : rawDirection === "next" || rawDirection === "down"
              ? "next"
              : rawDirection === "top" || rawDirection === "first"
                ? "top"
                : rawDirection === "bottom" || rawDirection === "latest" || rawDirection === "last"
                  ? "bottom"
                  : null;
        if (direction === null) {
          return fail(
            request,
            "invalid-request",
            `Unknown message direction "${rawDirection}". Expected previous, next, top, or bottom.`,
          );
        }
        const chat = dependencies.getChatControl();
        if (chat === null) {
          return fail(request, "command-failed", "No chat thread is currently open.");
        }
        const count = Math.max(1, Math.min(20, Math.floor(argNumber(args, "count") ?? 1)));
        const handled = chat.navigateMessage(direction, count);
        if (!handled) {
          return fail(request, "command-failed", "Could not navigate messages in this thread.");
        }
        const label =
          direction === "previous"
            ? count > 1
              ? `Previous ${count} messages`
              : "Previous message"
            : direction === "next"
              ? count > 1
                ? `Next ${count} messages`
                : "Next message"
              : direction === "top"
                ? "Top of thread"
                : "Bottom of thread";
        return ok(request, label, { direction, count });
      }

      case "scroll": {
        const rawDirection = argString(args, "direction") ?? "down";
        const direction: DesktopTimelineScrollDirection | null =
          rawDirection === "up" ||
          rawDirection === "down" ||
          rawDirection === "top" ||
          rawDirection === "bottom"
            ? rawDirection
            : null;
        if (direction === null) {
          return fail(
            request,
            "invalid-request",
            `Unknown scroll direction "${rawDirection}". Expected up, down, top, or bottom.`,
          );
        }
        const chat = dependencies.getChatControl();
        if (chat === null) {
          return fail(request, "command-failed", "No chat thread is currently open.");
        }
        const amount = argNumber(args, "amount") ?? 0.75;
        const clampedAmount = Math.max(0.15, Math.min(3, amount));
        const handled = chat.scrollTimeline(direction, clampedAmount);
        if (!handled) {
          return fail(request, "command-failed", "Could not scroll the current thread.");
        }
        const label =
          direction === "up"
            ? "Scrolled up"
            : direction === "down"
              ? "Scrolled down"
              : direction === "top"
                ? "Scrolled to top"
                : "Scrolled to bottom";
        return ok(request, label, { direction, amount: clampedAmount });
      }

      case "set-thinking": {
        const mode = argString(args, "mode") ?? "toggle";
        const current = dependencies.getSettings().expandThinkingByDefault;
        const next =
          mode === "on" || mode === "true" || mode === "expand"
            ? true
            : mode === "off" || mode === "false" || mode === "collapse"
              ? false
              : mode === "toggle"
                ? !current
                : null;
        if (next === null) {
          return fail(
            request,
            "invalid-request",
            `Unknown set-thinking mode "${mode}". Expected on, off, or toggle.`,
          );
        }
        await dependencies.updateSettings({ expandThinkingByDefault: next });
        return ok(
          request,
          next ? "Thinking expanded by default" : "Thinking collapsed by default",
          {
            expandThinkingByDefault: next,
          },
        );
      }

      case "set-tools": {
        const mode = argString(args, "mode") ?? "toggle";
        const current = dependencies.getSettings().expandToolCallsByDefault;
        const next =
          mode === "on" || mode === "true" || mode === "expand"
            ? true
            : mode === "off" || mode === "false" || mode === "collapse"
              ? false
              : mode === "toggle"
                ? !current
                : null;
        if (next === null) {
          return fail(
            request,
            "invalid-request",
            `Unknown set-tools mode "${mode}". Expected on, off, or toggle.`,
          );
        }
        await dependencies.updateSettings({ expandToolCallsByDefault: next });
        return ok(
          request,
          next ? "Tool calls expanded by default" : "Tool calls collapsed by default",
          { expandToolCallsByDefault: next },
        );
      }

      case "set-scroll-height": {
        const rawValue = argString(args, "value") ?? "cycle";
        const current = dependencies.getSettings().workLogScrollHeight;
        let next: WorkLogScrollHeight | null = null;
        if (rawValue === "cycle") {
          const idx = SCROLL_HEIGHT_ORDER.indexOf(current);
          next = SCROLL_HEIGHT_ORDER[(idx + 1) % SCROLL_HEIGHT_ORDER.length] ?? "default";
        } else if (rawValue === "compact" || rawValue === "normal") {
          next = "default";
        } else if (isWorkLogScrollHeight(rawValue)) {
          next = rawValue;
        }
        if (next === null) {
          return fail(
            request,
            "invalid-request",
            `Unknown scroll height "${rawValue}". Expected default, tall, full, or cycle.`,
          );
        }
        await dependencies.updateSettings({ workLogScrollHeight: next });
        const label =
          next === "full"
            ? "Activity height: Full (no scroll box)"
            : next === "tall"
              ? "Activity height: Tall"
              : "Activity height: Default";
        return ok(request, label, { workLogScrollHeight: next });
      }

      case "open-route": {
        const route = (argString(args, "route") ?? "").toLowerCase();
        if (route === "back") {
          dependencies.goBack();
          return ok(request, "Navigated back", { route: "back" });
        }
        if (route === "forward") {
          dependencies.goForward();
          return ok(request, "Navigated forward", { route: "forward" });
        }
        const target = ROUTE_TARGETS[route];
        if (!target) {
          return fail(
            request,
            "invalid-request",
            `Unknown route "${route}". Supported: ${Object.keys(ROUTE_TARGETS).join(", ")}, back, forward.`,
          );
        }
        await dependencies.navigateToRoute(target.path);
        return ok(request, `Opened ${target.label}`, { route, path: target.path });
      }

      case "toggle-panel": {
        const panel = (argString(args, "panel") ?? "sidebar").toLowerCase();
        if (panel === "sidebar") {
          const sidebar = dependencies.getSidebarControl();
          if (sidebar === null) {
            return fail(
              request,
              "command-failed",
              "Sidebar control is not available on this view.",
            );
          }
          sidebar.toggleSidebar();
          return ok(request, "Toggled sidebar", { panel: "sidebar" });
        }
        const chat = dependencies.getChatControl();
        if (chat === null) {
          return fail(request, "command-failed", "No chat thread is currently open.");
        }
        if (
          panel === "right" ||
          panel === "inspector" ||
          panel === "diffs" ||
          panel === "preview"
        ) {
          chat.toggleRightPanel();
          return ok(request, "Toggled right panel", { panel: "right" });
        }
        if (panel === "terminal") {
          chat.toggleTerminal();
          return ok(request, "Toggled terminal", { panel: "terminal" });
        }
        return fail(
          request,
          "invalid-request",
          `Unknown panel "${panel}". Expected sidebar, right, or terminal.`,
        );
      }

      case "read-latest": {
        const activeRef = resolveActiveThreadRef(dependencies);
        const threadId = argString(args, "threadId");
        const environmentId = argString(args, "environmentId");
        let targetRef = activeRef;
        if (threadId !== null) {
          const match = dependencies
            .readThreads()
            .find(
              (thread) =>
                thread.id === threadId &&
                (environmentId === null || thread.environmentId === environmentId),
            );
          targetRef = match
            ? { environmentId: match.environmentId, threadId: match.id }
            : environmentId !== null
              ? { environmentId: environmentId as EnvironmentId, threadId: threadId as ThreadId }
              : null;
        }
        if (targetRef === null) {
          return fail(request, "not-found", "No active thread to read.");
        }
        const latest = dependencies.readLatestAssistantMessage(targetRef);
        if (latest === null) {
          return fail(request, "not-found", "No assistant message found in this thread.");
        }
        const maxChars = Math.max(
          80,
          Math.min(32_000, Math.floor(argNumber(args, "maxChars") ?? 4_000)),
        );
        const truncated = latest.text.length > maxChars;
        const text = truncated ? `${latest.text.slice(0, maxChars)}…` : latest.text;
        return ok(request, `Read latest assistant reply (${latest.text.length} chars)`, {
          threadRef: targetRef,
          itemId: latest.itemId,
          text,
          truncated,
          totalChars: latest.text.length,
        });
      }

      case "send-message": {
        const text = argString(args, "text");
        if (text === null) {
          return fail(
            request,
            "invalid-request",
            "send-message requires a non-empty text argument.",
          );
        }
        const chat = dependencies.getChatControl();
        if (chat === null) {
          return fail(request, "command-failed", "No chat thread is currently open.");
        }
        const rawMode = argString(args, "mode");
        const mode = rawMode === "steer" ? "steer" : "auto";
        const sent = await chat.sendMessage(text, mode);
        if (!sent) {
          return fail(request, "command-failed", "Could not send message to the active thread.");
        }
        const preview = text.length > 60 ? `${text.slice(0, 59)}…` : text;
        return ok(request, `Sent message: “${preview}”`, { mode, chars: text.length });
      }

      case "stop-thread": {
        const chat = dependencies.getChatControl();
        if (chat === null) {
          return fail(request, "command-failed", "No chat thread is currently open.");
        }
        const stopped = await chat.interrupt();
        if (!stopped) {
          return fail(request, "command-failed", "No running turn to stop in this thread.");
        }
        return ok(request, "Stopped running turn", { stopped: true });
      }
    }
  } catch (error) {
    const message =
      error instanceof Error && error.message.trim().length > 0
        ? error.message
        : `T3 Code could not execute desktop control command "${command}".`;
    return fail(request, "internal-error", message);
  }
}

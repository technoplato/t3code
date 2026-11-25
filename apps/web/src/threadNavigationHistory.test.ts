import { threadKey } from "@t3tools/client-runtime/state/entities";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  resolveThreadHistoryRows,
  THREAD_NAVIGATION_HISTORY_LIMIT,
  withoutThreadVisit,
  withThreadVisit,
  type ThreadVisit,
  type ThreadVisitDetails,
} from "./threadNavigationHistory";

const LOCAL = EnvironmentId.make("local");
const REMOTE = EnvironmentId.make("remote");

function details(
  threadId: string,
  overrides: Partial<ThreadVisitDetails> = {},
): ThreadVisitDetails {
  return {
    environmentId: LOCAL,
    threadId: ThreadId.make(threadId),
    projectId: ProjectId.make("project"),
    title: threadId,
    ...overrides,
  };
}

function visits(...threadIds: ReadonlyArray<string>): ReadonlyArray<ThreadVisit> {
  return threadIds.map((threadId, index) => ({
    ...details(threadId),
    visitedAt: 100 - index,
  }));
}

const ids = (history: ReadonlyArray<ThreadVisitDetails>) =>
  history.map((entry) => `${entry.environmentId}:${entry.threadId}`);

describe("thread navigation history", () => {
  it("moves a revisited thread to the top and keeps one entry per environment and thread", () => {
    const revisited = withThreadVisit(visits("a", "b", "c"), details("c"), 200);
    expect(ids(revisited)).toEqual(["local:c", "local:a", "local:b"]);
    expect(revisited[0]?.visitedAt).toBe(200);

    // The same thread id on another environment is another thread.
    const elsewhere = withThreadVisit(revisited, details("c", { environmentId: REMOTE }), 300);
    expect(ids(elsewhere)).toEqual(["remote:c", "local:c", "local:a", "local:b"]);
  });

  it("drops the oldest visit past the limit", () => {
    const full = visits(
      ...Array.from({ length: THREAD_NAVIGATION_HISTORY_LIMIT }, (_, index) => `t${index}`),
    );
    const next = withThreadVisit(full, details("new"), 200);
    expect(next).toHaveLength(THREAD_NAVIGATION_HISTORY_LIMIT);
    expect(next[0]?.threadId).toBe("new");
    expect(ids(next)).not.toContain(`local:t${THREAD_NAVIGATION_HISTORY_LIMIT - 1}`);
  });

  it("refreshes the title and project of the thread on top without counting a new visit", () => {
    const history = withThreadVisit(visits("a"), details("b", { title: "New thread" }), 200);
    const titled = withThreadVisit(
      history,
      details("b", { title: "Fix the login bug", projectId: ProjectId.make("moved") }),
      999,
    );
    expect(titled).toEqual([
      { ...details("b"), title: "Fix the login bug", projectId: "moved", visitedAt: 200 },
      history[1],
    ]);
  });

  it("removes only the named thread", () => {
    const history = [
      ...visits("a", "b"),
      { ...details("a", { environmentId: REMOTE }), visitedAt: 1 },
    ];
    expect(ids(withoutThreadVisit(history, details("a")))).toEqual(["local:b", "remote:a"]);
  });
});

describe("thread history rows", () => {
  const at = "2026-01-01T00:00:00.000Z";
  const shell = (
    threadId: string,
    overrides: { title?: string; archivedAt?: string; deletedAt?: string } = {},
  ) => ({
    environmentId: LOCAL,
    id: ThreadId.make(threadId),
    projectId: ProjectId.make("live-project"),
    title: overrides.title ?? threadId,
    archivedAt: overrides.archivedAt ?? null,
    deletedAt: overrides.deletedAt ?? null,
  });
  const history = visits("open", "live", "settled", "archived", "deleted", "tagged");
  const base = {
    history,
    shells: [
      shell("open"),
      shell("live", { title: "Live title" }),
      shell("archived", { archivedAt: at }),
      shell("deleted", { deletedAt: at }),
      shell("tagged"),
    ],
    hiddenThreadKeys: new Set([threadKey(details("tagged"))]),
    hidingAnywhere: false,
    currentThread: { environmentId: LOCAL, threadId: ThreadId.make("open") },
  };

  it("shows live titles, keeps threads the shell leaves out, and drops the rest", () => {
    expect(
      resolveThreadHistoryRows(base).map((row) => [row.threadId, row.title, row.projectId]),
    ).toEqual([
      ["live", "Live title", "live-project"],
      // Never pruned for being unlisted: it shows what was stored at the visit.
      ["settled", "settled", "project"],
    ]);
  });

  it("leaves unlisted threads out while an environment hides tagged threads", () => {
    expect(
      resolveThreadHistoryRows({ ...base, hidingAnywhere: true }).map((row) => row.threadId),
    ).toEqual(["live"]);
  });
});

import { threadKey } from "@t3tools/client-runtime/state/entities";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useEffect, useState } from "react";

import { writeLocalStorageValue } from "./hooks/useLocalStorage";

export const THREAD_NAVIGATION_HISTORY_STORAGE_KEY = "t3code:thread-history:v1";
export const THREAD_NAVIGATION_HISTORY_LIMIT = 30;
// Long enough that a route passing over a thread on its way elsewhere is not a visit.
const THREAD_VISIT_DWELL_MS = 400;

const ThreadVisit = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
  // Kept with the title so a thread the shell no longer lists still has a row to show.
  projectId: ProjectId,
  title: Schema.String,
  visitedAt: Schema.Number,
});
export type ThreadVisit = typeof ThreadVisit.Type;
export type ThreadVisitDetails = Omit<ThreadVisit, "visitedAt">;

export const ThreadNavigationHistory = Schema.Array(ThreadVisit);
export const EMPTY_THREAD_NAVIGATION_HISTORY: ReadonlyArray<ThreadVisit> = Object.freeze([]);

function isSameThread(left: ScopedThreadRef, right: ScopedThreadRef): boolean {
  return left.environmentId === right.environmentId && left.threadId === right.threadId;
}

/** Moves the thread to the top, most recent first. */
export function withThreadVisit(
  history: ReadonlyArray<ThreadVisit>,
  visit: ThreadVisitDetails,
  visitedAt: number,
): ReadonlyArray<ThreadVisit> {
  const head = history[0];
  // A thread already on top is being re-read, such as for a new title, not visited again.
  const entry = {
    environmentId: visit.environmentId,
    threadId: visit.threadId,
    projectId: visit.projectId,
    title: visit.title,
    visitedAt: head !== undefined && isSameThread(head, visit) ? head.visitedAt : visitedAt,
  };
  return [entry, ...history.filter((other) => !isSameThread(other, visit))].slice(
    0,
    THREAD_NAVIGATION_HISTORY_LIMIT,
  );
}

export function withoutThreadVisit(
  history: ReadonlyArray<ThreadVisit>,
  ref: ScopedThreadRef,
): ReadonlyArray<ThreadVisit> {
  return history.filter((entry) => !isSameThread(entry, ref));
}

function recordThreadVisit(visit: ThreadVisitDetails): void {
  writeLocalStorageValue(
    THREAD_NAVIGATION_HISTORY_STORAGE_KEY,
    (history) => withThreadVisit(history, visit, Date.now()),
    EMPTY_THREAD_NAVIGATION_HISTORY,
    ThreadNavigationHistory,
  );
}

/**
 * Only for a thread known to be gone. A thread the shell merely stops listing (settled, or its
 * environment offline) keeps its entry.
 */
export function removeThreadVisit(ref: ScopedThreadRef): void {
  writeLocalStorageValue(
    THREAD_NAVIGATION_HISTORY_STORAGE_KEY,
    (history) => withoutThreadVisit(history, ref),
    EMPTY_THREAD_NAVIGATION_HISTORY,
    ThreadNavigationHistory,
  );
}

/**
 * Records `visit` once the route has stayed on it, and again when its title or project changes.
 * `shown` is false while the thread sits behind Settings or Usage, or has no view yet.
 */
export function useRecordThreadVisit(visit: ThreadVisitDetails | null, shown: boolean): void {
  const key = visit === null ? null : threadKey(visit);
  // Sticks once the thread shows, so opening Settings over it does not cancel the wait.
  const [arrivedKey, setArrivedKey] = useState<string | null>(null);
  const nextArrivedKey = key !== null && (shown || arrivedKey === key) ? key : null;
  if (nextArrivedKey !== arrivedKey) setArrivedKey(nextArrivedKey);

  const environmentId = visit?.environmentId;
  const threadId = visit?.threadId;
  const projectId = visit?.projectId;
  const title = visit?.title;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- writes the visit to localStorage after the dwell; leaving the thread first cancels it
  useEffect(() => {
    if (
      arrivedKey === null ||
      environmentId === undefined ||
      threadId === undefined ||
      projectId === undefined ||
      title === undefined
    ) {
      return;
    }
    const timer = setTimeout(
      () => recordThreadVisit({ environmentId, threadId, projectId, title }),
      THREAD_VISIT_DWELL_MS,
    );
    return () => clearTimeout(timer);
  }, [arrivedKey, environmentId, threadId, projectId, title]);
}

/**
 * The history rows to show, most recent first. A listed thread shows its live title; one the
 * shell leaves out (an older settled thread) shows the title it had when visited.
 */
export function resolveThreadHistoryRows(input: {
  history: ReadonlyArray<ThreadVisit>;
  shells: ReadonlyArray<
    Pick<
      EnvironmentThreadShell,
      "environmentId" | "id" | "projectId" | "title" | "archivedAt" | "deletedAt"
    >
  >;
  hiddenThreadKeys: ReadonlySet<string>;
  hidingAnywhere: boolean;
  currentThread: ScopedThreadRef | null;
}): ReadonlyArray<ThreadVisitDetails> {
  const shellByKey = new Map(
    input.shells.map((shell) => [
      threadKey({ environmentId: shell.environmentId, threadId: shell.id }),
      shell,
    ]),
  );
  return input.history.flatMap((entry) => {
    if (input.currentThread !== null && isSameThread(entry, input.currentThread)) return [];
    const key = threadKey(entry);
    if (input.hiddenThreadKeys.has(key)) return [];
    const shell = shellByKey.get(key);
    // An unlisted thread's tags are unknown, so while any environment hides threads it stays out.
    if (shell === undefined) return input.hidingAnywhere ? [] : [entry];
    if (shell.deletedAt !== null || shell.archivedAt !== null) return [];
    return [{ ...entry, projectId: shell.projectId, title: shell.title }];
  });
}

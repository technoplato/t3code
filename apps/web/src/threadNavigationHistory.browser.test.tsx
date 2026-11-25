import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { fakeTimers, render } from "../test/render";
import {
  THREAD_NAVIGATION_HISTORY_STORAGE_KEY,
  useRecordThreadVisit,
  type ThreadVisit,
  type ThreadVisitDetails,
} from "./threadNavigationHistory";

function Recorder(props: { visit: ThreadVisitDetails | null; shown: boolean }) {
  useRecordThreadVisit(props.visit, props.shown);
  return null;
}

function visit(threadId: string, title = threadId): ThreadVisitDetails {
  return {
    environmentId: EnvironmentId.make("environment-one"),
    threadId: ThreadId.make(threadId),
    projectId: ProjectId.make("project-one"),
    title,
  };
}

function stored(): ReadonlyArray<ThreadVisit> {
  return JSON.parse(localStorage.getItem(THREAD_NAVIGATION_HISTORY_STORAGE_KEY) ?? "[]");
}

it("records a thread once the route has stayed on it, also when Settings opens over it", async () => {
  localStorage.removeItem(THREAD_NAVIGATION_HISTORY_STORAGE_KEY);
  using _history = {
    [Symbol.dispose]: () => localStorage.removeItem(THREAD_NAVIGATION_HISTORY_STORAGE_KEY),
  };
  // Before the render: the first render starts the wait.
  using _timers = fakeTimers();
  // No router: the route arrives as props.
  await using screen = await render(<Recorder visit={visit("passed")} shown />, { router: false });

  // The route leaves before the wait ends, as when stepping back through history.
  vi.advanceTimersByTime(399);
  await screen.rerender(<Recorder visit={visit("stayed", "New thread")} shown />);
  vi.advanceTimersByTime(399);
  expect(stored()).toEqual([]);
  vi.advanceTimersByTime(1);
  expect(stored().map((entry) => entry.threadId)).toEqual(["stayed"]);

  // Settings opening over a thread during its wait still counts the visit.
  await screen.rerender(<Recorder visit={visit("behind")} shown />);
  vi.advanceTimersByTime(100);
  await screen.rerender(<Recorder visit={visit("behind")} shown={false} />);
  vi.advanceTimersByTime(300);
  expect(stored().map((entry) => entry.threadId)).toEqual(["behind", "stayed"]);

  // A thread first seen behind Settings is no visit until it shows.
  await screen.rerender(<Recorder visit={visit("unseen")} shown={false} />);
  vi.advanceTimersByTime(400);
  expect(stored().map((entry) => entry.threadId)).toEqual(["behind", "stayed"]);

  // A generated title replaces the stored one without counting another visit.
  await screen.rerender(<Recorder visit={visit("stayed", "New thread")} shown />);
  vi.advanceTimersByTime(400);
  const [revisited] = stored();
  await screen.rerender(<Recorder visit={visit("stayed", "Fix the login bug")} shown />);
  vi.advanceTimersByTime(400);
  expect(stored()[0]).toEqual({ ...revisited, title: "Fix the login bug" });
});

import {
  EnvironmentId,
  MessageId,
  ProjectId,
  ThreadId,
  type AssistantCitation,
} from "@t3tools/contracts";
import { useLocation, type AnyRouter } from "@tanstack/react-router";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import {
  assistantCitationFromLocation,
  assistantCitationNavigation,
} from "../../lib/assistantCitationNavigation";
import {
  THREAD_NAVIGATION_HISTORY_STORAGE_KEY,
  useRecordThreadVisit,
  type ThreadVisit,
} from "../../threadNavigationHistory";
import {
  isAppModalPage,
  startMainAppLocationTracking,
  useCloseAppModal,
  useNavigateToMainApp,
} from "./mainAppLocation";

const THREAD_PATH = "/environment-one/thread-one";

const citation: AssistantCitation = {
  version: 1,
  environmentId: EnvironmentId.make("environment-one"),
  threadId: ThreadId.make("thread-one"),
  messageId: MessageId.make("assistant-one"),
  text: "quoted reply",
  start: 0,
  end: 12,
  prefix: "",
  suffix: "",
};

function ReturnControls() {
  const closeAppModal = useCloseAppModal();
  const navigateToMainApp = useNavigateToMainApp();
  return (
    <>
      <button type="button" onClick={() => void closeAppModal()}>
        Close modal
      </button>
      <button type="button" onClick={() => void navigateToMainApp()}>
        Back to app
      </button>
    </>
  );
}

// Records the route's thread as the thread view does; the test router has no thread params.
function VisitRecorder() {
  const pathname = useLocation({ select: (location) => location.pathname });
  const [environmentId, threadId] = pathname.split("/").slice(1);
  useRecordThreadVisit(
    environmentId && threadId && !isAppModalPage(pathname)
      ? {
          environmentId: EnvironmentId.make(environmentId),
          threadId: ThreadId.make(threadId),
          projectId: ProjectId.make("project-one"),
          title: threadId,
        }
      : null,
    true,
  );
  return null;
}

function storedVisits(): ReadonlyArray<ThreadVisit> {
  return JSON.parse(localStorage.getItem(THREAD_NAVIGATION_HISTORY_STORAGE_KEY) ?? "[]");
}

// The tracker records on onResolved, which the router emits only once React commits the page.
async function settled(router: AnyRouter, navigation: Promise<void>) {
  await navigation;
  await vi.waitFor(() =>
    expect(router.state.resolvedLocation?.href).toBe(router.state.location.href),
  );
}

describe("main app return location", () => {
  it("closes Usage without leaving the current document when the app started with history", async () => {
    await using screen = await render(<ReturnControls />, { router: "/" });
    const router = screen.router!;
    await settled(router, router.navigate({ href: THREAD_PATH }));
    using _tracking = { [Symbol.dispose]: startMainAppLocationTracking(router) };
    using go = vi.spyOn(router.history, "go");

    await settled(router, router.navigate({ href: "/usage" }));
    await userEvent.click(screen.getByRole("button", { name: "Close modal" }));
    await vi.waitFor(() => expect(router.state.location.pathname).toBe(THREAD_PATH));
    expect(go).not.toHaveBeenCalled();
  });

  it("returns to the thread without re-opening the quote source it was opened at", async () => {
    await using screen = await render(<ReturnControls />, { router: THREAD_PATH });
    const router = screen.router!;
    using _tracking = { [Symbol.dispose]: startMainAppLocationTracking(router) };

    const returnLocation = async (from: string, control: string) => {
      await settled(router, router.navigate(assistantCitationNavigation(citation, null)));
      expect(assistantCitationFromLocation(router.state.location.href)).toEqual(citation);
      await settled(router, router.navigate({ href: from }));
      await userEvent.click(screen.getByRole("button", { name: control }));
      await vi.waitFor(() => expect(router.state.location.pathname).toBe(THREAD_PATH));
      return router.state.location.href;
    };

    const closingUsage = await returnLocation("/usage", "Close modal");
    const sidebarBack = await returnLocation("/pull-requests", "Back to app");

    expect({ closingUsage, sidebarBack }).toEqual({
      closingUsage: THREAD_PATH,
      sidebarBack: THREAD_PATH,
    });
  });

  it("leaves no stop on Settings for history back after it closes", async () => {
    const otherThreadPath = "/environment-one/thread-two";
    await using screen = await render(<ReturnControls />, { router: THREAD_PATH });
    const router = screen.router!;
    using _tracking = { [Symbol.dispose]: startMainAppLocationTracking(router) };

    await settled(router, router.navigate({ href: otherThreadPath }));
    await settled(router, router.navigate({ href: "/settings/general" }));
    await userEvent.click(screen.getByRole("button", { name: "Close modal" }));
    await vi.waitFor(() => expect(router.state.location.pathname).toBe(otherThreadPath));

    router.history.forward();
    await vi.waitFor(() => expect(router.state.location.pathname).toBe(otherThreadPath));
    router.history.back();
    await vi.waitFor(() => expect(router.state.location.pathname).toBe(THREAD_PATH));
    router.history.forward();
    await vi.waitFor(() => expect(router.state.location.pathname).toBe(otherThreadPath));
    router.history.forward();
    await vi.waitFor(() => expect(router.state.location.pathname).toBe(otherThreadPath));
  });

  it("does not count the thread that closing Settings steps back over as a visit", async () => {
    const threadTwoPath = "/environment-one/thread-two";
    const visitedThreads = () => storedVisits().map((visit) => visit.threadId);
    localStorage.removeItem(THREAD_NAVIGATION_HISTORY_STORAGE_KEY);
    using _history = {
      [Symbol.dispose]: () => localStorage.removeItem(THREAD_NAVIGATION_HISTORY_STORAGE_KEY),
    };
    await using screen = await render(
      <>
        <VisitRecorder />
        <ReturnControls />
      </>,
      { router: THREAD_PATH },
    );
    const router = screen.router!;
    using _tracking = { [Symbol.dispose]: startMainAppLocationTracking(router) };
    await vi.waitFor(() => expect(visitedThreads()).toEqual(["thread-one"]));
    await settled(router, router.navigate({ href: threadTwoPath }));
    await vi.waitFor(() => expect(visitedThreads()).toEqual(["thread-two", "thread-one"]));
    const beforeSettings = storedVisits();

    await settled(router, router.navigate({ href: "/settings/general" }));
    using go = vi.spyOn(router.history, "go");
    await userEvent.click(screen.getByRole("button", { name: "Close modal" }));
    await vi.waitFor(() => expect(router.state.location.pathname).toBe(threadTwoPath));
    // Closing went back to thread one's entry on its way to thread two.
    expect(go).toHaveBeenCalledExactlyOnceWith(-2);

    // A visit that starts later is recorded later, so by then thread one's would have been too.
    await settled(router, router.navigate({ href: "/environment-one/thread-three" }));
    await vi.waitFor(() => expect(visitedThreads()[0]).toBe("thread-three"));
    expect(storedVisits().slice(1)).toEqual(beforeSettings);
  });
});

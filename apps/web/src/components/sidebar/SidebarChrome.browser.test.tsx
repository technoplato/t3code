import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { useQuietThreadShells } from "../../state/entities";
import { makeThreadFixture } from "../../test-fixtures";
import {
  THREAD_NAVIGATION_HISTORY_STORAGE_KEY,
  type ThreadVisit,
} from "../../threadNavigationHistory";
import { SidebarProvider } from "../ui/sidebar";
import { SidebarBrandWidthProbe, SidebarChromeHeader } from "./SidebarChrome";

vi.mock("../../state/entities", { spy: true });

const ENVIRONMENT_ID = EnvironmentId.make("environment-one");

function visit(threadId: string, title: string, visitedAt: number): ThreadVisit {
  return {
    environmentId: ENVIRONMENT_ID,
    threadId: ThreadId.make(threadId),
    projectId: ProjectId.make("project-one"),
    title,
    visitedAt,
  };
}

// The header shows its buttons from the md breakpoint up; the test page is phone-sized.
async function setup() {
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  await page.viewport(1280, 800);
  // The live thread was still untitled when visited; the settled one is no longer in the shell.
  localStorage.setItem(
    THREAD_NAVIGATION_HISTORY_STORAGE_KEY,
    JSON.stringify([
      visit("thread-live", "New thread", 2),
      visit("thread-settled", "Settled thread", 1),
    ]),
  );
  vi.mocked(useQuietThreadShells).mockReturnValue([
    makeThreadFixture({
      environmentId: ENVIRONMENT_ID,
      id: ThreadId.make("thread-live"),
      title: "Live thread",
    }),
  ]);
  return {
    async [Symbol.asyncDispose]() {
      localStorage.removeItem(THREAD_NAVIGATION_HISTORY_STORAGE_KEY);
      vi.mocked(useQuietThreadShells).mockReset();
      await page.viewport(viewport.width, viewport.height);
    },
  };
}

const header = (isElectron: boolean) => (
  <SidebarProvider>
    <SidebarChromeHeader isElectron={isElectron} />
  </SidebarProvider>
);

const historyButton = () => page.getByRole("button", { name: "History", exact: true });
const rowTitles = () =>
  page
    .getByRole("menuitem")
    .elements()
    .map((row) => row.textContent);

describe("sidebar header thread history", () => {
  it("follows back and forward on desktop, stands alone on the web, and has its width reserved", async () => {
    await using _fixture = await setup();
    const widths = {
      desktop: vi.fn<(width: number) => void>(),
      web: vi.fn<(width: number) => void>(),
    };
    await using screen = await render(
      <SidebarProvider>
        <div data-testid="desktop">
          <SidebarChromeHeader isElectron />
        </div>
        <div data-testid="web">
          <SidebarChromeHeader isElectron={false} />
        </div>
        <SidebarBrandWidthProbe isElectron onWidthChange={widths.desktop} />
        <SidebarBrandWidthProbe isElectron={false} onWidthChange={widths.web} />
      </SidebarProvider>,
    );
    const shownButtons = (testId: string) =>
      [...screen.getByTestId(testId).element().querySelectorAll("button")].filter(
        (button) => button.getClientRects().length > 0,
      );
    expect(shownButtons("desktop").map((button) => button.ariaLabel)).toEqual([
      "Go back",
      "Go forward",
      "History",
    ]);
    expect(shownButtons("web").map((button) => button.ariaLabel)).toEqual(["History"]);

    // The probe's own right padding and border; the header's content must fit inside the rest.
    const probeEdge = 13;
    const contentWidth = (testId: string) =>
      shownButtons(testId).at(-1)!.getBoundingClientRect().right -
      screen.getByTestId(testId).element().getBoundingClientRect().left;
    await vi.waitFor(() => {
      expect(widths.desktop.mock.lastCall?.[0]).toBeCloseTo(contentWidth("desktop") + probeEdge, 0);
      expect(widths.web.mock.lastCall?.[0]).toBeCloseTo(contentWidth("web") + probeEdge, 0);
    });
  });

  it("shows its tooltip until the menu opens, then goes to the clicked thread", async () => {
    await using _fixture = await setup();
    await using screen = await render(header(false));
    const tooltip = page.getByText("History", { exact: true });

    await userEvent.hover(historyButton());
    await expect.element(tooltip).toBeVisible();
    await userEvent.click(historyButton());
    await expect.element(page.getByRole("menu")).toBeVisible();
    await expect.element(tooltip).not.toBeInTheDocument();
    // The listed thread shows its live title; the unlisted one falls back to the stored title.
    expect(rowTitles()).toEqual(["Live thread", "Settled thread"]);

    await userEvent.click(page.getByRole("menuitem", { name: "Settled thread" }));
    await vi.waitFor(() =>
      expect(screen.router!.state.location.pathname).toBe("/environment-one/thread-settled"),
    );
    await expect.element(page.getByRole("menu")).not.toBeInTheDocument();
  });

  it("opens and picks a thread from the keyboard", async () => {
    await using _fixture = await setup();
    await using screen = await render(header(false));

    historyButton().element().focus();
    await userEvent.keyboard("{Enter}");
    await expect.element(page.getByRole("menuitem", { name: "Live thread" })).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}");
    await expect.element(page.getByRole("menuitem", { name: "Settled thread" })).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() =>
      expect(screen.router!.state.location.pathname).toBe("/environment-one/thread-settled"),
    );
  });
});

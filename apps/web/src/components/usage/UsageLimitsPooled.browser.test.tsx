import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { CHATGPT_USAGE_URL } from "@t3tools/shared/usageLimits";
import { describe, expect, it, vi } from "vite-plus/test";

import "../../index.css";

import { render } from "../../../test/render";
import { UsageLimitsPooled } from "./UsageLimitsPooled";

const checkedAt = "2026-10-25T16:00:00.000Z";

function managedChatGpt(instanceId: string, displayName: string): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make("codex"),
    displayName,
    enabled: true,
    installed: true,
    version: "0.164.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits: {
      checkedAt,
      windows: [],
      unavailable: { reason: "unsupported", message: "Track usage in ChatGPT." },
      externalUsage: { label: "ChatGPT usage", url: CHATGPT_USAGE_URL },
    },
  };
}

describe("UsageLimitsPooled ChatGPT usage card", () => {
  it("names the managed connections it covers", async () => {
    const presentations = new Map([
      [
        EnvironmentId.make("desk"),
        {
          entry: { target: { label: "Desk" } },
          serverConfig: {
            providers: [
              managedChatGpt("chatgpt_work", "ChatGPT Work"),
              managedChatGpt("chatgpt_personal", "ChatGPT Personal"),
            ],
          },
        },
      ],
    ]);
    await using screen = await render(
      <UsageLimitsPooled presentations={presentations} now={Date.parse(checkedAt)} />,
    );

    await expect
      .element(screen.getByText("ChatGPT Work on Desk, ChatGPT Personal on Desk"))
      .toBeVisible();
    await expect
      .element(screen.getByText("View usage in ChatGPT with your connected account."))
      .toBeVisible();
  });
});

function claude(instanceId: string, displayName: string, resetsAt: string): ServerProvider {
  return {
    ...managedChatGpt(instanceId, displayName),
    driver: ProviderDriverKind.make("claudeAgent"),
    usageLimits: {
      checkedAt,
      windows: [{ id: "five_hour", kind: "session", label: "Session", usedPercent: 20, resetsAt }],
    },
  };
}

describe("UsageLimitsPooled account order", () => {
  it("drags an account onto another to set the manual order", async () => {
    const presentations = new Map([
      [
        EnvironmentId.make("desk"),
        {
          entry: { target: { label: "Desk" } },
          serverConfig: {
            providers: [
              claude("claude_late", "Late", "2026-10-25T19:00:00.000Z"),
              claude("claude_soon", "Soon", "2026-10-25T17:00:00.000Z"),
            ],
          },
        },
      ],
    ]);
    const onAccountsViewChange = vi.fn();
    await using screen = await render(
      <UsageLimitsPooled
        presentations={presentations}
        now={Date.parse(checkedAt)}
        onAccountsViewChange={onAccountsViewChange}
      />,
    );

    const source = screen.getByRole("button", { name: /^Soon: / }).element() as HTMLElement;
    const target = screen.getByRole("button", { name: /^Late: / }).element() as HTMLElement;
    const from = source.getBoundingClientRect();
    const to = target.getBoundingClientRect();
    const mouse = (type: string, clientX: number) =>
      new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX,
        clientY: from.y + from.height / 2,
      });
    source.dispatchEvent(mouse("mousedown", from.x + from.width / 2));
    // The first move passes the activation distance; the drag only tracks moves after it.
    document.dispatchEvent(mouse("mousemove", from.x + from.width / 2 + 10));
    document.dispatchEvent(mouse("mousemove", to.x + to.width / 2));
    await vi.waitFor(() => expect(target.style.transform).toMatch(/translate3d\(-?[1-9]/));
    document.dispatchEvent(mouse("mouseup", to.x + to.width / 2));

    expect(onAccountsViewChange).toHaveBeenCalledWith({
      sort: "manual",
      hideEmptySessions: false,
      hideEmptyWeeks: false,
      order: ["desk:claude_late", "desk:claude_soon"],
    });
  });
});

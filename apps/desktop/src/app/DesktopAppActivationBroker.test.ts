import { ProjectId, ThreadId, type DesktopAppActivationRequest } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { DesktopAppActivationBroker } from "./DesktopAppActivationBroker.ts";

const request: DesktopAppActivationRequest = {
  version: 1,
  requestId: "request-1",
  type: "open-workspace",
  workspaceRoot: "/workspace/project",
  platform: "linux",
};

describe("DesktopAppActivationBroker", () => {
  it("focuses immediately and waits for renderer readiness", async () => {
    const activate = vi.fn();
    const send = vi.fn();
    const broker = new DesktopAppActivationBroker({ requestTimeoutMs: 1_000, activate });

    const response = broker.request(request);
    expect(activate).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();

    broker.registerRenderer(send);
    expect(send).toHaveBeenCalledWith(request);
    broker.complete({
      version: 1,
      requestId: request.requestId,
      ok: true,
      projectId: ProjectId.make("project-1"),
      threadId: ThreadId.make("thread-1"),
    });

    await expect(response).resolves.toMatchObject({ ok: true, projectId: "project-1" });
    broker.close();
  });

  it("fails an in-flight request when the renderer goes away", async () => {
    const broker = new DesktopAppActivationBroker({ requestTimeoutMs: 1_000, activate: vi.fn() });
    broker.registerRenderer(vi.fn());

    const response = broker.request(request);
    broker.clearRenderer();

    await expect(response).resolves.toMatchObject({
      ok: false,
      code: "renderer-unavailable",
    });
    broker.close();
  });

  it("never sends a canceled request that was queued behind another request", async () => {
    const send = vi.fn();
    const broker = new DesktopAppActivationBroker({ requestTimeoutMs: 1_000, activate: vi.fn() });
    broker.registerRenderer(send);
    const secondRequest = { ...request, requestId: "request-2" };

    const firstResponse = broker.request(request);
    const secondResponse = broker.request(secondRequest);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenLastCalledWith(request);

    broker.cancel(secondRequest.requestId);
    broker.complete({
      version: 1,
      requestId: request.requestId,
      ok: true,
      projectId: ProjectId.make("project-1"),
      threadId: ThreadId.make("thread-1"),
    });

    await expect(firstResponse).resolves.toMatchObject({ ok: true });
    await expect(secondResponse).resolves.toMatchObject({ ok: false });
    expect(send).toHaveBeenCalledTimes(1);
    broker.close();
  });

  it("only focuses the window for control requests when requested or when command is focus", async () => {
    const activate = vi.fn();
    const send = vi.fn();
    const broker = new DesktopAppActivationBroker({ requestTimeoutMs: 1_000, activate });
    broker.registerRenderer(send);

    const statusReq: DesktopAppActivationRequest = {
      version: 1,
      requestId: "control-status",
      type: "control",
      command: "status",
    };
    const statusRes = broker.request(statusReq);
    expect(activate).not.toHaveBeenCalled();
    broker.complete({
      version: 1,
      requestId: "control-status",
      ok: true,
      command: "status",
      summary: "ok",
    });
    await expect(statusRes).resolves.toMatchObject({ ok: true, command: "status" });

    const focusReq: DesktopAppActivationRequest = {
      version: 1,
      requestId: "control-focus",
      type: "control",
      command: "focus",
    };
    const focusRes = broker.request(focusReq);
    expect(activate).toHaveBeenCalledTimes(1);
    broker.complete({
      version: 1,
      requestId: "control-focus",
      ok: true,
      command: "focus",
      summary: "Focused",
    });
    await expect(focusRes).resolves.toMatchObject({ ok: true, command: "focus" });

    const navFocusReq: DesktopAppActivationRequest = {
      version: 1,
      requestId: "control-open",
      type: "control",
      command: "open-thread",
      args: { query: "test" },
      focusWindow: true,
    };
    const navFocusRes = broker.request(navFocusReq);
    expect(activate).toHaveBeenCalledTimes(2);
    broker.complete({
      version: 1,
      requestId: "control-open",
      ok: true,
      command: "open-thread",
      summary: "Opened",
    });
    await expect(navFocusRes).resolves.toMatchObject({ ok: true, command: "open-thread" });
    broker.close();
  });
});

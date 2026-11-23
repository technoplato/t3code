import { assert, describe, it } from "@effect/vitest";
import {
  AuthSessionId,
  type ClientView,
  EnvironmentId,
  type OrchestrationV2TurnItem,
  RpcClientId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  type ClientViewThreadData,
  describeTurnItem,
  describeViewClient,
  hydrateActiveClientView,
  MAX_PENDING_BLOCKER_LENGTH,
  MAX_VISIBLE_TEXT_LENGTH,
  sliceVisibleText,
} from "./clientViewHydration.ts";
import type { TrackedClientView } from "./clientViewRegistry.ts";

const NOW = DateTime.makeUnsafe("2026-05-13T00:00:00.000Z");

function turnItem(fields: object): OrchestrationV2TurnItem {
  return {
    id: "item-1",
    threadId: "thread-1",
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 0,
    status: "completed",
    title: null,
    startedAt: null,
    completedAt: null,
    updatedAt: NOW,
    ...fields,
  } as OrchestrationV2TurnItem;
}

function threadData(overrides: Partial<ClientViewThreadData> = {}): ClientViewThreadData {
  return {
    shell: {
      title: "Fix the flaky test",
      status: "running",
      providerInstanceId: "claude",
      modelSelection: { instanceId: "claude", model: "opus" },
      activityRunStartedAt: NOW,
      latestRunStartedAt: null,
      pendingRuntimeRequest: null,
    } as ClientViewThreadData["shell"],
    project: { title: "t3code", workspaceRoot: "/work/t3code" },
    messages: new Map(),
    turnItems: new Map(),
    pendingRequestItem: null,
    ...overrides,
  };
}

function tracked(view: Partial<ClientView> = {}): TrackedClientView {
  return {
    sessionId: AuthSessionId.make("session-1"),
    rpcClientId: RpcClientId.make(1),
    clientId: "client-1",
    clientKind: "desktop-renderer",
    view: {
      windowId: "window-1",
      seq: 7,
      focused: true,
      lastGestureAtMs: 1_000,
      environmentId: EnvironmentId.make("environment-1"),
      threadId: ThreadId.make("thread-1"),
      ...view,
    },
    rankedGestureAtMs: 1_000,
    updatedAtMs: 2_000,
    expiresAtMs: 47_000,
  };
}

const hydrate = (view: Partial<ClientView>, thread: ClientViewThreadData) =>
  hydrateActiveClientView({
    tracked: tracked(view),
    thread,
    client: describeViewClient({ tracked: tracked(view), session: null, hostName: "Mini" }),
    appBundleId: "com.example.app",
    capturedAtMs: 3_000,
  });

const paragraphs = Array.from(
  { length: 40 },
  (_, index) => `Paragraph ${index} explains one step of the fix in plain words.`,
);
const longReply = paragraphs.join("\n");

describe("sliceVisibleText", () => {
  it("returns the scrolled-to part of a long reply, cut at line ends", () => {
    const middle = sliceVisibleText(longReply, 0.5, 0.6);
    assert.isTrue(middle.startsWith("…Paragraph "));
    assert.isTrue(middle.endsWith("plain words.…"));
    const lines = middle.slice(1, -1).split("\n");
    for (const line of lines) assert.include(paragraphs, line);
    // A tenth of forty paragraphs, plus the lines the two cuts were widened to.
    assert.isAtLeast(lines.length, 4);
    assert.isAtMost(lines.length, 6);
    assert.include(lines, "Paragraph 20 explains one step of the fix in plain words.");
    assert.notInclude(middle, "Paragraph 0 ");
    assert.notInclude(middle, "Paragraph 39 ");
  });

  it("keeps the ends whole and marks only a cut edge", () => {
    assert.equal(sliceVisibleText(longReply, 0, 1), longReply);
    const top = sliceVisibleText(longReply, 0, 0.1);
    assert.isTrue(top.startsWith("Paragraph 0 "));
    assert.isTrue(top.endsWith("…"));
    const bottom = sliceVisibleText(longReply, 0.9, 1);
    assert.isTrue(bottom.startsWith("…"));
    assert.isTrue(bottom.endsWith("Paragraph 39 explains one step of the fix in plain words."));
  });

  it("falls back to word ends on one long line, and tolerates bad fractions", () => {
    const line = Array.from({ length: 400 }, (_, index) => `word${index}`).join(" ");
    const slice = sliceVisibleText(line, 0.4, 0.5).slice(1, -1);
    assert.isTrue(slice.split(" ").every((word) => /^word\d+$/u.test(word)));
    assert.equal(sliceVisibleText(line, 0.5, 0.5), "");
    assert.equal(sliceVisibleText(line, Number.NaN, 2), line);
    assert.equal(sliceVisibleText(line, -1, Number.POSITIVE_INFINITY), "");
    assert.equal(sliceVisibleText(line, 0.5, 0.4), sliceVisibleText(line, 0.4, 0.5));
  });
});

describe("describeTurnItem", () => {
  it("names a tool and never quotes what it read, ran or wrote", () => {
    const secret = "AWS_SECRET=hunter2";
    const lines = [
      turnItem({ type: "dynamic_tool", toolName: "Read", input: { path: secret }, output: secret }),
      turnItem({ type: "command_execution", input: `echo ${secret}`, output: secret }),
      turnItem({ type: "file_change", fileName: "a.env", diffStr: secret, newStr: secret }),
      turnItem({ type: "web_search", patterns: [secret] }),
      turnItem({ type: "dynamic_tool", toolName: null, input: secret }),
    ].map((item) => {
      const described = describeTurnItem(item);
      assert.equal(described.kind, "tool");
      return "line" in described ? described.line : null;
    });
    assert.deepStrictEqual(lines, [
      "[tool: Read]",
      "[tool: command]",
      "[tool: edit]",
      "[tool: web-search]",
      "[tool: tool]",
    ]);
  });
});

describe("describeViewClient", () => {
  const describeClient = (
    reported: Pick<TrackedClientView, "clientKind" | "identity">,
    session: Parameters<typeof describeViewClient>[0]["session"] = null,
    hostName: string | null = null,
  ) => describeViewClient({ tracked: { clientId: "client-1", ...reported }, session, hostName });

  it("tells a phone, a tablet, a desktop app and a browser apart", () => {
    const iphone = describeClient({
      clientKind: "mobile",
      identity: {
        formFactor: "phone",
        os: "iOS",
        osVersion: "26.1",
        deviceName: "iPhone",
        deviceModel: "iPhone 17 Pro",
        appName: "T3 Code",
        appVersion: "2.3.0",
        connection: "relay",
      },
    });
    assert.deepStrictEqual(iphone, {
      clientKind: "mobile",
      deviceName: "iPhone",
      client: {
        clientId: "client-1",
        formFactor: "phone",
        os: "iOS",
        osVersion: "26.1",
        deviceModel: "iPhone 17 Pro",
        browser: null,
        appName: "T3 Code",
        appVersion: "2.3.0",
        webDeployment: null,
        connection: "relay",
      },
    });

    const ipad = describeClient({
      clientKind: "mobile",
      identity: { formFactor: "tablet", os: "iPadOS", deviceName: "iPad" },
    });
    assert.equal(ipad.clientKind, iphone.clientKind);
    assert.deepStrictEqual(
      [ipad.client.formFactor, ipad.client.os, ipad.deviceName],
      ["tablet", "iPadOS", "iPad"],
    );

    const androidTablet = describeClient({
      clientKind: "mobile",
      identity: { formFactor: "tablet", os: "Android", deviceName: "Pixel Tablet" },
    });
    assert.deepStrictEqual(
      [androidTablet.client.formFactor, androidTablet.client.os, androidTablet.deviceName],
      ["tablet", "Android", "Pixel Tablet"],
    );

    // A desktop app names no device; on the server's own machine that is the host.
    const desktop = describeClient(
      {
        clientKind: "desktop-renderer",
        identity: { formFactor: "desktop", os: "macOS", appName: "T3 Code", connection: "local" },
      },
      { deviceType: "desktop", browser: "Chrome" },
      "mini.local",
    );
    assert.deepStrictEqual(
      [desktop.clientKind, desktop.deviceName, desktop.client.browser, desktop.client.connection],
      ["desktop", "mini.local", null, "local"],
    );

    const browser = describeClient({
      clientKind: "web",
      identity: {
        formFactor: "desktop",
        os: "macOS",
        browser: "Safari",
        webDeployment: "hosted",
        connection: "relay",
      },
    });
    assert.deepStrictEqual(
      [browser.clientKind, browser.deviceName, browser.client.webDeployment],
      ["web", "Safari on macOS", "hosted"],
    );
  });

  it("falls back to the sign-in's record for a client that sends no identity", () => {
    const older = describeClient(
      { clientKind: "mobile" },
      { label: "T3 Code Mobile", deviceType: "mobile", os: "iOS" },
    );
    assert.deepStrictEqual(
      [older.deviceName, older.client.formFactor, older.client.os, older.client.connection],
      ["T3 Code Mobile", "phone", "iOS", null],
    );
    const unknown = describeClient({ clientKind: "unknown" });
    assert.deepStrictEqual(
      [unknown.clientKind, unknown.deviceName, unknown.client.formFactor],
      ["web", null, null],
    );
  });
});

describe("hydrateActiveClientView", () => {
  it("takes prose from the server's records and lists tools by name", () => {
    const snapshot = hydrate(
      {
        items: [
          { id: "message-user", kind: "anything", from: 0, to: 1 },
          { id: "tool-1", from: 0, to: 1 },
          { id: "tool-2", from: 0, to: 1 },
          { id: "message-assistant", from: 0.5, to: 0.6 },
        ],
      },
      threadData({
        messages: new Map([
          ["message-user", { role: "user", text: "Why does it flake?", streaming: false }],
          ["message-assistant", { role: "assistant", text: longReply, streaming: true }],
        ]),
        turnItems: new Map([
          ["tool-1", turnItem({ type: "dynamic_tool", toolName: "Read", input: {} })],
          ["tool-2", turnItem({ type: "dynamic_tool", toolName: "Read", input: {} })],
        ]),
      }),
    );

    assert.equal(snapshot.threadUri, "t3-thread://v2/environment-1/thread-1");
    assert.deepStrictEqual(
      snapshot.visibleItems.map((item) => [item.id, item.kind]),
      [
        ["message-user", "user"],
        ["tool-1", "tool"],
        ["tool-2", "tool"],
        ["message-assistant", "assistant"],
      ],
    );
    const [question, tools, reply, ...rest] = snapshot.visibleText.split("\n\n");
    assert.equal(question, "Why does it flake?");
    assert.equal(tools, "[tool: Read]");
    assert.equal(reply, sliceVisibleText(longReply, 0.5, 0.6));
    assert.deepStrictEqual(rest, []);
    assert.isFalse(snapshot.truncated);
    assert.isTrue(snapshot.streaming);
    assert.equal(snapshot.focusedItemId, "message-assistant");
    assert.equal(snapshot.threadTitle, "Fix the flaky test");
    assert.equal(snapshot.projectTitle, "t3code");
    assert.equal(snapshot.workspaceRoot, "/work/t3code");
    assert.equal(snapshot.threadStatus, "running");
    assert.equal(snapshot.agentLabel, "claude opus");
    assert.equal(snapshot.runStartedAtMs, DateTime.toEpochMillis(NOW));
    assert.equal(snapshot.clientKind, "desktop");
    assert.equal(snapshot.deviceName, "Mini");
    assert.equal(snapshot.client.clientId, "client-1");
    assert.equal(snapshot.leaseExpiresAtMs, 47_000);
    assert.equal(snapshot.seq, 7);
  });

  it("drops an item the thread does not hold", () => {
    const snapshot = hydrate(
      {
        items: [
          { id: "message-from-another-thread", from: 0, to: 1 },
          { id: "message-1", from: 0, to: 1 },
        ],
        selection: { itemId: "message-from-another-thread", text: "picked words" },
      },
      threadData({
        messages: new Map([["message-1", { role: "assistant", text: "Here.", streaming: false }]]),
      }),
    );
    assert.deepStrictEqual(
      snapshot.visibleItems.map((item) => item.id),
      ["message-1"],
    );
    assert.equal(snapshot.visibleText, "Here.");
    // The selection is the one thing taken from the client; its item still has to be real.
    assert.equal(snapshot.selectedText, "picked words");
    assert.equal(snapshot.focusedItemId, "message-1");
  });

  it("caps the visible text and says so", () => {
    const wall = Array.from({ length: 2_000 }, (_, index) => `word${index}`).join(" ");
    const snapshot = hydrate(
      { items: [{ id: "message-1", from: 0, to: 1 }] },
      threadData({
        messages: new Map([["message-1", { role: "assistant", text: wall, streaming: false }]]),
      }),
    );
    assert.isTrue(snapshot.truncated);
    assert.isAtMost(snapshot.visibleText.length, MAX_VISIBLE_TEXT_LENGTH);
    assert.isAtLeast(snapshot.visibleText.length, MAX_VISIBLE_TEXT_LENGTH - 200);
    assert.match(snapshot.visibleText, /word\d+…$/u);
  });

  it("quotes a pending approval or question, capped", () => {
    const pending = { id: "request-1", kind: "command", createdAt: NOW };
    const approval = hydrate(
      {},
      threadData({
        shell: { ...threadData().shell, pendingRuntimeRequest: pending } as never,
        pendingRequestItem: turnItem({
          type: "approval_request",
          requestId: "request-1",
          requestKind: "command",
          prompt: "Run `rm -rf build`?",
        }),
      }),
    );
    assert.equal(approval.pendingBlocker, "Run `rm -rf build`?");
    assert.equal(approval.visibleText, "");
    assert.equal(approval.focusedItemId, null);

    const question = hydrate(
      {},
      threadData({
        shell: { ...threadData().shell, pendingRuntimeRequest: pending } as never,
        pendingRequestItem: turnItem({
          type: "user_input_request",
          requestId: "request-1",
          questions: [
            { id: "q1", header: "Target", question: "x".repeat(600), options: [] },
            { id: "q2", header: "Mode", question: "Which mode?", options: [] },
          ],
        }),
      }),
    );
    assert.equal(question.pendingBlocker?.length, MAX_PENDING_BLOCKER_LENGTH);
    assert.isTrue(question.pendingBlocker?.endsWith("…"));

    const unread = hydrate(
      {},
      threadData({ shell: { ...threadData().shell, pendingRuntimeRequest: pending } as never }),
    );
    assert.equal(unread.pendingBlocker, "[pending: command]");
    assert.isNull(hydrate({}, threadData()).pendingBlocker);
  });
});

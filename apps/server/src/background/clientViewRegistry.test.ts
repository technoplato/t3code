import { assert, describe, it } from "@effect/vitest";
import {
  AuthSessionId,
  type ClientView,
  EnvironmentId,
  RpcClientId,
  ThreadId,
} from "@t3tools/contracts";

import {
  type ClientViewRegistry,
  MAX_CLIENT_VIEWS_PER_RPC_CLIENT,
  nextClientViewExpiryMs,
  removeRpcClientViews,
  upsertClientView,
  winningClientView,
} from "./clientViewRegistry.ts";

const SESSION = AuthSessionId.make("session-1");
const TTL_MS = 45_000;

function view(overrides: Partial<ClientView> = {}): ClientView {
  return {
    windowId: "window-a",
    seq: 0,
    focused: true,
    lastGestureAtMs: 1_000,
    environmentId: EnvironmentId.make("environment-1"),
    threadId: ThreadId.make("thread-a"),
    ...overrides,
  };
}

function report(
  registry: ClientViewRegistry,
  rpcClientId: number,
  reported: ClientView,
  nowMs = 10_000,
  /** The client's own clock when it sent the report; the server's unless a test skews it. */
  observedAtMs = nowMs,
): ClientViewRegistry {
  return upsertClientView(
    registry,
    {
      sessionId: SESSION,
      rpcClientId: RpcClientId.make(rpcClientId),
      clientId: `client-${rpcClientId}`,
      clientKind: "web",
      view: reported,
      observedAtMs,
      ttlMs: TTL_MS,
    },
    nowMs,
  );
}

const winnerWindow = (registry: ClientViewRegistry, nowMs = 10_000) =>
  winningClientView(registry, nowMs)?.view.windowId ?? null;

describe("client view arbitration", () => {
  it("ranks by focus, then the latest gesture, then seq", () => {
    let registry = report(new Map(), 1, view({ windowId: "focused", lastGestureAtMs: 1_000 }));
    registry = report(
      registry,
      2,
      view({ windowId: "unfocused", focused: false, lastGestureAtMs: 9_000, seq: 500 }),
    );
    assert.equal(winnerWindow(registry), "focused");

    registry = report(registry, 3, view({ windowId: "phone", lastGestureAtMs: 2_000 }));
    assert.equal(winnerWindow(registry), "phone");

    registry = report(registry, 4, view({ windowId: "tie", lastGestureAtMs: 2_000, seq: 1 }));
    assert.equal(winnerWindow(registry), "tie");
  });

  it("a window that only streams never takes the view from the one being used", () => {
    let registry = report(new Map(), 1, view({ windowId: "in-use", lastGestureAtMs: 5_000 }));
    // A reply streaming in a second window re-reports its rows; its gesture time stays put.
    for (let seq = 1; seq <= 50; seq += 1) {
      registry = report(
        registry,
        2,
        view({ windowId: "streaming", lastGestureAtMs: 4_000, seq }),
        10_000 + seq,
      );
      assert.equal(winnerWindow(registry, 10_000 + seq), "in-use");
    }
  });

  it("keeps windows apart and drops only the disconnected connection's", () => {
    let registry = report(new Map(), 1, view({ windowId: "one", lastGestureAtMs: 3_000 }));
    registry = report(registry, 1, view({ windowId: "two", lastGestureAtMs: 2_000 }));
    registry = report(registry, 2, view({ windowId: "other", lastGestureAtMs: 1_000 }));
    assert.equal(registry.size, 3);

    const afterDisconnect = removeRpcClientViews(registry, {
      sessionId: SESSION,
      rpcClientId: RpcClientId.make(1),
    });
    assert.equal(winnerWindow(afterDisconnect), "other");
    assert.strictEqual(
      removeRpcClientViews(afterDisconnect, {
        sessionId: SESSION,
        rpcClientId: RpcClientId.make(9),
      }),
      afterDisconnect,
    );
    // The same connection id in another session is another connection.
    assert.strictEqual(
      removeRpcClientViews(afterDisconnect, {
        sessionId: AuthSessionId.make("session-2"),
        rpcClientId: RpcClientId.make(2),
      }),
      afterDisconnect,
    );
  });

  it("lets a lease lapse", () => {
    let registry = report(new Map(), 1, view({ windowId: "early", lastGestureAtMs: 9_000 }));
    registry = report(registry, 2, view({ windowId: "late", lastGestureAtMs: 1_000 }), 20_000);
    assert.equal(winnerWindow(registry, 20_000), "early");
    assert.equal(nextClientViewExpiryMs(registry, 20_000), 10_000 + TTL_MS);
    assert.equal(winnerWindow(registry, 10_000 + TTL_MS), "late");
    assert.equal(winnerWindow(registry, 20_000 + TTL_MS), null);
    assert.equal(nextClientViewExpiryMs(registry, 20_000 + TTL_MS), null);
  });

  it("ignores a report that an earlier one overtook, and a gesture from the future", () => {
    let registry = report(new Map(), 1, view({ seq: 4, threadId: ThreadId.make("thread-new") }));
    registry = report(registry, 1, view({ seq: 3, threadId: ThreadId.make("thread-old") }));
    assert.equal(winningClientView(registry, 10_000)?.view.threadId, "thread-new");

    registry = report(registry, 2, view({ windowId: "skewed", lastGestureAtMs: 99_999_999 }));
    registry = report(registry, 3, view({ windowId: "honest", lastGestureAtMs: 10_500 }), 11_000);
    assert.equal(winnerWindow(registry, 11_000), "honest");
  });

  it("ranks a gesture by its age, so a device with a wrong clock neither always wins nor always loses", () => {
    const now = 10_000_000;
    // The desktop was touched a minute ago. The phone's clock runs ten minutes behind, and it
    // was touched a second ago.
    let registry = report(
      new Map(),
      1,
      view({ windowId: "desktop", lastGestureAtMs: now - 60_000 }),
      now,
    );
    registry = report(
      registry,
      2,
      view({ windowId: "phone", lastGestureAtMs: now - 601_000 }),
      now,
      now - 600_000,
    );
    assert.equal(winnerWindow(registry, now), "phone");

    // Back at the desktop. The phone's next heartbeat repeats its old gesture and moves no rank.
    registry = report(
      registry,
      1,
      view({ windowId: "desktop", lastGestureAtMs: now + 5_000, seq: 1 }),
      now + 5_000,
    );
    registry = report(
      registry,
      2,
      view({ windowId: "phone", lastGestureAtMs: now - 601_000, seq: 1 }),
      now + 25_000,
      now - 575_000,
    );
    assert.equal(winnerWindow(registry, now + 25_000), "desktop");

    // A tablet whose clock runs an hour ahead, last touched ten minutes ago, does not win.
    registry = report(
      registry,
      3,
      view({ windowId: "tablet", lastGestureAtMs: now + 3_000_000 }),
      now + 26_000,
      now + 3_626_000,
    );
    assert.equal(winnerWindow(registry, now + 26_000), "desktop");
  });

  it("bounds the windows one connection can hold", () => {
    let registry: ClientViewRegistry = new Map();
    for (let index = 0; index <= MAX_CLIENT_VIEWS_PER_RPC_CLIENT; index += 1) {
      registry = report(registry, 1, view({ windowId: `window-${index}` }), 10_000 + index);
    }
    assert.equal(registry.size, MAX_CLIENT_VIEWS_PER_RPC_CLIENT);
    assert.isFalse([...registry.values()].some((entry) => entry.view.windowId === "window-0"));
  });
});

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  AuthSessionId,
  type ClientActivityReportInput,
  type ClientView,
  EnvironmentId,
  RpcClientId,
  ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as ConfigProvider from "effect/ConfigProvider";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as ClientViewExport from "./ClientViewExport.ts";
import { ClientViewSnapshot, type ClientViewThreadData } from "./clientViewHydration.ts";

const LOCAL = EnvironmentId.make("environment-local");
const REMOTE = EnvironmentId.make("environment-remote");
const THREAD = ThreadId.make("thread-1");
const SESSION = AuthSessionId.make("session-1");
const decodeSnapshot = Schema.decodeUnknownEffect(Schema.fromJsonString(ClientViewSnapshot));

const layerConfig = (overrides: Partial<ServerConfig.ServerConfig["Service"]>) =>
  Layer.effect(
    ServerConfig.ServerConfig,
    Effect.gen(function* () {
      return { ...(yield* ServerConfig.ServerConfig), ...overrides };
    }),
  ).pipe(
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "client-view-export-" })),
    Layer.provideMerge(NodeServices.layer),
  );

function threadData(text: string): ClientViewThreadData {
  return {
    shell: {
      title: "Viewed thread",
      status: "running",
      providerInstanceId: "claude",
      modelSelection: { instanceId: "claude", model: "opus" },
      activityRunStartedAt: null,
      latestRunStartedAt: null,
      pendingRuntimeRequest: null,
    } as ClientViewThreadData["shell"],
    project: { title: "Project", workspaceRoot: "/work/project" },
    messages: new Map([["message-1", { role: "assistant", text, streaming: true }]]),
    turnItems: new Map(),
    pendingRequestItem: null,
  };
}

function report(view?: Partial<ClientView> & Pick<ClientView, "lastGestureAtMs">) {
  return {
    clientId: "client-1",
    clientKind: "desktop-renderer",
    visible: true,
    focused: true,
    recentlyInteracted: true,
    scopes: [],
    ttlMs: 45_000,
    observedAt: DateTime.makeUnsafe(0),
    ...(view === undefined
      ? {}
      : {
          view: {
            windowId: "window-1",
            seq: 0,
            focused: true,
            environmentId: LOCAL,
            threadId: THREAD,
            items: [{ id: "message-1", from: 0, to: 1 }],
            ...view,
          },
        }),
  } satisfies ClientActivityReportInput;
}

/** An opted-in export over in-memory records, with every write it makes on a queue. */
const withExport = <A, E>(
  body: (harness: {
    readonly views: ReturnType<typeof ClientViewExport.ClientViewExport.defaultValue>;
    readonly written: Queue.Queue<ClientViewSnapshot>;
    readonly threadChanges: Queue.Queue<ThreadId>;
    readonly threads: Map<ThreadId, ClientViewThreadData>;
    readonly nowMs: number;
  }) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const written = yield* Queue.unbounded<ClientViewSnapshot>();
    const threadChanges = yield* Queue.unbounded<ThreadId>();
    const threads = new Map([[THREAD, threadData("First draft of the reply.")]]);
    const layer = ClientViewExport.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(
            ClientViewExport.ClientViewSource,
            ClientViewExport.ClientViewSource.of({
              environmentId: Effect.succeed(LOCAL),
              readThread: (threadId) => Effect.sync(() => threads.get(threadId) ?? null),
              threadChanges: Stream.fromQueue(threadChanges),
              sessionClient: () =>
                Effect.succeed({ label: "Paired client", deviceType: "desktop", os: "macOS" }),
              hostName: Effect.succeed("mini.local"),
            }),
          ),
          Layer.succeed(
            ClientViewExport.ClientViewSink,
            ClientViewExport.ClientViewSink.of({
              write: (snapshot) => Queue.offer(written, snapshot).pipe(Effect.asVoid),
            }),
          ),
          layerConfig({ exportClientView: true, mode: "desktop" }),
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({ __CFBundleIdentifier: "com.example.desktop" }),
          ),
        ),
      ),
    );
    return yield* Effect.gen(function* () {
      const views = yield* ClientViewExport.ClientViewExport;
      // Off zero, so a gesture time in the past stays in the past.
      yield* TestClock.adjust("1 hour");
      assert.equal((yield* Queue.take(written)).state, "none");
      const nowMs = yield* Clock.currentTimeMillis;
      return yield* body({ views, written, threadChanges, threads, nowMs });
    }).pipe(Effect.provide(layer));
  });

describe("ClientViewExport", () => {
  it.effect("writes the thread in view, at most once a second", () =>
    withExport(({ views, written, nowMs }) =>
      Effect.gen(function* () {
        yield* views.reportClientActivity(
          SESSION,
          RpcClientId.make(1),
          report({ lastGestureAtMs: nowMs - 500 }),
        );
        const first = yield* Queue.take(written);
        assert.equal(first.state, "active");
        if (first.state !== "active") return;
        assert.equal(first.visibleText, "First draft of the reply.");
        assert.equal(first.threadId, THREAD);
        assert.equal(first.environmentId, LOCAL);
        // A desktop window that sends no identity is taken to be this machine's own app.
        assert.equal(first.deviceName, "mini.local");
        assert.equal(first.clientKind, "desktop");
        assert.equal(first.client.clientId, "client-1");
        assert.equal(first.appBundleId, "com.example.desktop");
        assert.equal(first.capturedAtMs, nowMs);
        assert.equal(first.leaseExpiresAtMs, nowMs + 45_000);
        assert.isTrue(first.streaming);

        for (const seq of [1, 2]) {
          yield* views.reportClientActivity(
            SESSION,
            RpcClientId.make(1),
            report({ lastGestureAtMs: nowMs - 500, seq, items: [] }),
          );
        }
        yield* TestClock.adjust("999 millis");
        assert.equal(yield* Queue.size(written), 0);
        yield* TestClock.adjust("1 millis");
        const second = yield* Queue.take(written);
        assert.equal(second.state === "active" ? second.seq : null, 2);
        assert.equal(second.state === "active" ? second.visibleText : null, "");
        assert.equal(yield* Queue.size(written), 0);
      }),
    ),
  );

  it.effect("keeps the window in use while another one streams", () =>
    withExport(({ views, written, threadChanges, threads, nowMs }) =>
      Effect.gen(function* () {
        const other = ThreadId.make("thread-streaming");
        threads.set(other, threadData("Streaming elsewhere."));
        yield* views.reportClientActivity(
          SESSION,
          RpcClientId.make(1),
          report({ lastGestureAtMs: nowMs - 100 }),
        );
        assert.equal((yield* Queue.take(written)).state, "active");

        for (let seq = 1; seq <= 5; seq += 1) {
          yield* views.reportClientActivity(
            SESSION,
            RpcClientId.make(2),
            report({
              windowId: "window-2",
              threadId: other,
              focused: false,
              lastGestureAtMs: nowMs - 100,
              seq,
            }),
          );
          yield* Queue.offer(threadChanges, other);
          yield* TestClock.adjust("1 second");
        }
        assert.equal(yield* Queue.size(written), 0);

        // The viewed thread's own reply growing is written, and moves no rank.
        threads.set(THREAD, threadData("First draft of the reply, now longer."));
        yield* Queue.offer(threadChanges, THREAD);
        yield* TestClock.adjust("1 second");
        const grown = yield* Queue.take(written);
        assert.equal(grown.state === "active" ? grown.threadId : null, THREAD);
        assert.equal(
          grown.state === "active" ? grown.visibleText : null,
          "First draft of the reply, now longer.",
        );
        assert.equal(grown.state === "active" ? grown.seq : null, 0);
        assert.equal(grown.state === "active" ? grown.lastGestureAtMs : null, nowMs - 100);
      }),
    ),
  );

  it.effect("names another environment's thread and carries none of its text", () =>
    withExport(({ views, written, nowMs }) =>
      Effect.gen(function* () {
        yield* views.reportClientActivity(SESSION, RpcClientId.make(1), {
          ...report({
            environmentId: REMOTE,
            lastGestureAtMs: nowMs - 100,
            selection: { text: "words selected on the other server" },
          }),
          clientKind: "mobile",
          identity: {
            formFactor: "tablet",
            os: "iPadOS",
            deviceName: "Studio iPad",
            connection: "relay",
          },
        });
        assert.deepStrictEqual(yield* Queue.take(written), {
          version: 1,
          state: "other-environment",
          capturedAtMs: nowMs,
          leaseExpiresAtMs: nowMs + 45_000,
          clientKind: "mobile",
          deviceName: "Studio iPad",
          client: {
            clientId: "client-1",
            formFactor: "tablet",
            os: "iPadOS",
            osVersion: null,
            deviceModel: null,
            browser: null,
            appName: null,
            appVersion: null,
            webDeployment: null,
            connection: "relay",
          },
          windowId: "window-1",
          environmentId: REMOTE,
          threadId: THREAD,
        });
      }),
    ),
  );

  it.effect("names whichever client was used last, window by window", () =>
    withExport(({ views, written, nowMs }) =>
      Effect.gen(function* () {
        const who = Effect.map(Queue.take(written), (snapshot) =>
          snapshot.state === "none"
            ? null
            : [snapshot.clientKind, snapshot.client.formFactor, snapshot.windowId].join(" "),
        );
        const desktopWindow = (rpcClientId: number, view: Parameters<typeof report>[0]) =>
          views.reportClientActivity(SESSION, RpcClientId.make(rpcClientId), report(view));
        const phone = (lastGestureAtMs: number) =>
          views.reportClientActivity(AuthSessionId.make("session-phone"), RpcClientId.make(1), {
            ...report({ windowId: "launch-1", lastGestureAtMs }),
            clientId: "mobile-1",
            clientKind: "mobile",
            identity: { formFactor: "phone", os: "iOS", connection: "relay" },
          });

        yield* desktopWindow(1, { lastGestureAtMs: nowMs - 60_000 });
        assert.equal(yield* who, "desktop desktop window-1");

        // The desktop window stays open and focused while the phone is scrolled.
        yield* TestClock.adjust("1 second");
        yield* phone(nowMs);
        assert.equal(yield* who, "mobile phone launch-1");

        // A second window of the same desktop app shares its client id and connects on its own.
        yield* TestClock.adjust("1 second");
        yield* desktopWindow(2, { windowId: "window-2", lastGestureAtMs: nowMs + 1_500 });
        const second = yield* Queue.take(written);
        assert.equal(second.state === "none" ? null : second.windowId, "window-2");
        assert.equal(second.state === "none" ? null : second.client.clientId, "client-1");

        // Clicking back into the first window blurs the second.
        yield* TestClock.adjust("1 second");
        yield* desktopWindow(2, {
          windowId: "window-2",
          focused: false,
          lastGestureAtMs: nowMs + 1_500,
          seq: 1,
        });
        yield* desktopWindow(1, { lastGestureAtMs: nowMs + 500, seq: 1 });
        assert.equal(yield* who, "desktop desktop window-1");

        // Both windows close; the phone, silent since, holds the view until its lease lapses.
        yield* TestClock.adjust("1 second");
        yield* views.removeRpcClient(SESSION, RpcClientId.make(1));
        yield* views.removeRpcClient(SESSION, RpcClientId.make(2));
        assert.equal(yield* who, "mobile phone launch-1");
        yield* TestClock.adjust("45 seconds");
        assert.equal(yield* who, null);
      }),
    ),
  );

  it.effect("clears on disconnect, on leaving the thread, and when the lease lapses", () =>
    withExport(({ views, written, nowMs }) =>
      Effect.gen(function* () {
        const gesture = { lastGestureAtMs: nowMs - 100 };
        const expectState = (state: ClientViewSnapshot["state"]) =>
          Effect.map(Queue.take(written), (snapshot) => assert.equal(snapshot.state, state));

        yield* views.reportClientActivity(SESSION, RpcClientId.make(1), report(gesture));
        yield* expectState("active");
        yield* views.removeRpcClient(SESSION, RpcClientId.make(1));
        yield* TestClock.adjust("1 second");
        yield* expectState("none");

        yield* TestClock.adjust("1 second");
        yield* views.reportClientActivity(SESSION, RpcClientId.make(2), report(gesture));
        yield* expectState("active");
        yield* views.reportClientActivity(SESSION, RpcClientId.make(2), report());
        yield* TestClock.adjust("1 second");
        yield* expectState("none");

        yield* TestClock.adjust("1 second");
        yield* views.reportClientActivity(SESSION, RpcClientId.make(3), report(gesture));
        yield* expectState("active");
        yield* TestClock.adjust("44 seconds");
        assert.equal(yield* Queue.size(written), 0);
        yield* TestClock.adjust("1 second");
        yield* expectState("none");
      }),
    ),
  );

  it.effect("treats a thread this server does not hold as no view", () =>
    withExport(({ views, written, threads, nowMs }) =>
      Effect.gen(function* () {
        threads.clear();
        yield* views.reportClientActivity(
          SESSION,
          RpcClientId.make(1),
          report({ lastGestureAtMs: nowMs - 100 }),
        );
        yield* TestClock.adjust("5 seconds");
        assert.equal(yield* Queue.size(written), 0);
      }),
    ),
  );
});

describe("ClientViewExport file", () => {
  const filePath = Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    return path.join(config.stateDir, ClientViewExport.CLIENT_VIEW_FILE_NAME);
  });

  it.effect("stays off unless the server config turns it on", () =>
    Effect.gen(function* () {
      const views = yield* ClientViewExport.ClientViewExport;
      const fileSystem = yield* FileSystem.FileSystem;
      yield* views.reportClientActivity(
        SESSION,
        RpcClientId.make(1),
        report({ lastGestureAtMs: 0 }),
      );
      yield* TestClock.adjust("1 minute");
      assert.isFalse(yield* fileSystem.exists(yield* filePath));
    }).pipe(
      Effect.provide(
        ClientViewExport.layer.pipe(
          Layer.provide(
            Layer.succeed(
              ClientViewExport.ClientViewSource,
              ClientViewExport.ClientViewSource.of({
                environmentId: Effect.succeed(LOCAL),
                readThread: () => Effect.succeed(threadData("Never read.")),
                threadChanges: Stream.never,
                sessionClient: () => Effect.succeed(null),
                hostName: Effect.succeed("mini.local"),
              }),
            ),
          ),
          Layer.provide(ClientViewExport.layerFileSink),
          Layer.provideMerge(layerConfig({})),
        ),
      ),
    ),
  );

  it.effect("replaces the file whole and keeps it owner-only", () =>
    Effect.gen(function* () {
      const sink = yield* ClientViewExport.ClientViewSink;
      const fileSystem = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig.ServerConfig;
      const target = yield* filePath;
      // As if an earlier owner had left it readable by everyone.
      yield* fileSystem.writeFileString(target, "stale");
      yield* fileSystem.chmod(target, 0o644);

      for (const capturedAtMs of [1, 2]) {
        yield* sink.write({ version: 1, state: "none", capturedAtMs });
        assert.deepStrictEqual(yield* decodeSnapshot(yield* fileSystem.readFileString(target)), {
          version: 1,
          state: "none",
          capturedAtMs,
        });
        assert.equal((yield* fileSystem.stat(target)).mode & 0o777, 0o600);
      }
      const leftovers = (yield* fileSystem.readDirectory(config.stateDir)).filter((entry) =>
        entry.startsWith("t3-write-"),
      );
      assert.deepStrictEqual(leftovers, []);
    }).pipe(
      Effect.provide(
        ClientViewExport.layerFileSink.pipe(
          Layer.provideMerge(layerConfig({ exportClientView: true })),
        ),
      ),
    ),
  );
});

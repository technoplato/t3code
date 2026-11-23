import {
  type AuthSessionId,
  type ClientActivityReportInput,
  type EnvironmentId,
  MessageId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2TurnItem,
  type RpcClientId,
  type ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import { threadLinkHref } from "@t3tools/shared/threadLinks";
import * as NodeOS from "node:os";

import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { resolveLeaseTtlMs } from "./BackgroundPolicy.ts";
import {
  type ClientViewSnapshot,
  ClientViewSnapshot as ClientViewSnapshotSchema,
  type ClientViewThreadData,
  describeViewClient,
  hydrateActiveClientView,
  type ViewSessionClient,
} from "./clientViewHydration.ts";
import {
  type ClientViewRegistry,
  nextClientViewExpiryMs,
  removeRpcClientViews,
  type TrackedClientView,
  upsertClientView,
  winningClientView,
} from "./clientViewRegistry.ts";

export const CLIENT_VIEW_FILE_NAME = "client-view.json";
const WRITE_INTERVAL = Duration.seconds(1);
const FILE_MODE = 0o600;

const encodeSnapshot = Schema.encodeEffect(Schema.fromJsonString(ClientViewSnapshotSchema));
const isMessageId = Schema.is(MessageId);
const isTurnItemId = Schema.is(TurnItemId);

/** What the export reads from the rest of the server. */
export class ClientViewSource extends Context.Service<
  ClientViewSource,
  {
    readonly environmentId: Effect.Effect<EnvironmentId>;
    /** Null when the thread is unknown or cannot be read. */
    readonly readThread: (
      threadId: ThreadId,
      itemIds: ReadonlyArray<string>,
    ) => Effect.Effect<ClientViewThreadData | null>;
    /** One element per change to a thread's projection. */
    readonly threadChanges: Stream.Stream<ThreadId>;
    /** What the session's sign-in recorded about its client. */
    readonly sessionClient: (sessionId: AuthSessionId) => Effect.Effect<ViewSessionClient | null>;
    readonly hostName: Effect.Effect<string>;
  }
>()("t3/background/ClientViewExport/ClientViewSource") {}

/** Where a changed snapshot goes. */
export class ClientViewSink extends Context.Service<
  ClientViewSink,
  { readonly write: (snapshot: ClientViewSnapshot) => Effect.Effect<void> }
>()("t3/background/ClientViewExport/ClientViewSink") {}

/** Does nothing unless a layer provides the export; only an opted-in server builds one. */
export class ClientViewExport extends Context.Reference<{
  readonly reportClientActivity: (
    sessionId: AuthSessionId,
    rpcClientId: RpcClientId,
    input: ClientActivityReportInput,
  ) => Effect.Effect<void>;
  readonly removeRpcClient: (
    sessionId: AuthSessionId,
    rpcClientId: RpcClientId,
  ) => Effect.Effect<void>;
}>("t3/background/ClientViewExport", {
  defaultValue: () => ({
    reportClientActivity: () => Effect.void,
    removeRpcClient: () => Effect.void,
  }),
}) {}

const makeSource = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  let lastSession: {
    readonly sessionId: AuthSessionId;
    readonly client: ViewSessionClient | null;
  } | null = null;

  const readThread = Effect.fn("ClientViewSource.readThread")(
    function* (threadId: ThreadId, itemIds: ReadonlyArray<string>) {
      const shell = yield* orchestrator.getThreadShell(threadId);
      if (shell === null) return null;
      const project = Option.getOrNull(yield* projects.get(shell.projectId));

      // Each read is scoped to `threadId`, so an id from another thread resolves to nothing.
      const messages = new Map<string, OrchestrationV2ConversationMessage>(
        yield* orchestrator.getMessagesById(threadId, itemIds.filter(isMessageId)),
      );
      const turnItems = new Map<string, OrchestrationV2TurnItem>();
      for (const id of itemIds) {
        if (messages.has(id) || !isTurnItemId(id)) continue;
        const item = yield* orchestrator.getTurnItem({ threadId, itemId: id });
        if (item !== null) turnItems.set(id, item);
      }

      // A client that knows a plan only by its plan id reports that instead.
      const unresolved = new Set(itemIds.filter((id) => !messages.has(id) && !turnItems.has(id)));
      if (unresolved.size > 0) {
        const plans = yield* orchestrator.getThreadRecords(threadId, ["turnItems"], {
          turnItemTypes: ["proposed_plan", "todo_list"],
        });
        for (const item of plans.turnItems) {
          if (
            (item.type === "proposed_plan" || item.type === "todo_list") &&
            unresolved.has(item.planId)
          ) {
            turnItems.set(item.planId, item);
          }
        }
      }

      // A stored message item can omit its text; the message it names always has it.
      const messageItems = [...turnItems].flatMap(([reportedId, item]) =>
        item.type === "user_message" || item.type === "assistant_message"
          ? [{ reportedId, messageId: item.messageId }]
          : [],
      );
      if (messageItems.length > 0) {
        const named = yield* orchestrator.getMessagesById(
          threadId,
          messageItems.map((entry) => entry.messageId),
        );
        for (const { reportedId, messageId } of messageItems) {
          const message = named.get(messageId);
          if (message === undefined) continue;
          messages.set(reportedId, message);
          turnItems.delete(reportedId);
        }
      }

      const pending = shell.pendingRuntimeRequest;
      const pendingRequestItem =
        pending === null
          ? null
          : ((yield* orchestrator.getThreadRecords(threadId, ["turnItems"], {
              turnItemRequestIds: [pending.id],
            })).turnItems.at(-1) ?? null);

      return {
        shell,
        project:
          project === null ? null : { title: project.title, workspaceRoot: project.workspaceRoot },
        messages,
        turnItems,
        pendingRequestItem,
      } satisfies ClientViewThreadData;
    },
    Effect.catchCause((cause) =>
      Effect.logWarning("Could not read the viewed thread", cause).pipe(Effect.as(null)),
    ),
  );

  return ClientViewSource.of({
    environmentId: serverEnvironment.getEnvironmentId,
    readThread,
    threadChanges: orchestrator.streamDomainEvents.pipe(
      Stream.map((event) => event.threadId),
      Stream.catchCause((cause) =>
        Stream.fromEffect(Effect.logWarning("Viewed thread changes stopped", cause)).pipe(
          Stream.drain,
        ),
      ),
    ),
    sessionClient: Effect.fn("ClientViewSource.sessionClient")(function* (sessionId) {
      if (lastSession?.sessionId === sessionId) return lastSession.client;
      const sessions = yield* auth
        .listClientSessions(sessionId)
        .pipe(Effect.orElseSucceed(() => []));
      const client = sessions.find((session) => session.current)?.client ?? null;
      lastSession = { sessionId, client };
      return client;
    }),
    hostName: Effect.sync(() => NodeOS.hostname()),
  });
});

export const layerSource = Layer.effect(ClientViewSource, makeSource);

/** Owner-only, and replaced whole: a reader sees the old snapshot or the new one, never part of one. */
export const layerFileSink = Layer.effect(
  ClientViewSink,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const filePath = path.join(config.stateDir, CLIENT_VIEW_FILE_NAME);
    const write = Effect.fn("ClientViewSink.write")(
      function* (snapshot: ClientViewSnapshot) {
        // An atomic save keeps the mode of the file it replaces, so narrow that first.
        yield* fileSystem.chmod(filePath, FILE_MODE).pipe(Effect.ignore);
        yield* writeFileStringAtomically({
          filePath,
          contents: `${yield* encodeSnapshot(snapshot)}\n`,
        });
      },
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.catchCause((cause) => Effect.logWarning("Could not write the client view", cause)),
    );
    return ClientViewSink.of({ write });
  }),
);

const make = Effect.gen(function* () {
  const source = yield* ClientViewSource;
  const sink = yield* ClientViewSink;
  const config = yield* ServerConfig.ServerConfig;
  const localEnvironmentId = yield* source.environmentId;
  // macOS sets this for a process an app bundle launched; a server started any other way has none.
  const hostBundleId = yield* Config.String("__CFBundleIdentifier").pipe(
    Config.option,
    Effect.map(Option.getOrNull),
    Effect.orElseSucceed(() => null),
  );
  const registryRef = yield* Ref.make<ClientViewRegistry>(new Map());
  const viewedThreadRef = yield* Ref.make<ThreadId | null>(null);
  const dirty = yield* Queue.sliding<void>(1);
  let lastWritten: string | null = null;

  const snapshotFor = Effect.fn("ClientViewExport.snapshotFor")(function* (
    winner: TrackedClientView | null,
    capturedAtMs: number,
  ) {
    if (winner === null) return { version: 1, state: "none", capturedAtMs } as const;
    const { view } = winner;
    // A desktop app's own window, on this machine. A client that predates `connection` counts.
    const onThisHost =
      config.mode === "desktop" &&
      winner.clientKind === "desktop-renderer" &&
      (winner.identity?.connection ?? "local") === "local";
    const client = describeViewClient({
      tracked: winner,
      session: yield* source.sessionClient(winner.sessionId),
      hostName: onThisHost ? yield* source.hostName : null,
    });
    if (view.environmentId !== localEnvironmentId) {
      return {
        version: 1,
        state: "other-environment",
        capturedAtMs,
        leaseExpiresAtMs: winner.expiresAtMs,
        ...client,
        windowId: view.windowId,
        environmentId: view.environmentId,
        threadId: view.threadId,
        threadUri: threadLinkHref(view),
      } as const;
    }
    const thread = yield* source.readThread(
      view.threadId,
      (view.items ?? []).map((item) => item.id),
    );
    if (thread === null) return { version: 1, state: "none", capturedAtMs } as const;
    return hydrateActiveClientView({
      tracked: winner,
      thread,
      client,
      appBundleId: onThisHost ? hostBundleId : null,
      capturedAtMs,
    });
  });

  const refresh = Effect.fn("ClientViewExport.refresh")(function* () {
    const nowMs = yield* Clock.currentTimeMillis;
    const winner = winningClientView(yield* Ref.get(registryRef), nowMs);
    yield* Ref.set(
      viewedThreadRef,
      winner !== null && winner.view.environmentId === localEnvironmentId
        ? winner.view.threadId
        : null,
    );
    const snapshot: ClientViewSnapshot = yield* snapshotFor(winner, nowMs);
    // Only a change is written; the capture time alone is not one.
    const comparable = yield* encodeSnapshot({ ...snapshot, capturedAtMs: 0 });
    if (comparable === lastWritten) return;
    yield* sink.write(snapshot);
    lastWritten = comparable;
  });

  const markDirty = Queue.offer(dirty, undefined).pipe(Effect.asVoid);

  yield* Effect.gen(function* () {
    const nowMs = yield* Clock.currentTimeMillis;
    const expiry = nextClientViewExpiryMs(yield* Ref.get(registryRef), nowMs);
    yield* expiry === null
      ? Queue.take(dirty)
      : Queue.take(dirty).pipe(Effect.timeoutOption(Duration.millis(expiry - nowMs)));
    yield* refresh().pipe(
      Effect.catchCause((cause) => Effect.logWarning("Could not refresh the client view", cause)),
    );
    yield* Effect.sleep(WRITE_INTERVAL);
  }).pipe(Effect.forever, Effect.forkScoped);

  // Per event, so untraced: a streaming reply emits many.
  yield* source.threadChanges.pipe(
    Stream.runForEach((threadId) =>
      Effect.flatMap(Ref.get(viewedThreadRef), (viewed) =>
        viewed === threadId ? markDirty : Effect.void,
      ),
    ),
    Effect.forkScoped,
  );
  yield* markDirty;

  const updateRegistry = (update: (registry: ClientViewRegistry) => ClientViewRegistry) =>
    Ref.modify(registryRef, (registry) => {
      const next = update(registry);
      return [next !== registry, next] as const;
    }).pipe(Effect.flatMap((changed) => (changed ? markDirty : Effect.void)));

  return ClientViewExport.of({
    reportClientActivity: Effect.fn("ClientViewExport.reportClientActivity")(
      function* (sessionId, rpcClientId, input) {
        const { view } = input;
        // A window that stops sending a view has left its thread.
        if (view === undefined) {
          return yield* updateRegistry((registry) =>
            removeRpcClientViews(registry, { sessionId, rpcClientId }),
          );
        }
        const nowMs = yield* Clock.currentTimeMillis;
        yield* updateRegistry((registry) =>
          upsertClientView(
            registry,
            {
              sessionId,
              rpcClientId,
              clientId: input.clientId,
              clientKind: input.clientKind,
              ...(input.identity === undefined ? {} : { identity: input.identity }),
              view,
              observedAtMs: DateTime.toEpochMillis(input.observedAt),
              ttlMs: resolveLeaseTtlMs(input.ttlMs),
            },
            nowMs,
          ),
        );
      },
    ),
    removeRpcClient: Effect.fn("ClientViewExport.removeRpcClient")(
      function* (sessionId, rpcClientId) {
        yield* updateRegistry((registry) =>
          removeRpcClientViews(registry, { sessionId, rpcClientId }),
        );
      },
    ),
  });
});

/** Tracks nothing and writes nothing unless the server config turns the export on. */
export const layer = Layer.effect(
  ClientViewExport,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    return config.exportClientView === true ? yield* make : ClientViewExport.defaultValue();
  }),
);

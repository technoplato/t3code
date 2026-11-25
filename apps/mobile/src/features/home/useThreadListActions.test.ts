import { makeThreadShellFixture } from "../../test-fixtures";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  AuthOrchestrationOperateScope,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type ThreadTitleRegenerationOutcome,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  connectedEnvironmentIds: [] as EnvironmentId[],
  pendingOrder: null as object | null,
  dropBusy: false,
  holdingRows: false,
  failedAction: null as string | null,
  thrownAction: null as string | null,
  preferences: null as { workingShelfEnabled?: boolean; inboxSortOrder?: string } | null,
  heldOrders: [] as { readonly arriving?: string }[],
  titleOutcome: null as ThreadTitleRegenerationOutcome | null,
  archivedRefreshes: [] as string[],
  onArchivedRefresh: undefined as (() => void) | undefined,
  scopes: new Map<string, Set<string>>(),
  shells: [] as EnvironmentThreadShell[],
  requests: [] as {
    action: string;
    environmentId: string;
    input: { threadId: string; orderKey?: string; snoozedUntil?: string; reason?: string };
  }[],
  dialogs: [] as { onConfirm: () => void }[],
  alerts: [] as {
    title: string;
    buttons?: { text: string; onPress?: () => void }[];
  }[],
  afterRequest: undefined as (() => void) | undefined,
  heldActions: new Map<string, Promise<void>>(),
}));

vi.mock("react", () => ({
  useCallback: (callback: unknown) => callback,
  useRef: (current: unknown) => ({ current }),
}));
vi.mock("react-native", () => ({
  Alert: {
    alert: (title: string, _message: string, buttons?: { text: string; onPress?: () => void }[]) =>
      state.alerts.push({ title, buttons }),
  },
}));
vi.mock("expo-haptics", () => ({
  impactAsync: async () => {},
  ImpactFeedbackStyle: { Light: "light" },
}));
vi.mock("../../components/ui/Dialog", () => ({
  alert: (title: string, _message: string, buttons?: { text: string; onPress?: () => void }[]) =>
    state.alerts.push({ title, buttons }),
  confirm: (dialog: { onConfirm: () => void }) => state.dialogs.push(dialog),
}));
vi.mock("../archive/useArchivedThreadSnapshots", () => ({
  refreshArchivedThreadsForEnvironment: (environmentId: string) => {
    state.archivedRefreshes.push(environmentId);
    state.onArchivedRefresh?.();
  },
}));
vi.mock("../../state/session", () => ({
  readEnvironmentScope: (environmentId: string, scope: string) =>
    state.scopes.get(environmentId)?.has(scope) === true,
}));
vi.mock("../../state/presentation", () => ({
  connectedEnvironmentIdsAtom: "connected-environments",
}));
vi.mock("../../state/server", () => ({
  environmentServerConfigsAtom: "server-configs",
}));
vi.mock("../../state/preferences", () => ({ mobilePreferencesAtom: "mobile-preferences" }));
vi.mock("../../state/atom-registry", async () => {
  const { AsyncResult, AtomRegistry } = await import("effect/reactivity");
  const registry = AtomRegistry.make();
  const stub = {
    set: (_atom: string, value: boolean) => {
      state.dropBusy = value;
    },
    get: (atom: string) =>
      atom === "connected-environments"
        ? state.connectedEnvironmentIds
        : atom === "thread-drop-busy"
          ? state.dropBusy
          : atom === "steady-shells-holding"
            ? state.holdingRows
            : atom === "thread-shells"
              ? state.shells
              : atom === "queued-thread-keys"
                ? new Set<string>()
                : atom === "mobile-preferences"
                  ? state.preferences === null
                    ? AsyncResult.initial()
                    : AsyncResult.success(state.preferences)
                  : new Map(
                      [...state.scopes.keys()].map((environmentId) => [
                        environmentId,
                        {
                          environment: {
                            capabilities: {
                              threadSettlement: true,
                              threadSnooze: true,
                              threadPinning: true,
                              threadPinReorder: true,
                              threadTitleRegeneration: true,
                            },
                          },
                        },
                      ]),
                    ),
  };
  // Real atoms such as composerDraftsAtom go to a real registry; strings are stubbed state.
  return {
    appAtomRegistry: {
      get: (atom: unknown) =>
        typeof atom === "string"
          ? stub.get(atom)
          : registry.get(atom as Parameters<typeof registry.get>[0]),
      set: (atom: unknown, value: unknown) =>
        typeof atom === "string"
          ? stub.set(atom, value as boolean)
          : registry.set(atom as Parameters<typeof registry.set>[0], value),
    },
  };
});
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) => command,
}));
vi.mock("../../state/use-thread-outbox", () => ({ queuedThreadKeysAtom: "queued-thread-keys" }));
vi.mock("../../state/thread-order", () => ({
  threadDropBusyAtom: "thread-drop-busy",
  getPendingThreadOrder: () => state.pendingOrder,
  beginPendingThreadOrder: (pending: { readonly arriving?: string }) => {
    state.heldOrders.push(pending);
    state.pendingOrder = {};
    return {
      isPending: () => state.pendingOrder !== null,
      complete: () => {
        state.pendingOrder = null;
      },
      cancel: () => {
        state.pendingOrder = null;
      },
    };
  },
}));
vi.mock("../../state/threads", () => ({
  environmentThreadShells: { threadShellsAtom: "thread-shells" },
  steadyNavigationThreadShellsAtom: "thread-shells",
  steadyShellsHoldingAtom: "steady-shells-holding",
  threadEnvironment: Object.fromEntries(
    [
      "archive",
      "unarchive",
      "delete",
      "settle",
      "unsettle",
      "snooze",
      "unsnooze",
      "pin",
      "unpin",
      "reorderPin",
      "reorderActive",
      "updateMetadata",
      "regenerateTitle",
    ].map((action) => [
      action,
      async (request: {
        environmentId: string;
        input: { threadId: string; orderKey?: string };
      }) => {
        state.requests.push({ action, ...request });
        await state.heldActions.get(action);
        if (action === state.thrownAction) throw new Error("Connection dropped");
        if (!state.scopes.get(request.environmentId)?.has(AuthOrchestrationOperateScope)) {
          return AsyncResult.failure(Cause.fail(new Error("Thread operation denied")));
        }
        if (action === state.failedAction)
          return AsyncResult.failure(Cause.fail(new Error("Server rejected action")));
        state.afterRequest?.();
        return AsyncResult.success(action === "regenerateTitle" ? state.titleOutcome : undefined);
      },
    ]),
  ),
}));

import { appAtomRegistry } from "../../state/atom-registry";
import { composerDraftsAtom } from "../../state/use-composer-drafts";
import { registerThreadDismissal } from "./thread-dismissal";
import { dismissThreadUndoNotice, readThreadUndoNotice } from "./thread-undo-notice";
import { useThreadListActions } from "./useThreadListActions";

const primaryEnvironmentId = EnvironmentId.make("primary");
const otherEnvironmentId = EnvironmentId.make("other");

function makeThread(input: Partial<EnvironmentThreadShell> = {}): EnvironmentThreadShell {
  return makeThreadShellFixture({
    id: ThreadId.make("thread"),
    title: "Thread",
    environmentId: primaryEnvironmentId,
    projectId: ProjectId.make("project"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "model" },
    ...input,
  });
}

const mutationCases = [
  ["archiveThread", "archive"],
  ["settleThread", "settle"],
  ["unsettleThread", "unsettle"],
  ["snoozeThread", "snooze"],
  ["unsnoozeThread", "unsnooze"],
  ["pinThread", "pin"],
  ["unpinThread", "unpin"],
  ["regenerateThreadTitle", "regenerateTitle"],
] as const;

beforeEach(() => {
  state.connectedEnvironmentIds = [primaryEnvironmentId, otherEnvironmentId];
  state.failedAction = null;
  state.thrownAction = null;
  // Active ordered by hand: the Working shelf off and the default sort.
  state.preferences = { workingShelfEnabled: false };
  state.heldOrders = [];
  state.titleOutcome = null;
  state.archivedRefreshes = [];
  state.onArchivedRefresh = undefined;
  state.pendingOrder = null;
  state.dropBusy = false;
  state.holdingRows = false;
  state.scopes = new Map([
    [primaryEnvironmentId, new Set([AuthOrchestrationOperateScope])],
    [otherEnvironmentId, new Set<string>()],
  ]);
  state.requests = [];
  state.shells = [];
  state.dialogs = [];
  state.alerts = [];
  state.afterRequest = undefined;
  state.heldActions = new Map();
});

afterEach(() => {
  dismissThreadUndoNotice();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

it("reports a failed title generation as unsuccessful and allows another request", async () => {
  const actions = useThreadListActions();
  const thread = makeThread();
  state.titleOutcome = { status: "failed", message: "Model unavailable" };
  expect(await actions.regenerateThreadTitle(thread)).toBe(false);

  state.titleOutcome = { status: "renamed" };
  expect(await actions.regenerateThreadTitle(thread)).toBe(true);
});

describe("thread list operation permissions", () => {
  it.each(mutationCases)(
    "%s rejects a retained callback after its environment loses permission",
    async (handler) => {
      const actions = useThreadListActions();
      state.scopes.get(primaryEnvironmentId)!.clear();

      await actions[handler](makeThread(), "2099-01-01T00:00:00.000Z");

      expect(state.requests).toEqual([]);
    },
  );

  it.each(mutationCases)("%s requires the target environment's permission", async (handler) => {
    await useThreadListActions()[handler](
      makeThread({ environmentId: otherEnvironmentId }),
      "2099-01-01T00:00:00.000Z",
    );

    expect(state.requests).toEqual([]);
  });

  it("rechecks permission after a retained delete confirmation, then clears the draft", async () => {
    const draft = { text: "unsent", attachments: [] };
    appAtomRegistry.set(composerDraftsAtom, { "primary:thread": draft, "primary:other": draft });
    useThreadListActions().confirmDeleteThread(makeThread());
    const confirm = state.dialogs[0]?.onConfirm;
    expect(confirm).toBeTypeOf("function");
    state.scopes.get(primaryEnvironmentId)!.clear();

    await confirm!();

    expect(state.requests).toEqual([]);
    expect(Object.keys(appAtomRegistry.get(composerDraftsAtom))).toContain("primary:thread");

    state.scopes.get(primaryEnvironmentId)!.add(AuthOrchestrationOperateScope);
    const deleted = new Promise<void>((resolve) => (state.onArchivedRefresh = resolve));
    confirm!();
    await deleted;

    expect(state.requests).toEqual([expect.objectContaining({ action: "delete" })]);
    expect(Object.keys(appAtomRegistry.get(composerDraftsAtom))).toEqual(["primary:other"]);
  });
});

describe("pinned thread operation permissions", () => {
  it("checks every materialization target before writing any keys", async () => {
    const moved = makeThread({ pinnedAt: "2026-09-02T00:00:00.000Z" });
    state.shells = [
      moved,
      makeThread({
        id: ThreadId.make("other-thread"),
        environmentId: otherEnvironmentId,
        pinnedAt: "2026-09-02T00:00:00.000Z",
        createdAt: "2026-09-02T00:00:00.000Z",
      }),
    ];

    expect(await useThreadListActions().moveThread(moved, "up")).toBe(false);
    expect(state.requests).toEqual([]);
  });

  it("moves a keyed thread past a read-only neighbor without writing that neighbor", async () => {
    const moved = makeThread({ pinnedAt: "2026-09-02T00:00:00.000Z", pinOrderKey: "m" });
    state.shells = [
      moved,
      makeThread({
        id: ThreadId.make("other-thread"),
        environmentId: otherEnvironmentId,
        pinnedAt: "2026-09-02T00:00:00.000Z",
        pinOrderKey: "g",
      }),
    ];

    // Rows that wait to show can hold order keys the server has replaced.
    state.holdingRows = true;
    expect(await useThreadListActions().moveThread(moved, "up")).toBe(false);
    expect(state.requests).toEqual([]);
    state.holdingRows = false;

    expect(await useThreadListActions().moveThread(moved, "up")).toBe(true);
    expect(state.requests).toEqual([
      expect.objectContaining({ action: "reorderPin", environmentId: primaryEnvironmentId }),
    ]);
  });

  it("rechecks permission between materialization writes", async () => {
    const moved = makeThread({ pinnedAt: "2026-09-02T00:00:00.000Z" });
    state.shells = [
      moved,
      makeThread({
        id: ThreadId.make("other-thread"),
        pinnedAt: "2026-09-02T00:00:00.000Z",
        createdAt: "2026-09-02T00:00:00.000Z",
      }),
    ];
    state.afterRequest = () => state.scopes.get(primaryEnvironmentId)!.clear();

    expect(await useThreadListActions().moveThread(moved, "up")).toBe(false);
    expect(state.requests).toHaveLength(1);
  });
});

describe("thread reorder connection availability", () => {
  it.each(["active", "pinned"] as const)(
    "rejects %s materialization involving a cached capable offline neighbor",
    async (section) => {
      const moved = makeThread({
        pinnedAt: section === "pinned" ? "2026-09-02T00:00:00.000Z" : null,
      });
      state.shells = [
        moved,
        makeThread({
          id: ThreadId.make("offline-neighbor"),
          environmentId: otherEnvironmentId,
          createdAt: "2026-09-02T00:00:00.000Z",
          pinnedAt: moved.pinnedAt,
        }),
      ];
      state.scopes.get(otherEnvironmentId)?.add(AuthOrchestrationOperateScope);
      state.connectedEnvironmentIds = [primaryEnvironmentId];

      const { moveThread } = useThreadListActions();
      expect(await moveThread(moved, "up")).toBe(false);
      expect(state.requests).toEqual([]);

      state.connectedEnvironmentIds = [primaryEnvironmentId, otherEnvironmentId];

      expect(await moveThread(moved, "up")).toBe(true);
      expect(state.requests).toHaveLength(2);
      expect(new Set(state.requests.map(({ environmentId }) => environmentId))).toEqual(
        new Set([primaryEnvironmentId, otherEnvironmentId]),
      );
    },
  );

  it.each(["active", "pinned"] as const)(
    "uses the latest connection state in a retained %s move callback",
    async (section) => {
      const moved = makeThread({
        pinnedAt: section === "pinned" ? "2026-09-02T00:00:00.000Z" : null,
        pinOrderKey: section === "pinned" ? "m" : null,
        activeOrderKey: section === "active" ? "m" : null,
      });
      state.shells = [
        moved,
        makeThread({
          id: ThreadId.make("offline-neighbor"),
          environmentId: otherEnvironmentId,
          pinnedAt: moved.pinnedAt,
          pinOrderKey: section === "pinned" ? "g" : null,
          activeOrderKey: section === "active" ? "g" : null,
        }),
      ];
      const { moveThread } = useThreadListActions();
      state.connectedEnvironmentIds = [];

      expect(await moveThread(moved, "up")).toBe(false);
      expect(state.requests).toEqual([]);

      state.connectedEnvironmentIds = [primaryEnvironmentId];

      expect(await moveThread(moved, "up")).toBe(true);
      expect(state.requests).toEqual([
        expect.objectContaining({
          action: section === "pinned" ? "reorderPin" : "reorderActive",
          environmentId: primaryEnvironmentId,
        }),
      ]);
    },
  );
});

describe("thread action undo", () => {
  it.each([
    ["settleThread", "settle", "Settled", "unsettle"],
    ["snoozeThread", "snooze", "Snoozed", "unsnooze"],
  ] as const)(
    "%s keeps the successful request's undo when a duplicate is rejected",
    async (handler, action, notice, inverse) => {
      const actions = useThreadListActions();
      const thread = makeThread();
      const first = actions[handler](thread, "2099-01-01T09:00:00.000Z");

      expect(await actions[handler](thread, "2099-01-01T09:00:00.000Z")).toBe(false);
      expect(await first).toBe(true);
      expect(state.requests.map(({ action }) => action)).toEqual([action]);
      expect(readThreadUndoNotice()?.action).toBe(notice);
      await readThreadUndoNotice()!.undo();
      expect(state.requests.map(({ action }) => action)).toEqual([action, inverse]);
    },
  );

  it("keeps the latest unpin undo after concurrent unpin requests", async () => {
    const actions = useThreadListActions();
    const thread = makeThread();
    expect(await Promise.all([actions.unpinThread(thread), actions.unpinThread(thread)])).toEqual([
      true,
      true,
    ]);
    expect(readThreadUndoNotice()?.action).toBe("Unpinned");
    await readThreadUndoNotice()!.undo();
    expect(state.requests.map(({ action }) => action)).toEqual(["unpin", "unpin", "pin"]);
  });

  it("rejects a concurrent archive request without sending another mutation", async () => {
    const actions = useThreadListActions();
    const thread = makeThread();
    const first = actions.archiveThread(thread);
    expect(await actions.archiveThread(thread)).toBe(false);
    expect(await first).toBe(true);
    expect(state.requests.map(({ action }) => action)).toEqual(["archive"]);
    expect(state.archivedRefreshes).toEqual([primaryEnvironmentId]);
  });

  it("sends a different action while one is pending for the same thread", async () => {
    const actions = useThreadListActions();
    const thread = makeThread();
    const settleResponse = Promise.withResolvers<void>();
    state.heldActions.set("settle", settleResponse.promise);

    const pending = [
      actions.settleThread(thread),
      actions.unsettleThread(thread),
      actions.settleThread(thread),
    ];
    settleResponse.resolve();

    expect(await Promise.all(pending)).toEqual([true, true, true]);
    expect(state.requests.map(({ action }) => action)).toEqual(["settle", "unsettle", "settle"]);
  });

  it("restores pin placement and snooze after settling, only once", async () => {
    const thread = makeThread({
      pinnedAt: "2026-09-02T00:00:00.000Z",
      pinOrderKey: "m",
      snoozedUntil: "2099-01-01T09:00:00.000Z",
    });
    expect(await useThreadListActions().settleThread(thread)).toBe(true);
    const undo = readThreadUndoNotice()!.undo;
    expect(readThreadUndoNotice()?.action).toBe("Settled");
    await undo();
    await undo();
    expect(state.requests.map(({ action }) => action)).toEqual([
      "settle",
      "unsettle",
      "pin",
      "snooze",
    ]);
    expect(state.requests[2]?.input).toEqual({ threadId: thread.id, orderKey: "m" });
    expect(state.requests[3]?.input).toEqual({
      threadId: thread.id,
      snoozedUntil: thread.snoozedUntil,
    });
    expect(readThreadUndoNotice()).toBeNull();
  });

  // regression: #21401 restore archive and thread action undo
  it("wakes a snoozed thread through the undo action", async () => {
    const thread = makeThread();
    await useThreadListActions().snoozeThread(thread, "2099-01-01T09:00:00.000Z");
    expect(readThreadUndoNotice()?.action).toBe("Snoozed");
    await readThreadUndoNotice()!.undo();
    expect(state.requests.at(-1)).toMatchObject({
      action: "unsnooze",
      environmentId: thread.environmentId,
      input: { threadId: thread.id, reason: "user" },
    });
  });

  it.each([null, "2099-01-01T09:00:00.000Z", "2000-01-01T09:00:00.000Z"])(
    "restores an unpinned thread's previous position and unexpired snooze (%s)",
    async (snoozedUntil) => {
      const thread = makeThread({
        pinnedAt: "2026-09-02T00:00:00.000Z",
        pinOrderKey: "m",
        snoozedUntil,
      });
      await useThreadListActions().unpinThread(thread);
      expect(readThreadUndoNotice()?.action).toBe("Unpinned");
      await readThreadUndoNotice()!.undo();
      // 2099 is the unexpired case; 2000 has long passed.
      const restoresSnooze = snoozedUntil === "2099-01-01T09:00:00.000Z";
      expect(state.requests.map(({ action }) => action)).toEqual(
        restoresSnooze ? ["unpin", "pin", "snooze"] : ["unpin", "pin"],
      );
      expect(state.requests[1]).toMatchObject({
        action: "pin",
        input: { threadId: thread.id, orderKey: "m" },
      });
      if (restoresSnooze) {
        expect(state.requests[2]).toMatchObject({
          action: "snooze",
          environmentId: thread.environmentId,
          input: { threadId: thread.id, snoozedUntil },
        });
      }
    },
  );

  it.each(["settleThread", "unpinThread"] as const)(
    "%s plans its undo from the live row when the list holds an older one",
    async (handler) => {
      const held = makeThread({ pinnedAt: "2026-09-02T00:00:00.000Z", pinOrderKey: "m" });
      const live = makeThread({
        pinnedAt: "2026-09-02T00:00:00.000Z",
        pinOrderKey: "t",
        snoozedUntil: "2099-01-01T09:00:00.000Z",
      });
      state.shells = [live];
      await useThreadListActions()[handler](held);
      await readThreadUndoNotice()!.undo();
      expect(state.requests.slice(-2)).toMatchObject([
        { action: "pin", input: { threadId: live.id, orderKey: "t" } },
        { action: "snooze", input: { threadId: live.id, snoozedUntil: live.snoozedUntil } },
      ]);
    },
  );

  // regression: #21401 restore archive and thread action undo
  it("does not restore snooze if undoing an unpin fails", async () => {
    const thread = makeThread({
      pinnedAt: "2026-09-02T00:00:00.000Z",
      snoozedUntil: "2099-01-01T09:00:00.000Z",
    });
    await useThreadListActions().unpinThread(thread);
    state.failedAction = "pin";
    await readThreadUndoNotice()!.undo();
    expect(state.requests.map(({ action }) => action)).toEqual(["unpin", "pin"]);
  });

  it("invalidates a retained undo when another hook pins the thread", async () => {
    const thread = makeThread();
    await useThreadListActions().unpinThread(thread);
    const undo = readThreadUndoNotice()!.undo;
    await useThreadListActions().pinThread(thread);
    await undo();
    expect(state.requests.map(({ action }) => action)).toEqual(["unpin", "pin"]);
    expect(readThreadUndoNotice()).toBeNull();
  });

  // regression: #21401 restore archive and thread action undo
  it("does not offer undo for a failed action", async () => {
    state.failedAction = "settle";
    expect(await useThreadListActions().settleThread(makeThread())).toBe(false);
    expect(readThreadUndoNotice()).toBeNull();
  });

  it("stops restoring after a failed inverse command", async () => {
    const thread = makeThread({
      pinnedAt: "2026-09-02T00:00:00.000Z",
      snoozedUntil: "2099-01-01T09:00:00.000Z",
    });
    await useThreadListActions().settleThread(thread);
    state.failedAction = "unsettle";
    await readThreadUndoNotice()!.undo();
    expect(state.requests.map(({ action }) => action)).toEqual(["settle", "unsettle"]);
    expect(state.alerts.at(-1)?.title).toBe("Could not un-settle thread");
  });

  it("rechecks the destination permission before undoing", async () => {
    await useThreadListActions().unpinThread(makeThread());
    state.scopes.get(primaryEnvironmentId)!.clear();
    await readThreadUndoNotice()!.undo();
    expect(state.requests.map(({ action }) => action)).toEqual(["unpin"]);
  });

  // regression: #21401 restore archive and thread action undo
  it("expires undo after five seconds", async () => {
    vi.useFakeTimers();
    await useThreadListActions().unpinThread(makeThread());
    const undo = readThreadUndoNotice()!.undo;
    vi.advanceTimersByTime(5_000);
    expect(readThreadUndoNotice()).toBeNull();
    await undo();
    expect(state.requests.map(({ action }) => action)).toEqual(["unpin"]);
  });

  it("keeps the earlier Undo until archiving succeeds", async () => {
    const actions = useThreadListActions();
    const thread = makeThread();
    await actions.settleThread(thread);
    state.failedAction = "archive";
    expect(await actions.archiveThread(thread)).toBe(false);
    expect(readThreadUndoNotice()?.action).toBe("Settled");

    state.failedAction = null;
    expect(await actions.archiveThread(thread)).toBe(true);
    expect(readThreadUndoNotice()).toBeNull();
  });
});

describe("thread archive guard", () => {
  it("keeps active provider runs out of the archive", async () => {
    const thread = makeThread({
      runtime: {
        status: "running",
        activeRunId: RunId.make("active-run"),
        providerInstanceId: ProviderInstanceId.make("codex"),
        providerName: "codex",
        lastError: null,
        updatedAt: "2026-09-02T00:00:00.000Z",
      },
    });
    expect(await useThreadListActions().archiveThread(thread)).toBe(false);
    expect(state.requests).toEqual([]);
    expect(state.archivedRefreshes).toEqual([]);
    expect(state.alerts.at(-1)?.title).toBe("Could not archive thread");

    // A list can hold a row from before the run started.
    state.shells = [thread];
    expect(await useThreadListActions().archiveThread(makeThread())).toBe(false);
    expect(state.requests).toEqual([]);
  });
});

describe("thread drops", () => {
  const PINNED_AT = "2026-09-02T00:00:00.000Z";
  const INTO_ACTIVE = { section: "active", targetId: null, placement: "before" } as const;
  const INTO_SETTLED = { section: "settled", targetId: null, placement: "before" } as const;
  const neighbor = (input: Partial<EnvironmentThreadShell> = {}) =>
    makeThread({ id: ThreadId.make("neighbor"), ...input });
  const actions = () => state.requests.map(({ action }) => action);

  /** Counts the swipe-off dismissals a row of this thread would play. */
  function watchDismissals(thread: EnvironmentThreadShell) {
    const counter = { dismissals: 0 };
    const unregister = registerThreadDismissal(`${thread.environmentId}:${thread.id}`, () => {
      counter.dismissals += 1;
      return { finished: Promise.resolve(), restore: () => {} };
    });
    return Object.assign(counter, { unregister });
  }

  it.each([
    ["a reorder", "reorderPin", "up", { pinnedAt: PINNED_AT, pinOrderKey: "m" }],
    ["a pin", "pin", { section: "pinned", targetId: null, placement: "before" }, {}],
    ["an unpin", "unpin", INTO_ACTIVE, { pinnedAt: PINNED_AT, pinOrderKey: "m" }],
    ["a settle", "settle", INTO_SETTLED, {}],
    ["an un-settle", "unsettle", INTO_ACTIVE, { settledOverride: "settled" }],
    ["a wake", "unsnooze", INTO_ACTIVE, { snoozedUntil: "2099-01-01T09:00:00.000Z" }],
  ] as const)(
    "clears the drop lock and the held order when %s rejects",
    async (_name, action, destination, input) => {
      const moved = makeThread(input);
      state.shells = [
        moved,
        neighbor(action === "reorderPin" ? { pinnedAt: PINNED_AT, pinOrderKey: "g" } : {}),
      ];
      const { moveThread } = useThreadListActions();
      state.thrownAction = action;

      await expect(moveThread(moved, destination)).rejects.toThrow("Connection dropped");
      expect(state.dropBusy).toBe(false);
      expect(state.pendingOrder).toBeNull();

      // The next move is not refused.
      state.thrownAction = null;
      state.requests = [];
      expect(await moveThread(moved, destination)).toBe(true);
      expect(actions()).toContain(action);
      expect(state.dropBusy).toBe(false);
    },
  );

  it("clears the drop lock and the held order when a mutation fails", async () => {
    const moved = makeThread({ pinnedAt: PINNED_AT, pinOrderKey: "m" });
    state.shells = [moved, neighbor({ pinnedAt: PINNED_AT, pinOrderKey: "g" })];
    state.failedAction = "reorderPin";

    expect(await useThreadListActions().moveThread(moved, "up")).toBe(false);
    expect(state.dropBusy).toBe(false);
    expect(state.pendingOrder).toBeNull();
  });

  it.each([
    ["settle", INTO_SETTLED, {}],
    ["unpin", INTO_ACTIVE, { pinnedAt: PINNED_AT, pinOrderKey: "m" }],
    ["unsettle", INTO_ACTIVE, { settledOverride: "settled" }],
    ["unsnooze", INTO_ACTIVE, { snoozedUntil: "2099-01-01T09:00:00.000Z" }],
  ] as const)(
    "a drop that needs %s leaves the row in the list",
    async (action, destination, input) => {
      const moved = makeThread(input);
      state.shells = [moved, neighbor()];
      const row = watchDismissals(moved);

      expect(await useThreadListActions().moveThread(moved, destination)).toBe(true);
      expect(actions()).toContain(action);
      // No swipe off screen and no collapse: the row waits where it is for its new place.
      expect(row.dismissals).toBe(0);
      row.unregister();
    },
  );

  it.each(["settleThread", "unpinThread", "unsettleThread", "unsnoozeThread"] as const)(
    "%s from the row itself still dismisses the row",
    async (handler) => {
      const thread = makeThread();
      const row = watchDismissals(thread);

      expect(await useThreadListActions()[handler](thread)).toBe(true);
      expect(row.dismissals).toBe(1);
      row.unregister();
    },
  );

  describe("into an Active ordered by time", () => {
    it.each([
      ["the Working shelf", { workingShelfEnabled: true }],
      ["the shelf's default", {}],
      ["longest waiting", { workingShelfEnabled: false, inboxSortOrder: "longest_waiting" }],
    ] as const)("changes only the thread's state under %s", async (_name, preferences) => {
      state.preferences = preferences;
      const cases = [
        ["unpin", { pinnedAt: PINNED_AT, pinOrderKey: "m" }],
        ["unsettle", { settledOverride: "settled" }],
        ["unsnooze", { snoozedUntil: "2099-01-01T09:00:00.000Z" }],
      ] as const;
      for (const [action, input] of cases) {
        const moved = makeThread(input);
        state.shells = [moved, neighbor({ activeOrderKey: "g" })];
        state.requests = [];

        expect(
          await useThreadListActions().moveThread(moved, {
            section: "active",
            targetId: "primary:neighbor",
            placement: "after",
          }),
        ).toBe(true);
        // No order key: Active sorts by time and would ignore it.
        expect(actions()).toEqual([action]);
      }
      expect(state.heldOrders).toEqual([]);
      expect(state.dropBusy).toBe(false);
    });

    it("does nothing for a move within Active", async () => {
      state.preferences = { workingShelfEnabled: true };
      const moved = makeThread({ activeOrderKey: "m" });
      state.shells = [moved, neighbor({ activeOrderKey: "g" })];
      const { moveThread } = useThreadListActions();

      expect(await moveThread(moved, "up")).toBe(false);
      expect(
        await moveThread(moved, {
          section: "active",
          targetId: "primary:neighbor",
          placement: "before",
        }),
      ).toBe(false);
      expect(state.requests).toEqual([]);
      expect(state.dropBusy).toBe(false);
    });

    it("still reorders Pinned", async () => {
      state.preferences = { workingShelfEnabled: true };
      const moved = makeThread({ pinnedAt: PINNED_AT, pinOrderKey: "m" });
      state.shells = [moved, neighbor({ pinnedAt: PINNED_AT, pinOrderKey: "g" })];

      expect(await useThreadListActions().moveThread(moved, "up")).toBe(true);
      expect(actions()).toEqual(["reorderPin"]);
    });

    it("orders Active by hand until the preferences have loaded", async () => {
      state.preferences = null;
      const moved = makeThread({ pinnedAt: PINNED_AT, pinOrderKey: "m" });
      state.shells = [moved, neighbor({ activeOrderKey: "g" })];

      expect(await useThreadListActions().moveThread(moved, INTO_ACTIVE)).toBe(true);
      expect(actions()).toEqual(["unpin", "reorderActive"]);
    });
  });

  it.each([
    ["Active", INTO_ACTIVE, { pinnedAt: PINNED_AT, pinOrderKey: "m" }, {}],
    [
      "Pinned",
      { section: "pinned", targetId: null, placement: "before" },
      {},
      { pinnedAt: PINNED_AT, pinOrderKey: "g" },
    ],
  ] as const)(
    "holds the dropped row's slot in %s while its state change lands",
    async (_name, destination, input, neighborInput) => {
      const moved = makeThread(input);
      state.shells = [moved, neighbor(neighborInput)];

      expect(await useThreadListActions().moveThread(moved, destination)).toBe(true);
      // The hold names the row that joins, so its arrival does not read as a foreign change.
      expect(state.heldOrders).toEqual([expect.objectContaining({ arriving: "primary:thread" })]);
    },
  );

  it("names no arriving row for a move within a section", async () => {
    const moved = makeThread({ pinnedAt: PINNED_AT, pinOrderKey: "m" });
    state.shells = [moved, neighbor({ pinnedAt: PINNED_AT, pinOrderKey: "g" })];

    expect(await useThreadListActions().moveThread(moved, "up")).toBe(true);
    expect(state.heldOrders).toHaveLength(1);
    expect(state.heldOrders[0]?.arriving).toBeUndefined();
  });
});

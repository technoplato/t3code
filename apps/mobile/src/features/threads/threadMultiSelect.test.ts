import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { scopedThreadKey } from "../../lib/scopedEntities";
import { makeThreadShellFixture } from "../../test-fixtures";
import { resolveBulkThreadActionTargets, toggleSelectedThreadKey } from "./threadMultiSelect";

const envId = EnvironmentId.make("env-1");

function makeThread(
  id: string,
  overrides: Partial<EnvironmentThreadShell> = {},
): EnvironmentThreadShell {
  return makeThreadShellFixture({
    environmentId: envId,
    id: ThreadId.make(id),
    title: id,
    runtime: null,
    ...overrides,
  });
}

describe("resolveBulkThreadActionTargets", () => {
  it("partitions active, snoozed, settled, and blocked threads for bulk actions", () => {
    const active = makeThread("active");
    const snoozed = makeThread("snoozed", { snoozedUntil: "2026-06-02T12:00:00.000Z" });
    const settled = makeThread("settled", {
      settledOverride: "settled",
      settledAt: "2026-06-01T09:00:00.000Z",
    });
    const needsApproval = makeThread("approval", { hasPendingApprovals: true });
    const unselected = makeThread("unselected");

    const selectedKeys = new Set([
      scopedThreadKey(envId, active.id),
      scopedThreadKey(envId, snoozed.id),
      scopedThreadKey(envId, settled.id),
      scopedThreadKey(envId, needsApproval.id),
    ]);

    const result = resolveBulkThreadActionTargets({
      threads: [active, snoozed, settled, needsApproval, unselected],
      selectedKeys,
      now: "2026-06-01T10:00:00.000Z",
      snoozeEnvironmentIds: new Set([envId]),
      settlementEnvironmentIds: new Set([envId]),
    });

    expect(result.selectedThreads.map((t) => t.id)).toEqual([
      active.id,
      snoozed.id,
      settled.id,
      needsApproval.id,
    ]);
    expect(result.snoozableThreads.map((t) => t.id)).toEqual([active.id, settled.id]);
    expect(result.unsnoozableThreads.map((t) => t.id)).toEqual([snoozed.id]);
    expect(result.settlableThreads.map((t) => t.id)).toEqual([
      active.id,
      snoozed.id,
      needsApproval.id,
    ]);
    expect(result.unsettlableThreads.map((t) => t.id)).toEqual([settled.id]);
  });
});

describe("toggleSelectedThreadKey", () => {
  it("adds and removes thread keys immutably", () => {
    const first = toggleSelectedThreadKey(new Set(), "env-1:a");
    expect([...first]).toEqual(["env-1:a"]);
    const second = toggleSelectedThreadKey(first, "env-1:b");
    expect([...second]).toEqual(["env-1:a", "env-1:b"]);
    const third = toggleSelectedThreadKey(second, "env-1:a");
    expect([...third]).toEqual(["env-1:b"]);
  });
});

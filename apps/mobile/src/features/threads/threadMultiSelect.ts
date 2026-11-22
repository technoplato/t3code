import type { EnvironmentId } from "@t3tools/contracts";
import { canSnooze, effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

import { scopedThreadKey } from "../../lib/scopedEntities";

export interface BulkThreadActionTargets {
  readonly selectedThreads: ReadonlyArray<EnvironmentThreadShell>;
  readonly snoozableThreads: ReadonlyArray<EnvironmentThreadShell>;
  readonly unsnoozableThreads: ReadonlyArray<EnvironmentThreadShell>;
  readonly settlableThreads: ReadonlyArray<EnvironmentThreadShell>;
  readonly unsettlableThreads: ReadonlyArray<EnvironmentThreadShell>;
}

export function resolveBulkThreadActionTargets(input: {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly selectedKeys: ReadonlySet<string>;
  readonly now: string;
  readonly snoozeEnvironmentIds: ReadonlySet<EnvironmentId>;
  readonly settlementEnvironmentIds: ReadonlySet<EnvironmentId>;
}): BulkThreadActionTargets {
  if (input.selectedKeys.size === 0) {
    return {
      selectedThreads: [],
      snoozableThreads: [],
      unsnoozableThreads: [],
      settlableThreads: [],
      unsettlableThreads: [],
    };
  }

  const selectedThreads: EnvironmentThreadShell[] = [];
  const snoozableThreads: EnvironmentThreadShell[] = [];
  const unsnoozableThreads: EnvironmentThreadShell[] = [];
  const settlableThreads: EnvironmentThreadShell[] = [];
  const unsettlableThreads: EnvironmentThreadShell[] = [];

  for (const thread of input.threads) {
    if (thread.archivedAt !== null) continue;
    const key = scopedThreadKey(thread.environmentId, thread.id);
    if (!input.selectedKeys.has(key)) continue;

    selectedThreads.push(thread);

    const snoozeSupported = input.snoozeEnvironmentIds.has(thread.environmentId);
    const isSnoozed = snoozeSupported && effectiveSnoozed(thread, { now: input.now });
    if (isSnoozed) {
      unsnoozableThreads.push(thread);
    } else if (snoozeSupported && canSnooze(thread, { now: input.now })) {
      snoozableThreads.push(thread);
    }

    const settlementSupported = input.settlementEnvironmentIds.has(thread.environmentId);
    if (settlementSupported) {
      if (thread.settledOverride === "settled") {
        unsettlableThreads.push(thread);
      } else {
        settlableThreads.push(thread);
      }
    }
  }

  return {
    selectedThreads,
    snoozableThreads,
    unsnoozableThreads,
    settlableThreads,
    unsettlableThreads,
  };
}

export function toggleSelectedThreadKey(
  selectedKeys: ReadonlySet<string>,
  threadKey: string,
): ReadonlySet<string> {
  const next = new Set(selectedKeys);
  if (next.has(threadKey)) {
    next.delete(threadKey);
  } else {
    next.add(threadKey);
  }
  return next;
}

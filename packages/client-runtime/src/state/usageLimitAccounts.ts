import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import type { LimitAccount, LimitPool } from "@t3tools/shared/usageLimits";
import * as Schema from "effect/Schema";

export const LimitAccountSort = Schema.Literals([
  "reset",
  "manual",
  "sessionMostLeft",
  "sessionMostUsed",
  "weekMostLeft",
  "weekMostUsed",
  "weekSoonest",
]);
export type LimitAccountSort = typeof LimitAccountSort.Type;

export const LIMIT_ACCOUNT_SORTS = LimitAccountSort.literals;

/** How one client arranges the accounts on the Limits view. `order` holds account keys. */
export const LimitAccountsView = Schema.Struct({
  sort: LimitAccountSort,
  hideEmptySessions: Schema.Boolean,
  hideEmptyWeeks: Schema.Boolean,
  order: Schema.Array(Schema.String),
});
export type LimitAccountsView = typeof LimitAccountsView.Type;

export const DEFAULT_LIMIT_ACCOUNTS_VIEW: LimitAccountsView = {
  sort: "reset",
  hideEmptySessions: false,
  hideEmptyWeeks: false,
  order: [],
};

export function isDefaultLimitAccountsView(view: LimitAccountsView): boolean {
  return view.sort === "reset" && !view.hideEmptySessions && !view.hideEmptyWeeks;
}

export interface ArrangedLimitPool extends LimitPool {
  /** Accounts the filters put away, in the view's order. Revealing appends them to `accounts`. */
  readonly hidden: readonly LimitAccount[];
  readonly hiddenEmptySessions: number;
  readonly hiddenEmptyWeeks: number;
}

type Kind = "session" | "weekly";

// Pool members carry the session a spent week blocks as spent, so they are read instead of reports.
function windowsOf(pool: LimitPool, account: LimitAccount, kind: Kind) {
  const windows = pool.windows
    .filter((window) => window.kind === kind)
    .flatMap((window) =>
      window.members.filter((member) => member.account.key === account.key).map((m) => m.window),
    );
  if (kind === "session" || account.driver !== "claudeAgent") return windows;
  // Claude's model-specific weeks sit under the account's own week, which gates all of them.
  const own = windows.filter((window) => window.id === "seven_day");
  return own.length > 0 ? own : windows;
}

function resetMillis(window: ServerProviderUsageWindow): number | null {
  if (window.resetsAt === undefined) return null;
  const at = Date.parse(window.resetsAt);
  return Number.isFinite(at) ? at : null;
}

// A reset that already passed means the read is stale, not that the window is still spent.
function isSpent(window: ServerProviderUsageWindow, now: number): boolean {
  const reset = resetMillis(window);
  return window.usedPercent >= 100 && (reset === null || reset > now);
}

/** An account with no window of that kind is not empty: it has nothing to run out of. */
function isEmpty(pool: LimitPool, account: LimitAccount, kind: Kind, now: number): boolean {
  const windows = windowsOf(pool, account, kind);
  return windows.length > 0 && windows.every((window) => isSpent(window, now));
}

const missingLast = (left: number | null, right: number | null, direction: 1 | -1) =>
  left === null || right === null
    ? Number(left === null) - Number(right === null)
    : (left - right) * direction;

function comparator(pool: LimitPool, view: LimitAccountsView) {
  const { sort } = view;
  if (sort === "reset") return null;
  if (sort === "manual") {
    const position = new Map(view.order.map((key, index) => [key, index]));
    return (left: LimitAccount, right: LimitAccount) =>
      missingLast(position.get(left.key) ?? null, position.get(right.key) ?? null, 1);
  }
  const kind: Kind = sort.startsWith("session") ? "session" : "weekly";
  const usage = new Map(
    pool.accounts.map((account) => {
      const window = windowsOf(pool, account, kind)[0];
      return [
        account.key,
        {
          left: window ? 100 - window.usedPercent : null,
          reset: window ? resetMillis(window) : null,
        },
      ];
    }),
  );
  const direction = sort.endsWith("MostLeft") ? -1 : 1;
  return (left: LimitAccount, right: LimitAccount) => {
    const a = usage.get(left.key)!;
    const b = usage.get(right.key)!;
    return (
      (sort === "weekSoonest" ? 0 : missingLast(a.left, b.left, direction)) ||
      missingLast(a.reset, b.reset, 1)
    );
  };
}

// The sort is stable, so ties and accounts a manual order has not placed keep the pool's order.
function sortedAccounts(pool: LimitPool, view: LimitAccountsView): readonly LimitAccount[] {
  const compare = comparator(pool, view);
  return compare ? [...pool.accounts].sort(compare) : pool.accounts;
}

/**
 * Applies a client's sort and filters to pooled limits. Totals stay those of the whole pool:
 * a filter hides an account's column and rows, not its share of the quota.
 */
export function arrangeLimitPools(
  pools: readonly LimitPool[],
  view: LimitAccountsView,
  now: number,
  revealHidden = false,
): readonly ArrangedLimitPool[] {
  return pools.map((pool) => {
    const sorted = sortedAccounts(pool, view);
    const emptySessions = new Set(
      view.hideEmptySessions
        ? sorted.filter((account) => isEmpty(pool, account, "session", now))
        : [],
    );
    const emptyWeeks = new Set(
      view.hideEmptyWeeks ? sorted.filter((account) => isEmpty(pool, account, "weekly", now)) : [],
    );
    const isHidden = (account: LimitAccount) =>
      emptySessions.has(account) || emptyWeeks.has(account);
    const hidden = sorted.filter(isHidden);
    const shown = sorted.filter((account) => !isHidden(account));
    const accounts = revealHidden ? [...shown, ...hidden] : shown;
    return {
      ...pool,
      accounts,
      windows: pool.windows
        .map((window) => {
          const columns = new Map(window.columns.map((column) => [column.account.key, column]));
          return { ...window, columns: accounts.map((account) => columns.get(account.key)!) };
        })
        .filter((window) => window.columns.some((column) => column.window !== null)),
      hidden,
      hiddenEmptySessions: emptySessions.size,
      hiddenEmptyWeeks: emptyWeeks.size,
    };
  });
}

/**
 * Drops `activeKey` where `overKey` sits and switches to the manual order. Every pool's current
 * order is kept, so the move is the only thing that changes on screen.
 */
export function moveLimitAccount(
  pools: readonly LimitPool[],
  view: LimitAccountsView,
  activeKey: string,
  overKey: string,
): LimitAccountsView {
  const orders = pools.map((pool) => sortedAccounts(pool, view).map((account) => account.key));
  const keys = orders.find((order) => order.includes(activeKey));
  const to = keys?.indexOf(overKey) ?? -1;
  if (!keys || to === -1 || activeKey === overKey) return view;
  keys.splice(keys.indexOf(activeKey), 1);
  keys.splice(to, 0, activeKey);
  const placed = new Set(orders.flat());
  return {
    ...view,
    sort: "manual",
    order: [...view.order.filter((key) => !placed.has(key)), ...orders.flat()],
  };
}

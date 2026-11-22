import type {
  AuthSessionId,
  ClientActivityIdentity,
  ClientKind,
  ClientView,
  RpcClientId,
} from "@t3tools/contracts";

export const MAX_CLIENT_VIEWS_PER_RPC_CLIENT = 4;

export interface TrackedClientView {
  readonly sessionId: AuthSessionId;
  readonly rpcClientId: RpcClientId;
  readonly clientId: string;
  readonly clientKind: ClientKind;
  readonly identity?: ClientActivityIdentity | undefined;
  readonly view: ClientView;
  /** The gesture on this server's clock: when the report arrived, less the age the client gave. */
  readonly rankedGestureAtMs: number;
  readonly updatedAtMs: number;
  readonly expiresAtMs: number;
}

export type ClientViewRegistry = ReadonlyMap<string, TrackedClientView>;

type Connection = Pick<TrackedClientView, "sessionId" | "rpcClientId">;

function clientViewKey(connection: Connection, windowId: string): string {
  return JSON.stringify([connection.sessionId, connection.rpcClientId, windowId]);
}

function isSameConnection(entry: TrackedClientView, connection: Connection): boolean {
  return entry.sessionId === connection.sessionId && entry.rpcClientId === connection.rpcClientId;
}

function isLive(entry: TrackedClientView, nowMs: number): boolean {
  return entry.expiresAtMs > nowMs;
}

export function upsertClientView(
  registry: ClientViewRegistry,
  report: Connection &
    Pick<TrackedClientView, "clientId" | "clientKind" | "identity" | "view"> & {
      /** The client's clock when it sent the report, the same clock its gesture time is on. */
      readonly observedAtMs: number;
      readonly ttlMs: number;
    },
  nowMs: number,
): Map<string, TrackedClientView> {
  const next = new Map<string, TrackedClientView>();
  for (const [key, entry] of registry) {
    if (isLive(entry, nowMs)) next.set(key, entry);
  }

  const key = clientViewKey(report, report.view.windowId);
  const existing = next.get(key);
  // A report overtaken on the wire must not put an older view back.
  if (existing !== undefined && report.view.seq < existing.view.seq) return next;

  if (existing === undefined) {
    const sameConnection = [...next].filter(([, entry]) => isSameConnection(entry, report));
    if (sameConnection.length >= MAX_CLIENT_VIEWS_PER_RPC_CLIENT) {
      const [oldestKey] = sameConnection.reduce((oldest, candidate) =>
        candidate[1].updatedAtMs < oldest[1].updatedAtMs ? candidate : oldest,
      );
      next.delete(oldestKey);
    }
  }

  // Two devices' clocks disagree, so only the age is taken from the client. A report that repeats
  // a gesture keeps its rank: the time a heartbeat spent on the wire is not a newer gesture.
  const rankedGestureAtMs =
    existing !== undefined && existing.view.lastGestureAtMs === report.view.lastGestureAtMs
      ? existing.rankedGestureAtMs
      : nowMs - Math.max(0, report.observedAtMs - report.view.lastGestureAtMs);

  next.set(key, {
    sessionId: report.sessionId,
    rpcClientId: report.rpcClientId,
    clientId: report.clientId,
    clientKind: report.clientKind,
    ...(report.identity === undefined ? {} : { identity: report.identity }),
    view: report.view,
    rankedGestureAtMs,
    updatedAtMs: nowMs,
    expiresAtMs: nowMs + report.ttlMs,
  });
  return next;
}

/** Returns the registry it was given when the connection holds no view. */
export function removeRpcClientViews(
  registry: ClientViewRegistry,
  connection: Connection,
): ClientViewRegistry {
  const next = new Map(registry);
  for (const [key, entry] of next) {
    if (isSameConnection(entry, connection)) next.delete(key);
  }
  return next.size === registry.size ? registry : next;
}

/** Focus first, then the latest gesture, then `seq`. Nothing a server observes moves a rank. */
function outranks(candidate: TrackedClientView, current: TrackedClientView): boolean {
  if (candidate.view.focused !== current.view.focused) return candidate.view.focused;
  if (candidate.rankedGestureAtMs !== current.rankedGestureAtMs) {
    return candidate.rankedGestureAtMs > current.rankedGestureAtMs;
  }
  return candidate.view.seq > current.view.seq;
}

export function winningClientView(
  registry: ClientViewRegistry,
  nowMs: number,
): TrackedClientView | null {
  let winner: TrackedClientView | null = null;
  for (const entry of registry.values()) {
    if (isLive(entry, nowMs) && (winner === null || outranks(entry, winner))) winner = entry;
  }
  return winner;
}

export function nextClientViewExpiryMs(registry: ClientViewRegistry, nowMs: number): number | null {
  let next: number | null = null;
  for (const entry of registry.values()) {
    if (isLive(entry, nowMs) && (next === null || entry.expiresAtMs < next)) {
      next = entry.expiresAtMs;
    }
  }
  return next;
}

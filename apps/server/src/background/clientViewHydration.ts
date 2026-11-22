import {
  type AuthClientMetadata,
  CLIENT_VIEW_MAX_SELECTION_LENGTH,
  type ClientKind,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

import type { TrackedClientView } from "./clientViewRegistry.ts";

export const MAX_VISIBLE_TEXT_LENGTH = 4096;
export const MAX_PENDING_BLOCKER_LENGTH = 512;
const MAX_TOOL_NAME_LENGTH = 80;
/** How far a cut moves to reach a line or word boundary. */
const BOUNDARY_REACH = 160;
const ELLIPSIS = "…";

const SnapshotClientKind = Schema.Literals(["desktop", "web", "mobile"]);

const snapshotBaseFields = {
  version: Schema.Literal(1),
  capturedAtMs: Schema.Number,
} as const;

const NullableText = Schema.NullOr(Schema.String);

/** Null where neither the client nor its sign-in said. */
const SnapshotClient = Schema.Struct({
  /** One per install or browser profile; windows of one desktop app share it. */
  clientId: Schema.String,
  /** `phone`, `tablet` or `desktop`. */
  formFactor: NullableText,
  os: NullableText,
  osVersion: NullableText,
  deviceModel: NullableText,
  browser: NullableText,
  appName: NullableText,
  appVersion: NullableText,
  /** A browser only: `hosted` or `server`. */
  webDeployment: NullableText,
  /** How the client reaches this server: `local`, `direct`, `relay` or `ssh`. */
  connection: NullableText,
});

const snapshotWindowFields = {
  leaseExpiresAtMs: Schema.Number,
  clientKind: SnapshotClientKind,
  deviceName: NullableText,
  client: SnapshotClient,
  windowId: Schema.String,
  environmentId: Schema.String,
  threadId: Schema.String,
} as const;

const ActiveClientViewSnapshot = Schema.Struct({
  ...snapshotBaseFields,
  ...snapshotWindowFields,
  state: Schema.Literal("active"),
  appBundleId: Schema.NullOr(Schema.String),
  seq: Schema.Number,
  focused: Schema.Boolean,
  lastGestureAtMs: Schema.Number,
  threadTitle: Schema.String,
  projectTitle: Schema.NullOr(Schema.String),
  workspaceRoot: Schema.NullOr(Schema.String),
  threadStatus: Schema.String,
  agentLabel: Schema.String,
  runStartedAtMs: Schema.NullOr(Schema.Number),
  focusedItemId: Schema.NullOr(Schema.String),
  streaming: Schema.Boolean,
  visibleItems: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      kind: Schema.String,
      from: Schema.Number,
      to: Schema.Number,
    }),
  ),
  visibleText: Schema.String,
  selectedText: Schema.NullOr(Schema.String),
  pendingBlocker: Schema.NullOr(Schema.String),
  truncated: Schema.Boolean,
});
type ActiveClientViewSnapshot = typeof ActiveClientViewSnapshot.Type;

/** What `client-view.json` holds. Thread text appears only in the `active` state. */
export const ClientViewSnapshot = Schema.Union([
  Schema.Struct({ ...snapshotBaseFields, state: Schema.Literal("none") }),
  Schema.Struct({
    ...snapshotBaseFields,
    ...snapshotWindowFields,
    state: Schema.Literal("other-environment"),
  }),
  ActiveClientViewSnapshot,
]);
export type ClientViewSnapshot = typeof ClientViewSnapshot.Type;

type ViewMessage = Pick<OrchestrationV2ConversationMessage, "role" | "text" | "streaming">;

/** The server's own records for one viewed thread; nothing here comes from a client. */
export interface ClientViewThreadData {
  readonly shell: Pick<
    OrchestrationV2ThreadShell,
    | "title"
    | "status"
    | "providerInstanceId"
    | "modelSelection"
    | "activityRunStartedAt"
    | "latestRunStartedAt"
    | "pendingRuntimeRequest"
  >;
  readonly project: { readonly title: string; readonly workspaceRoot: string } | null;
  /** Both maps are keyed by the id a client reported and hold only this thread's records. */
  readonly messages: ReadonlyMap<string, ViewMessage>;
  readonly turnItems: ReadonlyMap<string, OrchestrationV2TurnItem>;
  readonly pendingRequestItem: OrchestrationV2TurnItem | null;
}

function clampFraction(value: number): number {
  return Number.isFinite(value) ? Math.min(Math.max(value, 0), 1) : 0;
}

function isLowSurrogate(text: string, index: number): boolean {
  const code = text.charCodeAt(index);
  return code >= 0xdc00 && code <= 0xdfff;
}

function snapStart(text: string, index: number): number {
  const floor = Math.max(0, index - BOUNDARY_REACH);
  const line = text.lastIndexOf("\n", index - 1);
  if (line >= floor) return line + 1;
  for (let cursor = index; cursor > floor; cursor -= 1) {
    if (/\s/u.test(text[cursor - 1]!)) return cursor;
  }
  return floor === 0 ? 0 : isLowSurrogate(text, index) ? index - 1 : index;
}

function snapEnd(text: string, index: number): number {
  const ceiling = Math.min(text.length, index + BOUNDARY_REACH);
  const line = text.indexOf("\n", index);
  if (line !== -1 && line <= ceiling) return line;
  for (let cursor = index; cursor < ceiling; cursor += 1) {
    if (/\s/u.test(text[cursor]!)) return cursor;
  }
  return ceiling === text.length ? ceiling : isLowSurrogate(text, index) ? index + 1 : index;
}

/**
 * The part of `text` between two fractions of its length, widened to whole lines where one ends
 * nearby and to whole words otherwise. A cut edge is marked with an ellipsis.
 */
export function sliceVisibleText(text: string, from: number, to: number): string {
  const lower = Math.min(clampFraction(from), clampFraction(to));
  const upper = Math.max(clampFraction(from), clampFraction(to));
  if (upper <= lower || text.length === 0) return "";
  const start = lower === 0 ? 0 : snapStart(text, Math.floor(text.length * lower));
  const end = upper === 1 ? text.length : snapEnd(text, Math.ceil(text.length * upper));
  const slice = text.slice(start, end).trim();
  if (slice.length === 0) return "";
  return `${start > 0 ? ELLIPSIS : ""}${slice}${end < text.length ? ELLIPSIS : ""}`;
}

function capText(text: string, maxLength: number): { text: string; truncated: boolean } {
  if (text.length <= maxLength) return { text, truncated: false };
  const limit = maxLength - ELLIPSIS.length;
  const boundary = text.slice(0, limit + 1).search(/\s\S*$/u);
  const end = boundary > limit - BOUNDARY_REACH ? boundary : limit;
  const cut = isLowSurrogate(text, end) ? end - 1 : end;
  return { text: `${text.slice(0, cut).trimEnd()}${ELLIPSIS}`, truncated: true };
}

function toolLine(name: string): string {
  const compact = name.replace(/\s+/gu, " ").trim();
  return `[tool: ${compact.slice(0, MAX_TOOL_NAME_LENGTH) || "tool"}]`;
}

type ItemContent =
  | { readonly kind: string; readonly prose: string; readonly streaming: boolean }
  | { readonly kind: string; readonly line: string | null; readonly streaming: boolean };

/** Prose for what a person wrote or reads; a tool is only ever named, never quoted. */
export function describeTurnItem(item: OrchestrationV2TurnItem): ItemContent {
  switch (item.type) {
    case "user_message":
      return { kind: "user", prose: item.text, streaming: false };
    case "assistant_message":
      return { kind: "assistant", prose: item.text, streaming: item.streaming };
    case "proposed_plan":
      return { kind: "plan", prose: item.markdown, streaming: item.streaming };
    case "todo_list":
      return {
        kind: "plan",
        prose: item.steps.map((step) => `- ${step.text}`).join("\n"),
        streaming: false,
      };
    case "approval_request":
      return { kind: "approval", line: `[approval: ${item.requestKind}]`, streaming: false };
    case "user_input_request":
      return { kind: "question", line: "[question]", streaming: false };
    case "dynamic_tool":
      return { kind: "tool", line: toolLine(item.toolName ?? "tool"), streaming: false };
    case "command_execution":
      return { kind: "tool", line: toolLine("command"), streaming: false };
    case "file_change":
      return { kind: "tool", line: toolLine("edit"), streaming: false };
    case "file_search":
      return { kind: "tool", line: toolLine("file-search"), streaming: false };
    case "web_search":
      return { kind: "tool", line: toolLine("web-search"), streaming: false };
    case "subagent":
      return { kind: "tool", line: toolLine("subagent"), streaming: false };
    case "reasoning":
      return { kind: item.type, line: null, streaming: item.streaming };
    default:
      return { kind: item.type, line: null, streaming: false };
  }
}

function describeMessage(message: ViewMessage): ItemContent {
  return message.role === "system"
    ? { kind: "system", line: null, streaming: message.streaming }
    : { kind: message.role, prose: message.text, streaming: message.streaming };
}

/** What a pending approval or question asks, as the user sees it. */
function pendingBlockerText(data: ClientViewThreadData): string | null {
  const request = data.shell.pendingRuntimeRequest;
  if (request === null) return null;
  const item = data.pendingRequestItem;
  const asked = (() => {
    switch (item?.type) {
      case "approval_request":
        return item.prompt ?? item.reason ?? item.title;
      case "user_input_request":
        return item.questions.map((question) => question.question).join("\n");
      case "secret_request":
        return item.reason || item.label;
      case "link_request":
        return item.reason;
      default:
        return null;
    }
  })();
  const text = asked?.trim() || `[pending: ${request.kind}]`;
  return capText(text, MAX_PENDING_BLOCKER_LENGTH).text;
}

function snapshotClientKind(kind: ClientKind): "desktop" | "web" | "mobile" {
  if (kind === "desktop-renderer") return "desktop";
  return kind === "mobile" ? "mobile" : "web";
}

/** What a session's sign-in recorded about its client: all a client that sends no identity gives. */
export type ViewSessionClient = Pick<AuthClientMetadata, "label" | "deviceType" | "os" | "browser">;

function sessionFormFactor(session: ViewSessionClient | null): string | null {
  if (session?.deviceType === "mobile") return "phone";
  return session?.deviceType === "tablet" || session?.deviceType === "desktop"
    ? session.deviceType
    : null;
}

export type ViewClientDescription = Pick<
  ActiveClientViewSnapshot,
  "clientKind" | "deviceName" | "client"
>;

/** Which client holds the view: what it reported, then what its sign-in recorded. */
export function describeViewClient(input: {
  readonly tracked: Pick<TrackedClientView, "clientId" | "clientKind" | "identity">;
  readonly session: ViewSessionClient | null;
  /** This server's host name, for a client that runs on the same machine. */
  readonly hostName: string | null;
}): ViewClientDescription {
  const { tracked, session } = input;
  const identity = tracked.identity ?? {};
  const clientKind = snapshotClientKind(tracked.clientKind);
  const os = identity.os ?? session?.os ?? null;
  // A desktop app's sign-in names the engine it embeds, which is not a browser anyone picked.
  const browser = identity.browser ?? (clientKind === "web" ? session?.browser : null) ?? null;
  return {
    clientKind,
    deviceName:
      identity.deviceName ??
      input.hostName ??
      (browser !== null && os !== null ? `${browser} on ${os}` : null) ??
      session?.label ??
      os,
    client: {
      clientId: tracked.clientId,
      formFactor:
        identity.formFactor ??
        sessionFormFactor(session) ??
        (clientKind === "desktop" ? "desktop" : null),
      os,
      osVersion: identity.osVersion ?? null,
      deviceModel: identity.deviceModel ?? null,
      browser,
      appName: identity.appName ?? null,
      appVersion: identity.appVersion ?? null,
      webDeployment: identity.webDeployment ?? null,
      connection: identity.connection ?? null,
    },
  };
}

function epochMillis(value: DateTime.Utc | null | undefined): number | null {
  return value === null || value === undefined ? null : DateTime.toEpochMillis(value);
}

export function hydrateActiveClientView(input: {
  readonly tracked: TrackedClientView;
  readonly thread: ClientViewThreadData;
  readonly client: ViewClientDescription;
  readonly appBundleId: string | null;
  readonly capturedAtMs: number;
}): ActiveClientViewSnapshot {
  const { tracked, thread } = input;
  const { view } = tracked;
  const visibleItems: Array<ActiveClientViewSnapshot["visibleItems"][number]> = [];
  const pieces: string[] = [];
  let streaming = false;
  let focusedProse: { readonly id: string; readonly length: number } | null = null;

  // An id this thread does not hold is dropped: a client names items, it never supplies them.
  for (const reported of view.items ?? []) {
    const message = thread.messages.get(reported.id);
    const turnItem = message === undefined ? thread.turnItems.get(reported.id) : undefined;
    if (message === undefined && turnItem === undefined) continue;
    const content = message !== undefined ? describeMessage(message) : describeTurnItem(turnItem!);
    const from = Math.min(clampFraction(reported.from), clampFraction(reported.to));
    const to = Math.max(clampFraction(reported.from), clampFraction(reported.to));
    visibleItems.push({ id: reported.id, kind: content.kind, from, to });
    streaming ||= content.streaming;
    const piece = "prose" in content ? sliceVisibleText(content.prose, from, to) : content.line;
    if (!piece || pieces.at(-1) === piece) continue;
    pieces.push(piece);
    if ("prose" in content && piece.length > (focusedProse?.length ?? 0)) {
      focusedProse = { id: reported.id, length: piece.length };
    }
  }

  const visible = capText(pieces.join("\n\n"), MAX_VISIBLE_TEXT_LENGTH);
  const selectedItemId = view.selection?.itemId;
  const selectedText = view.selection?.text.slice(0, CLIENT_VIEW_MAX_SELECTION_LENGTH) || null;
  const { shell } = thread;

  return {
    version: 1,
    state: "active",
    capturedAtMs: input.capturedAtMs,
    leaseExpiresAtMs: tracked.expiresAtMs,
    ...input.client,
    appBundleId: input.appBundleId,
    windowId: view.windowId,
    seq: view.seq,
    focused: view.focused,
    lastGestureAtMs: view.lastGestureAtMs,
    environmentId: view.environmentId,
    threadId: view.threadId,
    threadTitle: shell.title,
    projectTitle: thread.project?.title ?? null,
    workspaceRoot: thread.project?.workspaceRoot ?? null,
    threadStatus: shell.status,
    agentLabel: `${shell.providerInstanceId} ${shell.modelSelection.model}`,
    runStartedAtMs: epochMillis(shell.activityRunStartedAt ?? shell.latestRunStartedAt),
    focusedItemId:
      (selectedItemId !== undefined && visibleItems.some((item) => item.id === selectedItemId)
        ? selectedItemId
        : null) ??
      focusedProse?.id ??
      visibleItems[0]?.id ??
      null,
    streaming,
    visibleItems,
    visibleText: visible.text,
    selectedText,
    pendingBlocker: pendingBlockerText(thread),
    truncated: visible.truncated,
  };
}

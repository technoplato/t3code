import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  CLIENT_VIEW_MAX_ITEMS,
  CLIENT_VIEW_MAX_SELECTION_LENGTH,
  ClientActivityReportInput,
} from "./background.ts";

const decodeReport = Schema.decodeUnknownSync(ClientActivityReportInput);

// The report as a server built before the view existed decodes it.
const { view: _view, ...olderFields } = ClientActivityReportInput.fields;
const decodeOlderReport = Schema.decodeUnknownSync(Schema.Struct(olderFields));

const report = {
  clientId: "client-1",
  clientKind: "web",
  visible: true,
  focused: true,
  recentlyInteracted: true,
  scopes: [{ type: "provider-status" }],
  observedAt: DateTime.makeUnsafe("2026-05-13T00:00:00.000Z"),
} as const;

const view = {
  windowId: "window-1",
  seq: 3,
  focused: true,
  lastGestureAtMs: 1_000,
  environmentId: "environment-1",
  threadId: "thread-1",
  items: [{ id: "message-1", kind: "assistant", from: 0.25, to: 0.75 }],
  selection: { itemId: "message-1", text: "selected" },
} as const;

describe("ClientActivityReportInput", () => {
  it("decodes with and without a view", () => {
    expect(decodeReport(report).view).toBeUndefined();
    expect(decodeReport({ ...report, view }).view).toEqual(view);
    const { items: _items, selection: _selection, ...metadata } = view;
    expect(decodeReport({ ...report, view: metadata }).view).toEqual(metadata);
  });

  it("is ignored by a server whose schema predates the view", () => {
    const decoded = decodeOlderReport({ ...report, view });
    expect(decoded).not.toHaveProperty("view");
    expect(decoded.scopes).toEqual(report.scopes);
    // The RPC layer decodes with the default; this is the behaviour it relies on.
    expect(() => decodeOlderReport({ ...report, view }, { onExcessProperty: "error" })).toThrow();
  });

  it("bounds what a view can carry", () => {
    const item = { id: "message-1", from: 0, to: 1 };
    const decodeView = (overrides: object) =>
      decodeReport({ ...report, view: { ...view, ...overrides } });
    expect(decodeView({ items: [item] }).view?.items).toEqual([item]);
    expect(() => decodeView({ items: [{ ...item, to: 1.5 }] })).toThrow();
    expect(() => decodeView({ items: [{ ...item, from: -0.1 }] })).toThrow();
    expect(() =>
      decodeView({ items: Array.from({ length: CLIENT_VIEW_MAX_ITEMS + 1 }, () => item) }),
    ).toThrow();
    expect(() =>
      decodeView({ selection: { text: "x".repeat(CLIENT_VIEW_MAX_SELECTION_LENGTH + 1) } }),
    ).toThrow();
    expect(() => decodeView({ windowId: " " })).toThrow();
    expect(() => decodeView({ seq: -1 })).toThrow();
  });
});

import { describe, expect, it } from "vite-plus/test";

import {
  readDisclosureOverride,
  toolRowExpandsByDefault,
  writeDisclosureOverride,
} from "./TimelineWorkEntryRow.logic";

describe("toolRowExpandsByDefault", () => {
  const row = {
    expandToolCallsByDefault: true,
    canExpand: true,
    isSystemNotice: false,
    isNotification: false,
  };

  it("opens an expandable tool call only while the setting is on", () => {
    expect(toolRowExpandsByDefault(row)).toBe(true);
    expect(toolRowExpandsByDefault({ ...row, expandToolCallsByDefault: false })).toBe(false);
  });

  it("never opens a row with nothing to show, a notice, or a notification", () => {
    expect(toolRowExpandsByDefault({ ...row, canExpand: false })).toBe(false);
    expect(toolRowExpandsByDefault({ ...row, isSystemNotice: true })).toBe(false);
    expect(toolRowExpandsByDefault({ ...row, isNotification: true })).toBe(false);
  });
});

describe("disclosure overrides", () => {
  it("remembers a collapse, so a group the setting opens stays closed after it remounts", () => {
    const state = { expandedEntries: new Set<string>(), collapsedEntries: new Set<string>() };
    expect(readDisclosureOverride(state, "subagent-group:1")).toBeNull();

    writeDisclosureOverride(state, "subagent-group:1", false);
    expect(readDisclosureOverride(state, "subagent-group:1")).toBe(false);

    writeDisclosureOverride(state, "subagent-group:1", true);
    expect(readDisclosureOverride(state, "subagent-group:1")).toBe(true);
    expect(state.collapsedEntries.size).toBe(0);
  });
});

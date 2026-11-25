import { describe, expect, it } from "vite-plus/test";

import {
  clampWorkGroupExpandedHeightPx,
  resolveToolOutputMaxHeightClassName,
  resolveWorkGroupBaseMaxHeightCss,
  shouldVirtualizeFullHeightWorkGroup,
} from "./workLogScrollHeight";

describe("work log scroll heights", () => {
  it("bounds one tool output on every preset, full included", () => {
    expect(resolveToolOutputMaxHeightClassName("default")).toBe("max-h-80");
    expect(resolveToolOutputMaxHeightClassName("tall")).toBe("max-h-[min(36rem,80dvh)]");
    expect(resolveToolOutputMaxHeightClassName("full")).toBe("max-h-[80dvh]");
  });

  it("lets expanded rows widen their group by at most a share of the viewport", () => {
    expect(clampWorkGroupExpandedHeightPx(200, 1000)).toBe(200);
    expect(clampWorkGroupExpandedHeightPx(4_000, 1000)).toBe(600);
  });

  it("full renders a group inline until a long group opens every call itself", () => {
    expect(resolveWorkGroupBaseMaxHeightCss("full", 400)).toBeUndefined();
    expect(shouldVirtualizeFullHeightWorkGroup("full", true, 16)).toBe(true);
    expect(shouldVirtualizeFullHeightWorkGroup("full", true, 15)).toBe(false);
    expect(shouldVirtualizeFullHeightWorkGroup("full", false, 60)).toBe(false);
    expect(shouldVirtualizeFullHeightWorkGroup("tall", true, 60)).toBe(false);
  });
});

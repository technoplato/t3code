import { describe, expect, it } from "vite-plus/test";

import { linkedMessageId, linkedMessageOffset } from "./threadMessageLink.ts";

describe("linkedMessageId", () => {
  it("reads the id a link names, however the router delivers it", () => {
    expect(linkedMessageId("message-1")).toBe("message-1");
    expect(linkedMessageId(" message-1 ")).toBe("message-1");
    expect(linkedMessageId(["message-1", "message-2"])).toBe("message-1");
    expect(linkedMessageId(42)).toBe("42");
  });

  it("ignores a link that names nothing usable", () => {
    for (const value of [undefined, null, "", "   ", {}, [], true, "x".repeat(257)]) {
      expect(linkedMessageId(value)).toBeNull();
    }
  });
});

describe("linkedMessageOffset", () => {
  it("reads how far down the item a link points, however the router delivers it", () => {
    expect(linkedMessageOffset("0.4")).toBe(0.4);
    expect(linkedMessageOffset(" 0.25 ")).toBe(0.25);
    expect(linkedMessageOffset(["0.4", "0.9"])).toBe(0.4);
    expect(linkedMessageOffset(0.4)).toBe(0.4);
    expect(linkedMessageOffset("1")).toBe(1);
  });

  it("means the item's start for anything outside (0, 1]", () => {
    for (const value of [
      undefined,
      null,
      "",
      " ",
      "0",
      0,
      "-0.1",
      "1.01",
      2,
      "half",
      {},
      [],
      true,
    ]) {
      expect(linkedMessageOffset(value)).toBeNull();
    }
    for (const value of ["NaN", Number.NaN, "Infinity", Number.POSITIVE_INFINITY]) {
      expect(linkedMessageOffset(value)).toBeNull();
    }
  });
});

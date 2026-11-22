import { describe, expect, it } from "vite-plus/test";

import { linkedMessageId } from "./threadMessageLink.ts";

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

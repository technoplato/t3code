import { describe, expect, it } from "vite-plus/test";

import { createSwipeRowActivation } from "./swipe-row-activation";

describe("createSwipeRowActivation", () => {
  it("defers changes while a finger is on the list so a press is never remounted", () => {
    const activation = createSwipeRowActivation();
    activation.activate(["a"]);

    activation.trackTouches(["1"], ["1"]);
    activation.activate(["b"]);
    activation.activate(["c"]);
    expect(activation.isActive("a")).toBe(true);
    expect(activation.isActive("c")).toBe(false);

    activation.trackTouches([], []);
    expect(activation.isActive("a")).toBe(false);
    expect(activation.isActive("b")).toBe(false);
    expect(activation.isActive("c")).toBe(true);
  });

  it("ignores fingers that did not start on the list", () => {
    const activation = createSwipeRowActivation();
    activation.trackTouches(["1"], ["1", "2"]);
    activation.activate(["a"]);

    activation.trackTouches([], ["2"]);
    expect(activation.isActive("a")).toBe(true);
  });

  it("forgets its fingers when a gesture took the touch away without an end event", () => {
    const activation = createSwipeRowActivation();
    activation.trackTouches(["1"], ["1"]);
    activation.activate(["a"]);
    expect(activation.isActive("a")).toBe(false);

    // A thread drag ended: the row it scrolled in wakes without waiting for another touch.
    activation.resetTouches();
    expect(activation.isActive("a")).toBe(true);

    // With nothing waiting, a reset changes nothing, and later changes apply at once.
    activation.resetTouches();
    activation.activate(["b"]);
    expect(activation.isActive("b")).toBe(true);
  });

  it("drops a list finger whose end event never arrived", () => {
    const activation = createSwipeRowActivation();
    activation.trackTouches(["1"], ["1"]);
    activation.activate(["a"]);

    activation.trackTouches(["2"], ["2"]);
    activation.trackTouches([], []);
    expect(activation.isActive("a")).toBe(true);
  });
});

import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import { isSpeakerAllowed, parseT3VoiceCommand } from "./scribe-t3-voice-parser.mjs";

const { describe, it } = NodeTest;
const assert = NodeAssert;

describe("isSpeakerAllowed", () => {
  it("allows self speaker label, generic speaker clusters, and empty speakers", () => {
    assert.equal(isSpeakerAllowed({ kind: "segment.final", speaker: "🧢" }, "🧢"), true);
    assert.equal(isSpeakerAllowed({ kind: "segment.final", speaker: "speaker 0" }, "🧢"), true);
    assert.equal(isSpeakerAllowed({ kind: "segment.final", speaker: "speaker 3" }, "🧢"), true);
    assert.equal(isSpeakerAllowed({ kind: "segment.final" }, "🧢"), true);
  });

  it("rejects system audio, named other speakers, replays, and byHim=false", () => {
    assert.equal(isSpeakerAllowed({ kind: "segment.final", speaker: "System Audio" }, "🧢"), false);
    assert.equal(isSpeakerAllowed({ kind: "segment.final", speaker: "Mrs Rachel" }, "🧢"), false);
    assert.equal(isSpeakerAllowed({ kind: "segment.final", speaker: "Mr Aaron" }, "🧢"), false);
    assert.equal(
      isSpeakerAllowed({ kind: "segment.final", speaker: "🧢", replay: true }, "🧢"),
      false,
    );
    assert.equal(
      isSpeakerAllowed({ kind: "segment.final", speaker: "🧢", byHim: false }, "🧢"),
      false,
    );
    assert.equal(isSpeakerAllowed({ kind: "audio.copy", speaker: "🧢" }, "🧢"), false);
  });
});

describe("parseT3VoiceCommand", () => {
  it("parses message navigation and counts", () => {
    assert.deepEqual(
      {
        command: parseT3VoiceCommand("T3, previous message")?.command,
        args: parseT3VoiceCommand("T3, previous message")?.args,
      },
      { command: "navigate-message", args: { direction: "previous", count: 1 } },
    );

    const upTwo = parseT3VoiceCommand("Hey T3, go up two messages.");
    assert.equal(upTwo?.command, "navigate-message");
    assert.deepEqual(upTwo?.args, { direction: "previous", count: 2 });

    const next = parseT3VoiceCommand("T three, next answer");
    assert.equal(next?.command, "navigate-message");
    assert.deepEqual(next?.args, { direction: "next", count: 1 });

    const top = parseT3VoiceCommand("T3 Code, jump to top");
    assert.equal(top?.command, "navigate-message");
    assert.deepEqual(top?.args, { direction: "top" });

    const bottom = parseT3VoiceCommand("Scroll to bottom, T3.");
    assert.equal(bottom?.command, "navigate-message");
    assert.deepEqual(bottom?.args, { direction: "bottom" });
  });

  it("parses smooth scrolling", () => {
    const down = parseT3VoiceCommand("T3, scroll down");
    assert.equal(down?.command, "scroll");
    assert.deepEqual(down?.args, { direction: "down", amount: 0.75 });

    const upLittle = parseT3VoiceCommand("Okay T3, scroll up a little");
    assert.equal(upLittle?.command, "scroll");
    assert.deepEqual(upLittle?.args, { direction: "up", amount: 0.4 });
  });

  it("parses thinking, tool calls, and scroll height controls", () => {
    assert.deepEqual(parseT3VoiceCommand("T3, expand thinking")?.args, { mode: "on" });
    assert.deepEqual(parseT3VoiceCommand("T3, collapse thinking traces")?.args, { mode: "off" });
    assert.deepEqual(parseT3VoiceCommand("T3, toggle tools")?.args, { mode: "toggle" });
    assert.deepEqual(parseT3VoiceCommand("T3, full height")?.args, { value: "full" });
    assert.deepEqual(parseT3VoiceCommand("T3, tall height")?.args, { value: "tall" });
    assert.deepEqual(parseT3VoiceCommand("T3, default height")?.args, { value: "default" });
  });

  it("parses thread switching, routes, and panels", () => {
    const nextWorking = parseT3VoiceCommand("T3, next working thread");
    assert.equal(nextWorking?.command, "open-thread");
    assert.deepEqual(nextWorking?.args, { direction: "next", scope: "working" });
    assert.equal(nextWorking?.focusWindow, true);

    const openNamed = parseT3VoiceCommand("T3, open Show Linked Gemini Quota");
    assert.equal(openNamed?.command, "open-thread");
    assert.deepEqual(openNamed?.args, { query: "Show Linked Gemini Quota" });

    const numbered = parseT3VoiceCommand("T3, thread two");
    assert.equal(numbered?.command, "open-thread");
    assert.deepEqual(numbered?.args, { index: 2 });

    const quota = parseT3VoiceCommand("T3, show quota");
    assert.equal(quota?.command, "open-route");
    assert.deepEqual(quota?.args, { route: "usage" });

    const sidebar = parseT3VoiceCommand("T3, toggle sidebar");
    assert.equal(sidebar?.command, "toggle-panel");
    assert.deepEqual(sidebar?.args, { panel: "sidebar" });
  });

  it("parses explicit send/steer/stop/focus and ignores casual speech", () => {
    const send = parseT3VoiceCommand("T3, send please run the tests");
    assert.equal(send?.command, "send-message");
    assert.deepEqual(send?.args, { text: "please run the tests", mode: "auto" });

    const steer = parseT3VoiceCommand("T3, steer skip playwright for now");
    assert.equal(steer?.command, "send-message");
    assert.deepEqual(steer?.args, { text: "skip playwright for now", mode: "steer" });

    assert.equal(parseT3VoiceCommand("T3, stop generating")?.command, "stop-thread");
    assert.equal(parseT3VoiceCommand("T3, focus")?.command, "focus");

    // Casual mentions must NOT trigger commands
    assert.equal(parseT3VoiceCommand("I really like using T3 Code for this project"), null);
    assert.equal(parseT3VoiceCommand("Can we scroll down on the webpage?"), null);
    assert.equal(parseT3VoiceCommand("Next message please"), null);
    assert.equal(parseT3VoiceCommand("We should open the foldkit repo in T3"), null);
  });
});

const NUMBER_WORDS = new Map([
  ["a", 1],
  ["an", 1],
  ["one", 1],
  ["two", 2],
  ["to", 2],
  ["too", 2],
  ["three", 3],
  ["four", 4],
  ["for", 4],
  ["five", 5],
  ["six", 6],
  ["seven", 7],
  ["eight", 8],
  ["nine", 9],
  ["ten", 10],
  ["first", 1],
  ["second", 2],
  ["third", 3],
  ["fourth", 4],
  ["fifth", 5],
  ["sixth", 6],
  ["seventh", 7],
  ["eighth", 8],
  ["ninth", 9],
  ["tenth", 10],
]);

const LEADING_WAKE_RE =
  /^(?:(?:hey|ok|okay|yo|uh|um|and|so|please)\s+)*(?:t[\s-]*3(?:\s+code)?|t3code|t\s+three(?:\s+code)?|tee\s+three(?:\s+code)?|tea\s+three(?:\s+code)?)(?:\s*[,.:;!?-]+\s*|\s+)(.+)$/i;

const TRAILING_WAKE_RE =
  /^(.+?)(?:\s*[,.:;!?-]+\s*|\s+)(?:t[\s-]*3(?:\s+code)?|t3code|t\s+three(?:\s+code)?|tee\s+three(?:\s+code)?|tea\s+three(?:\s+code)?)[.!?,\s]*$/i;

function normalizeWhitespace(value) {
  return String(value ?? "")
    .replace(/[‘’`´]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function stripTrailingPunctuation(value) {
  return value.replace(/[.!?,;:\s]+$/g, "").trim();
}

function stripLeadingFillers(value) {
  return value
    .replace(/^(?:(?:please|can you|could you|would you|go ahead and|just|uh|um)\s+)+/i, "")
    .trim();
}

function parseSmallCount(token) {
  if (!token) return null;
  const cleaned = token.toLowerCase().trim();
  if (/^\d+$/.test(cleaned)) {
    const num = Number(cleaned);
    return num >= 1 && num <= 20 ? num : null;
  }
  return NUMBER_WORDS.get(cleaned) ?? null;
}

/**
 * Speaker filter matching Scribe's `isHis` + excluding known other named speakers.
 * Accepts self speaker label from meta.json (e.g. "🧢"), generic "speaker N" labels,
 * or blank speaker labels; rejects system audio, broadcasts, replays, and named others
 * like "Mrs Rachel" or "Mr Aaron".
 */
export function isSpeakerAllowed(record, selfSpeakerLabel = null) {
  if (!record || record.kind !== "segment.final") return false;
  if (record.replay === true) return false;
  if (record.byHim === false) return false;

  const rawSpeaker = typeof record.speaker === "string" ? record.speaker.trim() : "";
  if (rawSpeaker.length === 0) return true;
  if (/^system audio/i.test(rawSpeaker)) return false;
  if (/^speaker\s*\d+$/i.test(rawSpeaker)) return true;

  const lower = rawSpeaker.toLowerCase();
  if (lower === "michael" || lower === "me" || lower === "you" || rawSpeaker === "🧢") {
    return true;
  }
  if (selfSpeakerLabel && rawSpeaker.toLowerCase() === selfSpeakerLabel.trim().toLowerCase()) {
    return true;
  }
  return false;
}

function matchBody(rawBody, allowFreeform) {
  const cleaned = stripLeadingFillers(stripTrailingPunctuation(normalizeWhitespace(rawBody)));
  if (!cleaned) return null;
  const lower = cleaned.toLowerCase();

  // 1. Explicit send / steer (leading wake only, never trailing wake)
  if (allowFreeform) {
    const steerMatch = /^(?:steer(?:\s+(?:it|this|the thread))?(?:\s+to|\s+with)?)\s+(.+)$/i.exec(
      cleaned,
    );
    if (steerMatch?.[1]?.trim()) {
      const text = steerMatch[1].trim();
      return {
        commandId: "t3.send-message",
        command: "send-message",
        args: { text, mode: "steer" },
        focusWindow: false,
        label: `Steer: ${text.slice(0, 48)}`,
      };
    }

    const sendMatch =
      /^(?:send(?:\s+message)?|tell(?:\s+it|\s+the\s+agent|\s+them)?|reply(?:\s+with)?|ask(?:\s+it)?)\s+(.+)$/i.exec(
        cleaned,
      );
    if (sendMatch?.[1]?.trim()) {
      const text = sendMatch[1].trim();
      return {
        commandId: "t3.send-message",
        command: "send-message",
        args: { text, mode: "auto" },
        focusWindow: false,
        label: `Send: ${text.slice(0, 48)}`,
      };
    }
  }

  // 2. Message navigation (Cmd+Up / Cmd+Down / top / bottom)
  if (
    /^(?:(?:go|jump|scroll)\s+to\s+(?:the\s+)?)?(?:top(?:\s+of(?:\s+the)?\s+(?:thread|chat|conversation))?|first\s+(?:message|answer)|beginning(?:\s+of(?:\s+the)?\s+thread)?|all\s+the\s+way\s+up)$/i.test(
      lower,
    )
  ) {
    return {
      commandId: "t3.navigate-message.top",
      command: "navigate-message",
      args: { direction: "top" },
      focusWindow: false,
      label: "Top of thread",
    };
  }

  if (
    /^(?:(?:go|jump|scroll)\s+to\s+(?:the\s+)?)?(?:bottom(?:\s+of(?:\s+the)?\s+(?:thread|chat|conversation))?|latest\s+(?:message|answer|reply)|end(?:\s+of(?:\s+the)?\s+thread)?|all\s+the\s+way\s+down|follow(?:\s+bottom)?)$/i.test(
      lower,
    )
  ) {
    return {
      commandId: "t3.navigate-message.bottom",
      command: "navigate-message",
      args: { direction: "bottom" },
      focusWindow: false,
      label: "Bottom of thread",
    };
  }

  const prevMsgMatch =
    /^(?:(?:go|jump|step|move)\s+)?(?:(?:up|back)\s+(?:(\w+)\s+)?(?:messages?|answers?|replies|responses?)|(?:previous|prev|last)\s+(?:(\w+)\s+)?(?:messages?|answers?|replies|responses?)|step\s+up)$/i.exec(
      lower,
    );
  if (prevMsgMatch) {
    const count = parseSmallCount(prevMsgMatch[1] ?? prevMsgMatch[2]) ?? 1;
    return {
      commandId: "t3.navigate-message.previous",
      command: "navigate-message",
      args: { direction: "previous", count },
      focusWindow: false,
      label: count > 1 ? `Previous ${count} messages` : "Previous message",
    };
  }

  const nextMsgMatch =
    /^(?:(?:go|jump|step|move)\s+)?(?:(?:down|forward)\s+(?:(\w+)\s+)?(?:messages?|answers?|replies|responses?)|next\s+(?:(\w+)\s+)?(?:messages?|answers?|replies|responses?)|step\s+down)$/i.exec(
      lower,
    );
  if (nextMsgMatch) {
    const count = parseSmallCount(nextMsgMatch[1] ?? nextMsgMatch[2]) ?? 1;
    return {
      commandId: "t3.navigate-message.next",
      command: "navigate-message",
      args: { direction: "next", count },
      focusWindow: false,
      label: count > 1 ? `Next ${count} messages` : "Next message",
    };
  }

  // 3. Smooth scrolling
  const scrollUpMatch =
    /^(?:scroll\s+up|page\s+up)(?:\s+(a\s+little|a\s+bit|slightly|half|a\s+lot|more|twice))?$/i.exec(
      lower,
    );
  if (scrollUpMatch) {
    const mod = scrollUpMatch[1] ?? "";
    const amount = /little|bit|slightly|half/.test(mod)
      ? 0.4
      : /lot|more|twice/.test(mod)
        ? 1.25
        : 0.75;
    return {
      commandId: "t3.scroll.up",
      command: "scroll",
      args: { direction: "up", amount },
      focusWindow: false,
      label: "Scroll up",
    };
  }

  const scrollDownMatch =
    /^(?:scroll\s+down|page\s+down)(?:\s+(a\s+little|a\s+bit|slightly|half|a\s+lot|more|twice))?$/i.exec(
      lower,
    );
  if (scrollDownMatch) {
    const mod = scrollDownMatch[1] ?? "";
    const amount = /little|bit|slightly|half/.test(mod)
      ? 0.4
      : /lot|more|twice/.test(mod)
        ? 1.25
        : 0.75;
    return {
      commandId: "t3.scroll.down",
      command: "scroll",
      args: { direction: "down", amount },
      focusWindow: false,
      label: "Scroll down",
    };
  }

  // 4. Thinking traces, tool calls, and scroll-box height
  if (
    /^(?:expand|open|show|unfold)\s+(?:the\s+)?thinking(?:\s+traces?)?$|^thinking\s+on$/i.test(
      lower,
    )
  ) {
    return {
      commandId: "t3.set-thinking.on",
      command: "set-thinking",
      args: { mode: "on" },
      focusWindow: false,
      label: "Expand thinking",
    };
  }
  if (
    /^(?:collapse|close|hide|fold)\s+(?:the\s+)?thinking(?:\s+traces?)?$|^thinking\s+off$/i.test(
      lower,
    )
  ) {
    return {
      commandId: "t3.set-thinking.off",
      command: "set-thinking",
      args: { mode: "off" },
      focusWindow: false,
      label: "Collapse thinking",
    };
  }
  if (/^toggle\s+(?:the\s+)?thinking(?:\s+traces?)?$/i.test(lower)) {
    return {
      commandId: "t3.set-thinking.toggle",
      command: "set-thinking",
      args: { mode: "toggle" },
      focusWindow: false,
      label: "Toggle thinking",
    };
  }

  if (/^(?:expand|open|show|unfold)\s+(?:the\s+)?tool(?:\s*calls?|s)$|^tools?\s+on$/i.test(lower)) {
    return {
      commandId: "t3.set-tools.on",
      command: "set-tools",
      args: { mode: "on" },
      focusWindow: false,
      label: "Expand tool calls",
    };
  }
  if (
    /^(?:collapse|close|hide|fold)\s+(?:the\s+)?tool(?:\s*calls?|s)$|^tools?\s+off$/i.test(lower)
  ) {
    return {
      commandId: "t3.set-tools.off",
      command: "set-tools",
      args: { mode: "off" },
      focusWindow: false,
      label: "Collapse tool calls",
    };
  }
  if (/^toggle\s+(?:the\s+)?tool(?:\s*calls?|s)$/i.test(lower)) {
    return {
      commandId: "t3.set-tools.toggle",
      command: "set-tools",
      args: { mode: "toggle" },
      focusWindow: false,
      label: "Toggle tool calls",
    };
  }

  if (
    /^(?:full\s+height|no\s+scroll\s*box|expand\s+(?:work\s*log|activity)\s*(?:height)?|max\s+height)$/i.test(
      lower,
    )
  ) {
    return {
      commandId: "t3.set-scroll-height.full",
      command: "set-scroll-height",
      args: { value: "full" },
      focusWindow: false,
      label: "Activity height: Full",
    };
  }
  if (/^(?:tall\s+height|tall\s+scroll\s*box|taller(?:\s+scroll\s*box)?)$/i.test(lower)) {
    return {
      commandId: "t3.set-scroll-height.tall",
      command: "set-scroll-height",
      args: { value: "tall" },
      focusWindow: false,
      label: "Activity height: Tall",
    };
  }
  if (
    /^(?:default\s+height|normal\s+height|compact\s+height|reset\s+(?:scroll\s*)?height)$/i.test(
      lower,
    )
  ) {
    return {
      commandId: "t3.set-scroll-height.default",
      command: "set-scroll-height",
      args: { value: "default" },
      focusWindow: false,
      label: "Activity height: Default",
    };
  }
  if (/^cycle\s+(?:scroll\s*)?height$/i.test(lower)) {
    return {
      commandId: "t3.set-scroll-height.cycle",
      command: "set-scroll-height",
      args: { value: "cycle" },
      focusWindow: false,
      label: "Cycle activity height",
    };
  }

  // 5. Built-in routes & history
  if (/^(?:go\s+)?back$/i.test(lower)) {
    return {
      commandId: "t3.open-route.back",
      command: "open-route",
      args: { route: "back" },
      focusWindow: false,
      label: "Navigate back",
    };
  }
  if (/^(?:go\s+)?forward$/i.test(lower)) {
    return {
      commandId: "t3.open-route.forward",
      command: "open-route",
      args: { route: "forward" },
      focusWindow: false,
      label: "Navigate forward",
    };
  }

  const routePatterns = [
    [
      /^(?:(?:open|show|go\s+to|check)\s+)?(?:the\s+)?(?:usage|quota|limits?)(?:\s+page)?$/i,
      "usage",
      "Open Usage & Quota",
    ],
    [
      /^(?:(?:open|show|go\s+to)\s+)?(?:the\s+)?chat\s+settings$/i,
      "settings-chat",
      "Open Chat Settings",
    ],
    [
      /^(?:(?:open|show|go\s+to)\s+)?(?:the\s+)?providers?(?:\s+settings)?$/i,
      "settings-providers",
      "Open Providers",
    ],
    [
      /^(?:(?:open|show|go\s+to)\s+)?(?:the\s+)?(?:keybindings?|shortcuts?)(?:\s+settings)?$/i,
      "settings-keybindings",
      "Open Keybindings",
    ],
    [
      /^(?:(?:open|show|go\s+to)\s+)?(?:the\s+)?(?:settings|preferences)$/i,
      "settings",
      "Open Settings",
    ],
    [
      /^(?:(?:open|show|go\s+to)\s+)?(?:the\s+)?(?:pull\s+requests?|p\s*r\s*s?)$/i,
      "pull-requests",
      "Open Pull Requests",
    ],
    [/^(?:(?:open|show|go\s+to)\s+)?(?:the\s+)?issues$/i, "issues", "Open Issues"],
    [/^(?:(?:open|start|create)\s+)?(?:a\s+)?new\s+thread$/i, "new", "New thread"],
    [/^(?:(?:open|go\s+to)\s+)?home$/i, "home", "Open Home"],
  ];
  for (const [pattern, route, label] of routePatterns) {
    if (pattern.test(lower)) {
      return {
        commandId: `t3.open-route.${route}`,
        command: "open-route",
        args: { route },
        focusWindow: true,
        label,
      };
    }
  }

  // 6. Panels
  if (/^(?:toggle|show|hide|open|close)\s+(?:the\s+)?sidebar$/i.test(lower)) {
    return {
      commandId: "t3.toggle-panel.sidebar",
      command: "toggle-panel",
      args: { panel: "sidebar" },
      focusWindow: false,
      label: "Toggle sidebar",
    };
  }
  if (
    /^(?:toggle|show|hide|open|close)\s+(?:the\s+)?(?:right\s+panel|inspector|diffs?|preview(?:\s+panel)?)$/i.test(
      lower,
    )
  ) {
    return {
      commandId: "t3.toggle-panel.right",
      command: "toggle-panel",
      args: { panel: "right" },
      focusWindow: false,
      label: "Toggle right panel",
    };
  }
  if (/^(?:toggle|show|hide|open|close)\s+(?:the\s+)?terminal$/i.test(lower)) {
    return {
      commandId: "t3.toggle-panel.terminal",
      command: "toggle-panel",
      args: { panel: "terminal" },
      focusWindow: false,
      label: "Toggle terminal",
    };
  }

  // 7. Thread cycling & selection
  const cycleThreadMatch =
    /^(?:(?:go\s+to|switch\s+to|open|show)\s+)?(?:the\s+)?(next|previous|prev|last)\s+(?:(working|waiting|pinned|active|settled)\s+)?thread$/i.exec(
      lower,
    );
  if (cycleThreadMatch) {
    const direction = cycleThreadMatch[1] === "next" ? "next" : "previous";
    const scope = cycleThreadMatch[2] ?? "active";
    return {
      commandId: `t3.open-thread.${direction}`,
      command: "open-thread",
      args: { direction, scope },
      focusWindow: true,
      label: direction === "next" ? `Next ${scope} thread` : `Previous ${scope} thread`,
    };
  }

  const numberedThreadMatch =
    /^(?:(?:open|switch\s+to|go\s+to|show)\s+)?thread\s+(?:#\s*)?(\w+)$/i.exec(lower);
  if (numberedThreadMatch?.[1]) {
    const index = parseSmallCount(numberedThreadMatch[1]);
    if (index !== null) {
      return {
        commandId: "t3.open-thread.index",
        command: "open-thread",
        args: { index },
        focusWindow: true,
        label: `Open thread #${index}`,
      };
    }
  }

  // 8. Focus / status / list / stop
  if (
    /^(?:focus(?:\s+window)?|show\s+(?:yourself|window|t3)|bring\s+(?:up|to\s+front)|come\s+to\s+front)$/i.test(
      lower,
    )
  ) {
    return {
      commandId: "t3.focus",
      command: "focus",
      args: {},
      focusWindow: true,
      label: "Focus T3 Code",
    };
  }

  if (/^(?:status|where\s+am\s+i|what\s+thread(?:\s+am\s+i\s+on|\s+is\s+open)?)$/i.test(lower)) {
    return {
      commandId: "t3.status",
      command: "status",
      args: {},
      focusWindow: false,
      label: "Check T3 status",
    };
  }

  const listMatch =
    /^(?:list|show)\s+(?:my\s+|the\s+)?(?:(working|waiting|pinned|active|settled|all)\s+)?threads$|^what\s+threads\s+are\s+(working|waiting)$/i.exec(
      lower,
    );
  if (listMatch) {
    const filter = listMatch[1] ?? listMatch[2] ?? "active";
    return {
      commandId: "t3.list-threads",
      command: "list-threads",
      args: { filter, limit: 10 },
      focusWindow: false,
      label: `List ${filter} threads`,
    };
  }

  if (
    /^(?:stop(?:\s+generating|\s+running|\s+this\s+thread|\s+turn)?|interrupt|cancel\s+turn)$/i.test(
      lower,
    )
  ) {
    return {
      commandId: "t3.stop-thread",
      command: "stop-thread",
      args: {},
      focusWindow: false,
      label: "Stop running turn",
    };
  }

  // 9. Fuzzy open thread (leading wake only, so trailing chatter doesn't hijack)
  if (allowFreeform) {
    const openMatch =
      /^(?:open|switch\s+to|go\s+to|jump\s+to|show)\s+(?:the\s+)?(?:thread\s+)?(.+)$/i.exec(
        cleaned,
      );
    if (openMatch?.[1]) {
      const query = openMatch[1].replace(/\s+thread$/i, "").trim();
      if (query.length >= 2) {
        return {
          commandId: "t3.open-thread.query",
          command: "open-thread",
          args: { query },
          focusWindow: true,
          label: `Open “${query}”`,
        };
      }
    }
  }

  return null;
}

/**
 * Parse a spoken transcript line for an addressed T3 Code voice command.
 * Returns null if the line is not addressed to T3 or does not match a command.
 */
export function parseT3VoiceCommand(rawText) {
  const text = normalizeWhitespace(rawText);
  if (!text) return null;

  const leading = LEADING_WAKE_RE.exec(text);
  if (leading?.[1]) {
    const matched = matchBody(leading[1], true);
    if (matched) return { ...matched, heard: text };
  }

  const trailing = TRAILING_WAKE_RE.exec(text);
  if (trailing?.[1]) {
    const matched = matchBody(trailing[1], false);
    if (matched) return { ...matched, heard: text };
  }

  return null;
}

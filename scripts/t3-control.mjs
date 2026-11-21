#!/usr/bin/env node
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const PROTOCOL_VERSION = 1;
const DEFAULT_CUSTOM_STATE_DIR = NodePath.join(NodeOS.homedir(), ".t3-custom", "userdata");
const OFFICIAL_STATE_DIR = NodePath.join(NodeOS.homedir(), ".t3", "userdata");
const REQUEST_TIMEOUT_MS = 15_000;

function resolveControlSocketPath(stateDir) {
  const resolved = NodePath.resolve(stateDir);
  const stateHash = NodeCrypto.createHash("sha256").update(resolved).digest("hex").slice(0, 24);
  // oxlint-disable-next-line t3code/no-global-process-runtime -- standalone zero-dependency Node CLI script outside Effect
  const hostPlatform = NodeOS.platform();
  if (hostPlatform === "win32") {
    return `\\\\.\\pipe\\t3code-app-${stateHash}`;
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : stateHash.slice(0, 12);
  const socketName = `${stateHash}.sock`;
  const maxPathBytes = hostPlatform === "linux" ? 107 : 103;
  let directory = NodePath.join(NodeOS.tmpdir(), `t3code-${uid}`);
  if (Buffer.byteLength(NodePath.join(directory, socketName), "utf8") > maxPathBytes) {
    directory = NodePath.join("/tmp", `t3code-${uid}`);
  }
  return NodePath.join(directory, socketName);
}

export function sendControlRequest(command, args = {}, options = {}) {
  const stateDir =
    options.stateDir ??
    process.env.T3_CONTROL_STATE_DIR ??
    (options.official ? OFFICIAL_STATE_DIR : DEFAULT_CUSTOM_STATE_DIR);
  const socketPath = resolveControlSocketPath(stateDir);
  const requestId = NodeCrypto.randomUUID();
  const payload = {
    version: PROTOCOL_VERSION,
    requestId,
    type: "control",
    command,
    ...(Object.keys(args).length > 0 ? { args } : {}),
    ...(options.focusWindow === undefined ? {} : { focusWindow: options.focusWindow }),
  };

  return new Promise((resolve, reject) => {
    const socket = NodeNet.createConnection(socketPath);
    let buffer = "";
    let settled = false;

    const finish = (err, response) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err);
      else resolve(response);
    };

    const timer = setTimeout(() => {
      finish(new Error(`Timed out waiting for T3 Code response (${socketPath})`));
    }, options.timeoutMs ?? REQUEST_TIMEOUT_MS);

    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(`${JSON.stringify(payload)}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      const line = buffer.slice(0, newline);
      try {
        finish(null, JSON.parse(line));
      } catch (parseErr) {
        finish(new Error(`Invalid JSON from T3 Code: ${String(parseErr)}`));
      }
    });
    socket.on("error", (err) => {
      finish(
        new Error(
          `Could not connect to T3 Code control socket (${socketPath}): ${err.message}. Is T3 Code (Custom) running?`,
        ),
      );
    });
    socket.on("close", () => {
      if (!settled) {
        finish(new Error("T3 Code closed the control socket without replying."));
      }
    });
  });
}

function printHelp() {
  console.log(`t3-ctl — programmatic control CLI for T3 Code (Custom)

Usage:
  t3-ctl [global flags] <command> [args...]

Global flags:
  --json                 Print raw JSON response
  --focus                Raise/focus the T3 Code window
  --no-focus             Do not steal focus
  --state-dir <path>     Override stateDir (default: ~/.t3-custom/userdata)
  --official             Target official ~/.t3/userdata instead of custom

Commands:
  focus                                  Focus T3 Code window
  status                                 Show active thread, route, settings, and thread counts
  threads [--active|--working|--waiting|--pinned|--settled|--all] [--query <q>] [--limit N]
  open <query-or-threadId>               Open a thread by fuzzy title/project match or ID
  thread next|prev [--working|--waiting|--active|--all]
  msg prev|next|top|bottom [count]       Jump messages (same as Cmd+Up / Cmd+Down)
  scroll up|down|top|bottom [amount]     Scroll active timeline
  thinking on|off|toggle                 Expand or collapse thinking traces by default
  tools on|off|toggle                    Expand or collapse tool calls by default
  height default|tall|full|cycle         Change activity scroll-box height
  go usage|quota|settings|chat-settings|providers|keybindings|prs|issues|new|home|back|forward
  panel sidebar|right|terminal           Toggle sidebar, right panel, or terminal
  latest [--chars N]                     Read latest assistant message in active thread
  send [--steer] "<text>"                Send (or steer) a message in active thread
  stop                                   Stop the active thread's running turn
`);
}

function parseCli(argv) {
  let json = false;
  let focusWindow;
  let stateDir;
  let official = false;
  const rest = [];

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--json") json = true;
    else if (token === "--focus") focusWindow = true;
    else if (token === "--no-focus") focusWindow = false;
    else if (token === "--official") official = true;
    else if (token === "--state-dir" && argv[i + 1]) {
      stateDir = argv[i + 1];
      i += 1;
    } else if (token === "-h" || token === "--help") {
      return { help: true };
    } else {
      rest.push(token);
    }
  }

  const [cmd, ...args] = rest;
  if (!cmd) return { help: true };

  const options = { json, focusWindow, stateDir, official };

  switch (cmd) {
    case "focus":
      return { command: "focus", args: {}, options: { ...options, focusWindow: true } };
    case "status":
      return { command: "status", args: {}, options };
    case "threads": {
      const payload = {};
      for (let i = 0; i < args.length; i += 1) {
        const arg = args[i];
        if (arg === "--active") payload.filter = "active";
        else if (arg === "--working") payload.filter = "working";
        else if (arg === "--waiting") payload.filter = "waiting";
        else if (arg === "--pinned") payload.filter = "pinned";
        else if (arg === "--settled") payload.filter = "settled";
        else if (arg === "--all") payload.filter = "all";
        else if (arg === "--query" && args[i + 1]) {
          payload.query = args[i + 1];
          i += 1;
        } else if (arg === "--limit" && args[i + 1]) {
          payload.limit = Number(args[i + 1]);
          i += 1;
        } else if (!arg.startsWith("--") && !payload.query) {
          payload.query = args.slice(i).join(" ");
          break;
        }
      }
      return { command: "list-threads", args: payload, options };
    }
    case "open": {
      const query = args.join(" ").trim();
      if (!query) throw new Error("open requires a thread title, project query, or threadId.");
      return { command: "open-thread", args: { query }, options };
    }
    case "thread": {
      const sub = (args[0] ?? "").toLowerCase();
      const payload = {};
      if (sub === "next" || sub === "prev" || sub === "previous") {
        payload.direction = sub === "prev" ? "previous" : sub;
      } else if (/^\d+$/.test(sub)) {
        payload.index = Number(sub);
      } else {
        throw new Error(`Unknown thread subcommand "${sub}". Use next, prev, or a 1-based number.`);
      }
      for (const flag of args.slice(1)) {
        if (flag === "--working") payload.scope = "working";
        else if (flag === "--waiting") payload.scope = "waiting";
        else if (flag === "--active") payload.scope = "active";
        else if (flag === "--pinned") payload.scope = "pinned";
        else if (flag === "--all") payload.scope = "all";
      }
      return { command: "open-thread", args: payload, options };
    }
    case "msg":
    case "message": {
      const direction = (args[0] ?? "previous").toLowerCase();
      const count = args[1] ? Number(args[1]) : undefined;
      return {
        command: "navigate-message",
        args: { direction, ...(Number.isFinite(count) ? { count } : {}) },
        options,
      };
    }
    case "scroll": {
      const direction = (args[0] ?? "down").toLowerCase();
      const amount = args[1] ? Number(args[1]) : undefined;
      return {
        command: "scroll",
        args: { direction, ...(Number.isFinite(amount) ? { amount } : {}) },
        options,
      };
    }
    case "thinking":
      return {
        command: "set-thinking",
        args: { mode: (args[0] ?? "toggle").toLowerCase() },
        options,
      };
    case "tools":
      return { command: "set-tools", args: { mode: (args[0] ?? "toggle").toLowerCase() }, options };
    case "height":
      return {
        command: "set-scroll-height",
        args: { value: (args[0] ?? "cycle").toLowerCase() },
        options,
      };
    case "go":
    case "route":
      return { command: "open-route", args: { route: (args[0] ?? "home").toLowerCase() }, options };
    case "panel":
      return {
        command: "toggle-panel",
        args: { panel: (args[0] ?? "sidebar").toLowerCase() },
        options,
      };
    case "latest": {
      const payload = {};
      for (let i = 0; i < args.length; i += 1) {
        if (args[i] === "--chars" && args[i + 1]) {
          payload.maxChars = Number(args[i + 1]);
          i += 1;
        }
      }
      return { command: "read-latest", args: payload, options };
    }
    case "send": {
      let mode = "auto";
      const parts = [];
      for (const arg of args) {
        if (arg === "--steer") mode = "steer";
        else parts.push(arg);
      }
      const text = parts.join(" ").trim();
      if (!text) throw new Error("send requires message text.");
      return { command: "send-message", args: { text, mode }, options };
    }
    case "stop":
      return { command: "stop-thread", args: {}, options };
    default:
      throw new Error(`Unknown command "${cmd}". Run t3-ctl --help for usage.`);
  }
}

async function main() {
  const parsed = parseCli(process.argv.slice(2));
  if (parsed.help) {
    printHelp();
    return;
  }
  const response = await sendControlRequest(parsed.command, parsed.args, parsed.options);
  if (parsed.options.json) {
    console.log(JSON.stringify(response, null, 2));
    if (!response.ok) process.exitCode = 1;
    return;
  }
  if (!response.ok) {
    console.error(`Error (${response.code}): ${response.message}`);
    process.exitCode = 1;
    return;
  }
  console.log(response.summary);
  if (parsed.command === "list-threads" && Array.isArray(response.data?.threads)) {
    for (let i = 0; i < response.data.threads.length; i += 1) {
      const t = response.data.threads[i];
      const project = t.projectTitle ? `[${t.projectTitle}] ` : "";
      const pin = t.pinned ? "★ " : "";
      console.log(`  ${i + 1}. ${pin}${project}${t.title} (${t.status}) — ${t.threadId}`);
    }
  } else if (parsed.command === "read-latest" && typeof response.data?.text === "string") {
    console.log("");
    console.log(response.data.text);
  }
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return (
      NodeFS.realpathSync(process.argv[1]) ===
      NodeFS.realpathSync(NodeURL.fileURLToPath(import.meta.url))
    );
  } catch {
    return import.meta.url === `file://${process.argv[1]}`;
  }
}

if (isMainModule()) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}

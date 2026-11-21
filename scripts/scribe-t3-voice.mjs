#!/usr/bin/env node
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

import { isSpeakerAllowed, parseT3VoiceCommand } from "./scribe-t3-voice-parser.mjs";
import { sendControlRequest } from "./t3-control.mjs";

const execFileAsync = NodeUtil.promisify(NodeChildProcess.execFile);

const DEFAULT_SCRIBE_ROOT = NodePath.join(NodeOS.homedir(), "Scribe");
const DEFAULT_SCRIBE_BIN = NodePath.join(NodeOS.homedir(), "Scribe", "bin", "scribe");
const DEFAULT_ENV_FILE = NodePath.join(
  NodeOS.homedir(),
  ".config",
  "instant-tools",
  "scribe-main.env",
);
const DEFAULT_MIRROR_APP = NodePath.join(
  NodeOS.homedir(),
  "Library",
  "Application Support",
  "Scribe",
  "Mirror",
  "app",
);
const DEFAULT_STATE_FILE = NodePath.join(NodeOS.homedir(), ".t3-custom", "scribe-voice-state.json");
const POLL_INTERVAL_MS = 350;
const AGENT_NAME = "t3-voice";
const MAX_SEEN_SEGMENTS = 1_000;

function logEvent(event) {
  process.stderr.write(`${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
}

function stableUUID(...parts) {
  const bytes = NodeCrypto.createHash("sha256").update(parts.join("|")).digest().subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function readJsonSafe(filePath) {
  try {
    return JSON.parse(NodeFS.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function writeJsonAtomic(filePath, data) {
  NodeFS.mkdirSync(NodePath.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  NodeFS.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  NodeFS.renameSync(tmp, filePath);
}

function resolveCurrentRecordingDir(scribeRoot) {
  const currentLink = NodePath.join(scribeRoot, "current");
  try {
    const resolved = NodeFS.realpathSync(currentLink);
    if (NodeFS.existsSync(NodePath.join(resolved, "events.jsonl"))) {
      return resolved;
    }
  } catch {
    // fall through
  }
  return null;
}

function readRecordingMeta(recordingDir) {
  const meta = readJsonSafe(NodePath.join(recordingDir, "meta.json"));
  const speakers = Array.isArray(meta?.speakers) ? meta.speakers : [];
  const selfSpeaker =
    speakers.find((entry) => entry?.id === 0)?.label ?? speakers[0]?.label ?? null;
  return {
    id: typeof meta?.id === "string" ? meta.id.toLowerCase() : null,
    owner: typeof meta?.owner === "string" ? meta.owner.toLowerCase() : null,
    title: typeof meta?.title === "string" ? meta.title : NodePath.basename(recordingDir),
    state: typeof meta?.state === "string" ? meta.state : null,
    selfSpeakerLabel: typeof selfSpeaker === "string" ? selfSpeaker : null,
  };
}

let cachedInstantDb = null;

async function getInstantAdminDb(envFile = DEFAULT_ENV_FILE, mirrorAppDir = DEFAULT_MIRROR_APP) {
  if (cachedInstantDb) return cachedInstantDb;
  const keys = [
    "SCRIBE_MAIN_INSTANT_APP_ID",
    "INSTANT_APP_ID",
    "SCRIBE_SHARED_INSTANT_APP_ID",
    "SCRIBE_MAIN_INSTANT_ADMIN_TOKEN",
    "INSTANT_APP_ADMIN_TOKEN",
    "INSTANT_ADMIN_TOKEN",
    "SCRIBE_INSTANT_API_URI",
  ];
  const script =
    'set -a; source "$1" >/dev/null 2>&1 || exit 3; shift; for k in "$@"; do printf "%s\\0%s\\0" "$k" "${!k-}"; done';
  const { stdout } = await execFileAsync(
    "/bin/bash",
    ["-c", script, "t3-voice-env", envFile, ...keys],
    {
      encoding: "utf8",
    },
  );
  const parts = stdout.split("\0");
  const values = new Map();
  for (let i = 0; i + 1 < parts.length; i += 2) {
    if (parts[i + 1]) values.set(parts[i], parts[i + 1]);
  }
  const appId =
    values.get("SCRIBE_MAIN_INSTANT_APP_ID") ??
    values.get("INSTANT_APP_ID") ??
    values.get("SCRIBE_SHARED_INSTANT_APP_ID");
  const adminToken =
    values.get("SCRIBE_MAIN_INSTANT_ADMIN_TOKEN") ??
    values.get("INSTANT_APP_ADMIN_TOKEN") ??
    values.get("INSTANT_ADMIN_TOKEN");
  if (!appId || !adminToken) {
    throw new Error(`Missing InstantDB appId or adminToken in ${envFile}`);
  }
  const apiURI = (
    values.get("SCRIBE_INSTANT_API_URI") ??
    process.env.SCRIBE_INSTANT_API_URI ??
    "https://api.instantdb.com"
  ).replace(/\/+$/, "");

  const req = NodeModule.createRequire(NodePath.join(mirrorAppDir, "package.json"));
  const adminMod = await import(NodeURL.pathToFileURL(req.resolve("@instantdb/admin")).href);
  cachedInstantDb = adminMod.init({ appId, adminToken, apiURI, disableValidation: true });
  return cachedInstantDb;
}

/**
 * Write a native Scribe RuntimeVoiceCommand row into InstantDB (`recordingRuntimeEvents`,
 * kind: "voiceCommand", device: "mac").
 */
async function writeRuntimeVoiceCommandEvent({
  meta,
  record,
  parsed,
  marker,
  outcome = "ran",
  envFile,
  mirrorAppDir,
}) {
  if (!meta.id || !meta.owner) {
    throw new Error("Recording meta is missing id or owner; cannot write runtime voice command.");
  }
  const db = await getInstantAdminDb(envFile, mirrorAppDir);
  const segmentID = typeof record.segment === "string" ? record.segment.toLowerCase() : null;
  const eventId = stableUUID("t3-voice", meta.id, segmentID ?? String(record.index ?? Date.now()));
  const timestampSeconds = Math.max(
    0,
    typeof record.end === "number"
      ? record.end
      : typeof record.start === "number"
        ? record.start
        : 0,
  );
  const nowMs = Date.now();
  const stringArgs = {};
  for (const [k, v] of Object.entries(parsed.args ?? {})) {
    if (v !== undefined && v !== null) stringArgs[k] = String(v);
  }
  const runtimeVoiceCommand = {
    arguments: stringArgs,
    commandID: parsed.commandId,
    heard: String(parsed.heard ?? record.text ?? "").slice(0, 160),
    marker,
    outcome,
    placement: "localServer",
    ...(segmentID ? { segmentID } : {}),
  };
  const payloadJSON = JSON.stringify({ voiceCommand: { _0: runtimeVoiceCommand } });

  await db.transact([
    db.tx.recordingRuntimeEvents[eventId]
      .update({
        ownerUserID: meta.owner,
        recordingID: meta.id,
        formatVersion: 1,
        kind: "voiceCommand",
        timestampSeconds,
        capturedAtMs: nowMs,
        payloadJSON,
        updatedAtMs: nowMs,
        device: "mac",
      })
      .link({ recording: meta.id }),
  ]);
  return eventId;
}

/**
 * Post a compact, silent inline reply anchored right on segment #N via `scribe reply`
 * (no `--he-asked`, so zero sound/buzz/notification). Appears immediately inline on the
 * live iPhone/iPad/Mac recording timeline as one quiet line that expands on tap.
 */
async function postInlineScribeReply({ scribeBin, recordingId, record, parsed, response, marker }) {
  const segmentIndex = record.index;
  if (typeof segmentIndex !== "number") {
    throw new Error("Segment record has no numeric index for inline reply.");
  }
  const argsJson =
    Object.keys(parsed.args ?? {}).length > 0 ? ` ${JSON.stringify(parsed.args)}` : "";
  const lines = [];
  if (response.ok) {
    lines.push(`Triggered \`${parsed.command}\`${argsJson} → ${response.summary}`);
  } else {
    lines.push(`Command \`${parsed.command}\`${argsJson} failed: ${response.message}`);
  }
  lines.push(`Heard: “${parsed.heard}”`);

  if (parsed.command === "list-threads" && response.ok && Array.isArray(response.data?.threads)) {
    const preview = response.data.threads
      .slice(0, 5)
      .map(
        (t, i) =>
          `${i + 1}. ${t.projectTitle ? `[${t.projectTitle}] ` : ""}${t.title} (${t.status})`,
      );
    if (preview.length > 0) {
      lines.push("", ...preview);
    }
  }

  const cliArgs = [
    "reply",
    "--recording",
    recordingId,
    "--segment",
    String(segmentIndex),
    "--new-thread",
    "--agent",
    AGENT_NAME,
    "--title",
    marker.slice(0, 80),
    lines.join("\n"),
  ];
  const { stdout } = await execFileAsync(scribeBin, cliArgs, {
    encoding: "utf8",
    timeout: 20_000,
    env: { ...process.env, SCRIBE_AGENT: AGENT_NAME },
  });
  return stdout.trim();
}

function formatMarkerTitle(parsed, response) {
  if (!response.ok) {
    return `T3 · Failed (${parsed.label})`;
  }
  const summary =
    typeof response.summary === "string" && response.summary.trim()
      ? response.summary.trim()
      : parsed.label;
  return `T3 · ${summary}`;
}

async function handleVoiceCommandRecord(record, meta, config) {
  const parsed = parseT3VoiceCommand(record.text);
  if (!parsed) return null;

  logEvent({
    event: "matched",
    recording: meta.id,
    segment: record.segment ?? null,
    index: record.index ?? null,
    speaker: record.speaker ?? null,
    command: parsed.command,
    args: parsed.args,
  });

  let response;
  if (config.dryRun) {
    response = { ok: true, command: parsed.command, summary: `[dry-run] ${parsed.label}` };
  } else {
    try {
      response = await sendControlRequest(parsed.command, parsed.args, {
        focusWindow: parsed.focusWindow,
        stateDir: config.t3StateDir,
        official: config.official,
      });
    } catch (err) {
      response = {
        ok: false,
        code: "unreachable",
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  const marker = formatMarkerTitle(parsed, response);
  logEvent({
    event: response.ok ? "executed" : "failed",
    recording: meta.id,
    index: record.index ?? null,
    command: parsed.command,
    marker,
    ...(response.ok ? {} : { error: response.message }),
  });

  if (config.dryRun || config.inlineMode === "none") {
    return { parsed, response, marker };
  }

  // Inline Scribe reporting (never throws out to kill the watcher loop)
  if (config.inlineMode === "reply" || config.inlineMode === "both") {
    try {
      await postInlineScribeReply({
        scribeBin: config.scribeBin,
        recordingId: meta.id,
        record,
        parsed,
        response,
        marker,
      });
      logEvent({ event: "inlineReplyPosted", recording: meta.id, index: record.index, marker });
    } catch (err) {
      logEvent({
        event: "inlineReplyFailed",
        recording: meta.id,
        index: record.index,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if ((config.inlineMode === "runtime-event" || config.inlineMode === "both") && response.ok) {
    try {
      const eventId = await writeRuntimeVoiceCommandEvent({
        meta,
        record,
        parsed,
        marker,
        envFile: config.envFile,
        mirrorAppDir: config.mirrorAppDir,
      });
      logEvent({ event: "runtimeVoiceCommandWritten", recording: meta.id, eventId, marker });
    } catch (err) {
      logEvent({
        event: "runtimeVoiceCommandFailed",
        recording: meta.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { parsed, response, marker };
}

async function runWatcher(config) {
  let state = readJsonSafe(config.stateFile) ?? {
    v: 1,
    recordingDir: null,
    recordingId: null,
    byteOffset: 0,
    seenSegments: [],
  };
  let seen = new Set(Array.isArray(state.seenSegments) ? state.seenSegments : []);

  const persistState = () => {
    const trimmed = [...seen].slice(-MAX_SEEN_SEGMENTS);
    seen = new Set(trimmed);
    state = { ...state, seenSegments: trimmed };
    writeJsonAtomic(config.stateFile, state);
  };

  let activeDir = null;
  let activeMeta = null;
  let activeWatcher = null;
  let polling = false;

  const switchToRecording = (dir, fromStart) => {
    if (activeDir === dir) return;
    activeWatcher?.close();
    activeWatcher = null;
    activeDir = dir;
    activeMeta = readRecordingMeta(dir);

    const eventsPath = NodePath.join(dir, "events.jsonl");
    let offset = 0;
    if (state.recordingDir === dir && typeof state.byteOffset === "number") {
      try {
        const size = NodeFS.statSync(eventsPath).size;
        offset = state.byteOffset <= size ? state.byteOffset : size;
      } catch {
        offset = 0;
      }
    } else if (!fromStart) {
      try {
        offset = NodeFS.statSync(eventsPath).size;
      } catch {
        offset = 0;
      }
    }

    state = {
      ...state,
      recordingDir: dir,
      recordingId: activeMeta.id,
      byteOffset: offset,
    };
    persistState();

    logEvent({
      event: "watching",
      recording: activeMeta.id,
      folder: NodePath.basename(dir),
      selfSpeaker: activeMeta.selfSpeakerLabel,
      byteOffset: offset,
      inlineMode: config.inlineMode,
    });

    try {
      activeWatcher = NodeFS.watch(dir, { persistent: false }, () => {
        void drain();
      });
      activeWatcher.on("error", () => {});
    } catch {
      // safety poll covers it
    }
  };

  const drain = async () => {
    if (polling) return;
    polling = true;
    try {
      const currentDir = resolveCurrentRecordingDir(config.scribeRoot);
      if (!currentDir) return;

      if (activeDir !== currentDir) {
        // When rolling over to a brand-new recording while running, start from byte 0;
        // on initial daemon startup (activeDir === null), seek to EOF so old lines never replay.
        const rollover = activeDir !== null;
        switchToRecording(currentDir, rollover || config.fromStart);
      }

      const eventsPath = NodePath.join(activeDir, "events.jsonl");
      let stat;
      try {
        stat = NodeFS.statSync(eventsPath);
      } catch {
        return;
      }
      if (stat.size < state.byteOffset) {
        state.byteOffset = 0;
      }
      if (stat.size === state.byteOffset) return;

      const length = stat.size - state.byteOffset;
      const fd = NodeFS.openSync(eventsPath, "r");
      let chunk;
      try {
        const buf = Buffer.alloc(length);
        NodeFS.readSync(fd, buf, 0, length, state.byteOffset);
        chunk = buf.toString("utf8");
      } finally {
        NodeFS.closeSync(fd);
      }

      const lastNewline = chunk.lastIndexOf("\n");
      if (lastNewline === -1) return;

      const complete = chunk.slice(0, lastNewline);
      const consumedBytes = Buffer.byteLength(chunk.slice(0, lastNewline + 1), "utf8");
      state.byteOffset += consumedBytes;

      const lines = complete.split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        let record;
        try {
          record = JSON.parse(line);
        } catch {
          continue;
        }
        if (record.kind === "speakers") {
          activeMeta = readRecordingMeta(activeDir);
          continue;
        }
        if (record.kind !== "segment.final") continue;

        const segKey =
          typeof record.segment === "string"
            ? record.segment.toLowerCase()
            : `${activeMeta?.id ?? ""}:${record.index ?? ""}`;
        if (seen.has(segKey)) continue;
        seen.add(segKey);

        if (!isSpeakerAllowed(record, activeMeta?.selfSpeakerLabel ?? null)) continue;
        await handleVoiceCommandRecord(record, activeMeta, config);
      }

      persistState();
    } catch (err) {
      logEvent({
        event: "pollError",
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      polling = false;
    }
  };

  logEvent({
    event: "started",
    pid: process.pid,
    scribeRoot: config.scribeRoot,
    inlineMode: config.inlineMode,
    dryRun: config.dryRun,
  });

  await drain();
  const interval = setInterval(() => {
    void drain();
  }, POLL_INTERVAL_MS);

  const shutdown = (signal) => {
    clearInterval(interval);
    activeWatcher?.close();
    logEvent({ event: "stopped", signal });
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

function parseArgs(argv) {
  const config = {
    scribeRoot: process.env.SCRIBE_MIRROR_ROOT ?? DEFAULT_SCRIBE_ROOT,
    scribeBin: process.env.SCRIBE_BIN ?? DEFAULT_SCRIBE_BIN,
    envFile: process.env.SCRIBE_ENV_FILE ?? DEFAULT_ENV_FILE,
    mirrorAppDir: process.env.SCRIBE_MIRROR_APP ?? DEFAULT_MIRROR_APP,
    stateFile: process.env.T3_SCRIBE_VOICE_STATE ?? DEFAULT_STATE_FILE,
    t3StateDir: process.env.T3_CONTROL_STATE_DIR ?? undefined,
    official: false,
    inlineMode: process.env.T3_SCRIBE_INLINE_MODE ?? "reply", // reply | runtime-event | both | none
    dryRun: false,
    fromStart: false,
    testText: null,
    executeTest: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root" && argv[i + 1]) config.scribeRoot = argv[++i];
    else if (arg === "--scribe-bin" && argv[i + 1]) config.scribeBin = argv[++i];
    else if (arg === "--state-file" && argv[i + 1]) config.stateFile = argv[++i];
    else if (arg === "--t3-state-dir" && argv[i + 1]) config.t3StateDir = argv[++i];
    else if (arg === "--official") config.official = true;
    else if (arg === "--inline-mode" && argv[i + 1]) config.inlineMode = argv[++i];
    else if (arg === "--dry-run") config.dryRun = true;
    else if (arg === "--from-start") config.fromStart = true;
    else if (arg === "--test" && argv[i + 1]) config.testText = argv[++i];
    else if (arg === "--execute") config.executeTest = true;
    else if (arg === "-h" || arg === "--help") config.help = true;
  }
  return config;
}

function printHelp() {
  console.log(`scribe-t3-voice — live Scribe voice navigation bridge for T3 Code (Custom)

Usage:
  scribe-t3-voice [options]
  scribe-t3-voice --test "T3, previous message" [--execute]

Options:
  --root <dir>                   Scribe mirror root (default: ~/Scribe)
  --inline-mode <mode>           How triggered commands show inline in Scribe:
                                   reply         quiet inline row on live screen + playback (default)
                                   runtime-event native #492 RuntimeVoiceCommand in InstantDB
                                   both          write both inline reply and runtime event
                                   none          do not write back to Scribe
  --dry-run                      Parse and log commands without calling T3 or Scribe
  --from-start                   Process existing lines from start of current recording
  --t3-state-dir <path>          Override T3 Code stateDir (default: ~/.t3-custom/userdata)
  --official                     Target official ~/.t3/userdata instead of custom
  --test "<spoken line>"         Test parsing (add --execute to run against T3 Code)
`);
}

async function main() {
  const config = parseArgs(process.argv.slice(2));
  if (config.help) {
    printHelp();
    return;
  }

  if (config.testText !== null) {
    const parsed = parseT3VoiceCommand(config.testText);
    if (!parsed) {
      console.log(JSON.stringify({ matched: false, heard: config.testText }, null, 2));
      process.exitCode = 1;
      return;
    }
    if (!config.executeTest) {
      console.log(JSON.stringify({ matched: true, ...parsed }, null, 2));
      return;
    }
    const response = await sendControlRequest(parsed.command, parsed.args, {
      focusWindow: parsed.focusWindow,
      stateDir: config.t3StateDir,
      official: config.official,
    });
    const marker = formatMarkerTitle(parsed, response);
    console.log(JSON.stringify({ matched: true, ...parsed, marker, response }, null, 2));
    if (!response.ok) process.exitCode = 1;
    return;
  }

  await runWatcher(config);
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

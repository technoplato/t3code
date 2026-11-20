import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const repoRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const homeDir = NodeOS.homedir();
const sourceUserDataDir = NodePath.join(homeDir, ".t3", "userdata");
const backupMode = process.argv.includes("--backup");
const destFlagIndex = process.argv.indexOf("--dest");
const destFlagValue = destFlagIndex >= 0 ? process.argv[destFlagIndex + 1] : undefined;

const SAFE_CONFIG_FILES = [
  "settings.json",
  "client-settings.json",
  "keybindings.json",
  "keybindings-migrations",
  "cli-command-first-launch",
  "shell-environment-cache.json",
  "usage-model-rates.json",
  "model-manifest.json",
];

const SAFE_DIRECTORIES = ["providers", "themes", "attachments"];
const SAFE_HOME_DIRECTORIES = ["tools", "caches"];

function run(command, args, options = {}) {
  const result = NodeChildProcess.spawnSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    ...options,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function copyFileIfPresent(src, dest, mode) {
  if (!NodeFS.existsSync(src)) return false;
  NodeFS.mkdirSync(NodePath.dirname(dest), { recursive: true });
  NodeFS.copyFileSync(src, dest);
  if (mode !== undefined) {
    NodeFS.chmodSync(dest, mode);
  }
  return true;
}

function copyDirectoryIfPresent(src, dest) {
  if (!NodeFS.existsSync(src)) return false;
  NodeFS.rmSync(dest, { recursive: true, force: true });
  NodeFS.cpSync(src, dest, { recursive: true });
  return true;
}

function copyClerkDirectory(srcDir, destDir) {
  if (!NodeFS.existsSync(srcDir)) return false;
  NodeFS.rmSync(destDir, { recursive: true, force: true });
  NodeFS.mkdirSync(destDir, { recursive: true, mode: 0o700 });
  for (const entry of NodeFS.readdirSync(srcDir)) {
    const srcPath = NodePath.join(srcDir, entry);
    const destPath = NodePath.join(destDir, entry);
    if (NodeFS.statSync(srcPath).isFile()) {
      NodeFS.copyFileSync(srcPath, destPath);
      NodeFS.chmodSync(destPath, 0o600);
    }
  }
  NodeFS.chmodSync(destDir, 0o700);
  return true;
}

if (!NodeFS.existsSync(sourceUserDataDir)) {
  console.error(`[fork:userdata] Source directory not found: ${sourceUserDataDir}`);
  process.exit(1);
}

if (backupMode) {
  const stamp = new Date().toISOString().replaceAll(":", "-").replace(/\..*$/, "");
  const backupBase = destFlagValue
    ? NodePath.resolve(destFlagValue)
    : NodePath.join(homeDir, ".t3-backups", stamp);
  const backupUserDataDir = NodePath.join(backupBase, "userdata");
  NodeFS.mkdirSync(backupUserDataDir, { recursive: true, mode: 0o700 });

  const sourceDb = NodePath.join(sourceUserDataDir, "statev2.sqlite");
  if (NodeFS.existsSync(sourceDb)) {
    const destDb = NodePath.join(backupUserDataDir, "statev2.sqlite");
    run("sqlite3", [sourceDb, `.backup '${destDb.replaceAll("'", "''")}'`]);
  }

  for (const file of [
    ...SAFE_CONFIG_FILES,
    "desktop-settings.json",
    "environment-id",
    "anonymous-id",
    "connection-catalog.json",
  ]) {
    copyFileIfPresent(
      NodePath.join(sourceUserDataDir, file),
      NodePath.join(backupUserDataDir, file),
    );
  }
  copyClerkDirectory(
    NodePath.join(sourceUserDataDir, "clerk"),
    NodePath.join(backupUserDataDir, "clerk"),
  );
  for (const dir of [...SAFE_DIRECTORIES, "relay-clients"]) {
    copyDirectoryIfPresent(
      NodePath.join(sourceUserDataDir, dir),
      NodePath.join(backupUserDataDir, dir),
    );
  }
  console.log(`[backup:userdata] Saved full backup of ~/.t3/userdata to ${backupUserDataDir}`);
  process.exit(0);
}

const destHomeDir = destFlagValue
  ? NodePath.resolve(destFlagValue)
  : NodePath.join(homeDir, ".t3-custom");
const realOfficialHome = NodePath.resolve(NodePath.join(homeDir, ".t3"));
if (destHomeDir === realOfficialHome) {
  console.error("[fork:userdata] Refusing to write into live ~/.t3.");
  process.exit(1);
}

const destUserDataDir = NodePath.join(destHomeDir, "userdata");
NodeFS.mkdirSync(destUserDataDir, { recursive: true, mode: 0o700 });

// Hot read-only SQLite backup preserves ALL projects and threads (pinned, active,
// and settled), then scrubs scheduled tasks, remote links, and in-flight runs so
// the forked instance never auto-resumes live turns or touches other devices.
const sourceDb = NodePath.join(sourceUserDataDir, "statev2.sqlite");
const destDb = NodePath.join(destUserDataDir, "statev2.sqlite");
if (NodeFS.existsSync(sourceDb)) {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    NodeFS.rmSync(`${destDb}${suffix}`, { force: true });
  }
  run("sqlite3", [sourceDb, `.backup '${destDb.replaceAll("'", "''")}'`]);

  const tablesToClear = [
    "scheduled_task_webhook_deliveries",
    "scheduled_task_webhook_pending",
    "scheduled_task_webhook_relay_deliveries",
    "scheduled_task_webhook_replay_keys",
    "scheduled_tasks",
    "orchestration_v2_effect_outbox",
    "orchestration_v2_thread_launch_workflows",
    "orchestration_command_receipts",
    "orchestration_v2_command_receipts",
    "provider_session_runtime",
    "auth_sessions",
    "auth_pairing_links",
    "auth_connect_devices",
    "peer_environment_links",
  ];
  const existingTables = new Set(
    NodeChildProcess.execFileSync(
      "sqlite3",
      [destDb, "SELECT name FROM sqlite_master WHERE type='table';"],
      { encoding: "utf8" },
    )
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
  );
  const statements = ["PRAGMA foreign_keys = OFF;", "BEGIN TRANSACTION;"];
  for (const table of tablesToClear) {
    if (existingTables.has(table)) {
      statements.push(`DELETE FROM "${table}";`);
    }
  }
  if (existingTables.has("orchestration_v2_projection_runs")) {
    statements.push(
      `UPDATE orchestration_v2_projection_runs
       SET status = 'interrupted',
           completed_at = COALESCE(completed_at, requested_at),
           payload_json = CASE
             WHEN json_valid(payload_json) THEN json_set(payload_json, '$.status', 'interrupted', '$.completedAt', COALESCE(completed_at, requested_at))
             ELSE payload_json
           END
       WHERE status IN ('queued', 'preparing', 'starting', 'running', 'waiting');`,
    );
  }
  if (existingTables.has("orchestration_v2_projection_run_attempts")) {
    statements.push(
      `UPDATE orchestration_v2_projection_run_attempts
       SET status = 'interrupted',
           payload_json = CASE
             WHEN json_valid(payload_json) THEN json_set(payload_json, '$.status', 'interrupted')
             ELSE payload_json
           END
       WHERE status IN ('queued', 'preparing', 'starting', 'running', 'waiting');`,
    );
  }
  if (existingTables.has("orchestration_v2_projection_runtime_requests")) {
    statements.push(
      `UPDATE orchestration_v2_projection_runtime_requests
       SET status = 'cancelled',
           resolved_at = COALESCE(resolved_at, created_at),
           payload_json = CASE
             WHEN json_valid(payload_json) THEN json_set(payload_json, '$.status', 'cancelled')
             ELSE payload_json
           END
       WHERE status = 'pending';`,
    );
  }
  statements.push("COMMIT;");
  run("sqlite3", [destDb, statements.join("\n")]);
}

for (const file of SAFE_CONFIG_FILES) {
  copyFileIfPresent(NodePath.join(sourceUserDataDir, file), NodePath.join(destUserDataDir, file));
}

// Keep the forked instance strictly local-only so it never contends with
// official T3 Code's Tailscale Serve port or network exposure.
const desktopSettingsSrc = NodePath.join(sourceUserDataDir, "desktop-settings.json");
const desktopSettingsDest = NodePath.join(destUserDataDir, "desktop-settings.json");
if (NodeFS.existsSync(desktopSettingsSrc)) {
  const parsed = JSON.parse(NodeFS.readFileSync(desktopSettingsSrc, "utf8"));
  const sanitized = {
    ...parsed,
    serverExposureMode: "local-only",
    tailscaleServeEnabled: false,
  };
  NodeFS.writeFileSync(desktopSettingsDest, `${JSON.stringify(sanitized, null, 2)}\n`);
}

copyClerkDirectory(
  NodePath.join(sourceUserDataDir, "clerk"),
  NodePath.join(destUserDataDir, "clerk"),
);
for (const dir of SAFE_DIRECTORIES) {
  copyDirectoryIfPresent(
    NodePath.join(sourceUserDataDir, dir),
    NodePath.join(destUserDataDir, dir),
  );
}
for (const dir of SAFE_HOME_DIRECTORIES) {
  copyDirectoryIfPresent(NodePath.join(homeDir, ".t3", dir), NodePath.join(destHomeDir, dir));
}

// Ensure fresh identity/runtime state (never clone environment-id or relay-clients).
for (const omitted of [
  "environment-id",
  "relay-clients",
  "server-owner.sqlite",
  "server-owner.sqlite-journal",
  "server-owner.sqlite-wal",
  "server-owner.sqlite-shm",
  "server-runtime.json",
  "desktop-host-scope",
]) {
  NodeFS.rmSync(NodePath.join(destUserDataDir, omitted), { recursive: true, force: true });
}

console.log(
  `[fork:userdata] Forked ~/.t3/userdata -> ${destUserDataDir} (local-only, Tailscale Serve disabled, fresh environment-id).`,
);

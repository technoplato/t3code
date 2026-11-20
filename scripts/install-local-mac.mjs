import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const repoRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const productName = process.env.T3CODE_DESKTOP_PRODUCT_NAME?.trim() || "T3 Code (Custom)";
const appBaseName = process.env.T3CODE_DESKTOP_APP_BASE_NAME?.trim() || "T3 Code Custom";
const appId = process.env.T3CODE_DESKTOP_APP_ID?.trim() || "com.technoplato.t3code";
// oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone local install script has no Effect runtime.
const hostArch = NodeOS.arch();
const arch = process.env.T3CODE_DESKTOP_ARCH?.trim() || (hostArch === "arm64" ? "arm64" : "x64");
const outputDir = NodePath.join(repoRoot, "release", "custom");
const skipBuild = process.argv.includes("--skip-build");
const sharedHome =
  process.argv.includes("--shared-home") || process.env.T3CODE_DESKTOP_SHARED_HOME === "1";
const defaultHomeDirName = sharedHome
  ? ""
  : process.env.T3CODE_DESKTOP_DEFAULT_HOME_DIR_NAME?.trim() || ".t3-custom";
const userDataDirName = sharedHome
  ? ""
  : process.env.T3CODE_DESKTOP_USER_DATA_DIR_NAME?.trim() || "t3code-custom";

function run(command, args, options = {}) {
  const result = NodeChildProcess.spawnSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    ...options,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0 && !options.allowFailure) {
    process.exit(result.status ?? 1);
  }
  return result.status ?? 0;
}

const envPath = NodePath.join(repoRoot, ".env");
const envExamplePath = NodePath.join(repoRoot, ".env.example");
if (!NodeFS.existsSync(envPath) && NodeFS.existsSync(envExamplePath)) {
  NodeFS.copyFileSync(envExamplePath, envPath);
  console.log("[install:mac] Created .env from .env.example for T3 Connect sign-in and sync.");
}

if (!sharedHome) {
  const isolatedDb = NodePath.join(
    NodeOS.homedir(),
    defaultHomeDirName,
    "userdata",
    "statev2.sqlite",
  );
  if (!NodeFS.existsSync(isolatedDb)) {
    run(process.execPath, [
      "scripts/fork-userdata.mjs",
      "--dest",
      NodePath.join(NodeOS.homedir(), defaultHomeDirName),
    ]);
  }
}

if (!skipBuild) {
  run(
    process.execPath,
    [
      "scripts/build-desktop-artifact.ts",
      "--platform",
      "mac",
      "--target",
      "dir",
      "--arch",
      arch,
      "--output-dir",
      outputDir,
    ],
    {
      env: {
        ...process.env,
        T3CODE_DESKTOP_SIGNED: "false",
        T3CODE_DESKTOP_APP_ID: appId,
        T3CODE_DESKTOP_PRODUCT_NAME: productName,
        T3CODE_DESKTOP_APP_BASE_NAME: appBaseName,
        T3CODE_DESKTOP_DEFAULT_HOME_DIR_NAME: defaultHomeDirName,
        T3CODE_DESKTOP_USER_DATA_DIR_NAME: userDataDirName,
        T3CODE_DESKTOP_DISABLE_UPDATES: "true",
      },
    },
  );
}

const macDirName = arch === "arm64" ? "mac-arm64" : "mac";
const builtAppPath = NodePath.join(outputDir, macDirName, `${productName}.app`);
if (!NodeFS.existsSync(builtAppPath)) {
  console.error(`[install:mac] Built app not found at ${builtAppPath}`);
  process.exit(1);
}

const installedAppPath = NodePath.join("/Applications", `${productName}.app`);
if (NodeFS.existsSync(installedAppPath)) {
  NodeFS.rmSync(installedAppPath, { recursive: true, force: true });
}

run("ditto", [builtAppPath, installedAppPath]);
run("xattr", ["-dr", "com.apple.quarantine", installedAppPath], { allowFailure: true });
run("codesign", ["--force", "--deep", "--sign", "-", installedAppPath]);
run(
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",
  ["-f", installedAppPath],
  { allowFailure: true },
);
run("mdimport", [installedAppPath], { allowFailure: true });

console.log(
  `[install:mac] Installed ${installedAppPath} (home: ~/${defaultHomeDirName || ".t3"}, profile: ${userDataDirName || "t3code-v2"}).`,
);

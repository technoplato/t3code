// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { makeRuntimeTempReclaimer, processesNamingDirectory } from "./runtimeTempDirectory.ts";

describe("processesNamingDirectory", () => {
  it("finds the processes whose command line or environment names the directory", () => {
    const table = [
      "  101 /usr/bin/agent acp HOME=/Users/dev TMPDIR=/state/tmp/run-AbC123 TERM=dumb",
      "  102 node /state/tmp/run-AbC123/server.js HOME=/Users/dev",
      "  103 node build.js TMPDIR=/state/tmp/run-AbC1234",
      "  104 node other.js TMPDIR=/state/tmp/run-XyZ789",
      "",
    ].join("\n");
    expect(processesNamingDirectory(table, "/state/tmp/run-AbC123")).toEqual([101, 102]);
    expect(processesNamingDirectory(table, "/state/tmp/run-none")).toEqual([]);
  });
});

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")("makeRuntimeTempReclaimer", () => {
  // A daemon or detached command an agent started keeps the run's TMPDIR after the agent exits.
  it.live(
    "keeps a directory a live process still uses and removes it once that process is gone",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-runtime-temp-" });
        const used = path.join(root, "run-used");
        const idle = path.join(root, "run-idle");
        const later = path.join(root, "run-later");
        for (const directory of [used, idle, later]) yield* fileSystem.makeDirectory(directory);

        const daemon = NodeChildProcess.spawn(
          process.execPath,
          ["-e", "setInterval(() => {}, 1000)"],
          {
            env: { ...process.env, TMPDIR: used },
            stdio: "ignore",
          },
        );
        const exited = new Promise<void>((resolve) => daemon.once("exit", () => resolve()));
        yield* Effect.addFinalizer(() => Effect.sync(() => daemon.kill("SIGKILL")));

        const reclaimer = yield* makeRuntimeTempReclaimer({
          platform: HostProcess.Platform.defaultValue(),
          remove: (directory) =>
            fileSystem.remove(directory, { recursive: true, force: true }).pipe(Effect.orDie),
        });
        yield* reclaimer.release(used);
        yield* reclaimer.release(idle);
        expect(yield* fileSystem.exists(used), "a live process still uses it").toBe(true);
        expect(yield* fileSystem.exists(idle)).toBe(false);
        expect(yield* reclaimer.inUse([used, idle, later])).toEqual([used]);

        daemon.kill("SIGKILL");
        yield* Effect.promise(() => exited);
        // The next release reclaims what an earlier one had to keep.
        yield* reclaimer.release(later);
        expect(yield* fileSystem.exists(used)).toBe(false);
        expect(yield* fileSystem.exists(later)).toBe(false);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

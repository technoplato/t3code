import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { collectUint8StreamText } from "./collectStreamText.ts";

const PROCESS_TABLE_TIMEOUT = "5 seconds";
const MAX_PROCESS_TABLE_BYTES = 32 * 1024 * 1024;
const LOGGED_PROCESS_IDS = 8;

/** Pids of `ps axeww -o pid=,command=` rows whose command line or environment names `directory`. */
export function processesNamingDirectory(table: string, directory: string): ReadonlyArray<number> {
  const pids: Array<number> = [];
  for (const row of table.split("\n")) {
    let from = row.indexOf(directory);
    while (from !== -1) {
      const next = row[from + directory.length];
      // A longer sibling name is a different directory.
      if (next === undefined || next === "/" || next === "\\" || /\s/u.test(next)) break;
      from = row.indexOf(directory, from + 1);
    }
    if (from === -1) continue;
    const pid = Number.parseInt(row, 10);
    if (Number.isSafeInteger(pid) && pid > 0) pids.push(pid);
  }
  return pids;
}

/** Every process's command line and, for this user's own, its environment. None when unreadable. */
const readProcessTable = Effect.fn("runtimeTempDirectory.readProcessTable")(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* Effect.gen(function* () {
    // BSD `e` appends the environment; `ww` keeps the row whole.
    const child = yield* spawner.spawn(
      ChildProcess.make("ps", ["axeww", "-o", "pid=,command="], { shell: false }),
    );
    yield* Effect.addFinalizer(() => child.kill().pipe(Effect.ignore));
    const [stdout, exitCode] = yield* Effect.all(
      [
        collectUint8StreamText({ stream: child.stdout, maxBytes: MAX_PROCESS_TABLE_BYTES }),
        child.exitCode,
      ],
      { concurrency: "unbounded" },
    );
    return Number(exitCode) === 0 && !stdout.truncated
      ? Option.some(stdout.text)
      : Option.none<string>();
  }).pipe(
    Effect.scoped,
    Effect.timeoutOption(PROCESS_TABLE_TIMEOUT),
    Effect.map(Option.flatten),
    Effect.orElseSucceed(() => Option.none<string>()),
  );
});

export interface RuntimeTempReclaimer {
  /** The given directories a live process still names. Empty where processes cannot be listed. */
  readonly inUse: (directories: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<string>>;
  /**
   * Removes `directory` unless a live process still names it, and tries again the directories
   * earlier calls had to keep.
   */
  readonly release: (directory: string) => Effect.Effect<void>;
}

/**
 * An agent's run temp directory is the TMPDIR of every command it starts, and a daemon or detached
 * command outlives the agent. Removing the directory then breaks that process, so it stays until
 * no live process names it. Windows locks files in use instead, so nothing is checked there.
 */
export const makeRuntimeTempReclaimer = Effect.fn("makeRuntimeTempReclaimer")(function* (options: {
  readonly platform: NodeJS.Platform;
  /** Removes one directory. Owns its own retries and reports its own failures. */
  readonly remove: (directory: string) => Effect.Effect<void>;
}) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const kept = new Set<string>();

  const users = Effect.fn("RuntimeTempReclaimer.users")(function* (
    directories: ReadonlyArray<string>,
  ) {
    const found = new Map<string, ReadonlyArray<number>>();
    if (options.platform === "win32" || directories.length === 0) return found;
    const table = yield* readProcessTable().pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );
    if (Option.isNone(table)) {
      yield* Effect.logWarning(
        "Could not list processes, so agent temp directories are removed without checking for live users.",
      );
      return found;
    }
    for (const directory of directories) {
      const pids = processesNamingDirectory(table.value, directory);
      if (pids.length > 0) found.set(directory, pids);
    }
    return found;
  });

  const release: RuntimeTempReclaimer["release"] = Effect.fn("RuntimeTempReclaimer.release")(
    function* (directory) {
      const candidates = [...new Set([directory, ...kept])];
      const found = yield* users(candidates);
      for (const candidate of candidates) {
        const pids = found.get(candidate);
        if (pids === undefined) {
          kept.delete(candidate);
          yield* options.remove(candidate);
          continue;
        }
        if (kept.has(candidate)) continue;
        kept.add(candidate);
        yield* Effect.logWarning(
          "Kept an agent temp directory that processes the agent started still use.",
          {
            directory: candidate,
            processCount: pids.length,
            processIds: pids.slice(0, LOGGED_PROCESS_IDS),
          },
        );
      }
    },
  );

  return {
    inUse: (directories) => users(directories).pipe(Effect.map((found) => [...found.keys()])),
    release,
  } satisfies RuntimeTempReclaimer;
});

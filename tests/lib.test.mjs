// Run: npm test   (node:test, no dependencies)
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { buildAgyArgs, installHint, resolveAgyBinary, runAgyTask, runAgyTaskSync } from "../plugins/agy/scripts/lib/agy.mjs";
import { runCommand } from "../plugins/agy/scripts/lib/process.mjs";

import { parseArgs, splitRawArgumentString } from "../plugins/agy/scripts/lib/args.mjs";

const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const state = await import("../plugins/agy/scripts/lib/state.mjs");

const config = {
  valueOptions: ["model", "tag"],
  booleanOptions: ["json", "wait"],
  repeatableOptions: ["tag"],
  aliasMap: { m: "model" }
};

test("parseArgs: value, boolean, alias, inline and repeatable options", () => {
  const { options, positionals } = parseArgs(
    ["--model", "fast", "--json", "-m", "slow", "--tag=a", "--tag", "b", "hello"],
    config
  );
  assert.equal(options.model, "slow");
  assert.equal(options.json, true);
  assert.deepEqual(options.tag, ["a", "b"]);
  assert.deepEqual(positionals, ["hello"]);
});

test("parseArgs: -- passes everything through as positionals", () => {
  const { options, positionals } = parseArgs(["--json", "--", "--model", "x"], config);
  assert.equal(options.json, true);
  assert.deepEqual(positionals, ["--model", "x"]);
});

test("parseArgs: boolean --flag=false, unknown flags stay positional, missing value throws", () => {
  assert.equal(parseArgs(["--json=false"], config).options.json, false);
  assert.deepEqual(parseArgs(["--unknown"], config).positionals, ["--unknown"]);
  assert.throws(() => parseArgs(["--model"], config), /Missing value for --model/);
});

test("splitRawArgumentString: quotes, escapes and whitespace", () => {
  assert.deepEqual(splitRawArgumentString(`a "b c" 'd e'  f\\ g`), ["a", "b c", "d e", "f g"]);
  assert.deepEqual(splitRawArgumentString("   "), []);
  assert.deepEqual(splitRawArgumentString("trailing\\"), ["trailing\\"]);
});

function withTempState(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-plugin-test-"));
  const previous = process.env[PLUGIN_DATA_ENV];
  process.env[PLUGIN_DATA_ENV] = path.join(root, "data");
  const cwd = path.join(root, "workspace");
  fs.mkdirSync(cwd);
  try {
    return fn(cwd);
  } finally {
    if (previous === undefined) delete process.env[PLUGIN_DATA_ENV];
    else process.env[PLUGIN_DATA_ENV] = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("state: empty workspace yields the default state", () => {
  withTempState((cwd) => {
    const s = state.loadState(cwd);
    assert.deepEqual(s.jobs, []);
    assert.equal(s.config.stopReviewGate, false);
  });
});

test("state: state dir lives under the plugin data dir and is stable per workspace", () => {
  withTempState((cwd) => {
    const dir = state.resolveStateDir(cwd);
    assert.ok(dir.startsWith(process.env[PLUGIN_DATA_ENV]));
    assert.equal(dir, state.resolveStateDir(cwd));
  });
});

test("state: upsertJob inserts then merges by id, newest first", () => {
  withTempState((cwd) => {
    state.upsertJob(cwd, { id: "a", status: "running" });
    state.upsertJob(cwd, { id: "b", status: "running" });
    state.upsertJob(cwd, { id: "a", status: "done" });
    const jobs = state.listJobs(cwd);
    assert.equal(jobs.length, 2);
    assert.equal(jobs.find((j) => j.id === "a").status, "done");
  });
});

test("state: keeps at most 50 jobs", () => {
  withTempState((cwd) => {
    for (let i = 0; i < 55; i += 1) state.upsertJob(cwd, { id: `job-${i}` });
    assert.equal(state.listJobs(cwd).length, 50);
  });
});

test("state: a corrupt state file falls back to defaults", () => {
  withTempState((cwd) => {
    state.ensureStateDir(cwd);
    fs.writeFileSync(state.resolveStateFile(cwd), "{not json");
    assert.deepEqual(state.loadState(cwd).jobs, []);
  });
});

test("generateJobId: carries the prefix and is unique", () => {
  const a = state.generateJobId("review");
  assert.ok(a.startsWith("review-"));
  assert.notEqual(a, state.generateJobId("review"));
});


test("[TS-1001] [BE-UT] delegation arguments grant permissions without terminal sandbox for task and resume", () => {
  for (const options of [{}, { resumeLast: true }, { conversation: "existing" }, { dangerouslySkipPermissions: true }]) {
    const args = buildAgyArgs("review without modifying files", options);
    assert.equal(args.filter((arg) => arg === "--dangerously-skip-permissions").length, 1);
    assert.ok(!args.includes("--sandbox"));
  }
  assert.throws(() => buildAgyArgs("task", { sandbox: true }), /--sandbox is no longer supported/);
});

test("[TS-1002] [BE-IT] CLI rejects deprecated sandbox before launching a task or review", () => {
  const script = path.resolve("plugins/agy/scripts/agy-companion.mjs");
  for (const command of ["task", "review", "adversarial-review"]) {
    const result = spawnSync(process.execPath, [script, command, "--sandbox", "test"], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr + result.stdout, /--sandbox is no longer supported/);
  }
});


// Windows only spawns agy.exe without a shell, and a script stub cannot be one.
// resolveAgyBinary's Windows lookup is covered by the platform-injected tests below.
const POSIX_STUB_ONLY = process.platform === "win32" && "agy stub is a POSIX script; Windows can only spawn agy.exe";

test("[TS-1003] [BE-IT] asynchronous task and synchronous stop-review launch pass permission arguments to agy", { skip: POSIX_STUB_ONLY }, async () => {
  const tmpBase = path.resolve(".tmp");
  fs.mkdirSync(tmpBase, { recursive: true });
  const root = fs.mkdtempSync(path.join(tmpBase, "agy-stub-"));
  const stub = path.join(root, "agy");
  fs.writeFileSync(stub, `#!${process.execPath}\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n`, { mode: 0o755 });
  const previousPath = process.env.PATH;
  process.env.PATH = `${root}${path.delimiter}${previousPath}`;
  try {
    for (const result of [await runAgyTask(root, "task", { resumeLast: true }), runAgyTaskSync(root, "review")]) {
      assert.equal(result.exitCode, 0, result.stderr);
      const args = JSON.parse(result.stdout);
      assert.ok(args.includes("--dangerously-skip-permissions"));
      assert.ok(!args.includes("--sandbox"));
    }
  } finally {
    process.env.PATH = previousPath;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function withAgyDirs(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-resolve-"));
  const touch = (dir, name) => {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, name);
    fs.writeFileSync(file, "", { mode: 0o755 });
    return file;
  };
  try {
    return fn(root, touch);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("[TS-1004] [BE-UT] Windows lookup takes agy.exe from PATH and skips shims it cannot spawn", () => {
  withAgyDirs((root, touch) => {
    const shims = path.join(root, "shims");
    touch(shims, "agy");
    touch(shims, "agy.cmd");
    const exe = touch(path.join(root, "bin"), "agy.exe");
    const env = { PATH: [shims, path.join(root, "bin")].join(";") };
    assert.equal(resolveAgyBinary({ platform: "win32", env, homedir: root }), exe);
  });
});

test("[TS-1005] [BE-UT] Windows lookup falls back to the vendor install dir under LOCALAPPDATA", () => {
  withAgyDirs((root, touch) => {
    const exe = touch(path.join(root, "agy", "bin"), "agy.exe");
    assert.equal(resolveAgyBinary({ platform: "win32", env: { PATH: "", LOCALAPPDATA: root }, homedir: root }), exe);
    assert.equal(resolveAgyBinary({ platform: "win32", env: { PATH: "" }, homedir: root }), null);
  });
});

// A POSIX PATH is ":"-separated, which splits Windows temp paths at the drive letter.
const POSIX_PATHS_ONLY = process.platform === "win32" && "a \":\"-separated PATH cannot hold Windows drive paths";

test("[TS-1006] [BE-UT] POSIX lookup takes extensionless agy from PATH, ahead of every fallback", { skip: POSIX_PATHS_ONLY }, () => {
  withAgyDirs((root, touch) => {
    touch(path.join(root, "first"), "agy.exe");
    const onPath = touch(path.join(root, "second"), "agy");
    touch(path.join(root, ".local", "bin"), "agy");
    const env = { PATH: [path.join(root, "first"), path.join(root, "second")].join(":") };
    assert.equal(resolveAgyBinary({ platform: "linux", env, homedir: root }), onPath);
  });
});

// The Homebrew prefixes are real system dirs probed before ~/.local/bin, so
// this fallback can only be observed on a machine without agy installed there.
const HOMEBREW_AGY_PRESENT = ["/opt/homebrew/bin/agy", "/usr/local/bin/agy"].some((file) => fs.existsSync(file))
  && "agy is installed under a Homebrew prefix, which wins over ~/.local/bin";

test("[TS-1010] [BE-UT] POSIX lookup falls back to ~/.local/bin", { skip: HOMEBREW_AGY_PRESENT }, () => {
  withAgyDirs((root, touch) => {
    const local = touch(path.join(root, ".local", "bin"), "agy");
    assert.equal(resolveAgyBinary({ platform: "linux", env: { PATH: "" }, homedir: root }), local);
  });
});

test("[TS-1007] [BE-IT] runCommand passes arguments verbatim without a shell", () => {
  const injected = "a & echo injected | b";
  const result = runCommand(process.execPath, ["-e", "process.stdout.write(process.argv[1])", injected]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, injected);
});

test("[TS-1008] [BE-UT] install hint matches the platform's vendor installer", () => {
  assert.match(installHint("win32"), /install\.ps1/);
  assert.match(installHint("darwin"), /install\.sh \| bash/);
  assert.match(installHint("linux"), /install\.sh \| bash/);
});

test("[TS-1009] [BE-UT] Windows lookup reads Path/LocalAppData case-insensitively and unquotes PATH entries", () => {
  withAgyDirs((root, touch) => {
    const quotedDir = path.join(root, "Program Files", "agy");
    const exe = touch(quotedDir, "agy.exe");
    assert.equal(resolveAgyBinary({ platform: "win32", env: { Path: `"${quotedDir}"` }, homedir: root }), exe);
    const vendor = touch(path.join(root, "agy", "bin"), "agy.exe");
    assert.equal(resolveAgyBinary({ platform: "win32", env: { Path: "", LocalAppData: root }, homedir: root }), vendor);
  });
});

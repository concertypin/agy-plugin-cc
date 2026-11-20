// Run: npm test   (node:test, no dependencies)
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { AGY_RUN_MODES, buildAgyArgs, installHint, resolveAgyBinary, runAgyTask, runAgyTaskSync } from "../plugins/agy/scripts/lib/agy.mjs";
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


test("[TS-1001] [BE-UT] delegation arguments default to skipping permissions without terminal sandbox", () => {
  for (const options of [{}, { resumeLast: true }, { conversation: "existing" }, { mode: "dangerously-skip-permissions" }]) {
    const args = buildAgyArgs("review without modifying files", options);
    assert.equal(args.filter((arg) => arg === "--dangerously-skip-permissions").length, 1);
    assert.ok(!args.includes("--mode"));
    assert.ok(!args.includes("--sandbox"));
  }
  assert.throws(() => buildAgyArgs("task", { sandbox: true }), /--sandbox is no longer supported/);
});

test("[TS-1101] [BE-UT] agy execution modes pass --mode instead of skipping permissions", () => {
  for (const mode of ["auto", "accept-edits", "plan"]) {
    const args = buildAgyArgs("task", { mode, resumeLast: true });
    assert.deepEqual(args.slice(0, 3), ["--mode", mode, "--continue"]);
    assert.ok(!args.includes("--dangerously-skip-permissions"));
  }
  assert.deepEqual(AGY_RUN_MODES, ["auto", "accept-edits", "plan", "dangerously-skip-permissions"]);
  assert.throws(() => buildAgyArgs("task", { mode: "yolo" }), /Unknown agy run mode "yolo"/);
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

// Runs the companion with no agy reachable, so --dry-run and setup never start a real agy.
function withCompanion(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-mode-"));
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace);
  const script = path.resolve("plugins/agy/scripts/agy-companion.mjs");
  const run = (args, extraEnv = {}) => {
    const env = { ...process.env, PATH: "", Path: "", HOME: root, USERPROFILE: root, LOCALAPPDATA: root, CLAUDE_PLUGIN_DATA: path.join(root, "data"), ...extraEnv };
    if (!("AGY_PLUGIN_DEFAULT_MODE" in extraEnv)) delete env.AGY_PLUGIN_DEFAULT_MODE;
    return spawnSync(process.execPath, [script, ...args], { cwd: workspace, env, encoding: "utf8" });
  };
  const dryRunMode = (args, extraEnv) => {
    const result = run(["task", "--dry-run", "--json", ...args, "hello"], extraEnv);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout).options.find((option) => option.startsWith("mode: "));
  };
  const setup = (args, extraEnv) => {
    const result = run(["setup", "--json", ...args], extraEnv);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  try {
    return fn({ run, dryRunMode, setup });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("[TS-1102] [BE-IT] run mode precedence is flag, then workspace setup, then env, then default", () => {
  withCompanion(({ dryRunMode, setup }) => {
    const env = { AGY_PLUGIN_DEFAULT_MODE: "auto" };
    assert.equal(dryRunMode([]), "mode: dangerously-skip-permissions (no agy sandbox)");
    assert.equal(setup([]).modeSource, "default");
    assert.equal(dryRunMode([], env), "mode: auto");
    assert.equal(setup([], env).modeSource, "env");

    const configured = setup(["--mode", "plan"], env);
    assert.equal(configured.mode, "plan");
    assert.equal(configured.modeSource, "workspace");
    assert.equal(dryRunMode([], env), "mode: plan");
    assert.equal(dryRunMode(["--mode", "accept-edits"], env), "mode: accept-edits");
    assert.equal(dryRunMode(["--dangerously-skip-permissions"], env), "mode: dangerously-skip-permissions (no agy sandbox)");

    assert.equal(setup(["--clear-mode"], env).modeSource, "env");
    assert.equal(dryRunMode([], env), "mode: auto");
  });
});

test("[TS-1103] [BE-IT] invalid or conflicting run modes fail before agy starts", () => {
  withCompanion(({ run }) => {
    const cases = [
      [["task", "--dry-run", "--mode", "yolo", "hello"], {}, /Unknown --mode "yolo"/],
      [["task", "--dry-run", "--mode", "auto", "--dangerously-skip-permissions", "hello"], {}, /Choose either --mode or --dangerously-skip-permissions/],
      [["review", "--dry-run", "--mode", "yolo"], {}, /Unknown --mode "yolo"/],
      [["task", "--dry-run", "hello"], { AGY_PLUGIN_DEFAULT_MODE: "yolo" }, /Unknown AGY_PLUGIN_DEFAULT_MODE "yolo"/],
      [["setup", "--mode", "yolo"], {}, /Unknown --mode "yolo"/],
      [["setup", "--mode", "auto", "--clear-mode"], {}, /Choose either --mode or --clear-mode/],
      [["task", "--dry-run", "--mode=", "hello"], {}, /Missing value for --mode/],
      [["setup", "--mode="], {}, /Missing value for --mode/]
    ];
    for (const [args, env, pattern] of cases) {
      const result = run(args, env);
      assert.notEqual(result.status, 0, args.join(" "));
      assert.match(result.stderr + result.stdout, pattern);
    }
  });
});

test("[TS-1104] [BE-IT] --mode never leaks into the prompt text", () => {
  withCompanion(({ run }) => {
    const result = run(["task", "--dry-run", "--json", "--mode", "auto", "fix the bug"]);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.ok(report.details.includes("Prompt: fix the bug"), report.details.join(" | "));
  });
});

test("[TS-1105] [BE-IT] a background task keeps its run mode through the detached worker", { skip: POSIX_STUB_ONLY }, () => {
  const tmpBase = path.resolve(".tmp");
  fs.mkdirSync(tmpBase, { recursive: true });
  const root = fs.mkdtempSync(path.join(tmpBase, "agy-bg-"));
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "agy"), `#!${process.execPath}\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n`, { mode: 0o755 });
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace);
  const script = path.resolve("plugins/agy/scripts/agy-companion.mjs");
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, CLAUDE_PLUGIN_DATA: path.join(root, "data"), AGY_PLUGIN_DEFAULT_MODE: "plan" };
  const run = (args) => {
    const result = spawnSync(process.execPath, [script, ...args], { cwd: workspace, env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  try {
    const { jobId } = run(["task", "--background", "--json", "--mode", "auto", "hello"]);
    run(["status", jobId, "--wait", "--timeout-ms", "20000", "--json"]);
    const { storedJob } = run(["result", jobId, "--json"]);
    const agyArgs = JSON.parse(storedJob.result.rawOutput);
    assert.deepEqual(agyArgs.slice(0, 2), ["--mode", "auto"]);
    assert.ok(!agyArgs.includes("--dangerously-skip-permissions"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("[TS-1106] [BE-IT] setup reports an invalid env mode instead of failing, and env values are trimmed", () => {
  withCompanion(({ run, dryRunMode, setup }) => {
    const report = setup([], { AGY_PLUGIN_DEFAULT_MODE: "yolo" });
    assert.equal(report.mode, null);
    assert.match(report.modeError, /Unknown AGY_PLUGIN_DEFAULT_MODE "yolo"/);
    assert.ok(report.nextSteps.some((step) => step.includes("/agy:setup --mode")));
    const text = run(["setup"], { AGY_PLUGIN_DEFAULT_MODE: "yolo" });
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /run mode: invalid/);
    assert.equal(setup(["--mode", "auto"], { AGY_PLUGIN_DEFAULT_MODE: "yolo" }).mode, "auto");
    setup(["--clear-mode"]);
    assert.equal(dryRunMode([], { AGY_PLUGIN_DEFAULT_MODE: " accept-edits " }), "mode: accept-edits");
  });
});

const render = await import("../plugins/agy/scripts/lib/render.mjs");

test("[TS-1201] [BE-UT] task, review and stored results show agy's stderr notices beside its output", () => {
  const notice = "Skipped run_command: requires approval in headless mode";
  assert.equal(render.renderTaskResult({ rawOutput: "done", failureMessage: `${notice}\n` }, {}), `done\n\nNotices from agy:\n${notice}\n`);
  assert.equal(render.renderTaskResult({ rawOutput: "done\n", failureMessage: "  " }, {}), "done\n");
  assert.equal(render.renderTaskResult({ rawOutput: "", failureMessage: "boom" }, {}), "boom\n");

  const review = render.renderReviewResult("No issues.", { reviewLabel: "Review", targetLabel: "working tree", stderr: notice });
  assert.ok(review.endsWith(`No issues.\n\nNotices from agy:\n${notice}\n`), review);

  const job = { id: "task-1", title: "agy Task", status: "completed" };
  assert.equal(render.renderStoredJobResult(job, { result: { rawOutput: "done", stderr: notice } }), `done\n\nNotices from agy:\n${notice}\n`);
  assert.equal(render.renderStoredJobResult(job, { result: { rawOutput: "done" } }), "done\n");
  assert.equal(render.renderStoredJobResult(job, { result: { review: "Review" }, rendered: review }), review);
});

test("[TS-1202] [BE-IT] a skipped action reported on stderr reaches the task output, its JSON and the stored result", { skip: POSIX_STUB_ONLY }, () => {
  const tmpBase = path.resolve(".tmp");
  fs.mkdirSync(tmpBase, { recursive: true });
  const root = fs.mkdtempSync(path.join(tmpBase, "agy-notice-"));
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  const notice = "Skipped run_command: requires approval in headless mode";
  fs.writeFileSync(path.join(bin, "agy"), `#!${process.execPath}\nprocess.stdout.write("done");\nprocess.stderr.write(${JSON.stringify(`${notice}\n`)});\n`, { mode: 0o755 });
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace);
  const script = path.resolve("plugins/agy/scripts/agy-companion.mjs");
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, CLAUDE_PLUGIN_DATA: path.join(root, "data") };
  const run = (args) => {
    const result = spawnSync(process.execPath, [script, ...args], { cwd: workspace, env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  try {
    assert.equal(run(["task", "--mode", "auto", "hello"]), `done\n\nNotices from agy:\n${notice}\n`);
    const payload = JSON.parse(run(["task", "--json", "--mode", "auto", "hello"]));
    assert.equal(payload.rawOutput, "done");
    assert.equal(payload.stderr.trim(), notice);
    const { jobId } = JSON.parse(run(["task", "--background", "--json", "hello"]));
    run(["status", jobId, "--wait", "--timeout-ms", "20000", "--json"]);
    assert.equal(run(["result", jobId]), `done\n\nNotices from agy:\n${notice}\n`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("[TS-1203] [BE-IT] a review run appends agy's stderr notices to the rendered review", { skip: POSIX_STUB_ONLY }, () => {
  const tmpBase = path.resolve(".tmp");
  fs.mkdirSync(tmpBase, { recursive: true });
  const root = fs.mkdtempSync(path.join(tmpBase, "agy-review-notice-"));
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  const notice = "Skipped run_command: requires approval in headless mode";
  fs.writeFileSync(path.join(bin, "agy"), `#!${process.execPath}\nprocess.stdout.write("No issues.");\nprocess.stderr.write(${JSON.stringify(`${notice}\n`)});\n`, { mode: 0o755 });
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace);
  const git = (...args) => assert.equal(spawnSync("git", args, { cwd: workspace, encoding: "utf8" }).status, 0, args.join(" "));
  git("init", "-q");
  git("-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "init");
  fs.writeFileSync(path.join(workspace, "changed.txt"), "change\n");
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, CLAUDE_PLUGIN_DATA: path.join(root, "data") };
  try {
    const result = spawnSync(process.execPath, [path.resolve("plugins/agy/scripts/agy-companion.mjs"), "review", "--wait"], { cwd: workspace, env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.endsWith(`No issues.\n\nNotices from agy:\n${notice}\n`), result.stdout);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

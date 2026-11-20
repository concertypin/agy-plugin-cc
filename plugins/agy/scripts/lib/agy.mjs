import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { binaryAvailable } from "./process.mjs";

const HOMEBREW_PREFIXES = ["/opt/homebrew/bin", "/usr/local/bin"];

// Resolve agy from PATH first, then from the places package managers link it.
// Hook and IDE processes often run with a trimmed PATH; treating that as
// "not installed" sent assistants to the vendor installer on machines where
// the CLI was already present.
//
// On Windows the vendor installer ships agy.exe under %LOCALAPPDATA%\agy\bin.
// Only agy.exe is accepted there: Node cannot spawn .cmd/.bat shims without a
// shell, and an extensionless "agy" file is not runnable at all.
export function resolveAgyBinary({ platform = process.platform, env = process.env, homedir = os.homedir() } = {}) {
  const isWindows = platform === "win32";
  // Windows env keys are case-insensitive ("Path"), but a copied env object is not.
  const readEnv = (key) => isWindows
    ? env[Object.keys(env).find((name) => name.toUpperCase() === key)]
    : env[key];
  const localAppData = readEnv("LOCALAPPDATA");
  const fallbackDirs = isWindows
    ? (localAppData ? [path.join(localAppData, "agy", "bin")] : [])
    : [...HOMEBREW_PREFIXES, path.join(homedir, ".local", "bin")];
  const pathDirs = (readEnv("PATH") || "").split(isWindows ? ";" : ":")
    // Windows allows quoted PATH entries such as "C:\Program Files\agy\bin".
    .map((dir) => (isWindows ? dir.replace(/^"(.*)"$/, "$1") : dir));
  const dirs = [...pathDirs, ...fallbackDirs];
  const name = isWindows ? "agy.exe" : "agy";
  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, isWindows ? fs.constants.F_OK : fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // not here
    }
  }
  return null;
}

// agy updates itself in the background (no setting disables it) and the
// vendor installer puts it in ~/.local/bin, where that updater owns it. A
// Homebrew cask fights the updater: each self-update replaces the cask's
// symlink with a plain binary and the next `brew upgrade` fails to link.
export function installHint(platform = process.platform) {
  if (platform === "win32") {
    return "irm https://antigravity.google/cli/install.ps1 | iex   (in PowerShell)";
  }
  return "curl -fsSL https://antigravity.google/cli/install.sh | bash";
}

function agyCommand() {
  return resolveAgyBinary() ?? "agy";
}

export function getAgyAvailability(cwd) {
  const result = binaryAvailable(agyCommand(), ["--version"], { cwd });
  if (result.available) {
    return { available: true, detail: `agy ${result.detail}` };
  }
  return result;
}

export function getAgyAuthStatus(cwd) {
  const avail = getAgyAvailability(cwd);
  if (!avail.available) {
    return { loggedIn: false, detail: "agy not installed" };
  }
  return { loggedIn: true, detail: "agy is available (auth managed by agy itself)" };
}

// How delegated agy runs are permitted to act. The first three are agy's own
// `--mode` values; dangerously-skip-permissions approves every tool call and
// stays the default so existing installs behave exactly as before.
export const AGY_RUN_MODES = ["auto", "accept-edits", "plan", "dangerously-skip-permissions"];
export const DEFAULT_AGY_RUN_MODE = "dangerously-skip-permissions";

export function buildAgyArgs(prompt, options = {}) {
  if (options.sandbox) throw new Error("--sandbox is no longer supported for delegation; remove --sandbox and specify read-only behavior in the prompt if needed.");
  const mode = options.mode ?? DEFAULT_AGY_RUN_MODE;
  if (!AGY_RUN_MODES.includes(mode)) {
    throw new Error(`Unknown agy run mode "${mode}". Valid values: ${AGY_RUN_MODES.join(", ")}`);
  }
  const args = mode === "dangerously-skip-permissions" ? ["--dangerously-skip-permissions"] : ["--mode", mode];

  if (options.resumeLast) {
    args.push("--continue");
  }

  if (options.conversation) {
    args.push("--conversation", options.conversation);
  }

  if (options.model) {
    args.push("--model", options.model);
  }

  if (options.effort) {
    args.push("--effort", options.effort);
  }

  if (options.newProject) {
    args.push("--new-project");
  } else if (options.project) {
    args.push("--project", options.project);
  }

  for (const dir of options.addDirs ?? []) {
    args.push("--add-dir", dir);
  }

  if (options.logFile) {
    args.push("--log-file", options.logFile);
  }

  if (options.printTimeout) {
    args.push("--print-timeout", options.printTimeout);
  }

  const effectivePrompt = prompt || (options.resumeLast ? "Continue." : "");
  if (effectivePrompt) {
    args.push("--print", effectivePrompt);
  }

  return args;
}

export async function runAgyTask(cwd, prompt, options = {}) {
  const args = buildAgyArgs(prompt, options);

  if (!args.length) {
    throw new Error("No prompt or action provided for agy.");
  }

  return new Promise((resolve) => {
      const child = spawn(agyCommand(), args, {
        cwd: cwd || process.cwd(),
        env: options.env ?? process.env,
        stdio: ["ignore", "pipe", "pipe"]
      });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      const s = chunk.toString();
      stdout += s;
      options.onProgress?.({ message: s.trim().split("\n")[0] ?? "" });
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      resolve({ exitCode: 1, stdout, stderr: error.message });
    });

    child.on("close", (code) => {
      resolve({ exitCode: code ?? 0, stdout, stderr });
    });
  });
}

export function runAgyTaskSync(cwd, prompt, options = {}) {
  const args = buildAgyArgs(prompt, options);

  const result = spawnSync(agyCommand(), args, {
    cwd: cwd || process.cwd(),
    env: options.env ?? process.env,
    encoding: "utf8",
    timeout: options.timeout
  });

  if (result.error?.code === "ETIMEDOUT") {
    return {
      exitCode: 1,
      stdout: "",
      stderr: "agy task timed out.",
      timedOut: true
    };
  }

  return {
    exitCode: result.status ?? (result.error ? 1 : 0),
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    timedOut: false
  };
}

export function runAgyModels(cwd, options = {}) {
  const result = spawnSync(agyCommand(), ["models"], {
    cwd: cwd || process.cwd(),
    env: options.env ?? process.env,
    encoding: "utf8",
    timeout: options.timeout
  });

  return {
    exitCode: result.status ?? (result.error ? 1 : 0),
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ?? null
  };
}

export function runAgyAgents(cwd, options = {}) {
  const result = spawnSync(agyCommand(), ["agents"], {
    cwd: cwd || process.cwd(),
    env: options.env ?? process.env,
    encoding: "utf8",
    timeout: options.timeout
  });

  return {
    exitCode: result.status ?? (result.error ? 1 : 0),
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ?? null
  };
}

export function runAgyChangelog(cwd, options = {}) {
  const result = spawnSync(agyCommand(), ["changelog"], {
    cwd: cwd || process.cwd(),
    env: options.env ?? process.env,
    encoding: "utf8",
    timeout: options.timeout
  });

  return {
    exitCode: result.status ?? (result.error ? 1 : 0),
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ?? null
  };
}

# agy-plugin-cc

> Unofficial community project. Not affiliated with, sponsored or endorsed by Google. "Antigravity" and "Google" are trademarks of Google LLC.

A Claude Code plugin that integrates **Google's Antigravity (agy) CLI** and **Antigravity IDE** developer tools into Claude Code.

This companion extension follows the same design patterns as [`codex-plugin-cc`](https://github.com/openai/codex-plugin-cc), providing full job tracking, background execution, code review, and a session-aware stop-time review gate for **Google Antigravity** workflows.
(For OpenAI Codex CLI, see the counterpart: [`agy-plugin-codex`](https://github.com/Vit129/agy-plugin-codex)).

## Prerequisites

The Antigravity CLI must be installed and authenticated before using this plugin.

1. **Install agy CLI:**

   **Mac/Linux:**
   ```bash
   curl -fsSL https://antigravity.google/cli/install.sh | bash
   ```

   **Windows PowerShell:**
   ```powershell
   irm https://antigravity.google/cli/install.ps1 | iex
   ```

   **Windows CMD:**
   ```cmd
   curl -fsSL https://antigravity.google/cli/install.cmd -o install.cmd && install.cmd && del install.cmd
   ```

2. **Authenticate with your Google account:**
   ```bash
   agy auth
   ```

## Installation

In Claude Code:

```text
/plugin marketplace add Vit129/agy-plugin-cc
/plugin install agy@agy-plugin-cc
/reload-plugins
```

Updates: open `/plugin` → Marketplaces → `agy-plugin-cc` and turn on auto-update; new versions arrive when a session starts.
Manual update: `/plugin marketplace update agy-plugin-cc`, then `/reload-plugins`.

## Commands & Usage

### `/agy:setup`

Check whether `agy` is installed, optionally toggle the stop-time review gate, and set the run mode for this workspace.

```text
/agy:setup
/agy:setup --enable-review-gate
/agy:setup --disable-review-gate
/agy:setup --mode auto
/agy:setup --clear-mode
```

---

### `/agy:agy [prompt]`

Run a one-shot `agy` task directly.

```text
/agy:agy "Explain how the authentication flow works in this repo"
/agy:agy --resume "Keep going"
/agy:agy "What files changed in the last commit?"
```

---

### `/agy:rescue [task]`

Delegate investigation, fixes, or follow-up work to `agy`. Checks for a resumable previous session before starting.

```text
/agy:rescue "Fix the memory leak in the WebSocket connection handler"
/agy:rescue "Triage the slow query logs" --background
/agy:rescue "Keep going" --resume
/agy:rescue "Start over from scratch" --fresh
/agy:rescue "Read-only audit of the auth module"
```

**Flags:**

| Flag | Description |
|------|-------------|
| `--background` | Run in the background; check progress with `/agy:status` |
| `--resume` | Continue the most recent agy conversation |
| `--fresh` | Force a new conversation, ignoring previous context |

---

### `/agy:review`

Run a code review — agy examines the current git changes and reports findings.

```text
/agy:review
/agy:review --wait
/agy:review --background
/agy:review --scope branch
/agy:review --base main
```

**Scopes:** `auto` (default), `working-tree`, `branch`

---

### `/agy:adversarial-review [focus]`

Run an adversarial review — agy tries to find the strongest reasons the change should *not* ship.

```text
/agy:adversarial-review
/agy:adversarial-review "focus on the auth boundary"
/agy:adversarial-review --base main --wait
```

---

### `/agy:status [job-id]`

Show active and recent agy jobs for this repository.

```text
/agy:status
/agy:status task-abc123
/agy:status task-abc123 --wait
/agy:status --all
```

---

### `/agy:result [job-id]`

Show the stored output for a finished job.

```text
/agy:result
/agy:result task-abc123
```

---

### `/agy:cancel [job-id]`

Cancel an active background job.

```text
/agy:cancel
/agy:cancel task-abc123
```

---

## Run Mode

Every delegated run (`/agy:agy`, `/agy:rescue`, reviews, and the stop-time review gate) starts agy in one run mode:

| Mode | What agy may do |
|------|-----------------|
| `dangerously-skip-permissions` | Approve every tool call without asking (default) |
| `auto` | agy's auto mode: workspace edits and safe, reversible commands run; risky or irreversible actions are skipped |
| `accept-edits` | Approve workspace file edits; commands that need approval are skipped |
| `plan` | Read-only investigation: agy plans and does not edit files |

The first of these wins:

1. `--mode <mode>` on the command (`--dangerously-skip-permissions` is an alias for `--mode dangerously-skip-permissions`)
2. `/agy:setup --mode <mode>` for the current workspace (`--clear-mode` removes it)
3. The `AGY_PLUGIN_DEFAULT_MODE` environment variable, for example in the `env` block of `~/.claude/settings.json`
4. `dangerously-skip-permissions`

Delegated runs are headless, so an action agy would ask about is skipped instead: agy still exits successfully and prints a notice on stderr. A run can therefore finish without doing everything it was asked to do; the plugin appends those notices to the result under "Notices from agy" (and returns them as `stderr` in `--json` output).

`auto` needs agy's terminal sandbox (agy 1.3.5+ on macOS/Linux, 1.4.4+ on Windows 11 24H2 or later) and a personal account; where agy cannot offer it, agy falls back to its default mode. The stop-time review gate needs agy to answer `ALLOW:` or `BLOCK:`, so prefer a mode other than `plan` while the gate is on. `/agy:setup` shows the mode in effect and where it came from.

---

## Stop-Time Review Gate

When enabled, `agy` runs a review before each session ends and blocks if it finds issues.

```text
/agy:setup --enable-review-gate   # turn on
/agy:setup --disable-review-gate  # turn off
```

When a session ends with the gate enabled:
- `agy` reviews the previous Claude response
- If it responds `ALLOW:` — the session closes normally
- If it responds `BLOCK:` — the session is blocked with the reason

---

## Architecture

```
plugins/agy/
├── .claude-plugin/plugin.json       # plugin metadata (v1.1.0)
├── agents/agy-rescue.md             # agy:agy-rescue subagent
├── commands/                        # slash commands
│   ├── agy.md                       # /agy:agy
│   ├── rescue.md                    # /agy:rescue
│   ├── setup.md                     # /agy:setup
│   ├── review.md                    # /agy:review
│   ├── adversarial-review.md        # /agy:adversarial-review
│   ├── status.md                    # /agy:status
│   ├── result.md                    # /agy:result
│   └── cancel.md                    # /agy:cancel
├── hooks/hooks.json                 # SessionStart / SessionEnd / Stop
├── prompts/                         # prompt templates
│   ├── review.md
│   ├── adversarial-review.md
│   └── stop-review-gate.md
├── scripts/
│   ├── agy-companion.mjs            # main runtime (9 subcommands)
│   ├── session-lifecycle-hook.mjs   # SessionStart / SessionEnd handler
│   ├── stop-review-gate-hook.mjs    # Stop hook handler
│   └── lib/                         # modular library
│       ├── agy.mjs                  # agy CLI wrapper
│       ├── args.mjs                 # argument parsing
│       ├── fs.mjs                   # file utilities
│       ├── git.mjs                  # git review target resolution
│       ├── job-control.mjs          # job queries & enrichment
│       ├── process.mjs              # process utilities
│       ├── render.mjs               # output rendering
│       ├── state.mjs                # persistent job state
│       ├── tracked-jobs.mjs         # job lifecycle tracking
│       └── workspace.mjs            # git root resolution
└── skills/
    ├── agy-cli-runtime/SKILL.md     # internal runtime contract
    ├── agy-result-handling/SKILL.md # result presentation guidance
    └── gemini-3-prompting/SKILL.md  # prompt composition guidance
```

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

## Development and delivery

This is a Claude Code plugin package, not a local web application. `npm start` / `make start` runs the isolated package preview gate: syntax checks, unit tests, and `npm pack --dry-run`. There is no local GUI dev server; review runtime behavior by installing into a separate test Claude Code profile. The release script updates every semver/build surface, commits the candidate, and runs `npm run release:check` on that exact commit before it tags or pushes. CI runs the same gate on pull requests and pushes to `main`.

## Contributors

Developed and maintained by **Vit129** and **Claude** (Anthropic).

## License

Apache License 2.0 — see [LICENSE](./LICENSE) and [NOTICE](./NOTICE). Parts of the design
and scripts are derived from [`codex-plugin-cc`](https://github.com/openai/codex-plugin-cc) (Copyright 2026 OpenAI,
Apache-2.0), credited in `NOTICE`. Releases up to
v1.5.1 were published under MIT and remain available under those terms (`LICENSE-MIT`). Keep
`LICENSE` and `NOTICE` when you redistribute, and mark the files you change.

By default, delegated agy runs use `--dangerously-skip-permissions` without agy terminal sandboxing; see [Run Mode](#run-mode) to choose `auto`, `accept-edits`, or `plan` instead. Parent environment restrictions still apply. For read-only reviews, state that constraint in the prompt. The `--sandbox` option is rejected.

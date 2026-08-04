# Claude Code Tour

Ask Claude a question about your code and get a guided, step-by-step tour: it explores your workspace, then walks you through it, jumping to and highlighting each relevant range while explaining it in the sidebar.

## Requirements

The [Claude Code CLI](https://claude.com/claude-code) must be installed and logged in. This extension shells out to it (`claude -p ...`) using your existing login — no separate API key needed.

### Platform support

Windows, macOS and Linux. Finding the CLI is the only genuinely platform-specific part, and it differs more than you'd expect:

- **Windows** — Node does no `PATHEXT` resolution, so spawning bare `claude` fails with `ENOENT` even though it works in a terminal. The extension prefers a real `claude.exe`, unwraps an npm `.cmd` shim to its `claude.exe` sibling, and uses `cmd.exe` only as a last resort.
- **macOS / Linux** — the extension searches `PATH`, skipping non-executable matches the way a shell does, then probes well-known install locations (`~/.local/bin`, `~/.claude/local`, `/opt/homebrew/bin`, `/usr/local/bin`, …).

**If macOS says it can't find the CLI but `claude` works in your terminal**, the cause is almost always that an app launched from Finder or the Dock doesn't load your shell profile, so VS Code inherited a minimal `PATH`. Two fixes: relaunch VS Code with `code .` from a terminal, or run `which claude` and put that absolute path in `claudeCodeTour.claudePath` (`~` is supported).

Honest status: the full suite is run on Windows. The POSIX resolution branch is covered by tests that execute on macOS/Linux and by platform-stubbed control-flow checks, but it has not been run on real Apple hardware. If you hit something, please open an issue.

## Usage

1. Open a folder/workspace.
2. Run **Claude Code Tour: Ask About This Code** from the Command Palette, or open the Claude Code Tour view in the Activity Bar and type a question.
3. Use **Next** / **Prev** in the sidebar to step through the tour; the editor jumps to and highlights each step.

## Settings

- `claudeCodeTour.claudePath` - path to the `claude` executable if it's not on your PATH.
- `claudeCodeTour.model` - optional model override passed to the CLI.
- `claudeCodeTour.maxCostUsd` - optional spend cap per question (`0` disables it). Recommended: see the cost note below.
- `claudeCodeTour.timeoutSeconds` - how long to wait before giving up (default 300).

## Cost and latency

This extension uses your existing Claude Code login — there is no separate API key to set up. But each question spawns its own fresh Claude Code session, which explores the repository from scratch (12-17 tool calls in practice). That exploration is what costs time and usage.

**What the dollar figure means depends on your plan.** The number shown in the panel is the CLI's own API-rate accounting. On API-key billing it is real money. On a Pro/Max subscription there is no incremental charge, but the question still consumes your usage allowance — so a heavy session can still run you into a rate limit.

Measured against a mid-size React app (~40 source files), same question both times:

| Model | Wall clock | Reported cost | Steps | Anchor accuracy |
|---|---|---|---|---|
| default (Sonnet) | 74-81 s | ~$0.40 | 13 | 100% exact |
| `haiku` | 22 s | ~$0.04 | 6 | 100% exact |

**Haiku is roughly 10x cheaper and 3.5x faster with identical line-anchor accuracy** — it just produces a shorter, less thorough tour. If you're exploring at volume or teaching with it, set:

```json
"claudeCodeTour.model": "haiku"
```

The panel shows elapsed time and cost for every completed tour, you can cancel a running question, and `claudeCodeTour.maxCostUsd` caps a single question.

## How it works

Each question is sent to the Claude Code CLI with `--tools Read,Grep,Glob` (no write tools) and asked for schema-validated structured output (`--json-schema`): a summary plus an ordered list of `{file, startLine, endLine, anchor, title, explanation}` steps, which the extension plays back in the editor.

The prompt is delivered over **stdin**, never as a command-line argument, so your question text is never exposed to shell or `cmd.exe` parsing.

### Staying on the right lines

Line numbers go stale the instant a file is edited — and because the CLI reads from disk, unsaved editor changes make them wrong immediately. So each step also carries an `anchor`: its first line, copied verbatim. At display time the extension searches the current document for that anchor (exact, then re-indented, then whitespace-normalized), using the model's line number only to disambiguate multiple matches.

If a step is re-located or can't be found at all, the sidebar says so explicitly. A teaching tool that silently explains the wrong lines is worse than one that admits it lost its place.

### Security model

The CLI runs with `--permission-mode dontAsk`, **not** `bypassPermissions`. This is deliberate and was verified by measurement: under `bypassPermissions` the CLI will read and quote back files well outside your workspace (confirmed against a real `~/.claude.json`), which turns any prompt injection hidden in a workspace file into credential exfiltration. Under `dontAsk`, workspace reads still succeed and out-of-workspace reads are denied and logged.

Two further defenses:

- **Path containment** — every returned step path is resolved and rejected unless it stays inside the workspace folder, so a hallucinated or injected `../../.ssh/id_rsa` is never opened in your editor.
- **Prompt hardening** — the CLI is instructed to treat file contents as data rather than instructions, and not to read credential files.

Caveat worth knowing: prompt hardening is advisory, not enforced. Explanation text is generated by a model that has read your workspace, so treat a tour of an untrusted repository with the same caution you would treat running its code.

## Development

```bash
npm install
npm run compile           # or: npm run watch
npm test                  # unit tests (node:test), no VS Code needed
npm run test:integration  # launches a real VS Code and runs the suite inside it
npm run package           # produces a .vsix
```

Press <kbd>F5</kbd> to launch an Extension Development Host with the extension loaded.

The unit suite covers the CLI transport (argument construction, envelope parsing, step validation, cancellation, executable resolution) and the anchor resolver, using a fake CLI process rather than mocks — so the argv, stdin, exit codes and kill signals under test are real. The integration suite runs inside VS Code and covers activation, command registration, and range resolution against real `TextDocument`s.

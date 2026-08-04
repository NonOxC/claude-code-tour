# Changelog

All notable changes to the Claude Code Tour extension are documented here.

## [Unreleased]

### Changed

- **Asking a question no longer opens a prompt at the top of the window.** The `Ask About This Code` command now reveals the panel and focuses its own input. A modal quick-input is a worse place to type than the panel that is about to show the answer, and it hid the suggestions.

### Added

- **Right-click → Explain This With a Tour.** Select code in the editor and the question is composed for you from the file and line range; with no selection it asks about the whole file.
- **Empty state with one-click starters**, so the panel is usable without thinking up a question.
- **Motion cues:** a progress bar across the tour, steps that slide up as they replace one another, an animated marker on the current outline item, and a brief pulse on the editor range when it comes into view. All disabled under `prefers-reduced-motion` — every cue is also carried by colour, position or text.
- `Alt+←` / `Alt+→` step through a tour from anywhere; the keybindings only bind while a tour is active.
- Stepping now uses `InCenterIfOutsideViewport`, so moving between ranges already on screen no longer yanks the viewport.

### Fixed

- **macOS/Linux CLI discovery.** `PATH` lookup now skips non-executable matches instead of stopping at the first one, so a wrapper script someone forgot to `chmod +x` no longer shadows a working install. When `PATH` comes up empty the extension probes well-known install locations rather than giving up — this matters on macOS, where an app launched from Finder or the Dock does not load your shell profile.
- **`~` is now expanded** in `claudeCodeTour.claudePath`. The macOS install docs print the path as `~/.local/bin/claude`, which is exactly what users paste in, and it previously failed with "path does not exist".
- **Truthful not-found errors on POSIX.** Resolution no longer falls back to the bare name `claude`, which made preflight report *"Found the Claude Code CLI at claude but could not run it"* about a CLI it had never found. It now explains the inherited-`PATH` cause and how to fix it.
- **Workspace containment now compares canonical paths.** A symlink inside the workspace pointing outside it could previously pass the lexical check; on macOS the same check also produced false rejections, since `/tmp` is itself a symlink to `/private/tmp`.

### Added

- Initial implementation: ask a question, get a guided step-by-step tour.
- Sidebar webview player with Ask box and Next / Prev / End controls.
- Editor range highlighting that follows the current step.
- Settings: `claudeCodeTour.claudePath`, `claudeCodeTour.model`.

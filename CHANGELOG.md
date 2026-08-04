# Changelog

All notable changes to the Claude Code Tour extension are documented here.

## [Unreleased]

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

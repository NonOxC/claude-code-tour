# Changelog

All notable changes to the Claude Code Tour extension are documented here.

## [Unreleased]

### Changed

- **The panel now opens in the Secondary Side Bar (right) instead of the Activity Bar (left).** It was competing with the file explorer for the same space; on the right, the explorer stays put and the editor remains visible in the middle so you can watch the tour move between files. This uses the `secondarySidebar` view container contribution, which requires **VS Code 1.106+** — the minimum engine version has been raised accordingly, because declaring it on older builds makes views fall back to the Explorer and can disturb other extensions' view positions.
- **Asking a question no longer opens a prompt at the top of the window.** The `Ask About This Code` command now reveals the panel and focuses its own input. A modal quick-input is a worse place to type than the panel that is about to show the answer, and it hid the suggestions.

### Added

- **The tour is now visible in VS Code's own file explorer.** Files a tour visits are badged with their step number and tinted, and the current step's file gets a **▶** marker that moves through the tree as you step. Decorations propagate to parent folders, so directories light up while still collapsed. Extensions cannot style the workbench, so this uses `FileDecorationProvider` — the same mechanism Git uses for its `M`/`U` badges — rather than CSS. Colours are contributed as themeable tokens (`claudeCodeTour.currentFile`, `claudeCodeTour.tourFile`), and the whole thing is behind `claudeCodeTour.highlightInExplorer`.
- **An orange mortarboard button in the editor title bar (top right).** The primary way in, alongside the other editor actions. It uses a bundled SVG rather than a built-in codicon because VS Code recolours codicons to match the theme and will not honour a custom colour; an SVG with an explicit fill keeps the orange in both light and dark themes. The same icon is now used for the panel itself, and the status bar entry is tinted to match so the three read as one feature.
- **A 🎓 Tour button in the status bar.** Moving the panel to the Secondary Side Bar removed its Activity Bar icon, and a closed Secondary Side Bar offers no affordance at all — leaving the feature reachable only by keyboard shortcut or command palette. The status bar is visible regardless of which sidebars are open. This also required activating on startup, since the extension previously only woke when the panel was first opened, which would have meant the button did not exist until you had already found the panel.
- **A file map of the tour.** "Where this tour goes" lists every file the tour visits, grouped by directory in the order it first reaches them, with a clickable numbered badge per step. A marker travels to the current step's file, so jumping across the codebase reads as movement through a structure rather than as two unrelated highlight states.
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

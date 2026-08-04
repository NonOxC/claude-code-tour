import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ExtensionToWebviewMessage, StepResolution, TourPlan, TourStep } from './tourTypes';
import { startTour, RunTourOptions, RunHandle, CancelledError } from './claudeRunner';
import { resolveAnchor } from './anchorResolver';

interface ResolvedRange {
  range: vscode.Range;
  resolution: StepResolution;
  note?: string;
}

export class TourController implements vscode.Disposable {
  private plan: TourPlan | undefined;
  private index = 0;
  private workspaceRoot = '';
  private readonly decorationType: vscode.TextEditorDecorationType;
  private readonly arrivalFlashType: vscode.TextEditorDecorationType;
  private flashTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * Bumped on every new request and on end(). Every async continuation re-checks it
   * before touching the editor, so a slow file-open from a superseded step can't
   * resurrect a highlight after the tour moved on or was ended.
   */
  private generation = 0;
  private inFlight: RunHandle | undefined;
  /** URI whose editor currently owns the highlight, so stale ones can be cleaned up. */
  private decoratedUri: string | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly post: (msg: ExtensionToWebviewMessage) => void,
    private readonly decorations?: {
      setPlan: (plan: TourPlan) => void;
      setCurrent: (file: string) => void;
      clear: () => void;
    },
  ) {
    this.decorationType = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
      overviewRulerColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
      overviewRulerLane: vscode.OverviewRulerLane.Full,
    });
    // A brighter decoration laid over the steady one for a moment on arrival, so the
    // eye can find the new range after the editor scrolls. VS Code gives decorations
    // a CSS transition, so removing it fades out rather than snapping.
    this.arrivalFlashType = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor('editor.selectionHighlightBackground'),
      border: '1px solid',
      borderColor: new vscode.ThemeColor('focusBorder'),
    });

    // A file decorated while visible keeps its decoration when pushed to a background
    // tab; clear it the moment it comes back if it is no longer the active step.
    this.disposables.push(
      vscode.window.onDidChangeVisibleTextEditors((editors) => {
        for (const editor of editors) {
          if (editor.document.uri.toString() !== this.decoratedUri) {
            editor.setDecorations(this.decorationType, []);
          }
        }
      }),
    );
  }

  async runTourForQuestion(question: string, options: RunTourOptions): Promise<void> {
    // Supersede any request already running so we don't leave an orphaned CLI process.
    this.cancelInFlight();
    const myGeneration = ++this.generation;
    this.post({ type: 'loading', question });

    const handle = startTour(question, options);
    this.inFlight = handle;

    try {
      const plan = await handle.promise;
      if (myGeneration !== this.generation) {
        return;
      }
      this.plan = plan;
      this.setActiveContext(true);
      this.index = 0;
      this.workspaceRoot = options.workspaceRoot;
      // Snapshot before handing the plan to the webview, so a step that later fails
      // to re-anchor can still show the code it was written about.
      await this.captureSnapshots(plan);
      if (myGeneration !== this.generation) {
        return;
      }
      this.decorations?.setPlan(plan);
      this.post({ type: 'plan', plan, index: 0 });
      await this.showStep(myGeneration);
    } catch (err) {
      if (myGeneration !== this.generation || err instanceof CancelledError) {
        return;
      }
      this.post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    } finally {
      if (this.inFlight === handle) {
        this.inFlight = undefined;
      }
    }
  }

  cancel(): void {
    if (!this.inFlight) {
      return;
    }
    this.generation += 1;
    this.cancelInFlight();
    this.post({ type: 'idle' });
  }

  next(): void {
    if (!this.plan || this.index >= this.plan.steps.length - 1) {
      return;
    }
    this.index += 1;
    void this.showStep(this.generation);
  }

  prev(): void {
    if (!this.plan || this.index <= 0) {
      return;
    }
    this.index -= 1;
    void this.showStep(this.generation);
  }

  goto(target: number): void {
    if (!this.plan) {
      return;
    }
    const clamped = Math.max(0, Math.min(Math.floor(target), this.plan.steps.length - 1));
    if (!Number.isFinite(clamped)) {
      return;
    }
    this.index = clamped;
    void this.showStep(this.generation);
  }

  end(): void {
    this.generation += 1;
    this.cancelInFlight();
    this.clearDecorations();
    this.plan = undefined;
    this.decorations?.clear();
    this.setActiveContext(false);
    this.index = 0;
    this.post({ type: 'idle' });
  }

  dispose(): void {
    this.cancelInFlight();
    if (this.flashTimer) {
      clearTimeout(this.flashTimer);
    }
    this.decorationType.dispose();
    this.arrivalFlashType.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }

  /**
   * Read each step's range off disk once, while the tour is still fresh and the
   * anchors all resolve. Best-effort: a step we cannot read simply has no snapshot.
   */
  private async captureSnapshots(plan: TourPlan): Promise<void> {
    const MAX_SNAPSHOT_LINES = 60;
    for (const step of plan.steps) {
      const absPath = this.resolveWorkspacePath(step.file);
      if (!absPath) {
        continue;
      }
      try {
        const doc = await vscode.workspace.openTextDocument(absPath);
        const lines: string[] = [];
        for (let i = 0; i < doc.lineCount; i++) {
          lines.push(doc.lineAt(i).text);
        }
        const resolved = resolveAnchor(lines, step, path.basename(step.file));
        const end = Math.min(resolved.endLine, resolved.startLine + MAX_SNAPSHOT_LINES - 1);
        step.snapshot = lines.slice(resolved.startLine, end + 1).join('\n');
      } catch {
        // Unreadable file: the step just goes without a snapshot.
      }
    }
  }

  private cancelInFlight(): void {
    this.inFlight?.cancel();
    this.inFlight = undefined;
  }

  private clearDecorations(): void {
    if (this.flashTimer) {
      clearTimeout(this.flashTimer);
      this.flashTimer = undefined;
    }
    for (const editor of vscode.window.visibleTextEditors) {
      editor.setDecorations(this.decorationType, []);
      editor.setDecorations(this.arrivalFlashType, []);
    }
    this.decoratedUri = undefined;
  }

  private flashArrival(editor: vscode.TextEditor, range: vscode.Range): void {
    if (this.flashTimer) {
      clearTimeout(this.flashTimer);
    }
    editor.setDecorations(this.arrivalFlashType, [range]);
    this.flashTimer = setTimeout(() => {
      this.flashTimer = undefined;
      // Only clear our own flash; the steady highlight stays put.
      editor.setDecorations(this.arrivalFlashType, []);
    }, 700);
  }

  private setActiveContext(active: boolean): void {
    void vscode.commands.executeCommand('setContext', 'claudeCodeTour.active', active);
  }

  /**
   * Resolve `step.file` to an absolute path that is provably inside the workspace.
   * The CLI's JSON is untrusted: a hallucinated or injected `../../.ssh/id_rsa` must
   * never be opened and highlighted in the user's editor.
   */
  private resolveWorkspacePath(file: string): string | undefined {
    if (!this.workspaceRoot) {
      return undefined;
    }
    const abs = path.resolve(this.workspaceRoot, file);

    // Compare canonical paths. A lexical check alone is defeated by a symlink
    // inside the workspace pointing out of it, and on macOS it also produces false
    // rejections because directories like /tmp are themselves symlinks
    // (/tmp -> /private/tmp), so the two sides would never share a prefix.
    const canonical = (p: string): string => {
      try {
        return fs.realpathSync.native(p);
      } catch {
        return path.resolve(p);
      }
    };

    const realRoot = canonical(this.workspaceRoot);
    // The file may legitimately not exist yet; canonicalize its parent instead.
    const realAbs = fs.existsSync(abs) ? canonical(abs) : path.join(canonical(path.dirname(abs)), path.basename(abs));

    const rel = path.relative(realRoot, realAbs);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
      return undefined;
    }
    return realAbs;
  }

  private async showStep(expectedGeneration: number): Promise<void> {
    if (!this.plan || expectedGeneration !== this.generation) {
      return;
    }
    const step = this.plan.steps[this.index];
    if (!step) {
      return;
    }
    // Move the explorer marker up front, so the tree updates even if the file
    // itself turns out to be unopenable.
    this.decorations?.setCurrent(step.file);

    const absPath = this.resolveWorkspacePath(step.file);
    if (!absPath) {
      this.clearDecorations();
      this.post({
        type: 'step',
        index: this.index,
        resolution: 'missing-file',
        note: `Refused to open "${step.file}" — it resolves outside this workspace. The explanation below may be unreliable.`,
      });
      return;
    }

    let doc: vscode.TextDocument;
    try {
      doc = await vscode.workspace.openTextDocument(absPath);
    } catch {
      if (expectedGeneration !== this.generation) {
        return;
      }
      this.clearDecorations();
      this.post({
        type: 'step',
        index: this.index,
        resolution: 'missing-file',
        note: `Could not open "${step.file}" — it may have been moved, renamed, or deleted since the tour was generated.`,
      });
      return;
    }
    if (expectedGeneration !== this.generation) {
      return;
    }

    const resolved = resolveStepRange(doc, step);

    let editor: vscode.TextEditor;
    try {
      editor = await vscode.window.showTextDocument(doc, {
        preview: false,
        viewColumn: vscode.ViewColumn.Active,
      });
    } catch {
      if (expectedGeneration !== this.generation) {
        return;
      }
      this.clearDecorations();
      this.post({
        type: 'step',
        index: this.index,
        resolution: 'unresolved',
        note: `Could not show "${step.file}" in an editor.`,
      });
      return;
    }
    // showTextDocument awaited: the tour may have been ended or advanced meanwhile.
    if (expectedGeneration !== this.generation) {
      return;
    }

    this.clearDecorations();
    editor.setDecorations(this.decorationType, [resolved.range]);
    this.decoratedUri = doc.uri.toString();

    // InCenterIfOutsideViewport, not InCenter: re-centering a range that is already
    // on screen yanks the view for no reason, which reads as jitter when stepping
    // through several ranges in the same file.
    editor.revealRange(resolved.range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    this.flashArrival(editor, resolved.range);

    this.post({
      type: 'step',
      index: this.index,
      resolution: resolved.resolution,
      note: resolved.note,
    });
  }
}

/** Bridge the pure line-based resolver to a concrete editor range. */
export function resolveStepRange(doc: vscode.TextDocument, step: TourStep): ResolvedRange {
  const lines: string[] = [];
  for (let i = 0; i < doc.lineCount; i++) {
    lines.push(doc.lineAt(i).text);
  }

  const resolved = resolveAnchor(lines, step, path.basename(step.file));
  const endText = doc.lineCount > 0 ? doc.lineAt(resolved.endLine).text : '';

  return {
    range: new vscode.Range(resolved.startLine, 0, resolved.endLine, endText.length),
    resolution: resolved.resolution,
    note: resolved.note,
  };
}

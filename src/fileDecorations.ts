import * as vscode from 'vscode';
import * as path from 'path';
import { TourPlan } from './tourTypes';

/**
 * Paints the tour onto VS Code's own file explorer.
 *
 * Extensions cannot style the workbench, so there is no way to animate the tree
 * directly. What we can do is decorate it - the same mechanism Git uses for its
 * M/U badges - and re-emit those decorations as the tour advances. The visible
 * result is a marker that moves through the real explorer as you step, with every
 * file the tour touches badged with its step number.
 *
 * `propagate` is what makes structure legible: a decorated file tints its parent
 * folders too, so the directories a tour passes through light up even while
 * collapsed.
 */
export class TourDecorationProvider implements vscode.FileDecorationProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri[]>();
  readonly onDidChangeFileDecorations = this.emitter.event;

  /** fsPath -> the 1-based step numbers that live in that file. */
  private steps = new Map<string, number[]>();
  private currentPath: string | undefined;
  private enabled = true;

  constructor(private readonly resolvePath: (file: string) => string | undefined) {}

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) {
      return;
    }
    this.enabled = enabled;
    this.refreshAll();
  }

  /** Called when a new plan arrives. */
  setPlan(plan: TourPlan): void {
    const previous = this.decoratedUris();
    this.steps = new Map();
    plan.steps.forEach((step, i) => {
      const abs = this.resolvePath(step.file);
      if (!abs) {
        return;
      }
      const key = normalize(abs);
      const list = this.steps.get(key) ?? [];
      list.push(i + 1);
      this.steps.set(key, list);
    });
    this.currentPath = undefined;
    this.emitter.fire([...previous, ...this.decoratedUris()]);
  }

  /** Called on every step change; moves the "current" marker. */
  setCurrent(file: string): void {
    const abs = this.resolvePath(file);
    const next = abs ? normalize(abs) : undefined;
    if (next === this.currentPath) {
      return;
    }
    const changed: vscode.Uri[] = [];
    if (this.currentPath) {
      changed.push(vscode.Uri.file(this.currentPath));
    }
    if (next) {
      changed.push(vscode.Uri.file(next));
    }
    this.currentPath = next;
    this.emitter.fire(changed);
  }

  clear(): void {
    const previous = this.decoratedUris();
    this.steps = new Map();
    this.currentPath = undefined;
    this.emitter.fire(previous);
  }

  dispose(): void {
    this.emitter.dispose();
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (!this.enabled || uri.scheme !== 'file') {
      return undefined;
    }
    const key = normalize(uri.fsPath);
    const stepNumbers = this.steps.get(key);
    if (!stepNumbers || stepNumbers.length === 0) {
      return undefined;
    }

    const isCurrent = key === this.currentPath;
    const label = stepNumbers.length === 1 ? `step ${stepNumbers[0]}` : `steps ${stepNumbers.join(', ')}`;

    return {
      // A badge is capped at two characters, so a step number past 99 degrades to a dot.
      badge: isCurrent ? '▶' : badgeFor(stepNumbers[0]),
      color: new vscode.ThemeColor(isCurrent ? 'claudeCodeTour.currentFile' : 'claudeCodeTour.tourFile'),
      tooltip: isCurrent ? `Claude Code Tour — currently here (${label})` : `Claude Code Tour — ${label}`,
      propagate: true,
    };
  }

  private refreshAll(): void {
    this.emitter.fire(this.decoratedUris());
  }

  private decoratedUris(): vscode.Uri[] {
    return [...this.steps.keys()].map((p) => vscode.Uri.file(p));
  }
}

function badgeFor(step: number): string {
  return step <= 99 ? String(step) : '•';
}

/**
 * Keys for the lookup map. Separators are normalised on both platforms; case is
 * folded only on Windows, where the same file genuinely can arrive spelled two
 * ways. POSIX paths stay case-sensitive because there they are distinct files.
 */
function normalize(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

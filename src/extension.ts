import * as vscode from 'vscode';
import { TourPanel } from './tourPanel';
import { TourController } from './tourController';
import { WebviewToExtensionMessage } from './tourTypes';
import { RunTourOptions, preflight, clearCliCache } from './claudeRunner';

const INSTALL_URL = 'https://claude.com/claude-code';

export function activate(context: vscode.ExtensionContext): void {
  const panel = new TourPanel(context.extensionUri);
  const controller = new TourController((msg) => panel.postMessage(msg));

  /** Remembered so a multi-root user isn't re-prompted on every question. */
  let chosenFolder: vscode.WorkspaceFolder | undefined;

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      chosenFolder = undefined;
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('claudeCodeTour.claudePath')) {
        clearCliCache();
      }
    }),
  );

  async function pickFolder(): Promise<vscode.WorkspaceFolder | undefined> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      void vscode.window.showErrorMessage('Claude Code Tour needs an open folder or workspace to explore.');
      return undefined;
    }
    if (folders.length === 1) {
      return folders[0];
    }
    if (chosenFolder && folders.includes(chosenFolder)) {
      return chosenFolder;
    }
    // Multi-root: silently exploring only the first folder produces confusingly
    // incomplete tours, so ask which one this question is about.
    const picked = await vscode.window.showQuickPick(
      folders.map((f) => ({ label: f.name, description: f.uri.fsPath, folder: f })),
      { title: 'Which folder should Claude explore?', ignoreFocusOut: true },
    );
    chosenFolder = picked?.folder;
    return chosenFolder;
  }

  async function getOptions(): Promise<RunTourOptions | undefined> {
    const folder = await pickFolder();
    if (!folder) {
      return undefined;
    }
    const config = vscode.workspace.getConfiguration('claudeCodeTour');
    const claudePath = config.get<string>('claudePath', 'claude') || 'claude';

    const check = await preflight(claudePath);
    if (!check.ok) {
      const choice = await vscode.window.showErrorMessage(check.message, 'Install Claude Code', 'Open Settings');
      if (choice === 'Install Claude Code') {
        void vscode.env.openExternal(vscode.Uri.parse(INSTALL_URL));
      } else if (choice === 'Open Settings') {
        void vscode.commands.executeCommand('workbench.action.openSettings', 'claudeCodeTour.claudePath');
      }
      return undefined;
    }

    const maxCost = config.get<number>('maxCostUsd', 0);
    const timeoutSeconds = config.get<number>('timeoutSeconds', 300);
    return {
      claudePath,
      model: config.get<string>('model', '') || undefined,
      maxCostUsd: typeof maxCost === 'number' && maxCost > 0 ? maxCost : undefined,
      timeoutMs:
        typeof timeoutSeconds === 'number' && timeoutSeconds > 0 ? Math.round(timeoutSeconds * 1000) : undefined,
      workspaceRoot: folder.uri.fsPath,
    };
  }

  async function ask(question: string): Promise<void> {
    const options = await getOptions();
    if (!options) {
      return;
    }
    await controller.runTourForQuestion(question, options);
  }

  /**
   * Reveal the panel and drop the cursor in its Ask box. Deliberately NOT a
   * showInputBox: a modal prompt at the top of the window is a worse place to type
   * than the panel that is about to show the answer, and it hides the suggestions.
   */
  async function askFlow(prefill?: string): Promise<void> {
    await vscode.commands.executeCommand('workbench.view.extension.claudeCodeTour');
    panel.postMessage({ type: 'focusInput', prefill });
  }

  /** Turn the current selection into a question without the user phrasing one. */
  async function explainSelection(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      await askFlow();
      return;
    }
    const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
    const relative = folder
      ? vscode.workspace.asRelativePath(editor.document.uri, false)
      : editor.document.fileName;

    const sel = editor.selection;
    if (sel.isEmpty) {
      await askFlow(`Walk me through ${relative} — what does it do and how does it fit together?`);
      return;
    }
    const startLine = sel.start.line + 1;
    const endLine = sel.end.line + 1;
    const where = startLine === endLine ? `line ${startLine}` : `lines ${startLine}-${endLine}`;
    await askFlow(`Explain ${relative} ${where}: what does this code do, and what else does it touch?`);
  }

  panel.setMessageHandler((msg: WebviewToExtensionMessage) => {
    switch (msg.type) {
      case 'ask':
        if (msg.question?.trim()) {
          void ask(msg.question.trim());
        }
        break;
      case 'next':
        controller.next();
        break;
      case 'prev':
        controller.prev();
        break;
      case 'goto':
        controller.goto(msg.index);
        break;
      case 'cancel':
        controller.cancel();
        break;
      case 'end':
        controller.end();
        break;
      case 'ready':
        break;
    }
  });

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(TourPanel.viewType, panel),
    vscode.commands.registerCommand('claudeCodeTour.ask', () => void askFlow()),
    vscode.commands.registerCommand('claudeCodeTour.explainSelection', () => void explainSelection()),
    vscode.commands.registerCommand('claudeCodeTour.next', () => controller.next()),
    vscode.commands.registerCommand('claudeCodeTour.prev', () => controller.prev()),
    vscode.commands.registerCommand('claudeCodeTour.end', () => controller.end()),
    controller,
  );
}

export function deactivate(): void {}

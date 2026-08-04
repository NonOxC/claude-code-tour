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

  async function askFlow(): Promise<void> {
    const question = await vscode.window.showInputBox({
      prompt: 'What do you want Claude to explain or walk you through?',
      placeHolder: 'e.g. "How does authentication work in this project?"',
      ignoreFocusOut: true,
    });
    if (!question?.trim()) {
      return;
    }
    await vscode.commands.executeCommand('workbench.view.extension.claudeCodeTour');
    await ask(question.trim());
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
    vscode.commands.registerCommand('claudeCodeTour.next', () => controller.next()),
    vscode.commands.registerCommand('claudeCodeTour.prev', () => controller.prev()),
    vscode.commands.registerCommand('claudeCodeTour.end', () => controller.end()),
    controller,
  );
}

export function deactivate(): void {}
